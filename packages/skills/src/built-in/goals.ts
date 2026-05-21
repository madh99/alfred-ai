import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { GoalsRepository, GoalCategory, GoalCadence } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action = 'add' | 'list' | 'get' | 'check' | 'pause' | 'resume' | 'complete' | 'abandon' | 'history';

/**
 * v639 — Goals-Skill. Persistente Ziele die der User explizit anlegt oder die aus
 * Chats extrahiert wurden. Der zugehörige GoalDriftAdapter (im InsightEngine) liest
 * `findGoalsDueForCheck()` und erzeugt drift-Insights wenn ein Ziel überfällig ist
 * ohne Activity-Evidenz.
 */
export class GoalsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'goal',
    category: 'productivity',
    description:
      'Ziele/Vorhaben verfolgen. ' +
      '"add" legt Ziel an (title, description?, category?, cadence?, target_metric?, check_frequency_days?). ' +
      '"list" zeigt aktive Ziele (filter status, category). ' +
      '"get" zeigt Detail + Checkpoint-History (goal_id). ' +
      '"check" loggt Checkpoint (goal_id, status: on-track/drifting/achieved/no-data, notes?). ' +
      '"pause"/"resume"/"complete"/"abandon" ändern Status. ' +
      '"history" listet Checkpoints eines Ziels.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'get', 'check', 'pause', 'resume', 'complete', 'abandon', 'history'] },
        goal_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        cadence: { type: 'string' },
        target_metric: { type: 'string' },
        check_frequency_days: { type: 'number' },
        status: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly repo: GoalsRepository) { super(); }

  async execute(input: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = ctx.masterUserId ?? ctx.userId;
    try {
      switch (action) {
        case 'add': return this.addGoal(userId, input);
        case 'list': return this.listGoals(userId, input);
        case 'get': return this.getGoal(userId, input);
        case 'check': return this.checkGoal(userId, input);
        case 'pause': return this.setStatus(userId, input, 'paused');
        case 'resume': return this.setStatus(userId, input, 'active');
        case 'complete': return this.setStatus(userId, input, 'achieved');
        case 'abandon': return this.setStatus(userId, input, 'abandoned');
        case 'history': return this.historyGoal(userId, input);
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async addGoal(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = (input.title as string)?.trim();
    if (!title) return { success: false, error: 'title erforderlich' };
    const g = await this.repo.create(userId, {
      title,
      description: input.description as string | undefined,
      category: input.category as GoalCategory | undefined,
      cadence: input.cadence as GoalCadence | undefined,
      targetMetric: input.target_metric as string | undefined,
      checkFrequencyDays: (input.check_frequency_days as number) ?? 7,
      source: 'user',
    });
    return { success: true, data: g, display: `🎯 Ziel angelegt: **${g.title}** (ID \`${g.id.slice(0, 8)}\`, Check alle ${g.checkFrequencyDays}d)` };
  }

  private async listGoals(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const status = input.status as any;
    const category = input.category as any;
    const list = await this.repo.list(userId, { status, category });
    if (list.length === 0) return { success: true, data: [], display: 'Noch keine Ziele angelegt — `goal add title=…` anfangen.' };

    const lines = ['## Ziele', '', '| Status | Kategorie | Titel | letzter Check | letzter Status |', '|---|---|---|---|---|'];
    for (const g of list) {
      const last = g.lastCheckedAt ? g.lastCheckedAt.slice(0, 10) : '—';
      const ls = g.lastStatus ?? '—';
      lines.push(`| ${g.status} | ${g.category ?? '—'} | ${g.title.slice(0, 50)} | ${last} | ${ls} |`);
    }
    return { success: true, data: list, display: lines.join('\n') };
  }

  private async getGoal(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.goal_id as string);
    if (!id) return { success: false, error: 'goal_id nicht gefunden' };
    const g = await this.repo.getById(userId, id);
    if (!g) return { success: false, error: 'nicht gefunden' };
    const cps = await this.repo.listCheckpoints(id, 10);
    const lines = [
      `## ${g.title}`, '',
      `**Status**: ${g.status} · **Kategorie**: ${g.category ?? '—'} · **Cadence**: ${g.cadence ?? '—'}`,
      g.description ? `\n${g.description}` : '',
      g.targetMetric ? `\n**Target**: ${g.targetMetric}` : '',
      `\n**Check alle**: ${g.checkFrequencyDays}d · **letzter Check**: ${g.lastCheckedAt?.slice(0, 16) ?? 'noch nie'}${g.lastStatus ? ` (${g.lastStatus})` : ''}`,
    ];
    if (cps.length > 0) {
      lines.push('', '### Checkpoints', '', '| Datum | Status | Notiz |', '|---|---|---|');
      for (const c of cps) lines.push(`| ${c.checkedAt.slice(0, 16)} | ${c.status ?? '—'} | ${(c.notes ?? '').slice(0, 60)} |`);
    }
    return { success: true, data: { goal: g, checkpoints: cps }, display: lines.join('\n') };
  }

  private async checkGoal(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.goal_id as string);
    if (!id) return { success: false, error: 'goal_id nicht gefunden' };
    const status = (input.status as any) ?? 'on-track';
    const notes = input.notes as string | undefined;
    await this.repo.recordCheckpoint(id, status, undefined, notes);
    return { success: true, display: `✓ Checkpoint geloggt — Status \`${status}\`${notes ? `\n${notes}` : ''}` };
  }

  private async setStatus(userId: string, input: Record<string, unknown>, newStatus: any): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.goal_id as string);
    if (!id) return { success: false, error: 'goal_id nicht gefunden' };
    const updated = await this.repo.update(userId, id, { status: newStatus });
    return { success: true, data: updated, display: `Status → ${newStatus}` };
  }

  private async historyGoal(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.goal_id as string);
    if (!id) return { success: false, error: 'goal_id nicht gefunden' };
    const cps = await this.repo.listCheckpoints(id, 50);
    if (cps.length === 0) return { success: true, data: [], display: 'Noch keine Checkpoints.' };
    const lines = ['### Checkpoints', '', '| Datum | Status | Notiz |', '|---|---|---|'];
    for (const c of cps) lines.push(`| ${c.checkedAt.slice(0, 16)} | ${c.status ?? '—'} | ${(c.notes ?? '').slice(0, 80)} |`);
    return { success: true, data: cps, display: lines.join('\n') };
  }

  private async resolveId(userId: string, idOrPrefix: string): Promise<string | null> {
    if (!idOrPrefix) return null;
    if (idOrPrefix.length === 36) return idOrPrefix;
    const all = await this.repo.list(userId, { limit: 200 });
    return all.find(g => g.id.startsWith(idOrPrefix))?.id ?? null;
  }
}
