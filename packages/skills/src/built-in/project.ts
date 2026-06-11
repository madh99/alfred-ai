import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type {
  ProjectRepository, Project, ProjectStatus, ProjectHealthMode, OpenItemStatus,
  ProjectOpenItem,
} from '@alfred/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExecFile = promisify(execFile);

type LlmAuditCallback = (prompt: string, tier?: string) => Promise<string>;

/** Callback signature for cross-domain cascade — set by alfred.ts wiring. */
export type IncidentCascadeFn = (incidentId: string, status: 'resolved' | 'closed' | 'reopened') => Promise<boolean>;

type Action =
  | 'list' | 'get' | 'create' | 'rename' | 'set_status' | 'set_health_mode'
  | 'list_open_items' | 'add_open_item' | 'resolve_open_item'
  | 'list_sessions' | 'list_decisions' | 'archive'
  | 'work_on_open_items' | 'audit_open_items';

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
            'work_on_open_items', 'audit_open_items',
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
   *  Multi-Phase-Project-Agent (gleiche Regel wie im Chat-Prompt-Builder). */
  private runCodeAgent?: (opts: { cwd: string; prompt: string }) => Promise<{ success: boolean; output: string }>;

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
  setCodeAgentRunner(fn: (opts: { cwd: string; prompt: string }) => Promise<{ success: boolean; output: string }>): void {
    this.runCodeAgent = fn;
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
    const lines = await Promise.all(items.map(async it => this.formatOpenItem(userId, it)));
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
    if (items.length === 0) return { success: false, error: 'Keine offenen Items zum Abarbeiten gefunden' };

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

    // v869 — Code-Agent-Pfad: läuft synchron; bei Erfolg werden die Items
    // DIREKT als done markiert (deterministisch, kein Matcher-Raten).
    if (mode === 'code' && this.runCodeAgent) {
      try {
        const result = await this.runCodeAgent({ cwd: project.cwd, prompt: goal });
        if (result.success) {
          let marked = 0;
          for (const id of itemIds) {
            try { if (await this.repo.updateOpenItemStatus(id, 'done')) marked++; } catch { /* skip */ }
          }
          return {
            success: true,
            data: { mode: 'code', projectId, items: itemIds, markedDone: marked },
            display: `✅ Code-Agent hat ${items.length} Item(s) direkt abgearbeitet — ${marked} als erledigt markiert.\n\n${result.output.slice(0, 2000)}`,
          };
        }
        return {
          success: false,
          data: { mode: 'code', projectId, items: itemIds },
          error: `Code-Agent fehlgeschlagen — Items bleiben offen. Output (Ende): ${result.output.slice(-600)}`,
        };
      } catch (err) {
        return { success: false, error: `Code-Agent-Lauf fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    try {
      // v869 — mentionedItemIds durchreichen: der v731-Auto-Done-Mechanismus
      // markiert nach erfolgreichem Run GENAU diese Items als done.
      const { taskId } = await this.startProjectAgent({ cwd: project.cwd, goal, projectId, mentionedItemIds: itemIds });
      return {
        success: true,
        data: { mode: 'project', taskId, projectId, items: itemIds },
        display: `▶ Project-Agent gestartet (taskId ${taskId.slice(0, 8)}) mit ${items.length} Item(s).\n\nNach erfolgreichem Abschluss werden genau diese Items automatisch als erledigt markiert.`,
      };
    } catch (err) {
      return { success: false, error: `Project-Agent-Start fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
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
    for (let i = 0; i < allItems.length; i++) {
      if (used.has(allItems[i].id)) continue;
      const tokA = new Set(allItems[i].title.toLowerCase().split(/\s+/).filter(t => t.length >= 4));
      const group: ProjectOpenItem[] = [allItems[i]];
      for (let j = i + 1; j < allItems.length; j++) {
        if (used.has(allItems[j].id)) continue;
        const tokB = new Set(allItems[j].title.toLowerCase().split(/\s+/).filter(t => t.length >= 4));
        const intersection = [...tokA].filter(t => tokB.has(t)).length;
        const union = new Set([...tokA, ...tokB]).size;
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
    const all = await this.repo.list(userId);
    return all.find(p => p.id.startsWith(input) || p.name.toLowerCase().includes(input.toLowerCase()))?.id ?? null;
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
