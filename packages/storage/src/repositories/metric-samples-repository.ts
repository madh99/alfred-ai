import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface MetricSample {
  id: string;
  userId: string;
  assetId?: string;
  metricName: string;
  value: number;
  unit?: string;
  sampledAt: string;
  source?: string;
}

export interface MetricForecast {
  metricName: string;
  assetId?: string;
  samplesCount: number;
  firstSeen: string;
  lastSeen: string;
  latestValue: number;
  slopePerDay: number;
  /** Days until `value` would reach `threshold` (linear extrapolation). null if slope ≤0 or already past. */
  daysUntilThreshold?: number | null;
  threshold?: number;
}

/**
 * v633 T3.4 — Persisting numeric monitor-values (CPU%, RAM%, disk%, queue length, …) so a
 * trend / capacity-forecast can be computed. Written by the auto-incident monitor wrap in
 * `alfred.ts` whenever it can parse a numeric value (`xx.x%` etc.) out of the alert text.
 */
export class MetricSamplesRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async record(userId: string, sample: Omit<MetricSample, 'id' | 'userId' | 'sampledAt'> & { sampledAt?: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO cmdb_metric_samples (id, user_id, asset_id, metric_name, value, unit, sampled_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        userId,
        sample.assetId ?? null,
        sample.metricName,
        sample.value,
        sample.unit ?? null,
        sample.sampledAt ?? new Date().toISOString(),
        sample.source ?? null,
      ],
    );
  }

  async listRecent(userId: string, opts?: { assetId?: string; metricName?: string; sinceIso?: string; limit?: number }): Promise<MetricSample[]> {
    const where: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts?.assetId) { where.push('asset_id = ?'); params.push(opts.assetId); }
    if (opts?.metricName) { where.push('metric_name = ?'); params.push(opts.metricName); }
    if (opts?.sinceIso) { where.push('sampled_at >= ?'); params.push(opts.sinceIso); }
    params.push(opts?.limit ?? 500);
    const rows = await this.db.query(
      `SELECT * FROM cmdb_metric_samples WHERE ${where.join(' AND ')} ORDER BY sampled_at DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      userId: r.user_id as string,
      assetId: (r.asset_id as string) ?? undefined,
      metricName: r.metric_name as string,
      value: Number(r.value),
      unit: (r.unit as string) ?? undefined,
      sampledAt: r.sampled_at as string,
      source: (r.source as string) ?? undefined,
    }));
  }

  /**
   * Compute a per-(asset, metric) linear forecast over the trailing window.
   * Returns one entry per distinct (asset_id, metric_name) pair with enough data points (≥3).
   */
  async forecast(userId: string, opts?: { windowDays?: number; threshold?: number; minSamples?: number }): Promise<MetricForecast[]> {
    const windowDays = opts?.windowDays ?? 30;
    const threshold = opts?.threshold ?? 95;
    const minSamples = opts?.minSamples ?? 3;
    const cutoffIso = new Date(Date.now() - windowDays * 86400_000).toISOString();
    const rows = await this.db.query(
      `SELECT asset_id, metric_name, value, sampled_at FROM cmdb_metric_samples
       WHERE user_id = ? AND sampled_at >= ?
       ORDER BY sampled_at ASC`,
      [userId, cutoffIso],
    ) as Array<{ asset_id: string | null; metric_name: string; value: number | string; sampled_at: string }>;

    const groups = new Map<string, Array<{ t: number; v: number }>>();
    for (const r of rows) {
      const key = `${r.asset_id ?? '∅'}::${r.metric_name}`;
      const arr = groups.get(key) ?? [];
      arr.push({ t: new Date(r.sampled_at).getTime() / 86400_000, v: Number(r.value) });
      groups.set(key, arr);
    }

    const results: MetricForecast[] = [];
    for (const [key, samples] of groups) {
      if (samples.length < minSamples) continue;
      const [assetId, metricName] = key.split('::');
      // Linear regression: v = slope * t + intercept
      const n = samples.length;
      const sumT = samples.reduce((s, x) => s + x.t, 0);
      const sumV = samples.reduce((s, x) => s + x.v, 0);
      const sumTV = samples.reduce((s, x) => s + x.t * x.v, 0);
      const sumTT = samples.reduce((s, x) => s + x.t * x.t, 0);
      const denom = n * sumTT - sumT * sumT;
      const slope = denom === 0 ? 0 : (n * sumTV - sumT * sumV) / denom;
      const intercept = (sumV - slope * sumT) / n;
      const latest = samples[samples.length - 1];
      const tNow = Date.now() / 86400_000;
      let daysUntilThreshold: number | null = null;
      if (slope > 0 && latest.v < threshold) {
        const tThreshold = (threshold - intercept) / slope;
        daysUntilThreshold = Math.max(0, Math.round(tThreshold - tNow));
      } else if (latest.v >= threshold) {
        daysUntilThreshold = 0;
      }
      results.push({
        metricName,
        assetId: assetId === '∅' ? undefined : assetId,
        samplesCount: n,
        firstSeen: new Date(samples[0].t * 86400_000).toISOString(),
        lastSeen: new Date(latest.t * 86400_000).toISOString(),
        latestValue: latest.v,
        slopePerDay: slope,
        daysUntilThreshold,
        threshold,
      });
    }
    return results.sort((a, b) => {
      // Most-urgent first: lowest daysUntilThreshold (non-null), then highest slope
      if (a.daysUntilThreshold != null && b.daysUntilThreshold != null) {
        return a.daysUntilThreshold - b.daysUntilThreshold;
      }
      if (a.daysUntilThreshold != null) return -1;
      if (b.daysUntilThreshold != null) return 1;
      return b.slopePerDay - a.slopePerDay;
    });
  }
}
