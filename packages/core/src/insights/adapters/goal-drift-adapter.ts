import type { GoalsRepository } from '@alfred/storage';
import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';

/**
 * v639 — Erzeugt einen Insight pro Goal das aktuell überfällig für seinen Check ist
 * (lastCheckedAt + checkFrequencyDays liegt in der Vergangenheit), inkl. expliziter
 * Drift-Warnung wenn beim letzten Check schon "drifting" stand.
 *
 * Der Adapter macht KEINEN automatischen Check — er bittet den User mit einer
 * Insight-Card darum, ein Update zu geben. Echte Activity-Detection (z.B. Sport-Termine
 * im Calendar) kann später als zweite Pass-Generation ergänzt werden.
 */
export class GoalDriftAdapter implements DomainAdapter {
  readonly name = 'goal-drift';

  constructor(private readonly goals: GoalsRepository) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    const out: InsightCandidate[] = [];
    const due = await this.goals.findGoalsDueForCheck(ctx.userId).catch(() => []);

    for (const g of due) {
      const overdueDays = g.lastCheckedAt
        ? Math.round((Date.now() - new Date(g.lastCheckedAt).getTime()) / 86400_000) - g.checkFrequencyDays
        : Math.round((Date.now() - new Date(g.createdAt).getTime()) / 86400_000);
      const wasDrifting = g.lastStatus === 'drifting';
      const confidence = wasDrifting ? 0.85 : 0.55 + Math.min(0.3, overdueDays * 0.02);

      const flag = wasDrifting ? '⚠️' : '🎯';
      const title = `${flag} Ziel-Check fällig: ${g.title.slice(0, 60)}`;
      const lines: string[] = [];
      lines.push(`**Status**: ${g.status} · **Cadence**: ${g.cadence ?? '—'}`);
      if (g.targetMetric) lines.push(`**Target**: ${g.targetMetric}`);
      if (g.lastCheckedAt) {
        lines.push(`\n**Letzter Check**: ${g.lastCheckedAt.slice(0, 16)} (${g.lastStatus ?? 'unbekannt'})`);
        if (overdueDays > 0) lines.push(`**Überfällig**: ${overdueDays}d über der ${g.checkFrequencyDays}d-Cadence`);
      } else {
        lines.push(`\n**Noch kein Check** — Ziel wurde vor ${overdueDays}d angelegt.`);
      }
      if (wasDrifting) lines.push(`\n_Letzte Bewertung war "drifting" — Zeit für eine Kurs-Korrektur oder Anpassung des Ziels._`);
      lines.push('');
      lines.push(`**Quick-Check**: \`goal check goal_id=${g.id.slice(0, 8)} status=on-track\` (oder \`drifting\`/\`achieved\`).`);

      out.push({
        category: 'goal-drift',
        title,
        body: lines.join('\n'),
        confidence,
        sourceData: { goalId: g.id, overdueDays, lastStatus: g.lastStatus, cadence: g.cadence },
        actionSkill: 'goal',
        actionParams: { action: 'check', goal_id: g.id, status: 'on-track' },
        dedupeKey: `goal-drift:${g.id}`,
      });
    }
    return out;
  }
}
