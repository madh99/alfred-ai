/**
 * v823 — AgentConventionsRepository.
 *
 * Persistiert die CLAUDE.md-Conventions pro Projekt (+ Package). Plus Helper für
 * History (Audit-Log + Rollback), Patterns (Cross-Project), Violations (Inverse
 * Learning), Test-Runs (Effectiveness-Tracking).
 *
 * Side-Effect-Notiz: alle SQL ist additiv. Existing-Tabellen werden nicht
 * angefasst — diese Repo schreibt nur in die durch Migration v99/v103
 * erzeugten neuen Tabellen.
 */

import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';
import type {
  AgentConventions,
  ConventionsHistoryEntry,
  ConventionPattern,
  ConventionViolation,
  ConventionTestRun,
  NeutralConventions,
  ConventionsScanSnapshot,
  ConventionsGeneratedBy,
  ConventionsSection,
  ConventionsOutputFormat,
  ConventionsLanguage,
} from '@alfred/types';

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function rowToConventions(r: DbRow): AgentConventions {
  const neutralRaw = parseJson<Partial<NeutralConventions>>(r.neutral_format, { meta: { version: '1', lessonsCount: 0, language: 'de' }, sections: {}, lessons: [] } as Partial<NeutralConventions>);
  const neutral: NeutralConventions = {
    meta: {
      version: '1',
      generatedAt: neutralRaw.meta?.generatedAt,
      scanHash: neutralRaw.meta?.scanHash,
      contentHash: neutralRaw.meta?.contentHash,
      lessonsCount: neutralRaw.meta?.lessonsCount ?? 0,
      language: (neutralRaw.meta?.language ?? 'de') as ConventionsLanguage,
    },
    sections: neutralRaw.sections ?? {},
    lessons: neutralRaw.lessons ?? [],
  };
  return {
    projectId: r.project_id as string,
    packagePath: (r.package_path as string) ?? '',
    content: (r.content as string) ?? '',
    draftContent: (r.draft_content as string | null) ?? null,
    neutralFormat: neutral,
    scanHash: (r.scan_hash as string) ?? '',
    contentHash: (r.content_hash as string) ?? '',
    generatedBy: ((r.generated_by as string) ?? 'manual') as ConventionsGeneratedBy,
    generatedAt: (r.generated_at as string | null) ?? null,
    lastAppliedAt: (r.last_applied_at as string | null) ?? null,
    lastDriftCheckAt: (r.last_drift_check_at as string | null) ?? null,
    driftScore: Number(r.drift_score ?? 0),
    sourceScan: parseJson<ConventionsScanSnapshot | null>(r.source_scan, null),
    filesWritten: parseJson<ConventionsOutputFormat[]>(r.files_written, []),
    skillContributions: parseJson<Record<string, { version: number; includedAt: string }>>(r.skill_contributions, {}),
    language: ((r.language as string) ?? 'de') as ConventionsLanguage,
    inheritsFrom: (r.inherits_from as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToHistory(r: DbRow): ConventionsHistoryEntry {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    packagePath: (r.package_path as string) ?? '',
    appliedAt: r.applied_at as string,
    appliedBy: r.applied_by as string,
    prevContentHash: (r.prev_content_hash as string | null) ?? null,
    newContentHash: r.new_content_hash as string,
    prevContentSnapshot: (r.prev_content_snapshot as string | null) ?? null,
    diffSummary: (r.diff_summary as string | null) ?? null,
    triggerSource: r.trigger_source as string,
    triggerSessionId: (r.trigger_session_id as string | null) ?? null,
    rolledBackAt: (r.rolled_back_at as string | null) ?? null,
    rolledBackBy: (r.rolled_back_by as string | null) ?? null,
  };
}

function rowToPattern(r: DbRow): ConventionPattern {
  return {
    id: r.id as string,
    masterUserId: r.master_user_id as string,
    patternText: r.pattern_text as string,
    patternSection: (r.pattern_section as string) as ConventionsSection,
    category: r.category as string,
    frameworkTags: parseJson<string[]>(r.framework_tags, []),
    occurrenceCount: Number(r.occurrence_count ?? 0),
    appliesToCount: Number(r.applies_to_count ?? 0),
    confidence: Number(r.confidence ?? 0),
    embeddingId: (r.embedding_id as string | null) ?? null,
    firstObservedAt: r.first_observed_at as string,
    lastObservedAt: r.last_observed_at as string,
    retiredAt: (r.retired_at as string | null) ?? null,
  };
}

function rowToViolation(r: DbRow): ConventionViolation {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    packagePath: (r.package_path as string) ?? '',
    conventionSection: (r.convention_section as string) as ConventionsSection,
    conventionExcerpt: r.convention_excerpt as string,
    sessionId: (r.session_id as string | null) ?? null,
    violatedAt: r.violated_at as string,
    resolvedAnyway: !!(r.resolved_anyway as number),
    manualOverride: !!(r.manual_override as number),
    detectionSource: r.detection_source as string,
  };
}

function rowToTestRun(r: DbRow): ConventionTestRun {
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? null,
    conventionsVersionHash: r.conventions_version_hash as string,
    canonicalTaskId: r.canonical_task_id as string,
    stack: r.stack as string,
    withConventions: !!(r.with_conventions as number),
    outcomePassed: !!(r.outcome_passed as number),
    outcomeDetails: (r.outcome_details as string | null) ?? null,
    fixAttempts: Number(r.fix_attempts ?? 0),
    durationMs: Number(r.duration_ms ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    ranAt: r.ran_at as string,
  };
}

export class AgentConventionsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  // ────────────────────────────────────────────────────────────────────────
  // Conventions — Phase 1 core
  // ────────────────────────────────────────────────────────────────────────

  async get(projectId: string, packagePath = ''): Promise<AgentConventions | null> {
    const r = await this.db.queryOne(
      `SELECT * FROM agent_conventions WHERE project_id = ? AND package_path = ?`,
      [projectId, packagePath],
    );
    return r ? rowToConventions(r) : null;
  }

  async listForProject(projectId: string): Promise<AgentConventions[]> {
    const rows = await this.db.query(
      `SELECT * FROM agent_conventions WHERE project_id = ? ORDER BY package_path ASC`,
      [projectId],
    );
    return rows.map(rowToConventions);
  }

  /** Upsert. Wenn pkg-Row existiert → update; sonst insert. */
  async upsert(opts: {
    projectId: string;
    packagePath?: string;
    content?: string;
    draftContent?: string | null;
    neutralFormat?: NeutralConventions;
    scanHash?: string;
    contentHash?: string;
    generatedBy?: ConventionsGeneratedBy;
    generatedAt?: string | null;
    lastAppliedAt?: string | null;
    driftScore?: number;
    sourceScan?: ConventionsScanSnapshot | null;
    filesWritten?: ConventionsOutputFormat[];
    skillContributions?: Record<string, { version: number; includedAt: string }>;
    language?: ConventionsLanguage;
    inheritsFrom?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const pkg = opts.packagePath ?? '';
    const existing = await this.get(opts.projectId, pkg);
    if (existing) {
      // Patch nur Felder die explizit gesetzt sind. JSON-Felder werden komplett ersetzt
      // wenn übergeben — wir bewegen die "Merge"-Verantwortung zum Caller.
      const fields: string[] = [];
      const values: unknown[] = [];
      const setIf = <T>(col: string, val: T | undefined, serialize?: (v: T) => string) => {
        if (val === undefined) return;
        fields.push(`${col} = ?`);
        values.push(serialize ? serialize(val) : val);
      };
      setIf('content', opts.content);
      setIf('draft_content', opts.draftContent);
      setIf('neutral_format', opts.neutralFormat, JSON.stringify);
      setIf('scan_hash', opts.scanHash);
      setIf('content_hash', opts.contentHash);
      setIf('generated_by', opts.generatedBy);
      setIf('generated_at', opts.generatedAt);
      setIf('last_applied_at', opts.lastAppliedAt);
      setIf('drift_score', opts.driftScore);
      setIf('source_scan', opts.sourceScan, (v) => v ? JSON.stringify(v) : '');
      setIf('files_written', opts.filesWritten, JSON.stringify);
      setIf('skill_contributions', opts.skillContributions, JSON.stringify);
      setIf('language', opts.language);
      setIf('inherits_from', opts.inheritsFrom);
      fields.push(`updated_at = ?`);
      values.push(now);
      values.push(opts.projectId, pkg);
      if (fields.length > 1) {
        await this.db.execute(
          `UPDATE agent_conventions SET ${fields.join(', ')} WHERE project_id = ? AND package_path = ?`,
          values,
        );
      }
      return;
    }
    await this.db.execute(
      `INSERT INTO agent_conventions
       (project_id, package_path, content, draft_content, neutral_format, scan_hash, content_hash,
        generated_by, generated_at, last_applied_at, drift_score, source_scan, files_written,
        skill_contributions, language, inherits_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.projectId, pkg,
        opts.content ?? '',
        opts.draftContent ?? null,
        JSON.stringify(opts.neutralFormat ?? { meta: { version: '1', lessonsCount: 0, language: opts.language ?? 'de' }, sections: {}, lessons: [] }),
        opts.scanHash ?? '',
        opts.contentHash ?? '',
        opts.generatedBy ?? 'manual',
        opts.generatedAt ?? null,
        opts.lastAppliedAt ?? null,
        opts.driftScore ?? 0,
        opts.sourceScan ? JSON.stringify(opts.sourceScan) : null,
        JSON.stringify(opts.filesWritten ?? []),
        JSON.stringify(opts.skillContributions ?? {}),
        opts.language ?? 'de',
        opts.inheritsFrom ?? null,
        now, now,
      ],
    );
  }

  async setDriftScore(projectId: string, packagePath: string, score: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE agent_conventions SET drift_score = ?, last_drift_check_at = ?, updated_at = ? WHERE project_id = ? AND package_path = ?`,
      [score, now, now, projectId, packagePath],
    );
  }

  async setDraft(projectId: string, packagePath: string, draftContent: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE agent_conventions SET draft_content = ?, updated_at = ? WHERE project_id = ? AND package_path = ?`,
      [draftContent, now, projectId, packagePath],
    );
  }

  async clearDraft(projectId: string, packagePath: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE agent_conventions SET draft_content = NULL, updated_at = ? WHERE project_id = ? AND package_path = ?`,
      [now, projectId, packagePath],
    );
  }

  async deleteByProject(projectId: string): Promise<void> {
    await this.db.execute(`DELETE FROM agent_conventions WHERE project_id = ?`, [projectId]);
  }

  /** Liste aller Projekte mit Conventions für den Drift-Check-Background-Job. */
  async listAllForDriftCheck(): Promise<Array<{ projectId: string; packagePath: string; lastDriftCheckAt: string | null }>> {
    // SQLite hat kein NULLS FIRST default-syntax in älteren Versionen — daher COALESCE-Fallback.
    const rows = await this.db.query(
      `SELECT project_id, package_path, last_drift_check_at FROM agent_conventions ORDER BY COALESCE(last_drift_check_at, '0') ASC`,
      [],
    );
    return rows.map(r => ({
      projectId: r.project_id as string,
      packagePath: (r.package_path as string) ?? '',
      lastDriftCheckAt: (r.last_drift_check_at as string | null) ?? null,
    }));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Lessons — Phase 2 (append + list aus neutralFormat.lessons)
  // ────────────────────────────────────────────────────────────────────────

  /** Append-only — Lessons werden NIE gelöscht (Audit-Trail). Resolved-anyway-Counter via incrementViolation. */
  async appendLesson(projectId: string, packagePath: string, lesson: { text: string; source: string; confidence: number; sessionId?: string }): Promise<string> {
    const conv = await this.get(projectId, packagePath);
    if (!conv) throw new Error(`Conventions not found for ${projectId}/${packagePath}`);
    const id = `lesson-${randomUUID()}`;
    const newLesson = {
      id,
      learnedAt: new Date().toISOString(),
      source: lesson.source as 'merge-gate-failure' | 'plan-fix-loop-resolved' | 'plan-awaiting-user' | 'user-chat-explicit' | 'drift-refresh-detected' | 'cross-project-pattern' | 'scan-update',
      text: lesson.text,
      sessionId: lesson.sessionId,
      confidence: lesson.confidence,
      appliedToMain: false,
      userApproved: null,
      violationsResolvedAnyway: 0,
      manualOverrides: 0,
      healthScore: 1.0,
    };
    conv.neutralFormat.lessons.push(newLesson);
    conv.neutralFormat.meta.lessonsCount = conv.neutralFormat.lessons.length;
    await this.upsert({
      projectId,
      packagePath,
      neutralFormat: conv.neutralFormat,
    });
    return id;
  }

  async markLessonApplied(projectId: string, packagePath: string, lessonId: string): Promise<void> {
    const conv = await this.get(projectId, packagePath);
    if (!conv) return;
    const lesson = conv.neutralFormat.lessons.find(l => l.id === lessonId);
    if (!lesson) return;
    lesson.appliedToMain = true;
    lesson.userApproved = true;
    await this.upsert({ projectId, packagePath, neutralFormat: conv.neutralFormat });
  }

  // ────────────────────────────────────────────────────────────────────────
  // History — Phase 3.2 Audit + Rollback
  // ────────────────────────────────────────────────────────────────────────

  async addHistory(opts: {
    projectId: string;
    packagePath?: string;
    appliedBy: string;
    prevContentHash: string | null;
    newContentHash: string;
    prevContentSnapshot: string | null;
    diffSummary: string | null;
    triggerSource: string;
    triggerSessionId?: string | null;
  }): Promise<string> {
    const id = `chist-${randomUUID()}`;
    await this.db.execute(
      `INSERT INTO agent_conventions_history
       (id, project_id, package_path, applied_at, applied_by, prev_content_hash, new_content_hash,
        prev_content_snapshot, diff_summary, trigger_source, trigger_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, opts.projectId, opts.packagePath ?? '',
        new Date().toISOString(),
        opts.appliedBy,
        opts.prevContentHash,
        opts.newContentHash,
        opts.prevContentSnapshot,
        opts.diffSummary,
        opts.triggerSource,
        opts.triggerSessionId ?? null,
      ],
    );
    return id;
  }

  async listHistory(projectId: string, packagePath = '', limit = 50): Promise<ConventionsHistoryEntry[]> {
    const rows = await this.db.query(
      `SELECT * FROM agent_conventions_history
       WHERE project_id = ? AND package_path = ?
       ORDER BY applied_at DESC LIMIT ?`,
      [projectId, packagePath, limit],
    );
    return rows.map(rowToHistory);
  }

  async markRolledBack(historyId: string, by: string): Promise<void> {
    await this.db.execute(
      `UPDATE agent_conventions_history SET rolled_back_at = ?, rolled_back_by = ? WHERE id = ?`,
      [new Date().toISOString(), by, historyId],
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cross-Project Patterns — Phase 3.3
  // ────────────────────────────────────────────────────────────────────────

  async upsertPattern(opts: {
    masterUserId: string;
    patternText: string;
    section: ConventionsSection;
    category: string;
    frameworkTags: string[];
    confidence: number;
    embeddingId?: string | null;
  }): Promise<ConventionPattern> {
    const existing = await this.db.queryOne(
      `SELECT * FROM convention_patterns WHERE master_user_id = ? AND pattern_text = ? AND retired_at IS NULL LIMIT 1`,
      [opts.masterUserId, opts.patternText],
    );
    const now = new Date().toISOString();
    if (existing) {
      const cur = rowToPattern(existing);
      await this.db.execute(
        `UPDATE convention_patterns
         SET occurrence_count = occurrence_count + 1,
             last_observed_at = ?,
             confidence = ?,
             framework_tags = ?
         WHERE id = ?`,
        [now, Math.max(cur.confidence, opts.confidence), JSON.stringify(Array.from(new Set([...cur.frameworkTags, ...opts.frameworkTags]))), cur.id],
      );
      return { ...cur, occurrenceCount: cur.occurrenceCount + 1, lastObservedAt: now };
    }
    const id = `cpat-${randomUUID()}`;
    await this.db.execute(
      `INSERT INTO convention_patterns
       (id, master_user_id, pattern_text, pattern_section, category, framework_tags,
        occurrence_count, applies_to_count, confidence, embedding_id,
        first_observed_at, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
      [id, opts.masterUserId, opts.patternText, opts.section, opts.category,
       JSON.stringify(opts.frameworkTags), opts.confidence,
       opts.embeddingId ?? null, now, now],
    );
    return {
      id, masterUserId: opts.masterUserId, patternText: opts.patternText,
      patternSection: opts.section, category: opts.category,
      frameworkTags: opts.frameworkTags, occurrenceCount: 1, appliesToCount: 0,
      confidence: opts.confidence, embeddingId: opts.embeddingId ?? null,
      firstObservedAt: now, lastObservedAt: now, retiredAt: null,
    };
  }

  async linkPatternSource(patternId: string, projectId: string, lessonId: string): Promise<void> {
    await this.db.execute(
      `INSERT OR IGNORE INTO convention_pattern_sources (pattern_id, project_id, lesson_id, added_at) VALUES (?, ?, ?, ?)`,
      [patternId, projectId, lessonId, new Date().toISOString()],
    ).catch(async () => {
      // PG hat kein "INSERT OR IGNORE" — Fallback mit ON CONFLICT DO NOTHING.
      await this.db.execute(
        `INSERT INTO convention_pattern_sources (pattern_id, project_id, lesson_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [patternId, projectId, lessonId, new Date().toISOString()],
      ).catch(() => { /* duplicate, ok */ });
    });
  }

  async listPatterns(masterUserId: string, opts?: { framework?: string; minOccurrence?: number; limit?: number }): Promise<ConventionPattern[]> {
    const conditions: string[] = ['master_user_id = ?', 'retired_at IS NULL'];
    const values: unknown[] = [masterUserId];
    if (opts?.minOccurrence) {
      conditions.push('occurrence_count >= ?');
      values.push(opts.minOccurrence);
    }
    const sql = `SELECT * FROM convention_patterns WHERE ${conditions.join(' AND ')} ORDER BY occurrence_count DESC, last_observed_at DESC LIMIT ?`;
    values.push(opts?.limit ?? 100);
    let rows = await this.db.query(sql, values);
    if (opts?.framework) {
      rows = rows.filter(r => parseJson<string[]>(r.framework_tags, []).includes(opts.framework!));
    }
    return rows.map(rowToPattern);
  }

  async incrementPatternAppliedCount(patternId: string): Promise<void> {
    await this.db.execute(
      `UPDATE convention_patterns SET applies_to_count = applies_to_count + 1 WHERE id = ?`,
      [patternId],
    );
  }

  async retirePattern(patternId: string): Promise<void> {
    await this.db.execute(
      `UPDATE convention_patterns SET retired_at = ? WHERE id = ?`,
      [new Date().toISOString(), patternId],
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Violations — Phase 4.2 Inverse Learning
  // ────────────────────────────────────────────────────────────────────────

  async recordViolation(opts: {
    projectId: string;
    packagePath?: string;
    section: ConventionsSection;
    excerpt: string;
    sessionId?: string;
    resolvedAnyway?: boolean;
    manualOverride?: boolean;
    detectionSource: string;
  }): Promise<string> {
    const id = `cvio-${randomUUID()}`;
    await this.db.execute(
      `INSERT INTO convention_violations
       (id, project_id, package_path, convention_section, convention_excerpt, session_id,
        violated_at, resolved_anyway, manual_override, detection_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, opts.projectId, opts.packagePath ?? '',
        opts.section, opts.excerpt.slice(0, 500),
        opts.sessionId ?? null,
        new Date().toISOString(),
        opts.resolvedAnyway ? 1 : 0,
        opts.manualOverride ? 1 : 0,
        opts.detectionSource,
      ],
    );
    return id;
  }

  async listViolations(projectId: string, packagePath = '', sinceIso?: string): Promise<ConventionViolation[]> {
    const conditions: string[] = ['project_id = ?', 'package_path = ?'];
    const values: unknown[] = [projectId, packagePath];
    if (sinceIso) {
      conditions.push('violated_at >= ?');
      values.push(sinceIso);
    }
    const rows = await this.db.query(
      `SELECT * FROM convention_violations WHERE ${conditions.join(' AND ')} ORDER BY violated_at DESC LIMIT 500`,
      values,
    );
    return rows.map(rowToViolation);
  }

  /** Aggregierte Health-Stats pro Section (für 4.2 Inverse Learning Suggestions). */
  async getSectionHealthStats(projectId: string, packagePath = '', sinceIso?: string): Promise<Array<{ section: string; violations: number; resolvedAnyway: number; manualOverrides: number; healthScore: number }>> {
    const conditions: string[] = ['project_id = ?', 'package_path = ?'];
    const values: unknown[] = [projectId, packagePath];
    if (sinceIso) {
      conditions.push('violated_at >= ?');
      values.push(sinceIso);
    }
    const rows = await this.db.query(
      `SELECT convention_section as section,
              COUNT(*) as total,
              SUM(resolved_anyway) as resolved,
              SUM(manual_override) as overrides
       FROM convention_violations
       WHERE ${conditions.join(' AND ')}
       GROUP BY convention_section`,
      values,
    );
    return rows.map(r => {
      const total = Number((r as { total: number }).total ?? 0);
      const resolved = Number((r as { resolved: number }).resolved ?? 0);
      const overrides = Number((r as { overrides: number }).overrides ?? 0);
      // Health: 1.0 = perfekt, 0.0 = jede Lesson wird verletzt UND geht trotzdem durch
      // Niedrig wenn viele resolved-anyway → Convention ist möglicherweise nicht nötig
      const violationRate = total > 0 ? (resolved + overrides) / total : 0;
      const healthScore = Math.max(0, 1 - violationRate);
      return {
        section: r.section as string,
        violations: total,
        resolvedAnyway: resolved,
        manualOverrides: overrides,
        healthScore,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test-Runs — Phase 4.6
  // ────────────────────────────────────────────────────────────────────────

  async recordTestRun(opts: {
    projectId?: string | null;
    conventionsVersionHash: string;
    canonicalTaskId: string;
    stack: string;
    withConventions: boolean;
    outcomePassed: boolean;
    outcomeDetails?: string;
    fixAttempts?: number;
    durationMs?: number;
    costUsd?: number;
  }): Promise<string> {
    const id = `ctest-${randomUUID()}`;
    await this.db.execute(
      `INSERT INTO convention_test_runs
       (id, project_id, conventions_version_hash, canonical_task_id, stack,
        with_conventions, outcome_passed, outcome_details, fix_attempts,
        duration_ms, cost_usd, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, opts.projectId ?? null, opts.conventionsVersionHash, opts.canonicalTaskId, opts.stack,
        opts.withConventions ? 1 : 0,
        opts.outcomePassed ? 1 : 0,
        opts.outcomeDetails ?? null,
        opts.fixAttempts ?? 0,
        opts.durationMs ?? 0,
        opts.costUsd ?? 0,
        new Date().toISOString(),
      ],
    );
    return id;
  }

  async listTestRuns(opts: { projectId?: string; taskId?: string; limit?: number }): Promise<ConventionTestRun[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (opts.projectId) { conditions.push('project_id = ?'); values.push(opts.projectId); }
    if (opts.taskId) { conditions.push('canonical_task_id = ?'); values.push(opts.taskId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(opts.limit ?? 100);
    const rows = await this.db.query(
      `SELECT * FROM convention_test_runs ${where} ORDER BY ran_at DESC LIMIT ?`,
      values,
    );
    return rows.map(rowToTestRun);
  }
}
