import type { AsyncDbAdapter } from '../db-adapter.js';

export interface UsageRecord {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface DailyUsageSummary {
  date: string;
  models: UsageRecord[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/**
 * v656 — Timezone-aware Bucket-Keys.
 *
 * Vorher: `new Date().toISOString().slice(0,10)` = UTC-Datum. In Europe/Vienna
 * (CEST=UTC+2) wurden die ersten 2h des lokalen Tages noch unter dem UTC-Datum
 * des Vortags gebucht — User-Report: "um 00:00 lokal kein neuer Tag".
 *
 * Lösung: `Intl.DateTimeFormat('en-CA', { timeZone })` liefert YYYY-MM-DD im
 * gewünschten TZ. `en-CA` hat YYYY-MM-DD als Native-Format ohne Locale-Suffix.
 */
function localDateKey(now: Date, tz: string | undefined): string {
  const timeZone = tz || 'UTC';
  try {
    // en-CA → YYYY-MM-DD; mit timeZone wird die Lokalzeit korrekt projiziert
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    // Fallback bei ungültigem Timezone-String
    return now.toISOString().slice(0, 10);
  }
}

function localHourKey(now: Date, tz: string | undefined): string {
  const timeZone = tz || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    // hour kann "24" sein in manchen impls — normalisieren
    let hour = get('hour');
    if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')}T${hour}`;
  } catch {
    return now.toISOString().slice(0, 13);
  }
}

export class UsageRepository {
  /** v656 — Owner-Timezone (z.B. 'Europe/Vienna') für Lokal-Bucketing. */
  private timezone: string | undefined;

  constructor(private readonly adapter: AsyncDbAdapter) {}

  setTimezone(tz: string | undefined): void {
    this.timezone = tz;
  }

  /**
   * Record a single LLM call.
   * Without userId: writes to llm_usage (global aggregate) — called by setPersist callback.
   * With userId: writes ONLY to llm_usage_by_user (per-user) — called by pipeline.
   * This separation prevents double-counting in llm_usage.
   *
   * v656: Schreibt parallel in llm_usage_hourly (Stunden-Bucket) für die
   * stundenweise Dashboard-Darstellung. Lokal-Zeitzone wird respektiert.
   */
  async record(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number, userId?: string): Promise<void> {
    const now = new Date();
    const date = localDateKey(now, this.timezone);
    const hourBucket = localHourKey(now, this.timezone);

    if (userId) {
      // Per-user only — global is handled by setPersist
      await this.adapter.execute(`
        INSERT INTO llm_usage_by_user (date, user_id, model, calls, input_tokens, output_tokens, cost_usd)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(date, user_id, model) DO UPDATE SET
          calls = llm_usage_by_user.calls + 1,
          input_tokens = llm_usage_by_user.input_tokens + excluded.input_tokens,
          output_tokens = llm_usage_by_user.output_tokens + excluded.output_tokens,
          cost_usd = llm_usage_by_user.cost_usd + excluded.cost_usd
      `, [date, userId, model, inputTokens, outputTokens, costUsd]);
    } else {
      // Global aggregate — called by setPersist for every LLM call
      await this.adapter.execute(`
        INSERT INTO llm_usage (date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, model) DO UPDATE SET
          calls = llm_usage.calls + excluded.calls,
          input_tokens = llm_usage.input_tokens + excluded.input_tokens,
          output_tokens = llm_usage.output_tokens + excluded.output_tokens,
          cache_read_tokens = llm_usage.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = llm_usage.cache_write_tokens + excluded.cache_write_tokens,
          cost_usd = llm_usage.cost_usd + excluded.cost_usd
      `, [date, model, 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd]);
      // v656 — Parallel-Schreiben in llm_usage_hourly
      try {
        await this.adapter.execute(`
          INSERT INTO llm_usage_hourly (hour_bucket, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(hour_bucket, model) DO UPDATE SET
            calls = llm_usage_hourly.calls + excluded.calls,
            input_tokens = llm_usage_hourly.input_tokens + excluded.input_tokens,
            output_tokens = llm_usage_hourly.output_tokens + excluded.output_tokens,
            cache_read_tokens = llm_usage_hourly.cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = llm_usage_hourly.cache_write_tokens + excluded.cache_write_tokens,
            cost_usd = llm_usage_hourly.cost_usd + excluded.cost_usd
        `, [hourBucket, model, 1, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd]);
      } catch { /* hourly table fehlt evtl. wenn Migration noch nicht durch — non-fatal */ }
    }
  }

  /** Get usage grouped by user_id for a date range. */
  async getByUser(startDate: string, endDate: string): Promise<Array<{ userId: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>> {
    const rows = await this.adapter.query(`
      SELECT user_id, SUM(calls) as calls, SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens, SUM(cost_usd) as cost_usd
      FROM llm_usage_by_user WHERE date >= ? AND date <= ?
      GROUP BY user_id ORDER BY cost_usd DESC
    `, [startDate, endDate]) as Record<string, unknown>[];
    return rows.map(r => ({
      userId: r.user_id as string,
      calls: r.calls as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      costUsd: r.cost_usd as number,
    }));
  }

  /** Get usage for a specific date. */
  async getDaily(date: string): Promise<DailyUsageSummary> {
    const rows = await this.adapter.query(`
      SELECT model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date = ?
    `, [date]) as Record<string, unknown>[];
    return this.buildSummary(date, rows);
  }

  /** Get usage for a date range (inclusive). */
  async getRange(startDate: string, endDate: string): Promise<DailyUsageSummary[]> {
    const rows = await this.adapter.query(`
      SELECT date, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage WHERE date >= ? AND date <= ? ORDER BY date, model
    `, [startDate, endDate]) as Record<string, unknown>[];
    const byDate = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const d = row.date as string;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(row);
    }
    return [...byDate.entries()].map(([d, r]) => this.buildSummary(d, r));
  }

  /** Get all-time totals grouped by model. */
  async getTotal(): Promise<UsageRecord[]> {
    const rows = await this.adapter.query(`
      SELECT model,
        SUM(calls) as calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(cost_usd) as cost_usd
      FROM llm_usage GROUP BY model
    `) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /**
   * v622 — Aggregiert llm_usage über Monats-Buckets statt täglich.
   * Wird vom Dashboard für Year/All-Time-Views genutzt (sonst 365 Tage-Balken).
   * Liefert pro Monat einen DailyUsageSummary mit `date='YYYY-MM'` (kein -DD).
   * Inklusive 'startDate' und 'endDate' (Format YYYY-MM-DD). Wenn 'endDate' im
   * laufenden Monat liegt, ist dieser Monat dabei (nicht abgeschnitten).
   */
  async getRangeByMonth(startDate: string, endDate: string): Promise<DailyUsageSummary[]> {
    const rows = await this.adapter.query(`
      SELECT SUBSTR(date, 1, 7) AS month, model,
             SUM(calls) AS calls,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_write_tokens) AS cache_write_tokens,
             SUM(cost_usd) AS cost_usd
      FROM llm_usage WHERE date >= ? AND date <= ?
      GROUP BY SUBSTR(date, 1, 7), model
      ORDER BY month, model
    `, [startDate, endDate]) as Record<string, unknown>[];
    const byMonth = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const m = row.month as string;
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m)!.push(row);
    }
    return [...byMonth.entries()].map(([m, r]) => this.buildSummary(m, r));
  }

  /**
   * v622 — All-Time Range: gibt frühestes Datum in llm_usage zurück, oder undefined.
   * Vom Dashboard genutzt um für "All-Time"-Picker den exakten startDate zu berechnen.
   */
  async getEarliestDate(): Promise<string | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT MIN(date) AS min_date FROM llm_usage`,
    ) as { min_date: string | null } | undefined;
    return row?.min_date ?? undefined;
  }

  async cleanup(olderThanDays: number = 365): Promise<number> {
    // v656 — Cutoff in Lokalzeit (sonst wäre er bei TZ-Wechsel der falsche Tag)
    const cutoff = localDateKey(new Date(Date.now() - olderThanDays * 86400000), this.timezone);
    const result = await this.adapter.execute(
      `DELETE FROM llm_usage WHERE date < ?`, [cutoff],
    );
    return result.changes;
  }

  /**
   * v656 — Stunden-Buckets für einen lokalen Tag (date = YYYY-MM-DD).
   * Liefert 24 DailyUsageSummary mit `date = 'YYYY-MM-DDTHH'` als Bucket-Key.
   * Leere Stunden werden als leerer Bucket mit totalCalls=0 zurückgegeben damit
   * das Frontend 24 Balken zeichnen kann.
   */
  async getHourly(localDate: string): Promise<DailyUsageSummary[]> {
    const rows = await this.adapter.query(`
      SELECT hour_bucket, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
      FROM llm_usage_hourly
      WHERE hour_bucket >= ? AND hour_bucket < ?
      ORDER BY hour_bucket, model
    `, [`${localDate}T00`, `${localDate}T24`]) as Record<string, unknown>[];
    const byBucket = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const b = row.hour_bucket as string;
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(row);
    }
    // Alle 24 Stunden zurückgeben — leere als 0-Bucket
    const result: DailyUsageSummary[] = [];
    for (let h = 0; h < 24; h++) {
      const bucketKey = `${localDate}T${String(h).padStart(2, '0')}`;
      const r = byBucket.get(bucketKey);
      result.push(this.buildSummary(bucketKey, r ?? []));
    }
    return result;
  }

  /** v656 — Hourly-Cleanup: für 62-Tage Retention (akt. Monat + Vormonat). */
  async cleanupHourly(olderThanDays: number = 62): Promise<number> {
    const cutoff = localDateKey(new Date(Date.now() - olderThanDays * 86400000), this.timezone);
    const cutoffBucket = `${cutoff}T00`;
    try {
      const result = await this.adapter.execute(
        `DELETE FROM llm_usage_hourly WHERE hour_bucket < ?`, [cutoffBucket],
      );
      return result.changes;
    } catch {
      return 0; // table noch nicht migriert
    }
  }

  private buildSummary(date: string, rows: Record<string, unknown>[]): DailyUsageSummary {
    const models = rows.map(r => this.mapRow(r));
    return {
      date,
      models,
      totalCalls: models.reduce((s, m) => s + m.calls, 0),
      totalInputTokens: models.reduce((s, m) => s + m.inputTokens, 0),
      totalOutputTokens: models.reduce((s, m) => s + m.outputTokens, 0),
      totalCostUsd: Math.round(models.reduce((s, m) => s + m.costUsd, 0) * 1_000_000) / 1_000_000,
    };
  }

  private mapRow(r: Record<string, unknown>): UsageRecord {
    return {
      model: r.model as string,
      calls: r.calls as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      costUsd: r.cost_usd as number,
    };
  }
}
