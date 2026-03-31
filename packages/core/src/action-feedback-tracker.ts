import type { Logger } from 'pino';
import type { ActivityRepository, MemoryRepository } from '@alfred/storage';

// ── Types ────────────────────────────────────────────────────

interface SkillAcceptanceRate {
  skillName: string;
  approved: number;
  rejected: number;
  expired: number;
  total: number;
  acceptanceRate: number;
}

// ── Constants ────────────────────────────────────────────────

/** Minimum confirmations needed to compute a meaningful rate. */
const MIN_CONFIRMATIONS = 3;

/** Analysis window in days. */
const ANALYSIS_WINDOW_DAYS = 30;

/** Acceptance rate thresholds for confidence mapping. */
const CONFIDENCE_MAP: Array<{ minRate: number; confidence: number }> = [
  { minRate: 0.8, confidence: 0.9 },
  { minRate: 0.5, confidence: 0.7 },
  { minRate: 0.2, confidence: 0.5 },
  { minRate: 0, confidence: 0.3 },
];

// ── Tracker ──────────────────────────────────────────────────

/**
 * Analyzes confirmation outcomes (accept/reject/expire) from activity_log
 * and saves per-skill acceptance rates as memories for the reasoning engine.
 *
 * Called weekly (Sunday 4 AM, alongside TemporalAnalyzer + KG Maintenance).
 */
export class ActionFeedbackTracker {
  constructor(
    private readonly activityRepo: ActivityRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  async analyze(userId: string): Promise<void> {
    try {
      const since = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 86400_000).toISOString();

      // Query all confirmation events in the window
      const confirmations = await this.activityRepo.query({
        eventType: 'confirmation',
        since,
        limit: 500,
      });

      if (confirmations.length === 0) return;

      // Group by skillName (stored in 'action' field)
      const groups = new Map<string, { approved: number; rejected: number; expired: number }>();
      for (const entry of confirmations) {
        const skillName = entry.action ?? 'unknown';
        if (!groups.has(skillName)) {
          groups.set(skillName, { approved: 0, rejected: 0, expired: 0 });
        }
        const g = groups.get(skillName)!;
        switch (entry.outcome) {
          case 'approved': g.approved++; break;
          case 'rejected': g.rejected++; break;
          case 'expired': g.expired++; break;
        }
      }

      // Calculate acceptance rates
      const rates: SkillAcceptanceRate[] = [];
      for (const [skillName, counts] of groups) {
        const total = counts.approved + counts.rejected + counts.expired;
        if (total < MIN_CONFIRMATIONS) continue;
        rates.push({
          skillName,
          ...counts,
          total,
          acceptanceRate: counts.approved / total,
        });
      }

      // Save per-skill feedback as memories
      for (const rate of rates) {
        const pct = Math.round(rate.acceptanceRate * 100);
        const confidence = CONFIDENCE_MAP.find(c => rate.acceptanceRate >= c.minRate)?.confidence ?? 0.5;

        let hint = '';
        if (pct >= 80) hint = ' → gut akzeptiert';
        else if (pct >= 50) hint = ' → gemischt';
        else if (pct >= 20) hint = ' → häufig abgelehnt';
        else hint = ' → fast immer abgelehnt';

        await this.memoryRepo.saveWithMetadata(
          userId,
          `action_feedback_${rate.skillName}`,
          `${rate.skillName}: ${pct}% Akzeptanz (${rate.approved}/${rate.total}${rate.rejected > 0 ? `, ${rate.rejected} abgelehnt` : ''}${rate.expired > 0 ? `, ${rate.expired} ignoriert` : ''})${hint}`,
          'behavior', 'pattern', confidence, 'auto',
        );
      }

      // Generate overall summary
      if (rates.length > 0) {
        const summary = rates
          .sort((a, b) => b.total - a.total)
          .slice(0, 10)
          .map(r => {
            const pct = Math.round(r.acceptanceRate * 100);
            const arrow = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '❌';
            return `${arrow} ${r.skillName}: ${pct}% (${r.approved}/${r.total})`;
          })
          .join('\n');

        await this.memoryRepo.saveWithMetadata(
          userId, 'action_feedback_summary',
          `Akzeptanzraten (${ANALYSIS_WINDOW_DAYS}d):\n${summary}`,
          'behavior', 'pattern', 0.8, 'auto',
        );
      }

      // Autonomy level suggestion
      await this.suggestAutonomyLevel(userId, rates);

      this.logger.info(
        { userId, skills: rates.length, totalConfirmations: confirmations.length },
        'Action feedback analysis completed',
      );
    } catch (err) {
      this.logger.warn({ err }, 'Action feedback analysis failed');
    }
  }

  /**
   * Extract acceptance rate from a stored feedback memory value.
   * Returns rate as 0-1 or undefined if not parseable.
   */
  static extractRate(value: string): number | undefined {
    const match = value.match(/(\d+)%\s*Akzeptanz/);
    if (match) return parseInt(match[1], 10) / 100;
    return undefined;
  }

  // ── Autonomy Suggestion ─────────────────────────────────────

  private async suggestAutonomyLevel(userId: string, rates: SkillAcceptanceRate[]): Promise<void> {
    if (rates.length < 3) return; // Not enough data

    const overallApproved = rates.reduce((sum, r) => sum + r.approved, 0);
    const overallTotal = rates.reduce((sum, r) => sum + r.total, 0);
    if (overallTotal < 10) return; // Not enough confirmations

    const overallRate = overallApproved / overallTotal;
    const current = await this.getCurrentAutonomyLevel(userId);

    let suggestion: string | null = null;

    if (overallRate >= 0.9 && current !== 'autonomous') {
      suggestion = `Autonomie-Upgrade empfohlen: ${Math.round(overallRate * 100)}% Akzeptanzrate über ${ANALYSIS_WINDOW_DAYS} Tage. Aktuell: ${current}. Empfehlung: autonomous.`;
    } else if (overallRate < 0.5 && current !== 'confirm_all') {
      suggestion = `Autonomie-Downgrade empfohlen: nur ${Math.round(overallRate * 100)}% Akzeptanzrate. Aktuell: ${current}. Empfehlung: confirm_all.`;
    } else if (overallRate >= 0.7 && overallRate < 0.9 && current === 'confirm_all') {
      suggestion = `Autonomie-Upgrade möglich: ${Math.round(overallRate * 100)}% Akzeptanzrate. Aktuell: confirm_all. Empfehlung: proactive.`;
    }

    if (suggestion) {
      await this.memoryRepo.saveWithMetadata(
        userId, 'autonomy_suggestion', suggestion,
        'behavior', 'pattern', 0.7, 'auto',
      );
      this.logger.info({ userId, suggestion }, 'Autonomy level suggestion saved');
    }
  }

  private async getCurrentAutonomyLevel(userId: string): Promise<string> {
    try {
      const mem = await this.memoryRepo.recall(userId, 'autonomy_level');
      if (mem) {
        const level = mem.value.toLowerCase().trim();
        if (level.includes('autonomous') || level.includes('autonom')) return 'autonomous';
        if (level.includes('proactive') || level.includes('proaktiv')) return 'proactive';
      }
    } catch { /* default */ }
    return 'confirm_all';
  }
}
