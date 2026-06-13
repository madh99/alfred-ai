import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type {
  ProjectRepository, Project, ProjectStatus, ProjectHealthMode, OpenItemStatus,
  ProjectOpenItem,
} from '@alfred/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
// v869.3 — Live-Output-Infrastruktur (Ring-Buffer + SSE) ist taskId-generisch
import { appendOutputLine, markOutputEnded } from './code-agent/project-agent-skill.js';
const pExecFile = promisify(execFile);

type LlmAuditCallback = (prompt: string, tier?: string) => Promise<string>;

/** Callback signature for cross-domain cascade — set by alfred.ts wiring. */
export type IncidentCascadeFn = (incidentId: string, status: 'resolved' | 'closed' | 'reopened') => Promise<boolean>;

type Action =
  | 'list' | 'get' | 'create' | 'rename' | 'set_status' | 'set_health_mode'
  | 'list_open_items' | 'add_open_item' | 'resolve_open_item'
  | 'list_sessions' | 'list_decisions' | 'archive'
  | 'work_on_open_items' | 'audit_open_items' | 'deep_verify_items'
  | 'update_dependencies' | 'review_codebase'
  | 'suggest_features' | 'plan_feature';

/** v870 — Deep-Verify-Verdikt eines Items (read-only Codebase-Prüfung). */
export interface DeepVerifyFinding {
  id: string;
  verdict: 'implemented' | 'partially' | 'not-implemented' | 'obsolete';
  confidence: number;
  evidence: string;
  missing?: string;
}

/**
 * v870.1 — String-bewusstes Bracket-Matching: findet das schließende `]` zum
 * `[` an Position start, ignoriert dabei Brackets INNERHALB von JSON-Strings.
 * Nötig weil Evidence-Belege Next.js-Pfade wie `[slug]`/`[id]` enthalten —
 * die brachen die alte non-greedy Regex-Extraktion (Vorfall 12.06., Lauf
 * 860f0740: 15 perfekte Verdikte geliefert, 0 geparst).
 */
function matchJsonArrayEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * v870 — Parse der Deep-Verify-Agent-Antwort: letztes valides Verdikt-Array
 * im Output (Agent darf davor frei erzählen), validiert gegen die geprüften
 * Item-IDs. Exportiert für Tests.
 */
export function parseDeepVerifyFindings(output: string, validIds: Set<string>): DeepVerifyFinding[] {
  const findings: DeepVerifyFinding[] = [];
  const VERDICTS = ['implemented', 'partially', 'not-implemented', 'obsolete'];
  // v870.1 — von hinten nach vorn jedes '[' string-bewusst matchen
  for (let start = output.lastIndexOf('['); start >= 0; start = start > 0 ? output.lastIndexOf('[', start - 1) : -1) {
    const end = matchJsonArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const valid = parsed.filter((r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' &&
        typeof (r as Record<string, unknown>).id === 'string' &&
        validIds.has((r as Record<string, unknown>).id as string) &&
        VERDICTS.includes((r as Record<string, unknown>).verdict as string));
      if (valid.length === 0) continue;
      for (const r of valid) {
        findings.push({
          id: r.id as string,
          verdict: r.verdict as DeepVerifyFinding['verdict'],
          confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.5))),
          evidence: String(r.evidence ?? '').slice(0, 300),
          missing: typeof r.missing === 'string' ? r.missing.slice(0, 300) : undefined,
        });
      }
      return findings; // erstes valides Array von hinten gewinnt
    } catch { /* nächsten Kandidaten probieren */ }
  }
  return findings;
}

/** v879 — Befund eines Codebase-Reviews (review_codebase). */
export interface ReviewFinding {
  /** Lauf-lokale ID f1..fn — Referenz für die Gegenprüfung. */
  id: string;
  title: string;
  kind: 'security' | 'bug' | 'gap' | 'quality';
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  confidence: number;
  suggestedMilestone?: string;
  /** Verdikte der optionalen Gegenprüfer-Agents. */
  crossChecks?: Array<{ agent: string; verdict: 'confirmed' | 'refuted' | 'unclear'; note?: string }>;
}

const REVIEW_KINDS = ['security', 'bug', 'gap', 'quality'];
const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'];

/**
 * v879 — Parse der Review-Agent-Antwort: letztes valides Befund-Array im
 * Output (string-bewusstes Bracket-Matching wie Deep-Verify — Evidence enthält
 * [slug]-Pfade). IDs werden lauf-lokal vergeben (f1..fn). Exportiert für Tests.
 */
export function parseReviewFindings(output: string): ReviewFinding[] {
  for (let start = output.lastIndexOf('['); start >= 0; start = start > 0 ? output.lastIndexOf('[', start - 1) : -1) {
    const end = matchJsonArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      const valid = parsed.filter((r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' &&
        typeof (r as Record<string, unknown>).title === 'string' &&
        ((r as Record<string, unknown>).title as string).trim().length > 0 &&
        REVIEW_KINDS.includes((r as Record<string, unknown>).kind as string) &&
        REVIEW_SEVERITIES.includes((r as Record<string, unknown>).severity as string));
      if (valid.length === 0) continue;
      return valid.slice(0, 25).map((r, i) => ({
        id: `f${i + 1}`,
        title: String(r.title).trim().slice(0, 200),
        kind: r.kind as ReviewFinding['kind'],
        severity: r.severity as ReviewFinding['severity'],
        evidence: String(r.evidence ?? '').slice(0, 300),
        confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.5))),
        suggestedMilestone: typeof r.suggestedMilestone === 'string' ? r.suggestedMilestone.trim().slice(0, 80) : undefined,
      }));
    } catch { /* nächsten Kandidaten probieren */ }
  }
  return [];
}

/** v880 — Feature-Vorschlag aus dem Discovery-Lauf. */
export interface FeatureSuggestion {
  /** Lauf-lokale ID s1..sn. */
  id: string;
  title: string;
  value: string;
  effort: 'S' | 'M' | 'L';
  rationale: string;
  /** Agents, die diese Idee (unabhängig) vorgeschlagen haben. */
  proposedBy: string[];
}

/**
 * v880 — Parse der Discovery-Antwort: letztes valides Vorschlags-Array.
 * Exportiert für Tests.
 */
export function parseFeatureSuggestions(output: string): Array<Omit<FeatureSuggestion, 'id' | 'proposedBy'>> {
  for (let start = output.lastIndexOf('['); start >= 0; start = start > 0 ? output.lastIndexOf('[', start - 1) : -1) {
    const end = matchJsonArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      const valid = parsed.filter((r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' &&
        typeof (r as Record<string, unknown>).title === 'string' &&
        ((r as Record<string, unknown>).title as string).trim().length > 0);
      if (valid.length === 0) continue;
      return valid.slice(0, 10).map(r => ({
        title: String(r.title).trim().slice(0, 150),
        value: String(r.value ?? '').trim().slice(0, 400),
        effort: ['S', 'M', 'L'].includes(String(r.effort).toUpperCase()) ? (String(r.effort).toUpperCase() as 'S' | 'M' | 'L') : 'M',
        rationale: String(r.rationale ?? '').trim().slice(0, 400),
      }));
    } catch { /* nächsten Kandidaten probieren */ }
  }
  return [];
}

/**
 * v880 — Parse der Plan-Antwort: Phasen-Array des Umsetzungsplans.
 * Exportiert für Tests.
 */
export function parseFeaturePlanPhases(output: string): Array<{ title: string; description: string }> {
  for (let start = output.lastIndexOf('['); start >= 0; start = start > 0 ? output.lastIndexOf('[', start - 1) : -1) {
    const end = matchJsonArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      const valid = parsed.filter((r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' &&
        typeof (r as Record<string, unknown>).title === 'string' &&
        ((r as Record<string, unknown>).title as string).trim().length > 0);
      if (valid.length === 0) continue;
      return valid.slice(0, 10).map(r => ({
        title: String(r.title).trim().slice(0, 200),
        description: String(r.description ?? '').trim().slice(0, 800),
      }));
    } catch { /* nächsten Kandidaten probieren */ }
  }
  return [];
}

/** v880 — simple Token-Containment für das Mergen von Vorschlägen zweier Agents. */
function suggestionOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-zà-ž0-9äöüß\s-]/gi, ' ').split(/[\s-]+/).filter(w => w.length >= 3));
  const ta = tok(a); const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let o = 0; for (const w of ta) if (tb.has(w)) o++;
  return o / Math.min(ta.size, tb.size);
}

/**
 * v879 — Parse der Gegenprüfer-Antwort (Verdikte pro Befund-ID).
 * Exportiert für Tests.
 */
export function parseCrossCheckVerdicts(output: string, validIds: Set<string>): Array<{ id: string; verdict: 'confirmed' | 'refuted' | 'unclear'; note?: string }> {
  const VERDICTS = ['confirmed', 'refuted', 'unclear'];
  for (let start = output.lastIndexOf('['); start >= 0; start = start > 0 ? output.lastIndexOf('[', start - 1) : -1) {
    const end = matchJsonArrayEnd(output, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      const valid = parsed.filter((r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' &&
        typeof (r as Record<string, unknown>).id === 'string' &&
        validIds.has((r as Record<string, unknown>).id as string) &&
        VERDICTS.includes((r as Record<string, unknown>).verdict as string));
      if (valid.length === 0) continue;
      return valid.map(r => ({
        id: r.id as string,
        verdict: r.verdict as 'confirmed' | 'refuted' | 'unclear',
        note: typeof r.note === 'string' ? r.note.slice(0, 250) : undefined,
      }));
    } catch { /* nächsten Kandidaten probieren */ }
  }
  return [];
}

const VALID_STATUS: ProjectStatus[] = ['active', 'paused', 'completed', 'maintenance', 'archived'];
const VALID_HEALTH: ProjectHealthMode[] = ['full', 'minimal', 'off'];

/**
 * ProjectSkill — manage long-lived project containers that hold sessions
 * (project-agent, code-agent, delegate, chat), open items, and decisions.
 *
 * Most projects auto-attach when a project-agent session starts (via ProjectManager).
 * This skill is the LLM-/chat-facing API for inspection, manual creation,
 * rename, archive, open-item management, and per-project health-mode tuning.
 */
export class ProjectSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'project',
    category: 'productivity',
    description:
      'Verwalte langlebige Projekt-Container für Project-Agent / Code-Agent / Delegate-Sessions. ' +
      'Actions: list (alle Projekte), get (Detail), create (manuell anlegen), rename (Name ändern), ' +
      'set_status (active/paused/completed/maintenance/archived), set_health_mode (full/minimal/off — Health-Checks pro Projekt), ' +
      'list_open_items, add_open_item, resolve_open_item, list_sessions, list_decisions, archive.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 20_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list', 'get', 'create', 'rename', 'set_status', 'set_health_mode',
            'list_open_items', 'add_open_item', 'resolve_open_item',
            'list_sessions', 'list_decisions', 'archive',
            'work_on_open_items', 'audit_open_items', 'deep_verify_items',
            'update_dependencies', 'review_codebase',
            'suggest_features', 'plan_feature',
          ],
        },
        project_id: { type: 'string', description: 'Project-ID oder Prefix (für get/rename/...)' },
        name: { type: 'string', description: 'Projektname (für create/rename)' },
        description: { type: 'string' },
        cwd: { type: 'string' },
        repo_url: { type: 'string' },
        status: { type: 'string', description: 'Neuer Status (für set_status)' },
        health_mode: { type: 'string', description: 'full/minimal/off (für set_health_mode)' },
        status_filter: { type: 'string', description: 'Status-Filter (für list/list_open_items)' },
        item_id: { type: 'string', description: 'Open-Item-ID (für resolve_open_item)' },
        item_status: { type: 'string', description: 'open/in_progress/done/cancelled' },
        title: { type: 'string', description: 'Open-Item-Titel (für add_open_item)' },
        priority: { type: 'string', description: 'low/normal/high' },
        packages: { type: 'array', items: { type: 'string' }, description: 'Optionale Paket-Teilmenge (für update_dependencies — leer = alle outdated)' },
        scope: { type: 'string', description: 'Review-Scope (für review_codebase — leer = Security, Bugs, Lücken, Qualität)' },
        review_agent: { type: 'string', description: 'CLI-Agent für das Review (für review_codebase — leer = Standard-Agent)' },
        cross_check_agents: { type: 'array', items: { type: 'string' }, description: 'Gegenprüfer-Agents (für review_codebase, optional)' },
        focus: { type: 'string', description: 'Themen-Fokus (für suggest_features, optional)' },
        agents: { type: 'array', items: { type: 'string' }, description: 'CLI-Agents für die Discovery (für suggest_features, 1-2, leer = Standard)' },
        agent: { type: 'string', description: 'CLI-Agent (für plan_feature, optional)' },
      },
      required: ['action'],
    },
  };

  /** Set by alfred.ts — called when an open-item with linkedIncidentId is resolved. */
  private incidentCascade?: IncidentCascadeFn;

  /** v641 — Callback to start a Project-Agent with a constructed goal. Set by alfred.ts.
   *  v869 — mentionedItemIds: die Item-IDs werden auf der Agent-Session persistiert,
   *  damit der v731-Auto-Done-Mechanismus sie nach erfolgreichem Run als done markiert.
   *  Vorher fehlte die Durchreichung komplett → Items blieben ewig offen. */
  private startProjectAgent?: (opts: { cwd: string; goal: string; projectId: string; mentionedItemIds?: string[] }) => Promise<{ taskId: string }>;
  /** v642 — LLM callback for the deep-audit pass. */
  private llmAuditCallback?: LlmAuditCallback;
  /** v869 — Code-Agent-Runner für die Triage: 1-2 einfache Items brauchen keinen
   *  Multi-Phase-Project-Agent (gleiche Regel wie im Chat-Prompt-Builder).
   *  v869.3 — taskId: Live-Output-Streaming in den outputBuffer (SSE in der WebUI). */
  private runCodeAgent?: (opts: { cwd: string; prompt: string; taskId?: string; agent?: string; projectId?: string }) => Promise<{ success: boolean; output: string }>;
  /** v869.3 — Owner-Benachrichtigung (Telegram) für async Code-Läufe. Set by alfred.ts. */
  private ownerNotify?: (text: string) => void;
  /** v869.4 — Sicherungsnetz: code_agent.push (committet nur bei dirty Tree,
   *  pusht aktuellen Branch, inkl. v863-Branch-Mismatch-Warnung). Set by alfred.ts. */
  private pushProject?: (opts: { cwd: string; commitMessage: string }) => Promise<{ success: boolean; summary: string }>;
  /** v869.3 — Doppel-Start-Guard: pro Projekt max. 1 laufender Open-Items-Code-Lauf. */
  private runningCodeJobs = new Map<string, string>();

  constructor(private readonly repo: ProjectRepository) {
    super();
  }

  /** Inject the cascade callback for ITSM linked open-items. */
  setIncidentCascade(fn: IncidentCascadeFn): void {
    this.incidentCascade = fn;
  }

  /** v641 — Inject the start-project-agent callback. */
  setProjectAgentStarter(fn: (opts: { cwd: string; goal: string; projectId: string; mentionedItemIds?: string[] }) => Promise<{ taskId: string }>): void {
    this.startProjectAgent = fn;
  }

  /** v869 — Inject the code-agent runner for single-item triage. */
  setCodeAgentRunner(fn: (opts: { cwd: string; prompt: string; taskId?: string; agent?: string; projectId?: string }) => Promise<{ success: boolean; output: string }>): void {
    this.runCodeAgent = fn;
  }

  /** v869.3 — Inject the owner notifier (Telegram) for async code runs. */
  setOwnerNotifier(fn: (text: string) => void): void {
    this.ownerNotify = fn;
  }

  /** v869.4 — Inject the push safety-net (code_agent.push). */
  setPushProject(fn: (opts: { cwd: string; commitMessage: string }) => Promise<{ success: boolean; summary: string }>): void {
    this.pushProject = fn;
  }

  /** v642 — Inject the LLM callback for deep audit. */
  setLlmCallback(cb: LlmAuditCallback): void {
    this.llmAuditCallback = cb;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId ?? context.alfredUserId ?? context.userId;
    if (!userId) return { success: false, error: 'Kein User-Kontext.' };

    switch (action) {
      case 'list': return this.listProjects(userId, input);
      case 'get': return this.getProject(userId, input);
      case 'create': return this.createProject(userId, input);
      case 'rename': return this.renameProject(userId, input);
      case 'set_status': return this.setStatus(userId, input);
      case 'set_health_mode': return this.setHealthMode(userId, input);
      case 'list_open_items': return this.listOpenItems(userId, input);
      case 'add_open_item': return this.addOpenItem(userId, input);
      case 'resolve_open_item': return this.resolveOpenItem(userId, input);
      case 'list_sessions': return this.listSessions(userId, input);
      case 'list_decisions': return this.listDecisions(userId, input);
      case 'archive': return this.archiveProject(userId, input);
      case 'work_on_open_items': return this.workOnOpenItems(userId, input);
      case 'audit_open_items': return this.auditOpenItems(userId, input);
      case 'deep_verify_items': return this.deepVerifyItems(userId, input);
      case 'update_dependencies': return this.updateDependencies(userId, input);
      case 'review_codebase': return this.reviewCodebase(userId, input);
      case 'suggest_features': return this.suggestFeatures(userId, input);
      case 'plan_feature': return this.planFeature(userId, input);
      default:
        return { success: false, error: `Unbekannte action "${String(action)}".` };
    }
  }

  private async listProjects(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const status = input.status_filter as ProjectStatus | undefined;
    if (status && !VALID_STATUS.includes(status)) {
      return { success: false, error: `Ungültiger status_filter. Erlaubt: ${VALID_STATUS.join(', ')}` };
    }
    const projects = await this.repo.list(userId, { status });
    if (projects.length === 0) {
      return { success: true, data: [], display: '_Keine Projekte._' };
    }
    const lines = projects.map(p => {
      const age = this.relativeTime(p.lastActiveAt);
      return `- **${p.name}** (${p.status}, ${age}) — ID: ${p.id.slice(0, 8)}${p.cwd ? ` · \`${p.cwd}\`` : ''}`;
    });
    return { success: true, data: projects, display: `## Projekte\n\n${lines.join('\n')}` };
  }

  private async getProject(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const sessions = await this.repo.listSessions(project.id, 10);
    const openItems = await this.repo.listOpenItems(userId, { projectId: project.id, status: 'open' });
    const decisions = await this.repo.listDecisions(project.id, 10);
    const healthSummary = await this.repo.getCurrentHealthSummary(project.id);

    const sessionLines = sessions.map(s => {
      const what = s.summary?.whatWasDone ? ` — ${s.summary.whatWasDone.slice(0, 120)}` : '';
      return `  - [${s.sessionType}] ${this.relativeTime(s.startedAt)}${what}`;
    });
    const openLines = openItems.map(it => `  - ${this.priorityIcon(it.priority)} ${it.title}`);
    const decLines = decisions.slice(0, 5).map(d => `  - ${d.choice}${d.rationale ? ` — _${d.rationale.slice(0, 80)}_` : ''}`);
    const healthLines: string[] = [];
    for (const probe of ['git', 'build', 'deps', 'http'] as const) {
      const entry = healthSummary[probe];
      if (!entry) continue;
      const icon = entry.status === 'ok' ? '✓' : entry.status === 'warning' ? '⚠' : entry.status === 'error' ? '✗' : '·';
      const ageStr = this.relativeTime(entry.checkedAt);
      const detail = entry.details ? ` — ${entry.details.slice(0, 100)}` : '';
      healthLines.push(`  - ${icon} **${probe}** (${entry.status}, ${ageStr})${detail}`);
    }

    const display = `## ${project.name}
- Status: **${project.status}** · Health-Mode: ${project.healthMode}
- ID: \`${project.id}\`
- ${project.cwd ? `CWD: \`${project.cwd}\`` : 'CWD: —'}
- ${project.repoUrl ? `Repo: ${project.repoUrl}` : 'Repo: —'}
- Last active: ${this.relativeTime(project.lastActiveAt)}
${project.description ? `\n${project.description}\n` : ''}
### Letzte Health-Checks
${healthLines.join('\n') || '  _noch keine Probes gelaufen_'}

### Letzte Sessions (${sessions.length})
${sessionLines.join('\n') || '  _keine_'}

### Offene Punkte (${openItems.length})
${openLines.join('\n') || '  _keine_'}

### Entscheidungen (${decisions.length})
${decLines.join('\n') || '  _keine_'}`;

    return { success: true, data: { project, sessions, openItems, decisions, health: healthSummary }, display };
  }

  private async createProject(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.name as string | undefined;
    if (!name || name.trim().length === 0) return { success: false, error: 'name erforderlich.' };
    const project = await this.repo.create(userId, {
      name: name.trim(),
      description: input.description as string | undefined,
      cwd: input.cwd as string | undefined,
      repoUrl: input.repo_url as string | undefined,
    });
    return {
      success: true, data: project,
      display: `✓ Projekt **${project.name}** angelegt (ID: ${project.id.slice(0, 8)}).`,
    };
  }

  private async renameProject(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    const name = input.name as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    if (!name || name.trim().length === 0) return { success: false, error: 'name erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const updated = await this.repo.update(userId, project.id, { name: name.trim() });
    return {
      success: true, data: updated,
      display: `✓ Umbenannt: **${project.name}** → **${name.trim()}** (Slug: ${updated?.slug ?? '?'}).`,
    };
  }

  private async setStatus(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    const status = input.status as ProjectStatus | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    if (!status || !VALID_STATUS.includes(status)) {
      return { success: false, error: `Ungültiger status. Erlaubt: ${VALID_STATUS.join(', ')}` };
    }
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const updated = await this.repo.update(userId, project.id, { status });
    return {
      success: true, data: updated,
      display: `✓ Status von **${project.name}**: ${project.status} → ${status}.`,
    };
  }

  private async setHealthMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    const mode = input.health_mode as ProjectHealthMode | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    if (!mode || !VALID_HEALTH.includes(mode)) {
      return { success: false, error: `Ungültiger health_mode. Erlaubt: ${VALID_HEALTH.join(', ')}` };
    }
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const updated = await this.repo.update(userId, project.id, { healthMode: mode });
    return {
      success: true, data: updated,
      display: `✓ Health-Mode für **${project.name}**: ${project.healthMode} → ${mode}.`,
    };
  }

  private async listOpenItems(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const projectIdRaw = input.project_id as string | undefined;
    let projectId: string | undefined;
    if (projectIdRaw) {
      const p = await this.resolveProject(userId, projectIdRaw);
      if (!p) return { success: false, error: `Projekt "${projectIdRaw}" nicht gefunden.` };
      projectId = p.id;
    }
    const status = (input.item_status as OpenItemStatus | undefined) ?? 'open';
    const items = await this.repo.listOpenItems(userId, { projectId, status });
    if (items.length === 0) return { success: true, data: [], display: '_Keine offenen Punkte._' };
    // v871.2 — N+1-Fix: vorher getById pro Item (445 Items → 445 Queries).
    // Jetzt: Projektnamen einmal pro DISTINCT projectId auflösen.
    const nameByProjectId = new Map<string, string>();
    for (const pid of new Set(items.map(i => i.projectId))) {
      try {
        const p = await this.repo.getById(userId, pid);
        nameByProjectId.set(pid, p?.name ?? '?');
      } catch { nameByProjectId.set(pid, '?'); }
    }
    const lines = items.map(it =>
      `- ${this.priorityIcon(it.priority)} **${it.title}** _(${nameByProjectId.get(it.projectId) ?? '?'})_ · ID: ${it.id.slice(0, 8)}`);
    return { success: true, data: items, display: `## Offene Punkte (${items.length})\n\n${lines.join('\n')}` };
  }

  private async addOpenItem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    const title = input.title as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    if (!title || title.trim().length === 0) return { success: false, error: 'title erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const priority = (input.priority as 'low' | 'normal' | 'high' | undefined) ?? 'normal';
    const item = await this.repo.addOpenItem(project.id, {
      title: title.trim(),
      description: input.description as string | undefined,
      priority,
    });
    return {
      success: true, data: item,
      display: `✓ Open-Item zu **${project.name}** hinzugefügt: ${title.trim()}`,
    };
  }

  private async resolveOpenItem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const itemId = input.item_id as string | undefined;
    const status = (input.item_status as OpenItemStatus | undefined) ?? 'done';
    if (!itemId) return { success: false, error: 'item_id erforderlich.' };
    // Verify the open item belongs to the user via JOIN
    const items = await this.repo.listOpenItems(userId, { limit: 1000 });
    const item = items.find(it => it.id === itemId || it.id.startsWith(itemId));
    if (!item) return { success: false, error: `Open-Item "${itemId}" nicht gefunden.` };
    await this.repo.updateOpenItemStatus(item.id, status);

    // v602 P4 — Cross-Domain Cascade: if this item is linked to an ITSM-incident
    // and status went to done/cancelled, also mark the incident as resolved.
    if (item.linkedIncidentId && (status === 'done' || status === 'cancelled') && this.incidentCascade) {
      try {
        await this.incidentCascade(item.linkedIncidentId, status === 'done' ? 'resolved' : 'closed');
      } catch { /* non-critical */ }
    }
    return {
      success: true, data: { id: item.id, status },
      display: `✓ "${item.title}" → ${status}.`,
    };
  }

  private async listSessions(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const sessions = await this.repo.listSessions(project.id, 50);
    if (sessions.length === 0) return { success: true, data: [], display: '_Keine Sessions._' };
    const lines = sessions.map(s => {
      const what = s.summary?.whatWasDone ?? '—';
      return `- **${s.sessionType}** · ${this.relativeTime(s.startedAt)} · ${what.slice(0, 200)}`;
    });
    return { success: true, data: sessions, display: `## Sessions: ${project.name}\n\n${lines.join('\n')}` };
  }

  private async listDecisions(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    const decisions = await this.repo.listDecisions(project.id, 50);
    if (decisions.length === 0) return { success: true, data: [], display: '_Keine Entscheidungen._' };
    const lines = decisions.map(d =>
      `- **${d.choice}** (${this.relativeTime(d.createdAt)})${d.rationale ? `\n  _${d.rationale}_` : ''}`,
    );
    return { success: true, data: decisions, display: `## Entscheidungen: ${project.name}\n\n${lines.join('\n')}` };
  }

  private async archiveProject(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.project_id as string | undefined;
    if (!id) return { success: false, error: 'project_id erforderlich.' };
    const project = await this.resolveProject(userId, id);
    if (!project) return { success: false, error: `Projekt "${id}" nicht gefunden.` };
    await this.repo.update(userId, project.id, { status: 'archived' });
    return { success: true, display: `✓ Projekt **${project.name}** archiviert.` };
  }

  private async resolveProject(userId: string, idOrSlug: string): Promise<Project | null> {
    const byId = await this.repo.getById(userId, idOrSlug);
    if (byId) return byId;
    return this.repo.getBySlug(userId, idOrSlug);
  }

  private async formatOpenItem(userId: string, it: ProjectOpenItem): Promise<string> {
    const project = await this.repo.getById(userId, it.projectId);
    const pname = project?.name ?? '?';
    return `- ${this.priorityIcon(it.priority)} **${it.title}** _(${pname})_ · ID: ${it.id.slice(0, 8)}`;
  }

  private priorityIcon(p: string): string {
    if (p === 'high') return '🔴';
    if (p === 'low') return '⚪';
    return '🟡';
  }

  private relativeTime(iso?: string): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return iso.slice(0, 10);
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'gerade eben';
    const m = Math.floor(s / 60);
    if (m < 60) return `vor ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `vor ${h}h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `vor ${d}d`;
    const mo = Math.floor(d / 30);
    return `vor ${mo}mo`;
  }

  /**
   * v641 — Project-Agent mit den ausgewählten Open-Items als Goal starten.
   * Wenn `item_ids` fehlt: nimm alle 'open'-Items des Projekts (capped auf max_items, default 10).
   * Sortierung: high priority zuerst, dann älteste zuerst.
   */
  private async workOnOpenItems(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.startProjectAgent) return { success: false, error: 'Project-Agent-Starter nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };

    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd → Project-Agent kann nicht starten' };

    const requestedIds = input.item_ids as string[] | undefined;
    const maxItems = (input.max_items as number) ?? 10;

    let items = await this.repo.listOpenItemsForProject(projectId, ['open', 'in_progress']);
    // v875 — blockierte Items überspringen: eine Abhängigkeit (depends_on)
    // blockiert, solange sie nicht done/cancelled ist. Deterministisch hier,
    // nicht nur als Prompt-Hinweis.
    let skippedBlocked: string[] = [];
    {
      const allActive = items;
      const activeIds = new Map(allActive.map(i => [i.id, i]));
      const isBlocked = (it: { dependsOn?: string[] }): boolean =>
        (it.dependsOn ?? []).some(depId => activeIds.has(depId)); // aktive (open/in_progress) Abhängigkeit = blockiert
      skippedBlocked = allActive.filter(isBlocked).map(i => i.title);
      items = allActive.filter(i => !isBlocked(i));
    }
    if (requestedIds && requestedIds.length > 0) {
      items = items.filter(i => requestedIds.includes(i.id) || requestedIds.some(p => i.id.startsWith(p)));
    }
    // Sort: high prio first, then oldest first
    items.sort((a, b) => {
      const pri = { high: 0, normal: 1, low: 2 } as Record<string, number>;
      const dp = (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
      if (dp !== 0) return dp;
      return a.createdAt.localeCompare(b.createdAt);
    });
    items = items.slice(0, maxItems);
    if (items.length === 0) {
      return {
        success: false,
        error: skippedBlocked.length > 0
          ? `Keine abarbeitbaren Items: ${skippedBlocked.length} sind durch Abhängigkeiten blockiert (${skippedBlocked.slice(0, 3).join(' | ').slice(0, 200)}${skippedBlocked.length > 3 ? ' …' : ''}). Erst die Abhängigkeiten erledigen.`
          : 'Keine offenen Items zum Abarbeiten gefunden',
      };
    }

    // Fallback-Goal (Template) — wird genutzt wenn die LLM-Aufbereitung scheitert
    const templateGoal = [
      `Arbeite die folgenden offenen Punkte des Projekts "${project.name}" ab. Pro Punkt: prüfe ob er noch zutrifft, implementiere die Änderung sauber, schreibe ggf. Tests. Halte dich an den bestehenden Code-Stil im Repo.`,
      '',
      ...items.map((it, idx) => {
        const lines = [`${idx + 1}. **${it.title}**`];
        if (it.description) lines.push(`   ${it.description}`);
        if (it.priority === 'high') lines.push('   _(high priority)_');
        return lines.join('\n');
      }),
      '',
      `Wenn ein Punkt nicht (mehr) zutrifft, dokumentiere kurz warum statt ihn blind umzusetzen.`,
    ].join('\n');

    // v869 — Triage + LLM-Goal: gleiche Regel wie der Chat-Prompt-Builder.
    // 1-2 einfache, fokussierte Items → code_agent (1 Subprozess, schneller,
    // kein File-Thrash-Risiko). Mehr/komplexer → project_agent mit präzise
    // formuliertem Auftrag statt Roh-Template. force_agent übersteuert.
    const forceAgent = input.force_agent as 'project' | 'code' | undefined;
    let mode: 'project' | 'code' = 'project';
    let goal = templateGoal;
    if (this.llmAuditCallback) {
      try {
        const triagePrompt = [
          `Du bereitest offene Projekt-Punkte für einen Coding-Agent auf. Projekt: "${project.name}".`,
          '',
          'ITEMS:',
          ...items.map((it, i) => `${i + 1}. ${it.title}${it.description ? ` — ${it.description}` : ''}${it.priority === 'high' ? ' (high prio)' : ''}`),
          '',
          'Entscheide:',
          '- mode "code": NUR wenn 1-2 Items UND alle klar umrissene, fokussierte Einzel-Fixes sind (Bug-Fix, kleine UI-Korrektur, einzelne Datei-Änderung) die KEINEN Multi-Phase-Plan brauchen.',
          '- mode "project": bei allem anderen (mehrere Items, Feature-Arbeit, Datenmodell/Migration, unklarer Scope).',
          '',
          'Formuliere zusätzlich einen präzisen Arbeitsauftrag (deutsch) für den Agent: konkret was zu tun ist, erwartetes Verhalten, was NICHT angefasst werden soll. Erfinde nichts dazu, was nicht in den Items steht.',
          '',
          'Antworte NUR mit validem JSON: {"mode": "code"|"project", "goal": "Arbeitsauftrag…"}',
        ].join('\n');
        const raw = await this.llmAuditCallback(triagePrompt, 'fast');
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { mode?: string; goal?: string };
          if (parsed.goal && parsed.goal.trim().length > 20) {
            goal = `${parsed.goal.trim()}\n\nBetroffene offene Punkte:\n${items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')}\n\nWenn ein Punkt nicht (mehr) zutrifft, dokumentiere kurz warum statt ihn blind umzusetzen.`;
          }
          if (parsed.mode === 'code' && items.length <= 2) mode = 'code';
        }
      } catch { /* Triage best-effort — Fallback: project_agent + Template */ }
    }
    if (forceAgent === 'project') mode = 'project';
    if (forceAgent === 'code') mode = 'code';
    if (mode === 'code' && !this.runCodeAgent) mode = 'project'; // Runner nicht verkabelt

    const itemIds = items.map(i => i.id);

    // v869.3 — Code-Agent-Pfad: ASYNC mit Live-Output. v869 lief synchron — der
    // WebUI-Button hing minutenlang am HTTP-Request (Vorfall 11.06., 195s-Lauf;
    // Läufe >5min wären in den Request-Timeout gelaufen). Jetzt: sofortige
    // Antwort mit liveTaskId (SSE-Panel), Items → in_progress, Continuation
    // markiert done bzw. re-opened mit Notiz + Telegram-Meldung.
    if (mode === 'code' && this.runCodeAgent) {
      const alreadyRunning = this.runningCodeJobs.get(projectId);
      if (alreadyRunning) {
        return {
          success: false,
          error: `Für dieses Projekt läuft bereits ein Open-Items-Code-Lauf (${alreadyRunning.slice(0, 8)}). Bitte warten, bis er fertig ist.`,
        };
      }
      const liveTaskId = randomUUID();
      this.runningCodeJobs.set(projectId, liveTaskId);
      // v871.1 — v705-Marker statt nacktem in_progress: `implementing:<taskId>`
      // macht die Items dem Startup-Aufräumer zuordenbar (Restart mitten im
      // Lauf → automatischer Revert auf open statt ewig in_progress).
      try { await this.repo.markItemsWorkingOnSession(itemIds, liveTaskId); } catch { /* best-effort */ }
      appendOutputLine(liveTaskId, 'system',
        `🚀 Code-Agent gestartet — ${items.length} Item(s): ${items.map(i => i.title).join(' | ').slice(0, 300)}`);

      const itemsSnapshot = items.map(i => ({ id: i.id, title: i.title, description: i.description }));
      const projectName = project.name;
      const cwd = project.cwd;
      // v869.4 — Schicht 1 (Prompt): Agent soll selbst committen (fachlich gute
      // Message). Push übernimmt deterministisch das Sicherungsnetz unten.
      const codeGoal = `${goal}\n\nAbschluss: Committe deine Änderungen mit aussagekräftiger Conventional-Commits-Message (fix(scope): …). Kein Push nötig — der erfolgt automatisch. Wenn nichts zu ändern war: kein Commit, dokumentiere kurz warum.`;
      void (async () => {
        try {
          const result = await this.runCodeAgent!({ cwd, prompt: codeGoal, taskId: liveTaskId, projectId });
          if (result.success) {
            // v871.1 — v705-Success-Pfad: setzt done + `implemented:<taskId>`-Marker
            let marked = 0;
            try { marked = await this.repo.resolveItemsForSession(liveTaskId, 0.95); } catch { /* fallback unten */ }
            if (marked === 0) {
              for (const it of itemsSnapshot) {
                try { if (await this.repo.updateOpenItemStatus(it.id, 'done')) marked++; } catch { /* skip */ }
              }
            }
            // v869.4 — Schicht 2 (deterministisch): Änderungen ins Remote sichern.
            // code_agent.push committet nur bei dirty Tree (kein Leer-Commit) und
            // pusht den aktuellen Branch (no-op wenn der Agent schon gepusht hat).
            // "Weich" (User-Entscheid): Items bleiben done auch bei Push-Fehlschlag —
            // dann aber laute Warnung mit Kontext.
            let secureNote = '';
            if (this.pushProject) {
              try {
                if (!existsSync(path.join(cwd, '.git'))) {
                  secureNote = '⚠️ Kein Git-Repo im Projekt — Commit/Push übersprungen.';
                } else {
                  const commitMsg = `fix: ${itemsSnapshot.map(i => i.title).join(' | ').slice(0, 140)}`;
                  const push = await this.pushProject({ cwd, commitMessage: commitMsg });
                  secureNote = push.success
                    ? `📤 Gesichert: ${push.summary}`
                    : `⚠️ Push fehlgeschlagen — Änderungen liegen lokal, bitte manuell pushen. ${push.summary}`;
                }
              } catch (err) {
                secureNote = `⚠️ Sicherungs-Push fehlgeschlagen: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)} — Änderungen liegen lokal.`;
              }
            }
            appendOutputLine(liveTaskId, 'system', `✅ Fertig — ${marked} Item(s) als erledigt markiert.${secureNote ? `\n${secureNote}` : ''}`);
            this.ownerNotify?.(`✅ Open-Items-Fix fertig (${projectName}): ${itemsSnapshot.map(i => i.title).join(' | ').slice(0, 300)} — ${marked} Item(s) erledigt markiert.${secureNote ? `\n${secureNote}` : ''}`);
          } else {
            // Fehlschlag: zurück auf open + datierte Notiz (Kontext für nächsten Versuch)
            // v871.1 — revertItemsForSession räumt auch den implementing:-Marker ab
            const dateStr = new Date().toISOString().slice(0, 10);
            for (const it of itemsSnapshot) {
              try {
                await this.repo.updateOpenItemFields(it.id, {
                  description: `${it.description ? `${it.description}\n\n` : ''}[Code-Agent-Lauf ${dateStr} fehlgeschlagen: ${result.output.slice(-200)}]`,
                });
              } catch { /* skip */ }
            }
            try { await this.repo.revertItemsForSession(liveTaskId); } catch {
              for (const it of itemsSnapshot) {
                try { await this.repo.updateOpenItemStatus(it.id, 'open'); } catch { /* skip */ }
              }
            }
            appendOutputLine(liveTaskId, 'system', `❌ Fehlgeschlagen — Items wieder geöffnet (mit Notiz). Output-Ende: ${result.output.slice(-400)}`);
            this.ownerNotify?.(`❌ Open-Items-Fix fehlgeschlagen (${projectName}): ${itemsSnapshot.map(i => i.title).join(' | ').slice(0, 200)}\nOutput-Ende: ${result.output.slice(-400)}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // v871.1 — revertItemsForSession räumt Status + implementing:-Marker ab
          try { await this.repo.revertItemsForSession(liveTaskId); } catch {
            for (const it of itemsSnapshot) {
              try { await this.repo.updateOpenItemStatus(it.id, 'open'); } catch { /* skip */ }
            }
          }
          appendOutputLine(liveTaskId, 'system', `❌ Lauf-Fehler: ${msg.slice(0, 300)} — Items wieder geöffnet.`);
          this.ownerNotify?.(`❌ Open-Items-Fix Fehler (${projectName}): ${msg.slice(0, 300)}`);
        } finally {
          this.runningCodeJobs.delete(projectId);
          try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
        }
      })();

      return {
        success: true,
        data: { mode: 'code', liveTaskId, projectId, items: itemIds },
        display: `🚀 Code-Agent gestartet (Hintergrund) — ${items.length} Item(s) auf "in Arbeit". Live-Output im Panel; bei Erfolg automatisch erledigt, bei Fehlschlag mit Notiz wieder geöffnet. Telegram-Meldung folgt.${skippedBlocked.length > 0 ? `\n⛓ ${skippedBlocked.length} Item(s) wegen offener Abhängigkeiten übersprungen.` : ''}`,
      };
    }

    try {
      // v869 — mentionedItemIds durchreichen: der v731-Auto-Done-Mechanismus
      // markiert nach erfolgreichem Run GENAU diese Items als done.
      const { taskId } = await this.startProjectAgent({ cwd: project.cwd, goal, projectId, mentionedItemIds: itemIds });
      return {
        success: true,
        data: { mode: 'project', taskId, projectId, items: itemIds },
        display: `▶ Project-Agent gestartet (taskId ${taskId.slice(0, 8)}) mit ${items.length} Item(s).\n\nNach erfolgreichem Abschluss werden genau diese Items automatisch als erledigt markiert.${skippedBlocked.length > 0 ? `\n⛓ ${skippedBlocked.length} Item(s) wegen offener Abhängigkeiten übersprungen.` : ''}`,
      };
    } catch (err) {
      return { success: false, error: `Project-Agent-Start fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** v870 — Deep-Verify-Resultate pro liveTaskId (in-memory, TTL 30 min).
   *  Die UI pollt das Ergebnis nach Lauf-Ende über den Result-Endpoint. */
  private deepVerifyResults = new Map<string, { status: 'running' | 'done' | 'failed'; findings: DeepVerifyFinding[]; error?: string; ts: number }>();
  private runningVerifyJobs = new Map<string, string>();

  getDeepVerifyResult(taskId: string): { status: 'running' | 'done' | 'failed'; findings: DeepVerifyFinding[]; error?: string } | null {
    // TTL-Cleanup nebenbei
    const cutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.deepVerifyResults) {
      if (v.ts < cutoff) this.deepVerifyResults.delete(k);
    }
    const r = this.deepVerifyResults.get(taskId);
    return r ? { status: r.status, findings: r.findings, error: r.error } : null;
  }

  /**
   * v870 — Deep-Verify: markierte (oder alle) offenen Items READ-ONLY gegen die
   * AKTUELLE Codebase prüfen. Re-Match kennt nur den letzten Lauf, das Audit-LLM
   * nur Commit-Messages + Dateinamen — hier liest ein code_agent-Lauf den Code
   * wirklich (Grep/Read) und liefert pro Item ein belegtes Verdikt. Ergebnis
   * wird NICHT automatisch angewendet — die UI zeigt es im Modal mit
   * Bulk-Aktionen (User entscheidet).
   */
  /**
   * v873 — Dependency-Update-Lauf: async Code-Agent aktualisiert outdated Deps
   * (alle oder eine Teilmenge) und verifiziert per Install + Build/Tests.
   * Gleiche Mechanik wie der Open-Items-Code-Pfad (v869.3): sofortige Antwort
   * mit liveTaskId (SSE-Panel), runningCodeJobs-Guard (max. 1 Code-Lauf pro
   * Projekt), pushProject-Sicherungsnetz (v869.4), Owner-Telegram am Ende.
   */
  private async updateDependencies(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.runCodeAgent) return { success: false, error: 'Code-Agent-Runner nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd' };
    if (!existsSync(project.cwd)) return { success: false, error: `cwd existiert nicht: ${project.cwd}` };
    if (!existsSync(path.join(project.cwd, 'package.json'))) {
      return { success: false, error: 'Kein package.json im Projekt — Dependency-Update aktuell nur für Node-Projekte' };
    }

    const alreadyRunning = this.runningCodeJobs.get(projectId);
    if (alreadyRunning) {
      return { success: false, error: `Für dieses Projekt läuft bereits ein Code-Lauf (${alreadyRunning.slice(0, 8)}). Bitte warten.` };
    }

    const packages = Array.isArray(input.packages)
      ? (input.packages as unknown[]).filter((p): p is string => typeof p === 'string' && /^[@a-z0-9._/-]+$/i.test(p)).slice(0, 50)
      : [];

    const prompt = [
      `Aktualisiere die veralteten npm-Dependencies des Projekts "${project.name}".`,
      packages.length > 0
        ? `NUR diese Pakete: ${packages.join(', ')}`
        : `Ermittle die veralteten direkten Dependencies selbst (z.B. \`npm outdated --depth=0\`).`,
      ``,
      `Regeln:`,
      `- Konservativ: bevorzuge Updates innerhalb der bestehenden Semver-Range (wanted). Major-Bumps nur, wenn der Changelog/Breaking-Umfang überschaubar ist UND Build + Tests danach grün sind — sonst auslassen und im Abschluss-Kommentar dokumentieren.`,
      `- Nach den Updates: Install ausführen, dann Build und (falls vorhanden) Tests laufen lassen. Schlägt etwas fehl: betroffenes Update zurücknehmen statt den Build kaputt zu hinterlassen.`,
      `- Lockfile mitcommitten.`,
      `- Abschluss: Committe mit aussagekräftiger Message (chore(deps): …). Kein Push nötig — der erfolgt automatisch.`,
      `- Wenn nichts zu aktualisieren war: kein Commit, kurz dokumentieren warum.`,
    ].join('\n');

    const liveTaskId = randomUUID();
    this.runningCodeJobs.set(projectId, liveTaskId);
    appendOutputLine(liveTaskId, 'system',
      `📦 Dependency-Update gestartet — ${packages.length > 0 ? packages.join(', ').slice(0, 300) : 'alle veralteten direkten Dependencies'}.`);

    const projectName = project.name;
    const cwd = project.cwd;
    void (async () => {
      try {
        const result = await this.runCodeAgent!({ cwd, prompt, taskId: liveTaskId, projectId });
        if (result.success) {
          let secureNote = '';
          if (this.pushProject) {
            try {
              const push = await this.pushProject({ cwd, commitMessage: `chore(deps): Dependency-Updates${packages.length > 0 ? ` (${packages.join(', ').slice(0, 100)})` : ''}` });
              secureNote = push.success
                ? `📤 Gesichert: ${push.summary}`
                : `⚠️ Push fehlgeschlagen — Änderungen liegen lokal. ${push.summary}`;
            } catch (err) {
              secureNote = `⚠️ Sicherungs-Push fehlgeschlagen: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}`;
            }
          }
          appendOutputLine(liveTaskId, 'system', `✅ Dependency-Update fertig.${secureNote ? `\n${secureNote}` : ''}`);
          this.ownerNotify?.(`✅ Dependency-Update fertig (${projectName}).${secureNote ? `\n${secureNote}` : ''}`);
        } else {
          appendOutputLine(liveTaskId, 'system', `❌ Dependency-Update fehlgeschlagen. Output-Ende: ${result.output.slice(-400)}`);
          this.ownerNotify?.(`❌ Dependency-Update fehlgeschlagen (${projectName}). Output-Ende: ${result.output.slice(-300)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutputLine(liveTaskId, 'system', `❌ Lauf-Fehler: ${msg.slice(0, 300)}`);
        this.ownerNotify?.(`❌ Dependency-Update Fehler (${projectName}): ${msg.slice(0, 300)}`);
      } finally {
        this.runningCodeJobs.delete(projectId);
        try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
      }
    })();

    return {
      success: true,
      data: { liveTaskId, projectId },
      display: `📦 Dependency-Update gestartet (Hintergrund) — Live-Output im Panel, Telegram-Meldung am Ende.`,
    };
  }

  /** v879 — Ergebnisse der Codebase-Reviews (TTL-Sweep wie Deep-Verify). */
  private reviewResults = new Map<string, { status: 'running' | 'done' | 'failed'; findings: ReviewFinding[]; reviewAgent?: string; error?: string; ts: number }>();

  getReviewResult(taskId: string): { status: 'running' | 'done' | 'failed'; findings: ReviewFinding[]; reviewAgent?: string; error?: string } | null {
    const r = this.reviewResults.get(taskId);
    if (!r) return null;
    return { status: r.status, findings: r.findings, reviewAgent: r.reviewAgent, error: r.error };
  }

  /**
   * v879 — Codebase-Review: Standard- (oder gewählter) CLI-Agent reviewt das
   * Repo read-only entlang des Scopes (Default: Security, Bugs, Lücken,
   * Qualität), hinterfragt seine Befunde selbst (zweistufiger Prompt) und
   * schreibt ein Review-Doc nach docs/. Optional prüfen 1–2 ANDERE Agents die
   * Befunde adversarial gegen (REFUTE-Auftrag). Ergebnis landet im
   * reviewResults-Store — die Ableitung in Items + Roadmap macht der User im
   * Ergebnis-Modal (nichts wird automatisch angelegt).
   */
  private async reviewCodebase(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.runCodeAgent) return { success: false, error: 'Code-Agent-Runner nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd' };
    if (!existsSync(project.cwd)) return { success: false, error: `cwd existiert nicht: ${project.cwd}` };

    const alreadyRunning = this.runningCodeJobs.get(projectId);
    if (alreadyRunning) {
      return { success: false, error: `Für dieses Projekt läuft bereits ein Code-Lauf (${alreadyRunning.slice(0, 8)}). Bitte warten.` };
    }

    const scope = typeof input.scope === 'string' && input.scope.trim().length > 0
      ? input.scope.trim().slice(0, 500)
      : 'Security (Auth, Permissions, Injection, Secrets), Bugs (Logikfehler, Race-Conditions, Fehlerbehandlung), Lücken (fehlende Validierung, unvollständige Features, tote Pfade), Qualität (Konsistenz, Test-Abdeckung kritischer Pfade)';
    const reviewAgent = typeof input.review_agent === 'string' && input.review_agent.trim() ? input.review_agent.trim() : undefined;
    const crossCheckAgents = Array.isArray(input.cross_check_agents)
      ? (input.cross_check_agents as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 2)
      : [];

    const dateStr = new Date().toISOString().slice(0, 10);
    const reviewPrompt = [
      `Du bist ein gründlicher, skeptischer Code-Reviewer. Analysiere die Codebase des Projekts "${project.name}" READ-ONLY.`,
      `Einzige erlaubte Schreiboperation: EIN Review-Dokument unter docs/codebase-review-${dateStr}.md erstellen und committen (docs(review): …). KEINE Code-Änderungen, KEIN Push.`,
      ``,
      `SCOPE: ${scope}`,
      ``,
      `VORGEHEN (zweistufig, WICHTIG):`,
      `1. SAMMELN: Untersuche systematisch (API-Routen, Auth/Permissions, DB/Migrationen, Input-Validierung, Fehlerbehandlung, Secrets/Konfiguration, kritische Pfade ohne Tests). Notiere Kandidaten mit Datei:Zeile.`,
      `2. SELBST-HINTERFRAGEN: Prüfe JEDEN Kandidaten adversarial gegen den Code: Stimmt die Fundstelle wirklich? Echtes Problem oder bewusste Design-Entscheidung (Kommentare/Tests/Doku dazu lesen)? Bereits anderswo abgesichert? Verwirf alles ohne harten Beleg. Setze confidence ehrlich.`,
      ``,
      `Schreibe die BESTÄTIGTEN Befunde strukturiert ins Review-Dokument (nach Severity gruppiert, mit Fundstellen) und committe es.`,
      ``,
      `Antworte AM ENDE mit GENAU EINEM JSON-Array (Markdown-Fences erlaubt):`,
      `[{"title":"kurz und umsetzbar (max 150 Zeichen)","kind":"security|bug|gap|quality","severity":"critical|high|medium|low","evidence":"Datei:Zeile + 1 Satz Beleg","confidence":0.0-1.0,"suggestedMilestone":"kurzer Milestone-Name (z.B. 'Review: Security')"}]`,
      `Maximal 25 Befunde — die wichtigsten zuerst. Wenn nichts gefunden: [].`,
    ].join('\n');

    const liveTaskId = randomUUID();
    this.runningCodeJobs.set(projectId, liveTaskId);
    const sweepCutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.reviewResults) {
      if (v.ts < sweepCutoff) this.reviewResults.delete(k);
    }
    this.reviewResults.set(liveTaskId, { status: 'running', findings: [], reviewAgent, ts: Date.now() });
    appendOutputLine(liveTaskId, 'system',
      `🔍 Codebase-Review gestartet (${reviewAgent ?? 'Standard-Agent'}) — Scope: ${scope.slice(0, 120)}…${crossCheckAgents.length > 0 ? ` Gegenprüfung: ${crossCheckAgents.join(', ')}.` : ''}`);

    const projectName = project.name;
    const cwd = project.cwd;
    void (async () => {
      try {
        const result = await this.runCodeAgent!({ cwd, prompt: reviewPrompt, taskId: liveTaskId, agent: reviewAgent, projectId });
        if (!result.success) {
          this.reviewResults.set(liveTaskId, { status: 'failed', findings: [], reviewAgent, error: `Review-Lauf fehlgeschlagen: ${result.output.slice(-300)}`, ts: Date.now() });
          appendOutputLine(liveTaskId, 'system', `❌ Review-Lauf fehlgeschlagen. Output-Ende: ${result.output.slice(-400)}`);
          this.ownerNotify?.(`❌ Codebase-Review fehlgeschlagen (${projectName}).`);
          return;
        }
        const findings = parseReviewFindings(result.output);
        appendOutputLine(liveTaskId, 'system', `📋 Review fertig — ${findings.length} Befund(e).`);

        // Review-Doc sichern (committet der Agent selbst; Push deterministisch hier)
        if (this.pushProject) {
          try {
            const push = await this.pushProject({ cwd, commitMessage: `docs(review): Codebase-Review ${dateStr}` });
            appendOutputLine(liveTaskId, 'system', push.success ? `📤 Review-Doc gesichert: ${push.summary}` : `⚠️ Push fehlgeschlagen: ${push.summary}`);
          } catch { /* best-effort */ }
        }

        // v879 — optionale Gegenprüfung durch ANDERE Agents (adversarial: REFUTE)
        if (findings.length > 0 && crossCheckAgents.length > 0) {
          const validIds = new Set(findings.map(f => f.id));
          const crossPrompt = [
            `Du bist ein unabhängiger Gegenprüfer. Ein anderer Agent hat beim Codebase-Review des Projekts "${projectName}" die folgenden Befunde gemeldet.`,
            `Deine Aufgabe: VERSUCHE SIE ZU WIDERLEGEN. Prüfe jeden Befund READ-ONLY direkt im Code (Fundstelle öffnen, Kontext lesen). Bestätige NUR mit eigenem Beleg. KEINE Dateiänderungen, KEINE Commits.`,
            ``,
            `BEFUNDE:`,
            JSON.stringify(findings.map(f => ({ id: f.id, title: f.title, evidence: f.evidence })), null, 1),
            ``,
            `Antworte AM ENDE mit GENAU EINEM JSON-Array: [{"id":"<id>","verdict":"confirmed|refuted|unclear","note":"1 Satz Beleg/Begründung"}]`,
            `Jede id genau einmal. verdict "refuted" NUR wenn du konkret belegen kannst, warum der Befund falsch ist.`,
          ].join('\n');
          for (const agent of crossCheckAgents) {
            appendOutputLine(liveTaskId, 'system', `🧪 Gegenprüfung durch ${agent} läuft…`);
            try {
              const cc = await this.runCodeAgent!({ cwd, prompt: crossPrompt, taskId: liveTaskId, agent, projectId });
              const verdicts = cc.success ? parseCrossCheckVerdicts(cc.output, validIds) : [];
              if (verdicts.length === 0) {
                appendOutputLine(liveTaskId, 'system', `⚠️ ${agent}: kein parsebares Verdikt — wird im Ergebnis als "unclear" geführt.`);
              }
              for (const f of findings) {
                const v = verdicts.find(x => x.id === f.id);
                (f.crossChecks ??= []).push(v
                  ? { agent, verdict: v.verdict, note: v.note }
                  : { agent, verdict: 'unclear', note: cc.success ? 'kein Verdikt geliefert' : 'Gegenprüf-Lauf fehlgeschlagen' });
              }
              const confirmed = verdicts.filter(v => v.verdict === 'confirmed').length;
              const refuted = verdicts.filter(v => v.verdict === 'refuted').length;
              appendOutputLine(liveTaskId, 'system', `🧪 ${agent}: ${confirmed} bestätigt, ${refuted} widerlegt, ${findings.length - confirmed - refuted} unklar.`);
            } catch (err) {
              appendOutputLine(liveTaskId, 'system', `⚠️ Gegenprüfung ${agent} fehlgeschlagen: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
              for (const f of findings) (f.crossChecks ??= []).push({ agent, verdict: 'unclear', note: 'Lauf-Fehler' });
            }
          }
        }

        this.reviewResults.set(liveTaskId, { status: 'done', findings, reviewAgent, ts: Date.now() });
        appendOutputLine(liveTaskId, 'system', `✅ Codebase-Review abgeschlossen — ${findings.length} Befund(e). Ergebnis-Modal öffnet sich.`);
        this.ownerNotify?.(`✅ Codebase-Review fertig (${projectName}): ${findings.length} Befund(e)${crossCheckAgents.length > 0 ? `, gegengeprüft von ${crossCheckAgents.join(', ')}` : ''}. Übernahme in Items/Roadmap in der WebUI.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.reviewResults.set(liveTaskId, { status: 'failed', findings: [], reviewAgent, error: msg.slice(0, 300), ts: Date.now() });
        appendOutputLine(liveTaskId, 'system', `❌ Lauf-Fehler: ${msg.slice(0, 300)}`);
        this.ownerNotify?.(`❌ Codebase-Review Fehler (${projectName}): ${msg.slice(0, 300)}`);
      } finally {
        this.runningCodeJobs.delete(projectId);
        try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
      }
    })();

    return {
      success: true,
      data: { liveTaskId, projectId, reviewAgent: reviewAgent ?? null, crossCheckAgents },
      display: `🔍 Codebase-Review gestartet (Hintergrund) — Live-Output im Panel, Ergebnis-Modal nach Abschluss. Es wird NICHTS automatisch geändert (nur ein Review-Doc in docs/).`,
    };
  }

  /** v880 — Ergebnisse der Feature-Discovery-Läufe (TTL-Sweep wie Review). */
  private suggestResults = new Map<string, { status: 'running' | 'done' | 'failed'; suggestions: FeatureSuggestion[]; error?: string; ts: number }>();

  getSuggestResult(taskId: string): { status: 'running' | 'done' | 'failed'; suggestions: FeatureSuggestion[]; error?: string } | null {
    const r = this.suggestResults.get(taskId);
    if (!r) return null;
    return { status: r.status, suggestions: r.suggestions, error: r.error };
  }

  /**
   * v880 — Feature-Discovery: 1–2 CLI-Agents analysieren das Repo read-only
   * und schlagen nützliche neue Features vor. Bestand wird mitgegeben
   * (vorhandene + abgelehnte Features, offene Items) damit nichts doppelt
   * oder erneut Abgelehntes kommt. Bei 2 Agents werden die Vorschläge per
   * Titel-Containment gemerged — was BEIDE unabhängig vorschlagen, trägt
   * beide Namen (starkes Signal fürs Modal).
   */
  private async suggestFeatures(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.runCodeAgent) return { success: false, error: 'Code-Agent-Runner nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd' };
    if (!existsSync(project.cwd)) return { success: false, error: `cwd existiert nicht: ${project.cwd}` };

    const alreadyRunning = this.runningCodeJobs.get(projectId);
    if (alreadyRunning) {
      return { success: false, error: `Für dieses Projekt läuft bereits ein Code-Lauf (${alreadyRunning.slice(0, 8)}). Bitte warten.` };
    }

    const focus = typeof input.focus === 'string' && input.focus.trim() ? input.focus.trim().slice(0, 300) : undefined;
    const agents = Array.isArray(input.agents)
      ? (input.agents as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 2)
      : [];
    const runAgents: Array<string | undefined> = agents.length > 0 ? agents : [undefined];
    const knownFeatures = Array.isArray(input.known_features)
      ? (input.known_features as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 60)
      : [];
    const rejectedFeatures = Array.isArray(input.rejected_features)
      ? (input.rejected_features as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 60)
      : [];
    const openItems = await this.repo.listOpenItemsForProject(projectId, ['open', 'in_progress']).catch(() => []);
    const openTitles = openItems.map(i => i.title).slice(0, 60);

    const prompt = [
      `Du bist ein Produkt-Berater mit Code-Zugriff. Analysiere das Projekt "${project.name}" READ-ONLY (KEINE Dateiänderungen, KEINE Commits) und schlage 5-10 NÜTZLICHE neue Features vor.`,
      ``,
      `FOKUS: ${focus ?? 'allgemein — was bringt den Nutzern/Betreibern dieses Projekts am meisten?'}`,
      ``,
      knownFeatures.length > 0 ? `BEREITS VORHANDEN (NICHT vorschlagen):\n${knownFeatures.map(f => `- ${f}`).join('\n')}` : '',
      rejectedFeatures.length > 0 ? `BEREITS ABGELEHNT (NIEMALS wieder vorschlagen):\n${rejectedFeatures.map(f => `- ${f}`).join('\n')}` : '',
      openTitles.length > 0 ? `BEREITS GEPLANT (offene Punkte, nicht doppeln):\n${openTitles.map(t => `- ${t}`).join('\n')}` : '',
      ``,
      `VORGEHEN:`,
      `1. Verschaffe dir einen echten Überblick (README, Routen/API, Datenmodelle, UI-Seiten).`,
      `2. SELBST-HINTERFRAGEN pro Idee: Existiert das schon (im Code nachsehen!)? Passt es zu Stack und Zielgruppe? Steht es in den Listen oben? Verwirf, was nicht besteht.`,
      ``,
      `Antworte AM ENDE mit GENAU EINEM JSON-Array:`,
      `[{"title":"max 120 Zeichen","value":"Nutzen in 1-2 Sätzen","effort":"S|M|L","rationale":"warum DIESES Projekt das braucht, 1-2 Sätze"}]`,
    ].filter(Boolean).join('\n');

    const liveTaskId = randomUUID();
    this.runningCodeJobs.set(projectId, liveTaskId);
    const sweepCutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.suggestResults) {
      if (v.ts < sweepCutoff) this.suggestResults.delete(k);
    }
    this.suggestResults.set(liveTaskId, { status: 'running', suggestions: [], ts: Date.now() });
    appendOutputLine(liveTaskId, 'system',
      `💡 Feature-Discovery gestartet (${runAgents.map(a => a ?? 'Standard-Agent').join(' + ')})${focus ? ` — Fokus: ${focus}` : ''}.`);

    const projectName = project.name;
    const cwd = project.cwd;
    void (async () => {
      try {
        const merged: FeatureSuggestion[] = [];
        let anySuccess = false;
        for (const agent of runAgents) {
          const label = agent ?? 'Standard-Agent';
          appendOutputLine(liveTaskId, 'system', `💡 ${label} analysiert…`);
          try {
            const result = await this.runCodeAgent!({ cwd, prompt, taskId: liveTaskId, agent, projectId });
            if (!result.success) {
              appendOutputLine(liveTaskId, 'system', `⚠️ ${label} fehlgeschlagen. Output-Ende: ${result.output.slice(-200)}`);
              continue;
            }
            anySuccess = true;
            const parsed = parseFeatureSuggestions(result.output);
            appendOutputLine(liveTaskId, 'system', `💡 ${label}: ${parsed.length} Vorschlag/Vorschläge.`);
            for (const s of parsed) {
              // Merge: gleicher Vorschlag von beiden Agents → ein Eintrag, beide Namen
              const existing = merged.find(m => suggestionOverlap(m.title, s.title) >= 0.6);
              if (existing) {
                if (!existing.proposedBy.includes(label)) existing.proposedBy.push(label);
              } else {
                merged.push({ id: `s${merged.length + 1}`, ...s, proposedBy: [label] });
              }
            }
          } catch (err) {
            appendOutputLine(liveTaskId, 'system', `⚠️ ${label} Fehler: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
          }
        }
        if (!anySuccess) {
          this.suggestResults.set(liveTaskId, { status: 'failed', suggestions: [], error: 'Alle Discovery-Läufe fehlgeschlagen', ts: Date.now() });
          appendOutputLine(liveTaskId, 'system', `❌ Feature-Discovery fehlgeschlagen.`);
          this.ownerNotify?.(`❌ Feature-Discovery fehlgeschlagen (${projectName}).`);
          return;
        }
        this.suggestResults.set(liveTaskId, { status: 'done', suggestions: merged, ts: Date.now() });
        appendOutputLine(liveTaskId, 'system', `✅ Feature-Discovery abgeschlossen — ${merged.length} Vorschlag/Vorschläge. Auswahl im Modal.`);
        this.ownerNotify?.(`✅ Feature-Discovery fertig (${projectName}): ${merged.length} Vorschlag/Vorschläge — Annehmen/Ablehnen in der WebUI.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.suggestResults.set(liveTaskId, { status: 'failed', suggestions: [], error: msg.slice(0, 300), ts: Date.now() });
        appendOutputLine(liveTaskId, 'system', `❌ Lauf-Fehler: ${msg.slice(0, 300)}`);
      } finally {
        this.runningCodeJobs.delete(projectId);
        try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
      }
    })();

    return {
      success: true,
      data: { liveTaskId, projectId },
      display: `💡 Feature-Discovery gestartet (Hintergrund) — Vorschläge erscheinen im Modal, nichts wird automatisch angelegt.`,
    };
  }

  /**
   * v880 — Umsetzungsplan für ein ANGENOMMENES Feature: Agent arbeitet den
   * Plan aus (docs/feature-plan-<slug>.md, committet) und liefert Phasen —
   * daraus entstehen Open-Items mit Roadmap-Milestone "Feature: <Titel>",
   * roadmap_order = Phasenreihenfolge und depends_on-Verkettung (Phase N
   * blockiert von Phase N-1). Die Items sind die einzige automatische
   * Anlage — sie folgt der EXPLIZITEN Zustimmung im Vorschlags-Modal.
   */
  private async planFeature(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.runCodeAgent) return { success: false, error: 'Code-Agent-Runner nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd' };
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 150) : '';
    if (!title) return { success: false, error: 'Missing required field "title"' };
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 800) : '';
    const agent = typeof input.agent === 'string' && input.agent.trim() ? input.agent.trim() : undefined;

    const alreadyRunning = this.runningCodeJobs.get(projectId);
    if (alreadyRunning) {
      return { success: false, error: `Für dieses Projekt läuft bereits ein Code-Lauf (${alreadyRunning.slice(0, 8)}). Bitte warten.` };
    }

    const slug = title.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
    const dateStr = new Date().toISOString().slice(0, 10);
    const prompt = [
      `Das Feature "${title}" wurde für das Projekt "${project.name}" beschlossen. Arbeite einen UMSETZUNGSPLAN aus — implementiere NICHTS.`,
      description ? `\nFEATURE-BESCHREIBUNG:\n${description}` : '',
      ``,
      `VORGEHEN:`,
      `1. Analysiere READ-ONLY die relevanten Teile der Codebase (betroffene Routen, Models, UI, bestehende Muster).`,
      `2. Entwirf 3-8 aufeinander aufbauende Arbeitspakete (Phasen) — jedes eigenständig umsetz- und testbar, konkret genug für einen Code-Agent (mit betroffenen Dateien/Bereichen).`,
      `3. Schreibe den Plan als docs/feature-plan-${slug}.md (Überblick, Phasen, Risiken, betroffene Bereiche) und committe NUR dieses Dokument (docs(plan): …). Kein Push.`,
      ``,
      `Antworte AM ENDE mit GENAU EINEM JSON-Array (Reihenfolge = Umsetzungsreihenfolge):`,
      `[{"title":"Arbeitspaket, max 150 Zeichen","description":"was konkret zu tun ist inkl. betroffener Dateien/Bereiche, 2-4 Sätze"}]`,
    ].filter(Boolean).join('\n');

    const liveTaskId = randomUUID();
    this.runningCodeJobs.set(projectId, liveTaskId);
    appendOutputLine(liveTaskId, 'system', `🗺 Umsetzungsplan für "${title}" wird ausgearbeitet…`);

    const projectName = project.name;
    const cwd = project.cwd;
    void (async () => {
      try {
        const result = await this.runCodeAgent!({ cwd, prompt, taskId: liveTaskId, agent, projectId });
        if (!result.success) {
          appendOutputLine(liveTaskId, 'system', `❌ Plan-Lauf fehlgeschlagen. Output-Ende: ${result.output.slice(-300)}`);
          this.ownerNotify?.(`❌ Feature-Plan fehlgeschlagen (${projectName}: ${title}).`);
          return;
        }
        const phases = parseFeaturePlanPhases(result.output);
        if (phases.length === 0) {
          appendOutputLine(liveTaskId, 'system', `⚠️ Kein parsebarer Phasen-Plan — Plan-Doc liegt ggf. trotzdem in docs/ (Doku-Tab). Items bitte manuell anlegen.`);
          this.ownerNotify?.(`⚠️ Feature-Plan (${projectName}: ${title}): kein parsebarer Phasen-Plan.`);
          return;
        }
        // Plan-Doc sichern (Push deterministisch — Agent committet nur)
        if (this.pushProject) {
          try {
            const push = await this.pushProject({ cwd, commitMessage: `docs(plan): Umsetzungsplan ${title.slice(0, 80)}` });
            appendOutputLine(liveTaskId, 'system', push.success ? `📤 Plan-Doc gesichert: ${push.summary}` : `⚠️ Push fehlgeschlagen: ${push.summary}`);
          } catch { /* best-effort */ }
        }
        // Items mit Milestone + Reihenfolge + Abhängigkeits-Kette anlegen
        const milestone = `Feature: ${title}`.slice(0, 80);
        let prevId: string | undefined;
        let created = 0;
        for (let i = 0; i < phases.length; i++) {
          try {
            const item = await this.repo.addOpenItem(projectId, {
              title: phases[i].title,
              description: `${phases[i].description}\n[Quelle: Feature-Plan docs/feature-plan-${slug}.md]`.slice(0, 1500),
              priority: 'normal',
            });
            try { await this.repo.updateOpenItemRoadmap(item.id, { milestone, order: i + 1 }); } catch { /* best-effort */ }
            if (prevId) {
              try { await this.repo.updateOpenItemFields(item.id, { dependsOn: [prevId] }); } catch { /* best-effort */ }
            }
            prevId = item.id;
            created++;
          } catch { /* einzelnes Paket darf nicht den Rest verhindern */ }
        }
        appendOutputLine(liveTaskId, 'system', `✅ Umsetzungsplan fertig — ${created} Arbeitspakete als Items angelegt (Milestone "${milestone}", ⛓-verkettet). Plan-Doc im Doku-Tab.`);
        this.ownerNotify?.(`✅ Feature-Plan fertig (${projectName}): "${title}" — ${created} Arbeitspakete in der Roadmap.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutputLine(liveTaskId, 'system', `❌ Lauf-Fehler: ${msg.slice(0, 300)}`);
        this.ownerNotify?.(`❌ Feature-Plan Fehler (${projectName}: ${title}): ${msg.slice(0, 300)}`);
      } finally {
        this.runningCodeJobs.delete(projectId);
        try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
      }
    })();

    return {
      success: true,
      data: { liveTaskId, projectId, milestone: `Feature: ${title}`.slice(0, 80) },
      display: `🗺 Umsetzungsplan wird ausgearbeitet (Hintergrund) — danach stehen die Arbeitspakete ⛓-verkettet in der Roadmap.`,
    };
  }

  private async deepVerifyItems(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.runCodeAgent) return { success: false, error: 'Code-Agent-Runner nicht verkabelt' };
    const projectId = await this.resolveProjectId(userId, input.project_id as string);
    if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
    const project = await this.repo.getById(userId, projectId);
    if (!project) return { success: false, error: 'Project nicht gefunden' };
    if (!project.cwd) return { success: false, error: 'Project hat keinen cwd' };
    if (!existsSync(project.cwd)) return { success: false, error: `cwd existiert nicht: ${project.cwd}` };

    const alreadyRunning = this.runningVerifyJobs.get(projectId);
    if (alreadyRunning) {
      return { success: false, error: `Deep-Verify läuft bereits für dieses Projekt (${alreadyRunning.slice(0, 8)}).` };
    }

    const requestedIds = input.item_ids as string[] | undefined;
    const maxItems = Math.min((input.max_items as number) ?? 15, 25);
    let items = await this.repo.listOpenItemsForProject(projectId, ['open', 'in_progress']);
    if (requestedIds && requestedIds.length > 0) {
      items = items.filter(i => requestedIds.includes(i.id) || requestedIds.some(p => i.id.startsWith(p)));
    }
    // gleiche Sortierung wie work_on_open_items: high prio zuerst, dann älteste
    items.sort((a, b) => {
      const pri = { high: 0, normal: 1, low: 2 } as Record<string, number>;
      const dp = (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
      if (dp !== 0) return dp;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const skippedForCap = Math.max(0, items.length - maxItems);
    items = items.slice(0, maxItems);
    if (items.length === 0) return { success: false, error: 'Keine offenen Items zum Prüfen gefunden' };

    const prompt = [
      `Du bist ein Code-Auditor. Prüfe READ-ONLY, ob die folgenden offenen Punkte des Projekts "${project.name}" im AKTUELLEN Code bereits umgesetzt sind.`,
      ``,
      `STRIKT: KEINE Dateiänderungen, KEINE Commits, KEINE Builds — ausschließlich Suchen (grep/glob) und Lesen relevanter Dateien.`,
      ``,
      `PUNKTE:`,
      ...items.map((it, i) => `${i + 1}. id=${it.id}\n   ${it.title}${it.description ? `\n   ${it.description.slice(0, 300)}` : ''}`),
      ``,
      `Für JEDEN Punkt: prüfe im Code und entscheide:`,
      `- "implemented": vollständig umgesetzt (Beleg: Datei + ggf. Zeile/Funktion)`,
      `- "partially": teilweise umgesetzt (Beleg + was konkret fehlt → Feld "missing")`,
      `- "not-implemented": nicht umgesetzt`,
      `- "obsolete": Punkt trifft nicht mehr zu (z.B. Feature entfernt/anders gelöst — begründen)`,
      ``,
      `Antworte AM ENDE mit GENAU EINEM JSON-Array (keine Markdown-Fences nötig, aber erlaubt):`,
      `[{"id":"<exakte-uuid-von-oben>","verdict":"implemented|partially|not-implemented|obsolete","confidence":0.0-1.0,"evidence":"Datei:Zeile bzw. knapper Beleg (max 200 Zeichen)","missing":"nur bei partially"}]`,
      ``,
      `Sei konservativ: implemented nur bei klarem Code-Beleg. Jede id aus PUNKTE muss genau einmal vorkommen.`,
    ].join('\n');

    const liveTaskId = randomUUID();
    this.runningVerifyJobs.set(projectId, liveTaskId);
    // v871.1 — TTL-Sweep auch beim Start (vorher nur im Getter → Map konnte
    // wachsen, wenn Ergebnisse nie abgeholt wurden)
    const sweepCutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.deepVerifyResults) {
      if (v.ts < sweepCutoff) this.deepVerifyResults.delete(k);
    }
    this.deepVerifyResults.set(liveTaskId, { status: 'running', findings: [], ts: Date.now() });
    appendOutputLine(liveTaskId, 'system', `🔬 Deep-Verify gestartet — ${items.length} Item(s) gegen die aktuelle Codebase${skippedForCap > 0 ? ` (${skippedForCap} weitere über der Kappe von ${maxItems} — späterer Lauf)` : ''}.`);

    const validIds = new Set(items.map(i => i.id));
    const cwd = project.cwd;
    void (async () => {
      try {
        const result = await this.runCodeAgent!({ cwd, prompt, taskId: liveTaskId, projectId });
        const findings = parseDeepVerifyFindings(result.output, validIds);
        if (result.success && findings.length > 0) {
          this.deepVerifyResults.set(liveTaskId, { status: 'done', findings, ts: Date.now() });
          const counts = { implemented: 0, partially: 0, 'not-implemented': 0, obsolete: 0 } as Record<string, number>;
          for (const f of findings) counts[f.verdict]++;
          appendOutputLine(liveTaskId, 'system',
            `✅ Analyse abgeschlossen — ${findings.length}/${items.length} Verdikte: ` +
            `${counts.implemented} implemented, ${counts.partially} partially, ${counts['not-implemented']} offen, ${counts.obsolete} obsolet. ` +
            `Ergebnis im Modal — nichts wurde automatisch geändert.`);
        } else {
          const why = !result.success ? `Agent-Lauf fehlgeschlagen: ${result.output.slice(-300)}` : 'Agent lieferte kein parsebares Verdikt-JSON.';
          this.deepVerifyResults.set(liveTaskId, { status: 'failed', findings, error: why, ts: Date.now() });
          appendOutputLine(liveTaskId, 'system', `❌ Deep-Verify fehlgeschlagen — ${why.slice(0, 300)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deepVerifyResults.set(liveTaskId, { status: 'failed', findings: [], error: msg.slice(0, 300), ts: Date.now() });
        appendOutputLine(liveTaskId, 'system', `❌ Deep-Verify Fehler: ${msg.slice(0, 300)}`);
      } finally {
        this.runningVerifyJobs.delete(projectId);
        try { markOutputEnded(liveTaskId); } catch { /* best-effort */ }
      }
    })();

    return {
      success: true,
      data: { liveTaskId, projectId, itemCount: items.length, skippedForCap },
      display: `🔬 Deep-Verify gestartet (Hintergrund, ${items.length} Item(s)${skippedForCap > 0 ? `, ${skippedForCap} über der Kappe` : ''}) — read-only Codebase-Prüfung. Ergebnis erscheint im Modal; nichts wird automatisch geändert.`,
    };
  }

  /**
   * v642 — Audit deutlich vertieft:
   *  - **Stats-Block**: Total/by-Prio/by-Age-Buckets/by-Description
   *  - **Age-Buckets** (1d / 1-7d / 7-30d / 30+d) statt nur "stale ≥30d"
   *  - **Duplikat-Detektion** (Title-Jaccard ≥0.7)
   *  - **Possibly-done** (auto_resolved_by gesetzt aber noch open)
   *  - **LLM-Pass** (default an): schickt Items + Goal + git log + file list an LLM,
   *    fragt nach "wahrscheinlich-erledigt" / "veraltet" / "redundant"
   *  - **Phase-Mismatch**: Items die "Phase N" referenzieren bei Project in höherer Iteration
   *
   * `data` ist strukturiert sodass die WebUI Bulk-Aktionen pro Sektion machen kann.
   */
  private async auditOpenItems(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const projectIdInput = input.project_id as string | undefined;
    const useLlm = input.with_llm !== false; // default an
    let allItems: ProjectOpenItem[];
    let project: Project | null = null;
    if (projectIdInput) {
      const projectId = await this.resolveProjectId(userId, projectIdInput);
      if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
      project = await this.repo.getById(userId, projectId);
      allItems = await this.repo.listOpenItemsForProject(projectId, ['open', 'in_progress']);
    } else {
      allItems = await this.repo.listOpenItems(userId, { status: 'open' });
    }
    if (allItems.length === 0) return { success: true, data: { stats: { total: 0 } }, display: 'Keine offenen Items.' };

    const now = Date.now();
    // ── Stats ────────────────────────────────────────────────────────
    const stats = {
      total: allItems.length,
      byPriority: { high: 0, normal: 0, low: 0 },
      byAge: { d1: 0, d1_7: 0, d7_30: 0, d30_plus: 0 },
      withDescription: 0,
      autoMarked: 0,
    };
    const ageBucket = (created: string) => {
      const d = (now - new Date(created).getTime()) / 86400_000;
      if (d < 1) return 'd1';
      if (d < 7) return 'd1_7';
      if (d < 30) return 'd7_30';
      return 'd30_plus';
    };

    for (const it of allItems) {
      stats.byPriority[it.priority as 'high' | 'normal' | 'low']++;
      stats.byAge[ageBucket(it.createdAt) as keyof typeof stats.byAge]++;
      if (it.description && it.description.trim().length > 0) stats.withDescription++;
      if (it.autoResolvedBy) stats.autoMarked++;
    }

    // ── Existing heuristics ──────────────────────────────────────────
    const stale30: ProjectOpenItem[] = [];
    const possiblyDone: ProjectOpenItem[] = [];
    for (const it of allItems) {
      const days = (now - new Date(it.createdAt).getTime()) / 86400_000;
      if (days >= 30) stale30.push(it);
      if (it.autoResolvedBy && it.status === 'open') possiblyDone.push(it);
    }

    // Title-Similarity-Duplikat-Detektion
    const used = new Set<string>();
    const duplicateGroups: Array<ProjectOpenItem[]> = [];
    // v871.2 — Tokens EINMAL pro Item vorberechnen. Vorher wurde tokB im inneren
    // Loop jedes Mal neu tokenisiert: bei 445 Items ~99k Tokenisierungen + Regex-
    // Splits im Event-Loop. Jetzt: O(n) Tokenisierung, O(n²) nur Set-Vergleiche.
    const tokens: Array<Set<string>> = allItems.map(it =>
      new Set(it.title.toLowerCase().split(/\s+/).filter(t => t.length >= 4)));
    for (let i = 0; i < allItems.length; i++) {
      if (used.has(allItems[i].id)) continue;
      const tokA = tokens[i];
      const group: ProjectOpenItem[] = [allItems[i]];
      for (let j = i + 1; j < allItems.length; j++) {
        if (used.has(allItems[j].id)) continue;
        const tokB = tokens[j];
        let intersection = 0;
        for (const t of tokA) if (tokB.has(t)) intersection++;
        const union = tokA.size + tokB.size - intersection;
        const jaccard = union === 0 ? 0 : intersection / union;
        if (jaccard >= 0.7) { group.push(allItems[j]); used.add(allItems[j].id); }
      }
      if (group.length >= 2) { duplicateGroups.push(group); used.add(allItems[i].id); }
    }

    // Phase-Mismatch (only if we know the project's current iteration)
    const phaseMismatch: ProjectOpenItem[] = [];
    // (kein iteration-state am Project — heuristisch über Goal/Description)

    // ── LLM-Pass (optional) ──────────────────────────────────────────
    interface LlmFinding { item_id: string; verdict: 'likely-done' | 'outdated' | 'redundant' | 'still-open'; confidence: number; reason: string }
    const llmFindings: LlmFinding[] = [];
    if (useLlm && this.llmAuditCallback && project && project.cwd && allItems.length > 0) {
      const repoSnapshot = await collectRepoSnapshot(project.cwd).catch(() => null);
      if (repoSnapshot) {
        const prompt = buildAuditPrompt(project, allItems, repoSnapshot);
        try {
          const raw = await this.llmAuditCallback(prompt, 'default');
          const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
          const start = cleaned.indexOf('[');
          const end = cleaned.lastIndexOf(']');
          if (start >= 0 && end > start) {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (Array.isArray(parsed)) {
              const ids = new Set(allItems.map(i => i.id));
              for (const r of parsed) {
                if (r && typeof r.item_id === 'string' && ids.has(r.item_id)) llmFindings.push(r);
              }
            }
          }
        } catch { /* LLM failure non-fatal */ }
      }
    }

    const llmLikelyDone = llmFindings.filter(f => f.verdict === 'likely-done' && f.confidence >= 0.6);
    const llmOutdated = llmFindings.filter(f => f.verdict === 'outdated');
    const llmRedundant = llmFindings.filter(f => f.verdict === 'redundant');

    // ── Markdown-Display ─────────────────────────────────────────────
    const lines: string[] = [`## Open-Items-Audit`, ''];
    lines.push(`**Total**: ${stats.total} · **High**: ${stats.byPriority.high} · **Normal**: ${stats.byPriority.normal} · **Low**: ${stats.byPriority.low}`);
    lines.push(`**Alter**: <1d ${stats.byAge.d1} · 1-7d ${stats.byAge.d1_7} · 7-30d ${stats.byAge.d7_30} · ≥30d ${stats.byAge.d30_plus}`);
    lines.push(`**Mit Beschreibung**: ${stats.withDescription}/${stats.total} · **Auto-markiert**: ${stats.autoMarked}`);
    lines.push('');

    const itemTitle = (id: string) => allItems.find(i => i.id === id)?.title.slice(0, 80) ?? id.slice(0, 8);

    if (llmLikelyDone.length > 0) {
      lines.push(`### 🤖 LLM: wahrscheinlich schon erledigt (${llmLikelyDone.length})`);
      for (const f of llmLikelyDone) {
        lines.push(`- \`${f.item_id.slice(0, 8)}\` **${itemTitle(f.item_id)}** (conf ${Math.round(f.confidence * 100)}%) — ${f.reason}`);
      }
      lines.push('');
    }
    if (llmOutdated.length > 0) {
      lines.push(`### 🗑️ LLM: veraltet (${llmOutdated.length})`);
      for (const f of llmOutdated) {
        lines.push(`- \`${f.item_id.slice(0, 8)}\` **${itemTitle(f.item_id)}** — ${f.reason}`);
      }
      lines.push('');
    }
    if (llmRedundant.length > 0) {
      lines.push(`### 🔁 LLM: redundant (${llmRedundant.length})`);
      for (const f of llmRedundant) {
        lines.push(`- \`${f.item_id.slice(0, 8)}\` **${itemTitle(f.item_id)}** — ${f.reason}`);
      }
      lines.push('');
    }
    if (possiblyDone.length > 0) {
      lines.push(`### 🤖 Matcher: vermutlich erledigt (${possiblyDone.length})`);
      lines.push(`_Confidence zu niedrig für Auto-Done._`);
      for (const it of possiblyDone) {
        lines.push(`- \`${it.id.slice(0, 8)}\` **${it.title.slice(0, 80)}** (${Math.round((it.autoResolvedConfidence ?? 0) * 100)}%)`);
      }
      lines.push('');
    }
    if (stale30.length > 0) {
      lines.push(`### 🕸️ ≥30d offen (${stale30.length})`);
      for (const it of stale30) {
        const days = Math.round((now - new Date(it.createdAt).getTime()) / 86400_000);
        lines.push(`- \`${it.id.slice(0, 8)}\` **${it.title.slice(0, 80)}** (${days}d)`);
      }
      lines.push('');
    }
    if (duplicateGroups.length > 0) {
      lines.push(`### 👯 Title-Duplikate (${duplicateGroups.length} Gruppe(n))`);
      for (const group of duplicateGroups) {
        lines.push(`- Gruppe (${group.length}):`);
        for (const it of group) lines.push(`  - \`${it.id.slice(0, 8)}\` ${it.title.slice(0, 80)}`);
      }
      lines.push('');
    }
    if (llmLikelyDone.length === 0 && llmOutdated.length === 0 && llmRedundant.length === 0 &&
        stale30.length === 0 && possiblyDone.length === 0 && duplicateGroups.length === 0) {
      lines.push(`✓ Keine Auffälligkeiten gefunden — ${stats.total} Items sehen alle aktiv aus.`);
    }

    return {
      success: true,
      data: {
        stats,
        allItems: allItems.map(i => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.createdAt, description: i.description ?? '' })),
        llmLikelyDone, llmOutdated, llmRedundant,
        possiblyDone: possiblyDone.map(i => ({ id: i.id, title: i.title, confidence: i.autoResolvedConfidence ?? 0 })),
        stale30: stale30.map(i => ({ id: i.id, title: i.title, ageDays: Math.round((now - new Date(i.createdAt).getTime()) / 86400_000) })),
        duplicateGroups: duplicateGroups.map(g => g.map(i => ({ id: i.id, title: i.title }))),
        phaseMismatch,
      },
      display: lines.join('\n'),
    };
  }

  private async resolveProjectId(userId: string, input: string): Promise<string | null> {
    if (!input) return null;
    if (input.length === 36) return input;
    // v871.2 — DB-seitig statt repo.list() + .find() (lud ALLE Projekte des Users)
    return this.repo.findIdByPrefixOrName(userId, input);
  }
}

// ── Helpers for v642 audit ─────────────────────────────────────────────

interface RepoSnapshot {
  recentCommits: string[]; // "sha title"
  files: string[];          // relative paths
  branch?: string;
}

/**
 * v642 — Read git log + file tree from a project's cwd. Used to feed the LLM-pass
 * with concrete signals about what the repo currently contains.
 */
async function collectRepoSnapshot(cwd: string): Promise<RepoSnapshot | null> {
  try {
    const [{ stdout: logOut }, { stdout: filesOut }, { stdout: branchOut }] = await Promise.all([
      pExecFile('git', ['-C', cwd, 'log', '--oneline', '-n', '40'], { timeout: 8000, maxBuffer: 1_000_000 }).catch(() => ({ stdout: '' })),
      pExecFile('git', ['-C', cwd, 'ls-files'], { timeout: 8000, maxBuffer: 4_000_000 }).catch(() => ({ stdout: '' })),
      pExecFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
    ]);
    return {
      recentCommits: logOut.split('\n').filter(Boolean).slice(0, 40),
      files: filesOut.split('\n').filter(Boolean).slice(0, 400),
      branch: branchOut.trim() || undefined,
    };
  } catch { return null; }
}

function buildAuditPrompt(project: Project, items: ProjectOpenItem[], repo: RepoSnapshot): string {
  const itemList = items.map(i => ({
    id: i.id,
    title: i.title.slice(0, 200),
    description: (i.description ?? '').slice(0, 300),
    priority: i.priority,
  }));
  return `Du bist ein erfahrener Tech-Lead. Hier ist ein Software-Projekt mit ${items.length} offenen Punkten. Bewerte welche Punkte realistisch noch offen sind versus bereits erledigt / veraltet / redundant.

**Projekt**: ${project.name}
**cwd**: ${project.cwd ?? '—'}
**Branch**: ${repo.branch ?? '—'}

**Letzte Commits (40)**:
${repo.recentCommits.slice(0, 40).map(c => `- ${c}`).join('\n')}

**Dateien im Repo (Auszug, max 400)**:
${repo.files.slice(0, 400).map(f => `- ${f}`).join('\n')}

**Offene Items** (id, title, description, priority):
${JSON.stringify(itemList, null, 2).slice(0, 12000)}

Antworte als JSON-Array. Pro Item ein Eintrag — aber nur für Items wo du eine klare Einordnung hast (NICHT alle):
{
  "item_id": "<uuid>",
  "verdict": "likely-done" | "outdated" | "redundant" | "still-open",
  "confidence": 0.0-1.0,
  "reason": "Knapp begründen (max 200 Zeichen). Bei 'likely-done': welche Commits/Dateien deuten darauf hin. Bei 'outdated': warum nicht mehr relevant. Bei 'redundant': mit welchem anderen item_id es redundant ist."
}

Konservativ sein — im Zweifel weglassen. Antworte NUR mit dem JSON-Array.`;
}
