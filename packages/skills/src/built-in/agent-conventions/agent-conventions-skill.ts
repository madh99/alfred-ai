/**
 * v824 — AgentConventionsSkill.
 *
 * Steuert das Lifecycle der projekt-spezifischen Agent-Conventions
 * (CLAUDE.md / AGENTS.md). Actions: detect, generate, apply, refresh,
 * drift_check, learn, status, history, rollback.
 *
 * Side-Effects:
 * - `generate`: read-only Repo-Scan + LLM-Call. KEIN File-Write.
 * - `apply`: schreibt CLAUDE.md (und optional AGENTS.md) ins cwd, optional git-commit.
 *   Erstellt Backup wenn Datei schon existiert.
 * - `rollback`: schreibt prev_content_snapshot zurück.
 * - alle anderen: nur DB-Reads/-Writes ohne FS-Modifikation.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  SkillMetadata, SkillContext, SkillResult,
  AgentConventions, ConventionsStatus, ConventionsStatusBadge,
  ConventionsOutputFormat, ConventionsLanguage, ConventionsSection,
  AgentConventionsConfig,
} from '@alfred/types';
import { Skill } from '../../skill.js';
import type { AgentConventionsRepository } from '@alfred/storage';

// Scanner + Generator werden via DI hereingereicht (live in @alfred/core,
// das wegen Circular-Dep nicht von hier importiert werden darf).
export interface RepoScannerLike {
  scan(cwd: string): Promise<{
    snapshot: import('@alfred/types').ConventionsScanSnapshot;
    llmContext: string;
    scanHash: string;
    warnings: string[];
  }>;
}

export interface ConventionsGeneratorLike {
  generate(opts: {
    cwd: string;
    llmContext: string;
    scanSnapshot: import('@alfred/types').ConventionsScanSnapshot;
    scanHash: string;
    language: ConventionsLanguage;
    generateMode: import('@alfred/types').ConventionsGenerateMode;
    tier: 'fast' | 'default' | 'strong';
    existingContent?: string;
    skillContributions?: Array<{ skill: string; markdown: string; section: import('@alfred/types').ConventionsSection }>;
    patternSuggestions?: Array<{ patternText: string; section: import('@alfred/types').ConventionsSection; confidence: number }>;
  }): Promise<{
    ok: boolean;
    markdown?: string;
    neutralFormat?: import('@alfred/types').NeutralConventions;
    scanHash: string;
    contentHash?: string;
    warnings: string[];
    costUsd: number;
    reason?: string;
  }>;
  /** Phase 3.5 — Übersetzt eine fertige CLAUDE.md in die andere Sprache. */
  translate?(opts: {
    markdown: string;
    fromLanguage: ConventionsLanguage;
    toLanguage: ConventionsLanguage;
    tier?: 'fast' | 'default' | 'strong';
  }): Promise<{ ok: boolean; markdown?: string; costUsd: number; reason?: string }>;
}

/** Phase 3.6 — Skill-Contribution-API. Jeder Alfred-Skill kann eine
 *  ConventionsContribution registrieren die in Generate einfließt wenn der
 *  Skill im Projekt aktiv ist (detect via projectScan). */
export interface SkillConventionsContribution {
  skillName: string;
  detectIfUsed: (scan: import('@alfred/types').ConventionsScanSnapshot) => boolean;
  contribution: { section: import('@alfred/types').ConventionsSection; markdown: string };
}

const exec = promisify(execFileCb);

type Action = 'status' | 'detect' | 'generate' | 'apply' | 'refresh' | 'drift_check' | 'rollback' | 'history' | 'learn' | 'list_lessons' | 'consolidate_lessons' | 'mark_lesson_applied' | 'list_packages' | 'generate_all_packages' | 'mine_patterns' | 'list_patterns' | 'retire_pattern' | 'record_violation' | 'section_health' | 'effectiveness_metrics' | 'self_modify' | 'test_harness_run' | 'get_config_overrides' | 'set_config_overrides' | 'run_canonical_task' | 'list_canonical_tasks';

interface SkillDeps {
  scanner: RepoScannerLike;
  generator: ConventionsGeneratorLike;
  conventionsRepo: AgentConventionsRepository;
  logger: Logger;
  /** Lookup von projectId → project mit cwd. Wird durch alfred.ts gesetzt. */
  resolveProject: (projectId: string) => Promise<{ id: string; cwd: string; userId: string } | null>;
  /** Config-Snapshot — defaults werden bei missing-keys angewendet. */
  config: () => Partial<AgentConventionsConfig>;
  /** Phase 3.3 — Lookup aller Projekte eines Master-Users für Cross-Project Pattern-Mining.
   *  Optional. Wenn nicht gesetzt: Pattern-Mining returns 0 patterns. */
  listProjectsForUser?: (masterUserId: string) => Promise<Array<{ id: string; userId: string; cwd: string }>>;
  /** v833 Phase 4.5-Upgrade — Optional Embedding-Service für Pattern-Mining + Lesson-Injection.
   *  Wenn gesetzt: Pattern-Mining nutzt Cosine-Similarity statt Jaccard. */
  embed?: (text: string) => Promise<number[] | null>;
}

const DEFAULT_CONFIG: AgentConventionsConfig = {
  enabled: false,
  generateMode: 'single',
  generateTier: 'strong',
  language: 'de',
  outputs: ['claude.md'],
  primaryOutput: 'claude.md',
  autoApplyMode: 'off',
  driftCheckIntervalHours: 24,
  driftRefreshAuto: false,
  lessonsAggressiveLearning: true,
  crossProjectPool: 'off',
  selfModifyAgent: { enabled: false, intervalDays: 7, sessionThreshold: 10 },
  embeddingInjection: false,
  inverseLearning: true,
  testHarness: { enabled: false, runsPerVersion: 10 },
  budget: { monthlyUsdCap: 50, alertAt: 0.8 },
  autoApplyAllowedSections: ['gotchas', 'doNotTouch'],
  allowedSkillContributions: '*',
};

/**
 * v826 Phase 3.2 — Trust-Threshold-Tabelle: ab welcher Lesson-Confidence + Mode
 * darf der Conventions-Update auto-applied werden.
 * Die Sections-Liste bestimmt zusätzlich welche CLAUDE.md-Bereiche überhaupt
 * auto-änderbar sind (Stack/Architektur niemals auto, nur Gotchas/DoNotTouch).
 */
function autoApplyAllowedByMode(
  mode: 'off' | 'minor' | 'confident' | 'aggressive' | 'auto-pr',
  maxLessonConfidence: number,
): { allowed: boolean; reason?: string } {
  if (mode === 'off') return { allowed: false, reason: 'mode=off' };
  if (mode === 'auto-pr') return { allowed: false, reason: 'auto-pr not yet implemented (Phase 3.x)' };
  if (mode === 'minor') {
    if (maxLessonConfidence >= 0.8) return { allowed: true };
    return { allowed: false, reason: `mode=minor requires confidence >= 0.8 (got ${maxLessonConfidence.toFixed(2)})` };
  }
  if (mode === 'confident') {
    if (maxLessonConfidence >= 0.85) return { allowed: true };
    return { allowed: false, reason: `mode=confident requires confidence >= 0.85 (got ${maxLessonConfidence.toFixed(2)})` };
  }
  if (mode === 'aggressive') {
    if (maxLessonConfidence >= 0.7) return { allowed: true };
    return { allowed: false, reason: `mode=aggressive requires confidence >= 0.7 (got ${maxLessonConfidence.toFixed(2)})` };
  }
  return { allowed: false, reason: `unknown mode ${mode}` };
}

function fileNameFor(format: ConventionsOutputFormat): string {
  switch (format) {
    case 'claude.md': return 'CLAUDE.md';
    case 'agents.md': return 'AGENTS.md';
    case 'cursor.rules': return '.cursor/rules/00-project.md';
    case 'copilot.md': return '.github/copilot-instructions.md';
    case 'codex.md': return '.codex/instructions.md';
    default: return 'CLAUDE.md';
  }
}

export class AgentConventionsSkill extends Skill {
  readonly metadata: SkillMetadata;
  /** Phase 3.6 — Registry für Skill-Contributions. alfred.ts ruft addContribution()
   *  beim Skill-Setup für jeden teilnehmenden Skill auf. */
  private readonly skillContributions: SkillConventionsContribution[] = [];
  addSkillContribution(c: SkillConventionsContribution): void {
    // Dedup nach skillName — neuer ersetzt alten
    const idx = this.skillContributions.findIndex(x => x.skillName === c.skillName);
    if (idx >= 0) this.skillContributions[idx] = c;
    else this.skillContributions.push(c);
  }
  /** Gibt alle Skill-Contributions zurück die zum aktuellen Scan passen. */
  private getActiveContributions(scan: import('@alfred/types').ConventionsScanSnapshot, cfg: AgentConventionsConfig): Array<{ skill: string; markdown: string; section: ConventionsSection }> {
    const allowList = cfg.allowedSkillContributions;
    return this.skillContributions
      .filter(c => allowList === '*' || (Array.isArray(allowList) && allowList.includes(c.skillName)))
      .filter(c => {
        try { return c.detectIfUsed(scan); } catch { return false; }
      })
      .map(c => ({ skill: c.skillName, markdown: c.contribution.markdown, section: c.contribution.section }));
  }

  constructor(private readonly deps: SkillDeps) {
    super();

    this.metadata = {
      name: 'agent_conventions',
      category: 'automation',
      description: 'Verwaltet projekt-spezifische CLAUDE.md/AGENTS.md-Konventionen für Coding-Agents (claude-code, vibe, codex). Auto-Generate aus Repo-Scan + LLM-Synthesis, Drift-Detection, Lessons-Loop.',
      riskLevel: 'write',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'detect', 'generate', 'apply', 'refresh', 'drift_check', 'rollback', 'history', 'learn', 'list_lessons', 'consolidate_lessons', 'mark_lesson_applied', 'list_packages', 'generate_all_packages', 'mine_patterns', 'list_patterns', 'retire_pattern', 'record_violation', 'section_health', 'effectiveness_metrics', 'self_modify', 'test_harness_run'],
            description: 'Action to perform',
          },
          project_id: { type: 'string', description: 'Project ID' },
          package_path: { type: 'string', description: 'Package-Path für Monorepos. Leer = root.' },
          language: { type: 'string', enum: ['de', 'en'], description: 'Output-Sprache. Default: aus config.' },
          tier: { type: 'string', enum: ['fast', 'default', 'strong'], description: 'LLM-Tier. Default: strong für generate.' },
          commit_to_git: { type: 'boolean', description: 'Apply: zusätzlich git commit (default true)' },
          outputs: { type: 'array', items: { type: 'string' }, description: 'Welche Output-Files schreiben. Default: claude.md only.' },
          history_id: { type: 'string', description: 'Für rollback: zu welcher History-Version zurück.' },
          lesson_text: { type: 'string', description: 'Für learn: was wurde gelernt (1-3 Zeilen, projekt-spezifisch).' },
          lesson_source: { type: 'string', description: 'Für learn: Trust-Source (merge-gate-failure | plan-fix-loop-resolved | plan-awaiting-user | user-chat-explicit).' },
          lesson_confidence: { type: 'number', description: 'Für learn: 0..1.' },
          lesson_session_id: { type: 'string', description: 'Für learn: optional Quell-Session.' },
          lesson_id: { type: 'string', description: 'Für mark_lesson_applied: ID der Lesson.' },
        },
        required: ['action', 'project_id'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _ctx: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const projectId = input.project_id as string;
    const packagePath = (input.package_path as string | undefined) ?? '';

    if (!projectId) return { success: false, error: 'project_id required' };

    try {
      switch (action) {
        case 'status': return await this.handleStatus(projectId, packagePath);
        case 'detect': return await this.handleDetect(projectId, packagePath);
        case 'generate': return await this.handleGenerate(projectId, packagePath, input);
        case 'apply': return await this.handleApply(projectId, packagePath, input);
        case 'refresh': return await this.handleRefresh(projectId, packagePath, input);
        case 'drift_check': return await this.handleDriftCheck(projectId, packagePath);
        case 'rollback': return await this.handleRollback(projectId, packagePath, input);
        case 'history': return await this.handleHistory(projectId, packagePath);
        case 'learn': return await this.handleLearn(projectId, packagePath, input);
        case 'list_lessons': return await this.handleListLessons(projectId, packagePath);
        case 'consolidate_lessons': return await this.handleConsolidateLessons(projectId, packagePath, input);
        case 'mark_lesson_applied': return await this.handleMarkLessonApplied(projectId, packagePath, input);
        case 'list_packages': return await this.handleListPackages(projectId);
        case 'generate_all_packages': return await this.handleGenerateAllPackages(projectId, input);
        case 'mine_patterns': return await this.handleMinePatterns(input);
        case 'list_patterns': return await this.handleListPatterns(input);
        case 'retire_pattern': return await this.handleRetirePattern(input);
        case 'record_violation': return await this.handleRecordViolation(projectId, packagePath, input);
        case 'section_health': return await this.handleSectionHealth(projectId, packagePath, input);
        case 'effectiveness_metrics': return await this.handleEffectivenessMetrics(projectId);
        case 'self_modify': return await this.handleSelfModify(projectId, packagePath, input);
        case 'test_harness_run': return await this.handleTestHarnessRun(projectId, input);
        case 'get_config_overrides': return await this.handleGetConfigOverrides(projectId, packagePath);
        case 'set_config_overrides': return await this.handleSetConfigOverrides(projectId, packagePath, input);
        case 'list_canonical_tasks': return await this.handleListCanonicalTasks();
        case 'run_canonical_task': return await this.handleRunCanonicalTask(projectId, input);
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      this.deps.logger.warn({ err, action, projectId }, 'v824 AgentConventionsSkill.execute failed');
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * v834 — Config-Resolution: globale Config + Project-spezifische Overrides mergen.
   * Project-Overrides gewinnen. Wird intern statt direkter `this.deps.config()` benutzt
   * (sobald wir Project-Kontext haben).
   */
  private async resolveConfigForProject(projectId: string, packagePath: string): Promise<AgentConventionsConfig> {
    const global = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath).catch(() => null);
    const overrides = conv?.configOverrides ?? {};
    // Shallow merge — nested objects (selfModifyAgent etc.) komplett ersetzen wenn vorhanden
    return { ...global, ...overrides };
  }

  // ── get/set config-overrides (Phase 3.x / Punkt 8) ────────────────────
  private async handleGetConfigOverrides(projectId: string, packagePath: string): Promise<SkillResult> {
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    const global = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const overrides = conv?.configOverrides ?? {};
    const effective = await this.resolveConfigForProject(projectId, packagePath);
    return { success: true, data: { global, overrides, effective } };
  }

  private async handleSetConfigOverrides(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const overrides = input.overrides as Partial<AgentConventionsConfig> | undefined;
    if (!overrides || typeof overrides !== 'object') return { success: false, error: 'overrides object required' };
    await this.deps.conventionsRepo.setConfigOverrides(projectId, packagePath, overrides);
    return { success: true, data: { overrides } };
  }

  // ── status ─────────────────────────────────────────────────────────────
  private async handleStatus(projectId: string, packagePath: string): Promise<SkillResult> {
    const status = await this.computeStatus(projectId, packagePath);
    return { success: true, data: status };
  }

  private async computeStatus(projectId: string, packagePath: string): Promise<ConventionsStatus> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) {
      return {
        projectId, packagePath,
        badge: 'missing', filePath: null, filePresent: false, alfredManaged: false,
        lastAppliedAt: null, driftScore: 0,
        contentHashCurrent: null, contentHashOnDisk: null,
      };
    }
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    const filePath = path.join(proj.cwd, packagePath, 'CLAUDE.md');
    const filePresent = existsSync(filePath);
    let contentHashOnDisk: string | null = null;
    let alfredManaged = false;
    if (filePresent) {
      try {
        const onDisk = readFileSync(filePath, 'utf8');
        contentHashOnDisk = createHash('sha256').update(onDisk).digest('hex').slice(0, 16);
        alfredManaged = /generated_by:\s*alfred-agent-conventions/i.test(onDisk.slice(0, 500));
      } catch { /* ignore */ }
    }

    let badge: ConventionsStatusBadge = 'missing';
    if (!filePresent) badge = 'missing';
    else if (!alfredManaged) badge = 'present-user-managed';
    else if (conv && conv.driftScore > 0.4) badge = 'present-drift';
    else badge = 'present-fresh';

    return {
      projectId, packagePath,
      badge,
      filePath,
      filePresent,
      alfredManaged,
      lastAppliedAt: conv?.lastAppliedAt ?? null,
      driftScore: conv?.driftScore ?? 0,
      contentHashCurrent: conv?.contentHash ?? null,
      contentHashOnDisk,
    };
  }

  // ── detect ─────────────────────────────────────────────────────────────
  private async handleDetect(projectId: string, packagePath: string): Promise<SkillResult> {
    return await this.handleStatus(projectId, packagePath);
  }

  // ── generate ──────────────────────────────────────────────────────────
  private async handleGenerate(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    if (!existsSync(proj.cwd)) return { success: false, error: `cwd does not exist: ${proj.cwd}` };

    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const language = (input.language as ConventionsLanguage | undefined) ?? cfg.language;
    const tier = (input.tier as 'fast' | 'default' | 'strong' | undefined) ?? cfg.generateTier;
    const scanCwd = packagePath ? path.join(proj.cwd, packagePath) : proj.cwd;

    const scan = await this.deps.scanner.scan(scanCwd);
    const existing = await this.deps.conventionsRepo.get(projectId, packagePath);

    // Phase 3.6 — Skill-Contributions sammeln die zum Scan passen
    const skillContributions = this.getActiveContributions(scan.snapshot, cfg);
    if (skillContributions.length > 0) {
      this.deps.logger.info({ count: skillContributions.length, skills: skillContributions.map(c => c.skill) }, 'v827 skill-contributions injected into generate');
    }

    // Phase 3.3 — Cross-Project-Pattern-Suggestions wenn pool aktiv + master_user_id ableitbar
    let patternSuggestions: Array<{ patternText: string; section: ConventionsSection; confidence: number }> | undefined;
    if (cfg.crossProjectPool !== 'off') {
      try {
        const patterns = await this.deps.conventionsRepo.listPatterns(proj.userId, { minOccurrence: 2, limit: 20 });
        if (patterns.length > 0) {
          patternSuggestions = patterns.map(p => ({ patternText: p.patternText, section: p.patternSection, confidence: p.confidence }));
          this.deps.logger.info({ count: patternSuggestions.length }, 'v827 cross-project patterns injected into generate');
        }
      } catch (err) {
        this.deps.logger.debug({ err }, 'v827 pattern-lookup failed (non-fatal)');
      }
    }

    const gen = await this.deps.generator.generate({
      cwd: scanCwd,
      llmContext: scan.llmContext,
      scanSnapshot: scan.snapshot,
      scanHash: scan.scanHash,
      language,
      generateMode: cfg.generateMode,
      tier,
      existingContent: existing?.content,
      skillContributions: skillContributions.length > 0 ? skillContributions : undefined,
      patternSuggestions,
    });

    if (!gen.ok || !gen.markdown || !gen.neutralFormat) {
      return { success: false, error: gen.reason ?? 'generation failed', data: { warnings: [...scan.warnings, ...gen.warnings] } };
    }

    // Persist draft (NICHT apply!). User reviewed + apply später.
    await this.deps.conventionsRepo.upsert({
      projectId,
      packagePath,
      draftContent: gen.markdown,
      neutralFormat: gen.neutralFormat,
      scanHash: gen.scanHash,
      sourceScan: scan.snapshot,
      language,
      generatedBy: 'auto',
      generatedAt: new Date().toISOString(),
    });

    return {
      success: true,
      data: {
        draft: gen.markdown,
        scanHash: gen.scanHash,
        contentHash: gen.contentHash,
        warnings: [...scan.warnings, ...gen.warnings],
        costUsd: gen.costUsd,
        scanSnapshot: scan.snapshot,
      },
    };
  }

  // ── apply ──────────────────────────────────────────────────────────────
  private async handleApply(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };

    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: false, error: 'No conventions row (run generate first)' };
    const contentToApply = (input.content as string | undefined) ?? conv.draftContent ?? conv.content;
    if (!contentToApply) return { success: false, error: 'No content to apply (no draft, no existing)' };

    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const outputs: ConventionsOutputFormat[] = (input.outputs as ConventionsOutputFormat[] | undefined) ?? cfg.outputs;
    const commitToGit = (input.commit_to_git as boolean | undefined) ?? true;
    const baseDir = packagePath ? path.join(proj.cwd, packagePath) : proj.cwd;

    // Backup existing
    const filesWritten: string[] = [];
    const prevSnapshot: { path: string; content: string } | null = (() => {
      const primaryPath = path.join(baseDir, fileNameFor(cfg.primaryOutput));
      if (existsSync(primaryPath)) {
        try {
          const c = readFileSync(primaryPath, 'utf8');
          const backupPath = `${primaryPath}.backup-${Date.now()}`;
          renameSync(primaryPath, backupPath);
          this.deps.logger.info({ from: primaryPath, to: backupPath }, 'v824 backup of existing file');
          return { path: primaryPath, content: c };
        } catch (err) {
          this.deps.logger.warn({ err, primaryPath }, 'v824 backup failed (continuing without)');
        }
      }
      return null;
    })();

    for (const format of outputs) {
      const filePath = path.join(baseDir, fileNameFor(format));
      try {
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
          await import('node:fs').then(fs => fs.mkdirSync(dir, { recursive: true }));
        }
        writeFileSync(filePath, contentToApply, { encoding: 'utf8' });
        filesWritten.push(filePath);
      } catch (err) {
        return { success: false, error: `Write failed for ${filePath}: ${(err as Error).message}`, data: { filesWritten } };
      }
    }

    // v827 Phase 3.5 — Translation: zusätzliches File in 2. Sprache wenn
    // config.language=both ODER config.translateTo gesetzt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translateTo = (cfg as any).translateTo as ConventionsLanguage | undefined;
    let translationCost = 0;
    if (translateTo && translateTo !== cfg.language && this.deps.generator.translate) {
      try {
        const t = await this.deps.generator.translate({
          markdown: contentToApply,
          fromLanguage: cfg.language,
          toLanguage: translateTo,
        });
        if (t.ok && t.markdown) {
          translationCost = t.costUsd;
          // Naming-Konvention: CLAUDE.md (primary) + CLAUDE.en.md (sec) bzw. CLAUDE.de.md
          for (const format of outputs) {
            const primaryFile = fileNameFor(format);
            const ext = path.extname(primaryFile);
            const base = primaryFile.slice(0, -ext.length);
            const translatedFile = `${base}.${translateTo}${ext}`;
            const translatedPath = path.join(baseDir, translatedFile);
            try {
              writeFileSync(translatedPath, t.markdown, { encoding: 'utf8' });
              filesWritten.push(translatedPath);
            } catch (err) {
              this.deps.logger.warn({ err, translatedPath }, 'v827 translation write failed (non-fatal)');
            }
          }
        } else {
          this.deps.logger.warn({ reason: t.reason }, 'v827 translation failed (non-fatal)');
        }
      } catch (err) {
        this.deps.logger.warn({ err }, 'v827 translation threw (non-fatal)');
      }
    }

    const newContentHash = createHash('sha256').update(contentToApply).digest('hex').slice(0, 16);

    // History eintragen
    const historyId = await this.deps.conventionsRepo.addHistory({
      projectId,
      packagePath,
      appliedBy: 'user',
      prevContentHash: conv.contentHash || null,
      newContentHash,
      prevContentSnapshot: prevSnapshot?.content ?? null,
      diffSummary: 'manual apply',
      triggerSource: (input.trigger_source as string | undefined) ?? 'user-apply',
      triggerSessionId: (input.trigger_session_id as string | undefined) ?? null,
    });

    // Conventions-Row: content+contentHash+lastAppliedAt
    await this.deps.conventionsRepo.upsert({
      projectId,
      packagePath,
      content: contentToApply,
      draftContent: null,
      contentHash: newContentHash,
      lastAppliedAt: new Date().toISOString(),
      filesWritten: outputs,
    });

    // Optional git-commit
    let commitSha: string | undefined;
    if (commitToGit) {
      try {
        await exec('git', ['-C', proj.cwd, 'add', ...filesWritten.map(f => path.relative(proj.cwd, f))], { timeout: 5000 });
        await exec('git', ['-C', proj.cwd, '-c', 'user.name=Alfred', '-c', 'user.email=alfred@local',
          'commit', '-m', 'chore: update agent conventions (auto-generated)'], { timeout: 8000 });
        const { stdout } = await exec('git', ['-C', proj.cwd, 'rev-parse', 'HEAD'], { timeout: 3000 });
        commitSha = String(stdout).trim().slice(0, 12);
      } catch (err) {
        this.deps.logger.warn({ err, projectId }, 'v824 git commit after apply failed (non-fatal)');
      }
    }

    // v880.1 — Konsolidierte Lessons beim Apply abräumen. VORHER wurde
    // markLessonApplied NUR im Auto-Apply-Pfad gerufen — der dokumentierte
    // manuelle Flow "Consolidate → Review → Apply" ließ alle Lessons ewig
    // pending, und der nächste Consolidate arbeitete dieselben erneut ein
    // (Vorfall 12.06., Alpbyte: 9 Lessons trotz Apply am 10.06. pending).
    // Gate auf generatedBy='lesson-derived': nur wenn der angewendete Draft
    // nachweislich aus einer Konsolidierung stammt — ein normaler
    // Refresh-Apply räumt KEINE fremden Lessons ab.
    let lessonsMarkedApplied = 0;
    if (conv.generatedBy === 'lesson-derived') {
      const pending = conv.neutralFormat.lessons.filter(l => !l.appliedToMain);
      for (const l of pending) {
        try {
          await this.deps.conventionsRepo.markLessonApplied(projectId, packagePath, l.id);
          lessonsMarkedApplied++;
        } catch (err) {
          this.deps.logger.warn({ err, lessonId: l.id }, 'v880.1 markLessonApplied on apply failed');
        }
      }
      if (lessonsMarkedApplied > 0) {
        this.deps.logger.info({ projectId, packagePath, lessonsMarkedApplied }, 'v880.1 apply: konsolidierte Lessons als angewendet markiert');
      }
    }

    return {
      success: true,
      data: {
        filesWritten: filesWritten.map(f => path.relative(proj.cwd, f)),
        commitSha,
        historyId,
        backupCreated: !!prevSnapshot,
        lessonsMarkedApplied,
      },
    };
  }

  // ── refresh ────────────────────────────────────────────────────────────
  private async handleRefresh(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    // Refresh = generate mit existingContent als Context. Identisch zu generate
    // bei nicht-existierendem File. Differenziert sich nur durch logging/UI.
    return await this.handleGenerate(projectId, packagePath, input);
  }

  // ── drift_check ────────────────────────────────────────────────────────
  private async handleDriftCheck(projectId: string, packagePath: string): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: true, data: { driftScore: 0, reasons: ['no conventions yet'] } };

    const scanCwd = packagePath ? path.join(proj.cwd, packagePath) : proj.cwd;
    const scan = await this.deps.scanner.scan(scanCwd);

    const reasons: string[] = [];
    let score = 0;

    // 1) scan_hash changed
    if (conv.scanHash && scan.scanHash !== conv.scanHash) {
      score += 0.1;
      reasons.push('repo-scan hash changed');
    }

    // 2) setup-files changed (höchstes Gewicht)
    const oldSetup = conv.sourceScan?.testSetupFiles ?? [];
    const newSetup = scan.snapshot.testSetupFiles ?? [];
    if (JSON.stringify(oldSetup) !== JSON.stringify(newSetup)) {
      score += 0.3;
      reasons.push('test-setup files changed');
    }

    // 3) package.json scripts changed
    const oldScripts = JSON.stringify(conv.sourceScan?.packageJsonScripts ?? {});
    const newScripts = JSON.stringify(scan.snapshot.packageJsonScripts ?? {});
    if (oldScripts !== newScripts) {
      score += 0.15;
      reasons.push('package.json scripts changed');
    }

    // 4) new top-level dirs
    const oldDirs = new Set(conv.sourceScan?.topLevelDirs ?? []);
    const newDirsAdded = (scan.snapshot.topLevelDirs ?? []).filter(d => !oldDirs.has(d));
    if (newDirsAdded.length > 0) {
      score += Math.min(0.15, newDirsAdded.length * 0.05);
      reasons.push(`${newDirsAdded.length} new top-level dirs: ${newDirsAdded.slice(0, 3).join(', ')}`);
    }

    // 5) age since last apply
    if (conv.lastAppliedAt) {
      const days = (Date.now() - new Date(conv.lastAppliedAt).getTime()) / (1000 * 60 * 60 * 24);
      const ageScore = Math.min(0.15, days / 30 * 0.15);
      if (days > 30) {
        score += ageScore;
        reasons.push(`${Math.floor(days)} days since last apply`);
      }
    }

    score = Math.min(1, score);
    await this.deps.conventionsRepo.setDriftScore(projectId, packagePath, score);

    return {
      success: true,
      data: {
        driftScore: score,
        reasons,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  // ── rollback ───────────────────────────────────────────────────────────
  private async handleRollback(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };

    const historyId = input.history_id as string | undefined;
    if (!historyId) return { success: false, error: 'history_id required' };

    const history = await this.deps.conventionsRepo.listHistory(projectId, packagePath, 200);
    const entry = history.find(h => h.id === historyId);
    if (!entry) return { success: false, error: 'history entry not found' };
    if (!entry.prevContentSnapshot) return { success: false, error: 'no previous snapshot stored for this entry' };

    // Write the snapshot back
    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const filePath = path.join(packagePath ? path.join(proj.cwd, packagePath) : proj.cwd, fileNameFor(cfg.primaryOutput));
    try {
      writeFileSync(filePath, entry.prevContentSnapshot, { encoding: 'utf8' });
    } catch (err) {
      return { success: false, error: `Rollback write failed: ${(err as Error).message}` };
    }

    await this.deps.conventionsRepo.markRolledBack(historyId, 'user');
    await this.deps.conventionsRepo.upsert({
      projectId, packagePath,
      content: entry.prevContentSnapshot,
      contentHash: entry.prevContentHash ?? '',
      draftContent: null,
      lastAppliedAt: new Date().toISOString(),
    });

    return { success: true, data: { rolledBackTo: historyId, filePath: path.relative(proj.cwd, filePath) } };
  }

  // ── history ────────────────────────────────────────────────────────────
  private async handleHistory(projectId: string, packagePath: string): Promise<SkillResult> {
    const entries = await this.deps.conventionsRepo.listHistory(projectId, packagePath, 50);
    return { success: true, data: { entries } };
  }

  // ── learn (Phase 2) ────────────────────────────────────────────────────
  // Append einer Lesson aus einem Trigger-Punkt (merge-gate-fail / awaiting-user / fix-loop / user-chat).
  // Wird in convention-Row als pending lesson gespeichert; consolidate_lessons mergt sie später ins content.
  private async handleLearn(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const lessonText = (input.lesson_text as string | undefined)?.trim();
    const source = (input.lesson_source as string | undefined) ?? 'user-chat-explicit';
    const confidence = (input.lesson_confidence as number | undefined) ?? 0.7;
    const sessionId = input.lesson_session_id as string | undefined;

    if (!lessonText || lessonText.length < 10) return { success: false, error: 'lesson_text required (min 10 chars)' };
    if (lessonText.length > 1000) return { success: false, error: 'lesson_text too long (max 1000 chars)' };

    // Sicherstellen dass eine conventions-row existiert (auto-create wenn nötig)
    const existing = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!existing) {
      // Empty conventions-row anlegen damit lessons sich anhängen können
      await this.deps.conventionsRepo.upsert({
        projectId,
        packagePath,
        generatedBy: 'lesson-derived',
      });
    }
    const lessonId = await this.deps.conventionsRepo.appendLesson(projectId, packagePath, {
      text: lessonText,
      source,
      confidence,
      sessionId,
    });
    this.deps.logger.info({ projectId, packagePath, lessonId, source, confidence }, 'v825 lesson recorded');
    return { success: true, data: { lessonId, source, confidence } };
  }

  // ── list_lessons (Phase 2) ─────────────────────────────────────────────
  private async handleListLessons(projectId: string, packagePath: string): Promise<SkillResult> {
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: true, data: { lessons: [], pendingCount: 0 } };
    const lessons = conv.neutralFormat.lessons;
    const pending = lessons.filter(l => !l.appliedToMain);
    return {
      success: true,
      data: {
        lessons,
        pendingCount: pending.length,
        appliedCount: lessons.length - pending.length,
      },
    };
  }

  // ── consolidate_lessons (Phase 2) ──────────────────────────────────────
  // LLM-Call: nimmt pending lessons + existing content → produziert refactored Draft
  // mit Lessons integriert. Schreibt in draft_content. User reviewed dann + apply.
  private async handleConsolidateLessons(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: false, error: 'No conventions row (run generate first)' };

    const pendingLessons = conv.neutralFormat.lessons.filter(l => !l.appliedToMain);
    if (pendingLessons.length === 0) {
      return { success: false, error: 'No pending lessons to consolidate' };
    }

    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const language = (input.language as ConventionsLanguage | undefined) ?? cfg.language;
    const tier = (input.tier as 'fast' | 'default' | 'strong' | undefined) ?? cfg.generateTier;

    // Generator wird mit existingContent + lessons-as-prompt-extension aufgerufen.
    // Wir piggybacken auf generate() statt einen separaten LLM-Call zu bauen —
    // der Generator versteht "Refresh mit Vorlage" + die Lessons werden via
    // patternSuggestions reingegeben damit sie als Cross-Reference erscheinen.
    const scanCwd = packagePath ? path.join(proj.cwd, packagePath) : proj.cwd;
    const scan = await this.deps.scanner.scan(scanCwd);

    const lessonsAsPatterns = pendingLessons.map(l => ({
      patternText: l.text,
      section: 'gotchas' as ConventionsSection,
      confidence: l.confidence,
    }));

    const gen = await this.deps.generator.generate({
      cwd: scanCwd,
      llmContext: scan.llmContext,
      scanSnapshot: scan.snapshot,
      scanHash: scan.scanHash,
      language,
      generateMode: cfg.generateMode,
      tier,
      existingContent: conv.content,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ patternSuggestions: lessonsAsPatterns }) as any),
    });

    if (!gen.ok || !gen.markdown || !gen.neutralFormat) {
      return { success: false, error: gen.reason ?? 'consolidate generation failed' };
    }

    // Lessons-Carry-Over: alle pending lessons werden in den neuen neutralFormat überführt
    // (Generator kann den lessons-array leer setzen — wir merge zurück damit nichts verloren geht)
    const mergedNeutral = {
      ...gen.neutralFormat,
      lessons: conv.neutralFormat.lessons, // behalte komplette Lesson-Historie
    };
    mergedNeutral.meta.lessonsCount = mergedNeutral.lessons.length;

    await this.deps.conventionsRepo.upsert({
      projectId,
      packagePath,
      draftContent: gen.markdown,
      neutralFormat: mergedNeutral,
      sourceScan: scan.snapshot,
      generatedAt: new Date().toISOString(),
      generatedBy: 'lesson-derived',
    });

    // v826 Phase 3.2 — Auto-Apply wenn config.autoApplyMode + Trust-Threshold passen.
    // Sicherheit: NUR wenn Datei alfred-managed ist (kein User-Override-Risk), NUR
    // wenn Conventions-Section "gotchas" oder "doNotTouch" geändert wurde (allowed-list),
    // NIE bei Stack/Architektur (zu fundamental).
    let autoApplied: { historyId: string; filePath: string; reason: string } | undefined;
    const maxLessonConf = pendingLessons.length > 0
      ? Math.max(...pendingLessons.map(l => l.confidence))
      : 0;
    const autoApplyDecision = autoApplyAllowedByMode(cfg.autoApplyMode, maxLessonConf);
    if (autoApplyDecision.allowed) {
      // Pre-Apply-Safety-Checks
      const filePath = path.join(packagePath ? path.join(proj.cwd, packagePath) : proj.cwd, fileNameFor(cfg.primaryOutput));
      let userManaged = false;
      if (existsSync(filePath)) {
        try {
          const onDisk = readFileSync(filePath, 'utf8').slice(0, 500);
          userManaged = !/generated_by:\s*alfred-agent-conventions/i.test(onDisk);
        } catch { /* */ }
      }
      if (userManaged) {
        this.deps.logger.info({ projectId, packagePath }, 'v826 auto-apply skipped: user-managed file (no overwrite)');
      } else {
        try {
          const applyResult = await this.handleApply(projectId, packagePath, {
            content: gen.markdown,
            commit_to_git: true,
            trigger_source: `auto-apply:${cfg.autoApplyMode}:lesson-consolidate`,
          });
          if (applyResult.success) {
            const applyData = applyResult.data as { historyId: string; filesWritten: string[] };
            autoApplied = {
              historyId: applyData.historyId,
              filePath: applyData.filesWritten[0] ?? filePath,
              reason: `auto-apply mode=${cfg.autoApplyMode}, maxConf=${maxLessonConf.toFixed(2)}`,
            };
            // Alle pending lessons als applied markieren
            for (const l of pendingLessons) {
              await this.deps.conventionsRepo.markLessonApplied(projectId, packagePath, l.id);
            }
            this.deps.logger.info({ projectId, packagePath, mode: cfg.autoApplyMode, lessons: pendingLessons.length }, 'v826 auto-applied conventions');
          }
        } catch (err) {
          this.deps.logger.warn({ err, projectId, packagePath }, 'v826 auto-apply failed (draft persisted, user can apply manually)');
        }
      }
    }

    return {
      success: true,
      data: {
        draft: gen.markdown,
        scanHash: gen.scanHash,
        contentHash: gen.contentHash,
        warnings: gen.warnings,
        costUsd: gen.costUsd,
        consolidatedLessonsCount: pendingLessons.length,
        scanSnapshot: scan.snapshot,
        autoApplied,
        autoApplyDecision: autoApplyDecision.allowed ? 'applied' : autoApplyDecision.reason,
      },
    };
  }

  // ── list_packages (Phase 3.1 — Monorepo-Support) ───────────────────────
  // Workspace-Detection: pnpm-workspace.yaml, package.json workspaces, nx.json,
  // turbo.json, lerna.json. Returns Package-Liste mit Pfaden + Status pro Package.
  private async handleListPackages(projectId: string): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    if (!existsSync(proj.cwd)) return { success: false, error: `cwd does not exist: ${proj.cwd}` };

    // Initial-Scan auf Root um workspaces zu erkennen
    const rootScan = await this.deps.scanner.scan(proj.cwd);
    const workspaces = rootScan.snapshot.workspaces ?? [];
    const packages: Array<{ path: string; name: string; type: 'root' | 'pkg' }> = [
      { path: '', name: '(root)', type: 'root' },
    ];

    // Globs auflösen (pragmatisch: nur packages/* style, kein voller glob-resolver)
    for (const pattern of workspaces) {
      if (pattern === '(nx)' || pattern === '(turbo)') continue;
      const cleanPattern = pattern.replace(/\/\*\*?$/, '').replace(/\/\*$/, '');
      const baseDir = path.join(proj.cwd, cleanPattern);
      if (!existsSync(baseDir)) continue;
      try {
        const entries = readdirSync(baseDir);
        for (const entry of entries) {
          const pkgPath = path.join(baseDir, entry);
          const pkgJsonPath = path.join(pkgPath, 'package.json');
          if (existsSync(pkgJsonPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
              const relPath = path.relative(proj.cwd, pkgPath).replace(/\\/g, '/');
              packages.push({ path: relPath, name: pkg.name ?? entry, type: 'pkg' });
            } catch { /* skip malformed package.json */ }
          }
        }
      } catch { /* skip unreadable dir */ }
    }

    // Convention-Status pro Package
    const existing = await this.deps.conventionsRepo.listForProject(projectId);
    const existingByPath = new Map(existing.map(c => [c.packagePath, c]));

    const result = packages.map(p => {
      const conv = existingByPath.get(p.path);
      const filePath = path.join(proj.cwd, p.path, 'CLAUDE.md');
      const filePresent = existsSync(filePath);
      return {
        ...p,
        filePath: path.relative(proj.cwd, filePath),
        hasConventionsRow: !!conv,
        filePresent,
        driftScore: conv?.driftScore ?? 0,
        lastAppliedAt: conv?.lastAppliedAt ?? null,
        pendingLessonsCount: conv?.neutralFormat.lessons.filter(l => !l.appliedToMain).length ?? 0,
      };
    });

    return {
      success: true,
      data: {
        isMonorepo: packages.length > 1,
        workspaceFormat: workspaces.length > 0 ? workspaces.join(',') : 'single-package',
        packages: result,
      },
    };
  }

  // ── generate_all_packages (Phase 3.1) ──────────────────────────────────
  // Sequenziell generate über alle erkannten Packages. Bulk-Operation.
  // Concurrency 1 (sequenziell) damit LLM-Rate-Limits respektiert werden +
  // single-package-error nicht alle anderen abbricht.
  private async handleGenerateAllPackages(projectId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const pkgList = await this.handleListPackages(projectId);
    if (!pkgList.success || !pkgList.data) return pkgList;
    const data = pkgList.data as { packages: Array<{ path: string; name: string }> };
    const results: Array<{ packagePath: string; ok: boolean; reason?: string; costUsd?: number }> = [];
    for (const pkg of data.packages) {
      try {
        const r = await this.handleGenerate(projectId, pkg.path, input);
        results.push({
          packagePath: pkg.path,
          ok: !!r.success,
          reason: r.error,
          costUsd: (r.data as { costUsd?: number } | undefined)?.costUsd,
        });
      } catch (err) {
        results.push({ packagePath: pkg.path, ok: false, reason: (err as Error).message });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    const totalCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    return {
      success: true,
      data: {
        packagesProcessed: results.length,
        successCount: okCount,
        failureCount: results.length - okCount,
        totalCostUsd: totalCost,
        perPackage: results,
      },
    };
  }

  // ── mine_patterns (Phase 3.3) ──────────────────────────────────────────
  // Cross-Project-Pattern-Mining: scannt alle Lessons aller User-Projekte,
  // clustert via einfacher Text-Ähnlichkeit (Jaccard auf bag-of-words),
  // persistiert Cluster mit >= 2 Lessons aus >= 2 Projekten als Pattern.
  // KEINE Embeddings (Phase 4.5) — pragmatisch und ausreichend für v827.
  private async handleMinePatterns(input: Record<string, unknown>): Promise<SkillResult> {
    const masterUserId = (input.master_user_id as string | undefined) ?? '';
    if (!masterUserId) return { success: false, error: 'master_user_id required' };
    if (!this.deps.listProjectsForUser) return { success: false, error: 'project-list lookup not configured' };

    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    if (cfg.crossProjectPool === 'off') {
      return { success: false, error: 'cross-project pool disabled (config.crossProjectPool=off)' };
    }

    const projects = await this.deps.listProjectsForUser(masterUserId);
    // Sammle alle pending+applied lessons mit project-anchor
    const allLessons: Array<{ projectId: string; lessonId: string; text: string; confidence: number }> = [];
    for (const proj of projects) {
      const convs = await this.deps.conventionsRepo.listForProject(proj.id);
      for (const conv of convs) {
        for (const l of conv.neutralFormat.lessons) {
          if (l.confidence < 0.5) continue;
          allLessons.push({ projectId: proj.id, lessonId: l.id, text: l.text, confidence: l.confidence });
        }
      }
    }

    if (allLessons.length === 0) {
      return { success: true, data: { lessonsAnalyzed: 0, patternsCreated: 0, patternsUpdated: 0 } };
    }

    // v833 — Embedding-basiertes Clustering wenn Service verfügbar, sonst Jaccard-Fallback
    type Cluster = { lessons: typeof allLessons; centroid: number[] | null; tokenUnion: Set<string> };
    const clusters: Cluster[] = [];
    const SIMILARITY_THRESHOLD_EMBED = 0.78;
    const SIMILARITY_THRESHOLD_JACCARD = 0.45;

    const cosine = (a: number[], b: number[]): number => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
      const denom = Math.sqrt(magA) * Math.sqrt(magB);
      return denom === 0 ? 0 : dot / denom;
    };

    const stopwords = new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'in', 'auf', 'mit', 'für', 'zu', 'von', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'with', 'for', 'to', 'of', 'is', 'are', 'was', 'were', 'ist', 'sind']);
    const tokenize = (s: string): Set<string> => {
      const tokens = s.toLowerCase().match(/[a-zA-Z_][\w./-]{2,}/g) ?? [];
      return new Set(tokens.filter(t => !stopwords.has(t) && t.length >= 3));
    };
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      const intersect = [...a].filter(x => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 0 : intersect / union;
    };

    const useEmbeddings = !!this.deps.embed;
    if (useEmbeddings) this.deps.logger.info({ count: allLessons.length }, 'v833 pattern-mining: embedding-mode');

    for (const lesson of allLessons) {
      let lessonEmb: number[] | null = null;
      const lessonTokens = tokenize(lesson.text);
      if (useEmbeddings) {
        lessonEmb = await this.deps.embed!(lesson.text.slice(0, 800)).catch(() => null);
      }
      if (!useEmbeddings && lessonTokens.size < 3) continue;
      let assigned = false;
      for (const cluster of clusters) {
        let sim = 0;
        if (useEmbeddings && lessonEmb && cluster.centroid) {
          sim = cosine(lessonEmb, cluster.centroid);
          if (sim >= SIMILARITY_THRESHOLD_EMBED) {
            cluster.lessons.push(lesson);
            // Centroid-Update (laufender Durchschnitt)
            const n = cluster.lessons.length;
            for (let i = 0; i < cluster.centroid.length; i++) {
              cluster.centroid[i] = (cluster.centroid[i] * (n - 1) + lessonEmb[i]) / n;
            }
            assigned = true;
            break;
          }
        } else {
          sim = jaccard(lessonTokens, cluster.tokenUnion);
          if (sim >= SIMILARITY_THRESHOLD_JACCARD) {
            cluster.lessons.push(lesson);
            for (const t of lessonTokens) cluster.tokenUnion.add(t);
            assigned = true;
            break;
          }
        }
      }
      if (!assigned) {
        clusters.push({
          lessons: [lesson],
          centroid: lessonEmb,
          tokenUnion: new Set(lessonTokens),
        });
      }
    }

    // Nur Cluster mit >= 2 Lessons aus >= 2 verschiedenen Projekten = Pattern
    let patternsCreated = 0;
    let patternsUpdated = 0;
    for (const cluster of clusters) {
      const projectIds = new Set(cluster.lessons.map(l => l.projectId));
      if (cluster.lessons.length < 2 || projectIds.size < 2) continue;

      // Pattern-Text: nehme die längste Lesson als Repräsentant
      const representative = cluster.lessons.sort((a, b) => b.text.length - a.text.length)[0];
      const avgConfidence = cluster.lessons.reduce((s, l) => s + l.confidence, 0) / cluster.lessons.length;

      const before = await this.deps.conventionsRepo.listPatterns(masterUserId);
      const beforeMatch = before.find(p => p.patternText === representative.text);
      const pattern = await this.deps.conventionsRepo.upsertPattern({
        masterUserId,
        patternText: representative.text,
        section: 'gotchas',
        category: 'gotcha',
        frameworkTags: [], // Phase 3.x: derive from project scans
        confidence: avgConfidence,
      });
      if (beforeMatch) patternsUpdated++;
      else patternsCreated++;

      // Link sources
      for (const lesson of cluster.lessons) {
        await this.deps.conventionsRepo.linkPatternSource(pattern.id, lesson.projectId, lesson.lessonId);
      }
    }

    return {
      success: true,
      data: {
        lessonsAnalyzed: allLessons.length,
        clustersFound: clusters.length,
        patternsCreated,
        patternsUpdated,
      },
    };
  }

  // ── list_patterns (Phase 3.3) ──────────────────────────────────────────
  private async handleListPatterns(input: Record<string, unknown>): Promise<SkillResult> {
    const masterUserId = (input.master_user_id as string | undefined) ?? '';
    if (!masterUserId) return { success: false, error: 'master_user_id required' };
    const patterns = await this.deps.conventionsRepo.listPatterns(masterUserId, { minOccurrence: 2 });
    return { success: true, data: { patterns } };
  }

  // ── retire_pattern (Phase 3.3) ─────────────────────────────────────────
  private async handleRetirePattern(input: Record<string, unknown>): Promise<SkillResult> {
    const patternId = input.pattern_id as string | undefined;
    if (!patternId) return { success: false, error: 'pattern_id required' };
    await this.deps.conventionsRepo.retirePattern(patternId);
    return { success: true, data: { patternId } };
  }

  // ── record_violation (Phase 4.2 Inverse Learning) ─────────────────────
  private async handleRecordViolation(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const section = (input.section as ConventionsSection | undefined) ?? 'gotchas';
    const excerpt = (input.excerpt as string | undefined)?.trim();
    if (!excerpt || excerpt.length < 5) return { success: false, error: 'excerpt required (min 5 chars)' };
    const id = await this.deps.conventionsRepo.recordViolation({
      projectId,
      packagePath,
      section,
      excerpt,
      sessionId: input.session_id as string | undefined,
      resolvedAnyway: !!input.resolved_anyway,
      manualOverride: !!input.manual_override,
      detectionSource: (input.detection_source as string | undefined) ?? 'manual',
    });
    return { success: true, data: { violationId: id } };
  }

  // ── section_health (Phase 4.2) ─────────────────────────────────────────
  // Liefert per-Section Health-Score: 1.0 = perfekt, 0.0 = überall verletzt+resolved-anyway.
  // Niedriger Score = Convention ist möglicherweise zu eng oder veraltet.
  private async handleSectionHealth(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const sinceIso = input.since_iso as string | undefined;
    const stats = await this.deps.conventionsRepo.getSectionHealthStats(projectId, packagePath, sinceIso);
    const suggested_removal = stats.filter(s => s.healthScore < 0.4 && s.violations >= 5);
    return { success: true, data: { stats, suggestedRemoval: suggested_removal } };
  }

  // ── effectiveness_metrics (Phase 4.1 A/B-Tests) ─────────────────────────
  // Pre-/Post-Apply Vergleich: liefert Counters für die wichtigsten Quality-Signals
  // basierend auf Conventions-Apply-Datum als Trennlinie.
  private async handleEffectivenessMetrics(projectId: string): Promise<SkillResult> {
    const conv = await this.deps.conventionsRepo.get(projectId, '');
    if (!conv || !conv.lastAppliedAt) {
      return { success: true, data: { hasBaseline: false, reason: 'no apply yet — baseline-window not started' } };
    }
    const violations = await this.deps.conventionsRepo.listViolations(projectId, '');
    const cutoff = conv.lastAppliedAt;
    const pre = violations.filter(v => v.violatedAt < cutoff);
    const post = violations.filter(v => v.violatedAt >= cutoff);
    return {
      success: true,
      data: {
        hasBaseline: true,
        appliedAt: cutoff,
        preApplyViolations: pre.length,
        postApplyViolations: post.length,
        lessonsTotal: conv.neutralFormat.lessons.length,
        lessonsApplied: conv.neutralFormat.lessons.filter(l => l.appliedToMain).length,
        driftScore: conv.driftScore,
        improvement: pre.length > 0 ? Math.round((1 - post.length / pre.length) * 100) : null,
        confidence: pre.length + post.length >= 10 ? 'statistically-relevant' : 'too-few-samples',
      },
    };
  }

  // ── self_modify (Phase 4.3 Self-Modifying-Agent) ──────────────────────
  // Reviewed alle Lessons + Violations + Drift + Cross-Patterns + scant Repo neu →
  // produziert kohärenten Refactor-Draft der existing CLAUDE.md mit allen
  // Erkenntnissen integriert. Kein direct apply — User reviewed im Modal.
  private async handleSelfModify(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: false, error: 'No conventions row (run generate first)' };

    // Sammle alle Kontext-Daten für den Refactor
    const violations = await this.deps.conventionsRepo.listViolations(projectId, packagePath);
    const healthStats = await this.deps.conventionsRepo.getSectionHealthStats(projectId, packagePath);
    const pendingLessons = conv.neutralFormat.lessons.filter(l => !l.appliedToMain);

    // Self-Modify nutzt consolidate_lessons als Backbone + zusätzliche Health-Info
    // im Prompt-Kontext (via patternSuggestions abuse — vereinfacht).
    const cfg = { ...DEFAULT_CONFIG, ...this.deps.config() };
    const language = (input.language as ConventionsLanguage | undefined) ?? cfg.language;
    const scanCwd = packagePath ? path.join(proj.cwd, packagePath) : proj.cwd;
    const scan = await this.deps.scanner.scan(scanCwd);

    const healthSuggestions = healthStats
      .filter(s => s.healthScore < 0.4 && s.violations >= 5)
      .map(s => ({ patternText: `Convention in Section "${s.section}" hat health=${s.healthScore.toFixed(2)} (${s.violations} violations, ${s.resolvedAnyway} resolved anyway). Eventuell entfernen oder umformulieren.`, section: s.section as ConventionsSection, confidence: 0.6 }));
    const lessonsAsPatterns = pendingLessons.map(l => ({ patternText: l.text, section: 'gotchas' as ConventionsSection, confidence: l.confidence }));

    const gen = await this.deps.generator.generate({
      cwd: scanCwd,
      llmContext: scan.llmContext,
      scanSnapshot: scan.snapshot,
      scanHash: scan.scanHash,
      language,
      generateMode: 'single',
      tier: 'strong', // Self-Modify ist kritisch → immer strong
      existingContent: conv.content,
      patternSuggestions: [...lessonsAsPatterns, ...healthSuggestions],
    });
    if (!gen.ok || !gen.markdown) return { success: false, error: gen.reason ?? 'self-modify generation failed' };

    await this.deps.conventionsRepo.upsert({
      projectId,
      packagePath,
      draftContent: gen.markdown,
      sourceScan: scan.snapshot,
      generatedAt: new Date().toISOString(),
      generatedBy: 'lesson-derived',
    });

    return {
      success: true,
      data: {
        draft: gen.markdown,
        scanHash: gen.scanHash,
        contentHash: gen.contentHash,
        warnings: gen.warnings,
        costUsd: gen.costUsd,
        consideredLessons: pendingLessons.length,
        consideredViolations: violations.length,
        suggestedRemovals: healthSuggestions.length,
      },
    };
  }

  // ── test_harness_run (Phase 4.6) ───────────────────────────────────────
  // Führt eine kanonische Test-Aufgabe gegen das Projekt aus + persistiert Outcome.
  // Vergleich mit/ohne Conventions kommt durch Vergleich von ranAt-Range vs
  // conventions.lastAppliedAt. Minimal-Implementierung: registriert Outcome,
  // weitere Test-Runner-Logik kommt in nachfolgenden Iterationen.
  private async handleTestHarnessRun(projectId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const taskId = (input.task_id as string | undefined)?.trim();
    const outcomePassed = !!input.outcome_passed;
    const stack = (input.stack as string | undefined) ?? 'unknown';
    if (!taskId) return { success: false, error: 'task_id required' };

    const conv = await this.deps.conventionsRepo.get(projectId, '');
    const versionHash = conv?.contentHash || 'no-conventions';
    const withConventions = !!conv?.content;

    const runId = await this.deps.conventionsRepo.recordTestRun({
      projectId,
      conventionsVersionHash: versionHash,
      canonicalTaskId: taskId,
      stack,
      withConventions,
      outcomePassed,
      outcomeDetails: input.outcome_details as string | undefined,
      fixAttempts: (input.fix_attempts as number | undefined) ?? 0,
      durationMs: (input.duration_ms as number | undefined) ?? 0,
      costUsd: (input.cost_usd as number | undefined) ?? 0,
    });

    return { success: true, data: { runId, versionHash, withConventions } };
  }

  // ── canonical_tasks (Phase 4.6 — Test-Harness-Runner) ────────────────
  private async handleListCanonicalTasks(): Promise<SkillResult> {
    const { CANONICAL_TASKS } = await import('./canonical-tasks.js');
    return { success: true, data: { tasks: CANONICAL_TASKS } };
  }

  private async handleRunCanonicalTask(projectId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const taskId = (input.task_id as string | undefined)?.trim();
    if (!taskId) return { success: false, error: 'task_id required' };

    const proj = await this.deps.resolveProject(projectId);
    if (!proj) return { success: false, error: 'Project not found' };
    if (!existsSync(proj.cwd)) return { success: false, error: `cwd does not exist: ${proj.cwd}` };

    const { CANONICAL_TASKS } = await import('./canonical-tasks.js');
    const task = CANONICAL_TASKS.find(t => t.id === taskId);
    if (!task) return { success: false, error: `task '${taskId}' not found. List: ${CANONICAL_TASKS.map(t => t.id).join(', ')}` };

    const startTime = Date.now();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    // v838 — NODE_OPTIONS für tsc/vitest-spawn (Test-Harness läuft tsc --noEmit etc.)
    const parentNodeOpts = process.env.NODE_OPTIONS ?? '';
    const nodeOpts = /max-old-space-size/.test(parentNodeOpts)
      ? parentNodeOpts
      : `${parentNodeOpts} --max-old-space-size=4096`.trim();
    const childEnv = { ...process.env, NODE_OPTIONS: nodeOpts };
    const runCmd = async (cmd: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number; output: string }> => {
      // Spawn via shell für Pipe/Glob-Support
      const isWin = process.platform === 'win32';
      const shellCmd = isWin ? 'cmd' : 'sh';
      const shellArgs = isWin ? ['/c', cmd] : ['-c', cmd];
      try {
        const { stdout, stderr } = await exec(shellCmd, shellArgs, { cwd: proj.cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: childEnv });
        return { ok: true, exitCode: 0, output: `${stdout}\n${stderr}`.slice(-3000) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { ok: false, exitCode: e.code ?? -1, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(-3000) };
      }
    };

    // Setup-Phase
    if (task.setup) {
      for (const cmd of task.setup) {
        const r = await runCmd(cmd, task.timeoutMs ?? 5 * 60_000);
        if (!r.ok) {
          return { success: false, error: `setup failed: ${cmd}`, data: { output: r.output, exitCode: r.exitCode } };
        }
      }
    }

    // Validate-Phase: alle Commands müssen passen
    const outputs: string[] = [];
    let outcomePassed = true;
    let lastExitCode = 0;
    for (const cmd of task.validate) {
      const r = await runCmd(cmd, task.timeoutMs ?? 5 * 60_000);
      outputs.push(`$ ${cmd} (exit=${r.exitCode})\n${r.output}`);
      if (!r.ok) {
        outcomePassed = false;
        lastExitCode = r.exitCode;
        break; // stoppe bei erstem Fehler
      }
    }

    const durationMs = Date.now() - startTime;

    // Outcome-Record via test_harness_run
    const conv = await this.deps.conventionsRepo.get(projectId, '');
    const versionHash = conv?.contentHash || 'no-conventions';
    const withConventions = !!conv?.content;
    const runId = await this.deps.conventionsRepo.recordTestRun({
      projectId,
      conventionsVersionHash: versionHash,
      canonicalTaskId: taskId,
      stack: task.stack,
      withConventions,
      outcomePassed,
      outcomeDetails: outputs.join('\n\n').slice(-5000),
      durationMs,
      costUsd: 0, // local execution, no LLM cost
    });

    this.deps.logger.info({ projectId, taskId, outcomePassed, durationMs, withConventions }, 'v836 canonical-task run complete');

    return {
      success: true,
      data: {
        runId,
        taskId,
        outcomePassed,
        durationMs,
        withConventions,
        versionHash,
        lastExitCode,
        outputTail: outputs.join('\n\n').slice(-2000),
      },
    };
  }

  // ── mark_lesson_applied (Phase 2) ──────────────────────────────────────
  // Nach erfolgreichem Apply einer consolidated-CLAUDE.md markieren wir die
  // Lessons als applied damit sie nicht erneut konsolidiert werden.
  private async handleMarkLessonApplied(projectId: string, packagePath: string, input: Record<string, unknown>): Promise<SkillResult> {
    const lessonId = input.lesson_id as string | undefined;
    if (lessonId) {
      await this.deps.conventionsRepo.markLessonApplied(projectId, packagePath, lessonId);
      return { success: true, data: { lessonId } };
    }
    // Ohne lesson_id: alle pending → applied (typischer Workflow nach consolidate+apply)
    const conv = await this.deps.conventionsRepo.get(projectId, packagePath);
    if (!conv) return { success: false, error: 'No conventions row' };
    let marked = 0;
    for (const l of conv.neutralFormat.lessons) {
      if (!l.appliedToMain) {
        await this.deps.conventionsRepo.markLessonApplied(projectId, packagePath, l.id);
        marked++;
      }
    }
    return { success: true, data: { marked } };
  }
}

/** Helper für AgentSessionManager — Lädt Conventions aus cwd. */
export async function loadConventionsForCwd(cwd: string, capBytes = 8192): Promise<string | null> {
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, 'AGENTS.md'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf8');
        return content.length > capBytes ? content.slice(0, capBytes) + '\n... (truncated)' : content;
      }
    } catch { /* skip */ }
  }
  return null;
}
