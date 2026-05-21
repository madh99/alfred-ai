import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { InsightsRepository, Insight } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action = 'list' | 'dismiss' | 'snooze' | 'act' | 'sweep' | 'stats';

interface SweepCallback {
  (userId: string): Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }>;
}

/**
 * v638 — Insights-Skill: User-facing Wrapper über das InsightEngine + InsightsRepository.
 *
 * Aktionen:
 *  - `list` (default) — zeigt offene Insights, optional filter category/limit
 *  - `dismiss insight_id=…` — markiert dismissed
 *  - `snooze insight_id=… hours=24` — snooze für X Stunden
 *  - `act insight_id=…` — führt die gebundene Skill-Action aus (gestaffelt via Confirmation)
 *  - `sweep` — manueller Trigger der Insight-Engine
 *  - `stats` — Counts pro Status
 */
export class InsightsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'insights',
    category: 'productivity',
    description:
      'Cross-Domain Insights: Anstöße und Optimierungs-Vorschläge die Alfred aus deinen Daten kombiniert. ' +
      '"list" zeigt offene Insights (optional category, limit). ' +
      '"dismiss" markiert Insight als erledigt (insight_id). ' +
      '"snooze" verschiebt um N Stunden (insight_id, hours). ' +
      '"act" führt die gebundene Aktion aus (insight_id). ' +
      '"sweep" trigger manuell die Engine. "stats" zeigt Counts.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'dismiss', 'snooze', 'act', 'sweep', 'stats'] },
        insight_id: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'number' },
        hours: { type: 'number' },
      },
      required: ['action'],
    },
  };

  private sweepCallback?: SweepCallback;

  constructor(private readonly repo: InsightsRepository) { super(); }

  setSweepCallback(cb: SweepCallback): void { this.sweepCallback = cb; }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId ?? context.userId;
    try {
      switch (action) {
        case 'list': return this.listInsights(userId, input);
        case 'dismiss': return this.dismissInsight(userId, input);
        case 'snooze': return this.snoozeInsight(userId, input);
        case 'act': return this.actInsight(userId, input);
        case 'sweep': return this.sweepNow(userId);
        case 'stats': return this.statsAction(userId);
        default: return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async listInsights(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const limit = (input.limit as number) ?? 20;
    const category = input.category as any;
    const list = await this.repo.list(userId, { category, limit });
    if (list.length === 0) return { success: true, data: [], display: 'Keine offenen Insights.' };

    const lines: string[] = [`## Insights (${list.length})`, ''];
    for (const i of list) {
      const conf = Math.round(i.confidence * 100);
      const flag = i.confidence >= 0.8 ? '🔴' : i.confidence >= 0.6 ? '🟡' : '🟢';
      lines.push(`### ${flag} ${i.title}`);
      lines.push(`_${i.category} · Confidence ${conf}% · ID \`${i.id.slice(0, 8)}\`${i.status === 'snoozed' && i.snoozedUntil ? ` · snoozed bis ${i.snoozedUntil.slice(0, 16)}` : ''}_`);
      lines.push('');
      lines.push(i.body);
      if (i.actionSkill) {
        lines.push('');
        lines.push(`**Aktion**: \`insights act insight_id=${i.id.slice(0, 8)}\` führt \`${i.actionSkill}\` aus.`);
      }
      lines.push('');
    }
    return { success: true, data: list, display: lines.join('\n') };
  }

  private async dismissInsight(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.insight_id as string);
    if (!id) return { success: false, error: 'insight_id nicht gefunden' };
    await this.repo.dismiss(userId, id);
    return { success: true, display: `✕ Insight ${id.slice(0, 8)} abgehakt.` };
  }

  private async snoozeInsight(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.insight_id as string);
    if (!id) return { success: false, error: 'insight_id nicht gefunden' };
    const hours = (input.hours as number) ?? 24;
    await this.repo.snooze(userId, id, hours);
    return { success: true, display: `💤 Insight ${id.slice(0, 8)} snoozed für ${hours}h.` };
  }

  private async actInsight(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = await this.resolveId(userId, input.insight_id as string);
    if (!id) return { success: false, error: 'insight_id nicht gefunden' };
    const i = await this.repo.getById(userId, id);
    if (!i) return { success: false, error: 'Insight nicht gefunden' };
    if (!i.actionSkill) return { success: false, error: 'Insight hat keine gebundene Aktion' };
    // Marker as acted — the actual skill-execution happens via the actAdapter callback set up
    // in alfred.ts (it routes to skill-sandbox).
    await this.repo.markActed(userId, id);
    return {
      success: true,
      display: `▶ Action für Insight ${id.slice(0, 8)} ausgelöst: \`${i.actionSkill}\` mit Params ${JSON.stringify(i.actionParams ?? {})}.`,
      data: { insightId: id, skill: i.actionSkill, params: i.actionParams ?? {} },
    };
  }

  private async sweepNow(userId: string): Promise<SkillResult> {
    if (!this.sweepCallback) return { success: false, error: 'Sweep-Callback nicht registriert' };
    const result = await this.sweepCallback(userId);
    const perAd = Object.entries(result.perAdapter).map(([k, v]) => `${k}: ${v}`).join(', ');
    return {
      success: true,
      data: result,
      display: `🔄 Sweep abgeschlossen — ${result.inserted} neue Insights, ${result.refreshed} aktualisiert.\n\nPro Adapter: ${perAd || '(none)'}\n${result.errors.length > 0 ? '\nFehler:\n' + result.errors.map(e => '- ' + e).join('\n') : ''}`,
    };
  }

  private async statsAction(userId: string): Promise<SkillResult> {
    const s = await this.repo.stats(userId);
    const display = `## Insight-Stats\n\n- **Pending**: ${s.pending}\n- **Snoozed**: ${s.snoozed}\n- **Dismissed**: ${s.dismissed}\n- **Acted**: ${s.acted}\n- **Expired**: ${s.expired}`;
    return { success: true, data: s, display };
  }

  /** Resolve a possibly-truncated insight_id (8 chars prefix) to the full UUID. */
  private async resolveId(userId: string, idOrPrefix: string): Promise<string | null> {
    if (!idOrPrefix) return null;
    if (idOrPrefix.length === 36) return idOrPrefix;
    const all = await this.repo.list(userId, { status: ['pending', 'snoozed'], limit: 200, includeExpiredSnoozes: true });
    const found = all.find(i => i.id.startsWith(idOrPrefix));
    return found?.id ?? null;
  }
}
