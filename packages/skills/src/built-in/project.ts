import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type {
  ProjectRepository, Project, ProjectStatus, ProjectHealthMode, OpenItemStatus,
  ProjectOpenItem,
} from '@alfred/storage';

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

  /** v641 — Callback to start a Project-Agent with a constructed goal. Set by alfred.ts. */
  private startProjectAgent?: (opts: { cwd: string; goal: string; projectId: string }) => Promise<{ taskId: string }>;

  constructor(private readonly repo: ProjectRepository) {
    super();
  }

  /** Inject the cascade callback for ITSM linked open-items. */
  setIncidentCascade(fn: IncidentCascadeFn): void {
    this.incidentCascade = fn;
  }

  /** v641 — Inject the start-project-agent callback. */
  setProjectAgentStarter(fn: (opts: { cwd: string; goal: string; projectId: string }) => Promise<{ taskId: string }>): void {
    this.startProjectAgent = fn;
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

    const goalLines = [
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
    ];
    const goal = goalLines.join('\n');

    try {
      const { taskId } = await this.startProjectAgent({ cwd: project.cwd, goal, projectId });
      return {
        success: true,
        data: { taskId, projectId, items: items.map(i => i.id) },
        display: `▶ Project-Agent gestartet (taskId ${taskId.slice(0, 8)}) mit ${items.length} Items als Goal.\n\nNach Abschluss versucht der OpenItemMatcher automatisch zu erkennen, welche Items erledigt wurden, und markiert sie als done.`,
      };
    } catch (err) {
      return { success: false, error: `Project-Agent-Start fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * v641 — Audit offener Items:
   *  - **stale**: ≥30d ohne Updates
   *  - **duplikat**: Title-Similarity ≥0.7 mit anderem open-Item
   *  - **possibly-done**: auto_resolved_by gesetzt aber status noch open (Matcher hatte Unsicherheit)
   * Liefert eine Übersicht — kein Auto-Cleanup ohne User-Entscheidung.
   */
  private async auditOpenItems(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const projectIdInput = input.project_id as string | undefined;
    let allItems: ProjectOpenItem[];
    if (projectIdInput) {
      const projectId = await this.resolveProjectId(userId, projectIdInput);
      if (!projectId) return { success: false, error: 'project_id nicht gefunden' };
      allItems = await this.repo.listOpenItemsForProject(projectId, ['open', 'in_progress']);
    } else {
      allItems = await this.repo.listOpenItems(userId, { status: 'open' });
    }
    if (allItems.length === 0) return { success: true, data: [], display: 'Keine offenen Items.' };

    const now = Date.now();
    const stale: ProjectOpenItem[] = [];
    const possiblyDone: ProjectOpenItem[] = [];
    const duplicateGroups: Array<ProjectOpenItem[]> = [];

    for (const it of allItems) {
      const ageDays = (now - new Date(it.createdAt).getTime()) / 86400_000;
      if (ageDays >= 30) stale.push(it);
      if (it.autoResolvedBy && it.status === 'open') possiblyDone.push(it);
    }

    // Title-Similarity-Duplikat-Detektion (simpler Jaccard auf Token)
    const used = new Set<string>();
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

    const lines: string[] = [`## Open-Items-Audit (${allItems.length} offen)`, ''];
    if (possiblyDone.length > 0) {
      lines.push(`### 🤖 Vermutlich bereits erledigt (${possiblyDone.length})`);
      lines.push(`_Der Matcher hat Indizien gefunden, aber Confidence zu niedrig für Auto-Done._`);
      for (const it of possiblyDone) {
        lines.push(`- \`${it.id.slice(0, 8)}\` ${it.title.slice(0, 80)} (conf ${Math.round((it.autoResolvedConfidence ?? 0) * 100)}%)`);
      }
      lines.push('');
    }
    if (stale.length > 0) {
      lines.push(`### 🕸️ Stale (≥30d offen, ${stale.length})`);
      for (const it of stale) {
        const days = Math.round((now - new Date(it.createdAt).getTime()) / 86400_000);
        lines.push(`- \`${it.id.slice(0, 8)}\` ${it.title.slice(0, 80)} (${days}d)`);
      }
      lines.push('');
    }
    if (duplicateGroups.length > 0) {
      lines.push(`### 👯 Mögliche Duplikate (${duplicateGroups.length} Gruppe(n))`);
      for (const group of duplicateGroups) {
        lines.push(`- Gruppe (${group.length}):`);
        for (const it of group) lines.push(`  - \`${it.id.slice(0, 8)}\` ${it.title.slice(0, 80)}`);
      }
      lines.push('');
    }
    if (stale.length === 0 && possiblyDone.length === 0 && duplicateGroups.length === 0) {
      lines.push('✓ Keine Auffälligkeiten — Open-Items sehen sauber aus.');
    } else {
      lines.push(`---\n**Aktion**: \`project resolve_open_item item_id=…\` zum Schließen, oder \`project work_on_open_items project_id=…\` um den Stapel abzuarbeiten.`);
    }

    return { success: true, data: { stale, possiblyDone, duplicateGroups }, display: lines.join('\n') };
  }

  private async resolveProjectId(userId: string, input: string): Promise<string | null> {
    if (!input) return null;
    if (input.length === 36) return input;
    const all = await this.repo.list(userId);
    return all.find(p => p.id.startsWith(input) || p.name.toLowerCase().includes(input.toLowerCase()))?.id ?? null;
  }
}
