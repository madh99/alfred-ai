import type BetterSqlite3 from 'better-sqlite3';
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
}

export class MemoryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  save(userId: string, key: string, value: string, category = 'general'): MemoryEntry {
    return this.saveWithMetadata(userId, key, value, category, 'general', 1.0, 'manual');
  }

  saveWithMetadata(
    userId: string,
    key: string,
    value: string,
    category: string,
    type: MemoryType,
    confidence: number,
    source: MemorySource,
  ): MemoryEntry {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(
      `INSERT INTO memories (id, user_id, key, value, category, type, confidence, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         category = excluded.category,
         type = excluded.type,
         confidence = excluded.confidence,
         source = excluded.source,
         updated_at = excluded.updated_at,
         expires_at = NULL`,
    ).run(id, userId, key, value, category, type, confidence, source, now, now);

    const row = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND key = ?',
    ).get(userId, key) as Record<string, unknown>;
    return this.mapRow(row);
  }

  saveWithTTL(
    userId: string,
    key: string,
    value: string,
    category: string,
    ttlMinutes: number,
  ): MemoryEntry {
    const entry = this.saveWithMetadata(userId, key, value, category, 'general', 1.0, 'manual');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db.prepare(
      'UPDATE memories SET expires_at = ? WHERE user_id = ? AND key = ?',
    ).run(expiresAt, userId, key);
    entry.expiresAt = expiresAt;
    return entry;
  }

  cleanupExpired(): number {
    const result = this.db.prepare(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`,
    ).run();
    return result.changes;
  }

  recall(userId: string, key: string): MemoryEntry | undefined {
    const row = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND key = ?',
    ).get(userId, key) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  search(userId: string, query: string): MemoryEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC',
    ).all(userId, pattern, pattern) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * BM25-inspired keyword search with term-frequency scoring.
   * Splits the query into terms and scores each memory by how many
   * terms match (in key or value), weighted by inverse document frequency.
   */
  keywordSearch(userId: string, query: string, limit = 20): MemoryEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (terms.length === 0) return [];

    // Build a WHERE clause that matches any term
    const conditions = terms.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)').join(' OR ');
    const params: unknown[] = [userId];
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`);
    }

    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND (${conditions}) ORDER BY updated_at DESC`,
    ).all(...params) as Record<string, unknown>[];

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
  recordAccess(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    ).run(now, id);
  }

  /**
   * Find stale memories: older than `olderThanDays` and with confidence below `maxConfidence`.
   */
  findStale(userId: string, olderThanDays: number, maxConfidence: number): MemoryEntry[] {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND updated_at < ? AND confidence <= ? ORDER BY confidence ASC',
    ).all(userId, cutoff, maxConfidence) as Record<string, unknown>[];

    return rows.map(row => this.mapRow(row));
  }

  /**
   * Bulk-delete memories by their IDs.
   */
  deleteByIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db.prepare(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
    ).run(...ids);
    return result.changes;
  }

  listByCategory(userId: string, category: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC',
    ).all(userId, category) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  listAll(userId: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC',
    ).all(userId) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  delete(userId: string, key: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM memories WHERE user_id = ? AND key = ?',
    ).run(userId, key);

    return result.changes > 0;
  }

  getRecentForPrompt(userId: string, limit = 20): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(userId, limit) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): MemoryEntry {
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
    };
  }
}
