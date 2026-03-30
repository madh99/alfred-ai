import type { Logger } from 'pino';
import type { MemoryRepository, ActivityRepository, WeeklySkillStats } from '@alfred/storage';

// ── Types ────────────────────────────────────────────────────

export interface Trend {
  skill: string;
  direction: 'up' | 'down';
  currentWeek: number;
  baseline: number;
  changePercent: number;
}

export interface Anomaly {
  type: 'error_spike' | 'usage_spike' | 'usage_drop' | 'duration_spike';
  skill: string;
  description: string;
  severity: 'warning' | 'critical';
  currentValue: number;
  baselineValue: number;
}

export interface TemporalReport {
  trends: Trend[];
  anomalies: Anomaly[];
  summary: string;
}

// ── Constants ────────────────────────────────────────────────

/** Minimum calls per week (baseline) to consider a skill for trend analysis. */
const MIN_BASELINE_CALLS = 5;

/** Trend threshold: change must exceed this percentage. */
const TREND_THRESHOLD_PERCENT = 30;

/** Anomaly multiplier for warning level. */
const ANOMALY_WARNING_MULTIPLIER = 2;

/** Anomaly multiplier for critical level. */
const ANOMALY_CRITICAL_MULTIPLIER = 5;

/** Number of weeks to use as baseline (excluding current week). */
const BASELINE_WEEKS = 3;

// ── Analyzer ─────────────────────────────────────────────────

/**
 * Temporal Analyzer: Detects trends and anomalies across weekly activity data.
 * Runs weekly (Sunday 4:00 AM) — no LLM calls, pure statistics.
 * Results are stored as memories (type='pattern') for use by the Reasoning Engine.
 */
export class TemporalAnalyzer {
  constructor(
    private readonly activityRepo: ActivityRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Analyze the last 4 weeks of activity for a user.
   * Detects trends (↑/↓ >30%) and anomalies (>2x baseline).
   */
  async analyze(userId: string): Promise<TemporalReport> {
    try {
      const since = new Date(Date.now() - 28 * 86400_000).toISOString();
      const weeklyStats = await this.activityRepo.weeklySkillStats(since, userId);

      if (weeklyStats.length === 0) {
        return { trends: [], anomalies: [], summary: 'Keine Aktivitätsdaten für Trendanalyse.' };
      }

      // Group by week
      const weeks = this.groupByWeek(weeklyStats);
      const weekKeys = Object.keys(weeks).sort();

      if (weekKeys.length < 2) {
        return { trends: [], anomalies: [], summary: 'Zu wenig Wochen für Trendanalyse (min. 2 nötig).' };
      }

      const currentWeekKey = weekKeys[weekKeys.length - 1];
      const baselineWeekKeys = weekKeys.slice(0, -1).slice(-BASELINE_WEEKS);

      // Compute baseline per skill
      const baseline = this.computeBaseline(weeks, baselineWeekKeys);
      const currentWeek = weeks[currentWeekKey] ?? {};

      // Detect trends and anomalies
      const trends = this.detectTrends(currentWeek, baseline);
      const anomalies = this.detectAnomalies(currentWeek, baseline);

      // Build summary text
      const summary = this.buildSummary(trends, anomalies, currentWeekKey);

      // Save to memories
      await this.saveResults(userId, trends, anomalies, summary);

      this.logger.info(
        { userId, trends: trends.length, anomalies: anomalies.length },
        'Temporal analysis completed',
      );

      return { trends, anomalies, summary };
    } catch (err) {
      this.logger.warn({ err }, 'Temporal analysis failed');
      return { trends: [], anomalies: [], summary: 'Temporale Analyse fehlgeschlagen.' };
    }
  }

  // ── Grouping ────────────────────────────────────────────────

  private groupByWeek(stats: WeeklySkillStats[]): Record<string, Record<string, SkillWeekData>> {
    const weeks: Record<string, Record<string, SkillWeekData>> = {};
    for (const s of stats) {
      if (!weeks[s.week]) weeks[s.week] = {};
      weeks[s.week][s.skillName] = {
        calls: s.calls,
        errors: s.errors,
        errorRate: s.calls > 0 ? s.errors / s.calls : 0,
        avgDurationMs: s.avgDurationMs,
      };
    }
    return weeks;
  }

  // ── Baseline Computation ────────────────────────────────────

  private computeBaseline(
    weeks: Record<string, Record<string, SkillWeekData>>,
    baselineWeekKeys: string[],
  ): Record<string, SkillWeekData> {
    const sums: Record<string, { calls: number; errors: number; durationSum: number; count: number }> = {};

    for (const weekKey of baselineWeekKeys) {
      const week = weeks[weekKey];
      if (!week) continue;
      for (const [skill, data] of Object.entries(week)) {
        if (!sums[skill]) sums[skill] = { calls: 0, errors: 0, durationSum: 0, count: 0 };
        sums[skill].calls += data.calls;
        sums[skill].errors += data.errors;
        sums[skill].durationSum += data.avgDurationMs * data.calls; // weighted avg
        sums[skill].count++;
      }
    }

    const baseline: Record<string, SkillWeekData> = {};
    for (const [skill, sum] of Object.entries(sums)) {
      const n = sum.count || 1;
      const avgCalls = sum.calls / n;
      const avgErrors = sum.errors / n;
      baseline[skill] = {
        calls: avgCalls,
        errors: avgErrors,
        errorRate: sum.calls > 0 ? sum.errors / sum.calls : 0,
        avgDurationMs: sum.calls > 0 ? sum.durationSum / sum.calls : 0,
      };
    }
    return baseline;
  }

  // ── Trend Detection ─────────────────────────────────────────

  private detectTrends(
    currentWeek: Record<string, SkillWeekData>,
    baseline: Record<string, SkillWeekData>,
  ): Trend[] {
    const trends: Trend[] = [];

    // Check all skills (current + baseline)
    const allSkills = new Set([...Object.keys(currentWeek), ...Object.keys(baseline)]);

    for (const skill of allSkills) {
      const current = currentWeek[skill]?.calls ?? 0;
      const base = baseline[skill]?.calls ?? 0;

      // Skip low-volume skills
      if (base < MIN_BASELINE_CALLS && current < MIN_BASELINE_CALLS) continue;

      // Avoid division by zero
      if (base === 0) {
        if (current >= MIN_BASELINE_CALLS) {
          trends.push({ skill, direction: 'up', currentWeek: current, baseline: 0, changePercent: 100 });
        }
        continue;
      }

      const changePercent = ((current - base) / base) * 100;

      if (changePercent > TREND_THRESHOLD_PERCENT) {
        trends.push({ skill, direction: 'up', currentWeek: current, baseline: Math.round(base), changePercent: Math.round(changePercent) });
      } else if (changePercent < -TREND_THRESHOLD_PERCENT) {
        trends.push({ skill, direction: 'down', currentWeek: current, baseline: Math.round(base), changePercent: Math.round(changePercent) });
      }
    }

    // Sort by absolute change descending
    return trends.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)).slice(0, 10);
  }

  // ── Anomaly Detection ───────────────────────────────────────

  private detectAnomalies(
    currentWeek: Record<string, SkillWeekData>,
    baseline: Record<string, SkillWeekData>,
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];

    for (const [skill, current] of Object.entries(currentWeek)) {
      const base = baseline[skill];
      if (!base || base.calls < MIN_BASELINE_CALLS) continue;

      // Error-Rate spike
      if (current.errorRate > 0.1 && base.errorRate > 0) {
        const ratio = current.errorRate / base.errorRate;
        if (ratio >= ANOMALY_WARNING_MULTIPLIER) {
          anomalies.push({
            type: 'error_spike',
            skill,
            description: `${skill}: Error-Rate ${(current.errorRate * 100).toFixed(0)}% (normal: ${(base.errorRate * 100).toFixed(0)}%)`,
            severity: ratio >= ANOMALY_CRITICAL_MULTIPLIER ? 'critical' : 'warning',
            currentValue: Math.round(current.errorRate * 100),
            baselineValue: Math.round(base.errorRate * 100),
          });
        }
      } else if (current.errorRate > 0.2 && base.errorRate === 0) {
        // New errors where there were none
        anomalies.push({
          type: 'error_spike',
          skill,
          description: `${skill}: ${(current.errorRate * 100).toFixed(0)}% Fehler (bisher keine)`,
          severity: current.errorRate > 0.5 ? 'critical' : 'warning',
          currentValue: Math.round(current.errorRate * 100),
          baselineValue: 0,
        });
      }

      // Usage spike
      if (base.calls > 0 && current.calls / base.calls >= ANOMALY_WARNING_MULTIPLIER * 1.5) {
        anomalies.push({
          type: 'usage_spike',
          skill,
          description: `${skill}: ${current.calls} Calls (normal: ~${Math.round(base.calls)}/Woche)`,
          severity: current.calls / base.calls >= ANOMALY_CRITICAL_MULTIPLIER ? 'critical' : 'warning',
          currentValue: current.calls,
          baselineValue: Math.round(base.calls),
        });
      }

      // Duration spike (performance degradation)
      if (base.avgDurationMs > 0 && current.avgDurationMs / base.avgDurationMs >= ANOMALY_WARNING_MULTIPLIER) {
        anomalies.push({
          type: 'duration_spike',
          skill,
          description: `${skill}: Ø ${Math.round(current.avgDurationMs)}ms (normal: ~${Math.round(base.avgDurationMs)}ms)`,
          severity: current.avgDurationMs / base.avgDurationMs >= ANOMALY_CRITICAL_MULTIPLIER ? 'critical' : 'warning',
          currentValue: Math.round(current.avgDurationMs),
          baselineValue: Math.round(base.avgDurationMs),
        });
      }
    }

    // Check for usage drops (skills in baseline but missing/low in current)
    for (const [skill, base] of Object.entries(baseline)) {
      if (base.calls < 10) continue; // Only flag drops for well-used skills
      const current = currentWeek[skill]?.calls ?? 0;
      if (current < base.calls * 0.3) {
        anomalies.push({
          type: 'usage_drop',
          skill,
          description: `${skill}: nur ${current} Calls (normal: ~${Math.round(base.calls)}/Woche)`,
          severity: current === 0 ? 'critical' : 'warning',
          currentValue: current,
          baselineValue: Math.round(base.calls),
        });
      }
    }

    // Sort: critical first, then by severity
    return anomalies
      .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1))
      .slice(0, 10);
  }

  // ── Summary + Storage ───────────────────────────────────────

  private buildSummary(trends: Trend[], anomalies: Anomaly[], weekKey: string): string {
    const parts: string[] = [`Woche ${weekKey}:`];

    if (trends.length > 0) {
      parts.push('Trends:');
      for (const t of trends.slice(0, 5)) {
        const arrow = t.direction === 'up' ? '↑' : '↓';
        parts.push(`  ${arrow} ${t.skill}: ${t.currentWeek} Calls (${t.changePercent > 0 ? '+' : ''}${t.changePercent}% vs. Ø ${t.baseline})`);
      }
    }

    if (anomalies.length > 0) {
      parts.push('Anomalien:');
      for (const a of anomalies.slice(0, 5)) {
        const icon = a.severity === 'critical' ? '🔴' : '🟡';
        parts.push(`  ${icon} ${a.description}`);
      }
    }

    if (trends.length === 0 && anomalies.length === 0) {
      parts.push('Keine auffälligen Trends oder Anomalien.');
    }

    return parts.join('\n');
  }

  private async saveResults(userId: string, trends: Trend[], anomalies: Anomaly[], summary: string): Promise<void> {
    // Save trends summary
    const trendsText = trends.length > 0
      ? trends.map(t => {
        const arrow = t.direction === 'up' ? '↑' : '↓';
        return `${arrow} ${t.skill}: ${t.changePercent > 0 ? '+' : ''}${t.changePercent}% (${t.currentWeek} vs. Ø ${t.baseline}/Woche)`;
      }).join('\n')
      : 'Keine signifikanten Trends.';

    await this.memoryRepo.saveWithMetadata(
      userId, 'temporal_trends_weekly', trendsText,
      'behavior', 'pattern', 0.7, 'auto',
    );

    // Save anomalies
    const anomaliesText = anomalies.length > 0
      ? anomalies.map(a => `[${a.severity}] ${a.description}`).join('\n')
      : 'Keine Anomalien.';

    await this.memoryRepo.saveWithMetadata(
      userId, 'temporal_anomalies_weekly', anomaliesText,
      'behavior', 'pattern', 0.8, 'auto',
    );
  }
}

// ── Internal Types ────────────────────────────────────────────

interface SkillWeekData {
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
}
