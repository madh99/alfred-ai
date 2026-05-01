import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type MemoryType =
  | 'fact'
  | 'preference'
  | 'correction'
  | 'entity'
  | 'decision'
  | 'relationship'
  | 'principle'
  | 'commitment'
  | 'moment'
  | 'skill'
  | 'pattern'
  | 'connection'
  | 'feedback'
  | 'rule'
  | 'general';

export type MemorySource = 'manual' | 'auto';

export interface MemoryEntry {
  id: string;
  userId: string;
  key: string;
  value: string;
  category: string;
  type: MemoryType;
  confidence: number;
  source: MemorySource;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  /**
   * Date until which this memory is semantically valid. Used by reasoning engine
   * to filter stale temporal corrections from the prompt block — past `relevant_until`,
   * the memory is rendered as "(abgelaufen)" or skipped, but NOT hard-deleted (kept
   * for historical context).
   */
  relevantUntil?: string | null;
  /**
   * For `_resolved` corrections: list of source-event identifiers this correction
   * resolves (e.g. ["invoice:INV-2026-04-001", "email:msg-id-abc"]). Future insights
   * matching the same topic but with DIFFERENT refs are NOT blocked by this correction.
   */
  sourceEventRefs?: string[] | null;
}

export class MemoryRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async save(userId: string, key: string, value: string, category = 'general'): Promise<MemoryEntry> {
    return this.saveWithMetadata(userId, key, value, category, 'general', 1.0, 'manual');
  }

  async saveWithMetadata(
    userId: string,
    key: string,
    value: string,
    category: string,
    type: MemoryType,
    confidence: number,
    source: MemorySource,
  ): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.adapter.execute(
      `INSERT INTO memories (id, user_id, key, value, category, type, confidence, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         category = excluded.category,
         type = excluded.type,
         confidence = excluded.confidence,
         source = excluded.source,
         updated_at = excluded.updated_at,
         expires_at = NULL
       -- Guard 1: auto cannot overwrite manual (user's explicit saves are protected)
       -- Guard 2: auto cannot overwrite correction-type memories (user corrections are permanent)
       -- Note: manual CAN overwrite manual/correction. auto CAN overwrite auto (except corrections).
       WHERE NOT (memories.source = 'manual' AND excluded.source = 'auto')
         AND NOT (memories.type = 'correction' AND excluded.source = 'auto')`,
      [id, userId, key, value, category, type, confidence, source, now, now],
    );

    const row = await this.adapter.queryOne(
      'SELECT * FROM memories WHERE user_id = ? AND key = ?',
      [userId, key],
    ) as Record<string, unknown>;
    return this.mapRow(row);
  }

  async saveWithTTL(
    userId: string,
    key: string,
    value: string,
    category: string,
    ttlMinutes: number,
  ): Promise<MemoryEntry> {
    const entry = await this.saveWithMetadata(userId, key, value, category, 'general', 1.0, 'manual');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await this.adapter.execute(
      'UPDATE memories SET expires_at = ? WHERE user_id = ? AND key = ?',
      [expiresAt, userId, key],
    );
    entry.expiresAt = expiresAt;
    return entry;
  }

  /** Set expiry date on a memory (for time-bound events). */
  async setExpiry(userId: string, key: string, expiresAt: string): Promise<void> {
    await this.adapter.execute(
      'UPDATE memories SET expires_at = ? WHERE user_id = ? AND key = ?',
      [expiresAt, userId, key],
    );
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`,
      [now],
    );
    return result.changes;
  }

  async recall(userId: string, key: string): Promise<MemoryEntry | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM memories WHERE user_id = ? AND key = ?',
      [userId, key],
    ) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  async search(userId: string, query: string): Promise<MemoryEntry[]> {
    const pattern = `%${query}%`;
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC',
      [userId, pattern, pattern, now],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * BM25-inspired keyword search with term-frequency scoring.
   * Splits the query into terms and scores each memory by how many
   * terms match (in key or value), weighted by inverse document frequency.
   */
  async keywordSearch(userId: string, query: string, limit = 20): Promise<MemoryEntry[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (terms.length === 0) return [];

    // Build a WHERE clause that matches any term
    const conditions = terms.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)').join(' OR ');
    const params: unknown[] = [userId];
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`);
    }

    const rows = await this.adapter.query(
      `SELECT * FROM memories WHERE user_id = ? AND (${conditions}) ORDER BY updated_at DESC`,
      params,
    ) as Record<string, unknown>[];

    // Score: count how many terms match each row
    const scored = rows.map(row => {
      const entry = this.mapRow(row);
      const text = `${entry.key} ${entry.value}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score += 1;
      }
      // Normalize by total terms
      return { entry, score: score / terms.length };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  /**
   * Record an access to a memory (updates last_accessed_at and increments access_count).
   */
  async recordAccess(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
      [now, id],
    );
  }

  /**
   * Find stale memories: older than `olderThanDays` and with confidence below `maxConfidence`.
   */
  async findStale(userId: string, olderThanDays: number, maxConfidence: number): Promise<MemoryEntry[]> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? AND updated_at < ? AND confidence <= ? AND type != ? ORDER BY confidence ASC',
      [userId, cutoff, maxConfidence, 'rule'],
    ) as Record<string, unknown>[];

    return rows.map(row => this.mapRow(row));
  }

  /**
   * Bulk-delete memories by their IDs.
   */
  async deleteByIds(ids: string[], userId?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const sql = userId
      ? `DELETE FROM memories WHERE id IN (${placeholders}) AND user_id = ?`
      : `DELETE FROM memories WHERE id IN (${placeholders})`;
    const params = userId ? [...ids, userId] : ids;
    const result = await this.adapter.execute(sql, params);
    return result.changes;
  }

  async listByCategory(userId: string, category: string): Promise<MemoryEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC',
      [userId, category],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async listAll(userId: string): Promise<MemoryEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC',
      [userId],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async delete(userId: string, key: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM memories WHERE user_id = ? AND key = ?',
      [userId, key],
    );

    return result.changes > 0;
  }

  async getByType(userId: string, type: string, limit = 10): Promise<MemoryEntry[]> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? AND type = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, updated_at DESC LIMIT ?',
      [userId, type, now, limit],
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Adjust the confidence of a memory by a delta (clamped to [0, 1]).
   */
  async updateConfidence(id: string, delta: number): Promise<void> {
    await this.adapter.execute(
      `UPDATE memories SET confidence = MIN(1.0, MAX(0.0, confidence + ?)), updated_at = ? WHERE id = ?`,
      [delta, new Date().toISOString(), id],
    );
  }

  async getRecentForPrompt(userId: string, limit = 20): Promise<MemoryEntry[]> {
    const now = new Date().toISOString();
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, updated_at DESC LIMIT ?',
      [userId, now, limit],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  /** Update relevant_until for a memory (used by save-time temporal extraction). */
  async setRelevantUntil(userId: string, key: string, relevantUntil: string | null): Promise<void> {
    await this.adapter.execute(
      'UPDATE memories SET relevant_until = ? WHERE user_id = ? AND key = ?',
      [relevantUntil, userId, key],
    );
  }

  /** Update source_event_refs (JSON-encoded array) for a memory. */
  async setSourceEventRefs(userId: string, key: string, refs: string[] | null): Promise<void> {
    await this.adapter.execute(
      'UPDATE memories SET source_event_refs = ? WHERE user_id = ? AND key = ?',
      [refs && refs.length > 0 ? JSON.stringify(refs) : null, userId, key],
    );
  }

  /** Update value (for migration that re-resolves relative dates). */
  async updateValue(userId: string, key: string, value: string): Promise<void> {
    await this.adapter.execute(
      'UPDATE memories SET value = ? WHERE user_id = ? AND key = ?',
      [value, userId, key],
    );
  }

  /** Iterate all memories for a user — used by migrations & cleanup tasks. */
  async getAllForUser(userId: string): Promise<MemoryEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC',
      [userId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): MemoryEntry {
    let sourceEventRefs: string[] | null = null;
    if (row.source_event_refs) {
      try { sourceEventRefs = JSON.parse(row.source_event_refs as string); } catch { sourceEventRefs = null; }
    }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      key: row.key as string,
      value: row.value as string,
      category: (row.category as string) || 'general',
      type: (row.type as MemoryType) || 'general',
      confidence: (row.confidence as number) ?? 1.0,
      source: (row.source as MemorySource) || 'manual',
      lastAccessedAt: (row.last_accessed_at as string) || null,
      accessCount: (row.access_count as number) ?? 0,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      expiresAt: (row.expires_at as string) ?? null,
      relevantUntil: (row.relevant_until as string) ?? null,
      sourceEventRefs,
    };
  }
}
