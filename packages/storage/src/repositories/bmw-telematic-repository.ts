import type { AsyncDbAdapter } from '../db-adapter.js';

export interface BmwTelematicEntry {
  id: number;
  userId: string;
  vin: string;
  source: 'mqtt' | 'rest';
  telematicData: Record<string, { value: string; unit: string; timestamp: string }>;
  createdAt: string;
}

export class BmwTelematicRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /** Write a telematic snapshot (from MQTT event or REST response). */
  async insert(userId: string, vin: string, source: 'mqtt' | 'rest', telematicData: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      'INSERT INTO bmw_telematic_log (user_id, vin, source, telematic_data, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, vin, source, JSON.stringify(telematicData), now],
    );
  }

  /** Get the latest telematic snapshot for a VIN (from any source). */
  async getLatest(userId: string, vin: string): Promise<BmwTelematicEntry | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM bmw_telematic_log WHERE user_id = ? AND vin = ? ORDER BY created_at DESC LIMIT 1',
      [userId, vin],
    ) as Record<string, unknown> | undefined;
    return row ? this.map(row) : undefined;
  }

  /** Get telematic history for a VIN within a time range. */
  async getHistory(userId: string, vin: string, from: string, to: string, limit = 500): Promise<BmwTelematicEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM bmw_telematic_log WHERE user_id = ? AND vin = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?',
      [userId, vin, from, to, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  /** Prune old entries (keep last N days). */
  async prune(daysToKeep = 90): Promise<number> {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60_000).toISOString();
    const result = await this.adapter.execute(
      'DELETE FROM bmw_telematic_log WHERE created_at < ?',
      [cutoff],
    );
    return result.changes;
  }

  private map(row: Record<string, unknown>): BmwTelematicEntry {
    let telematicData: Record<string, unknown> = {};
    try { telematicData = JSON.parse(row.telematic_data as string); } catch { /* empty */ }
    return {
      id: row.id as number,
      userId: row.user_id as string,
      vin: row.vin as string,
      source: row.source as 'mqtt' | 'rest',
      telematicData: telematicData as BmwTelematicEntry['telematicData'],
      createdAt: row.created_at as string,
    };
  }
}
