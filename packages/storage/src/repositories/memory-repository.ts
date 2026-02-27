import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface MemoryEntry {
  id: string;
  userId: string;
  key: string;
  value: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  save(userId: string, key: string, value: string, category = 'general'): MemoryEntry {
    const now = new Date().toISOString();

    const existing = this.db.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND key = ?',
    ).get(userId, key) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE memories SET value = ?, category = ?, updated_at = ? WHERE id = ?',
      ).run(value, category, now, existing.id);

      return {
        id: existing.id,
        userId,
        key,
        value,
        category,
        createdAt: (this.db.prepare('SELECT created_at FROM memories WHERE id = ?').get(existing.id) as { created_at: string }).created_at,
        updatedAt: now,
      };
    }

    const id = randomUUID();

    this.db.prepare(
      'INSERT INTO memories (id, user_id, key, value, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, key, value, category, now, now);

    return { id, userId, key, value, category, createdAt: now, updatedAt: now };
  }

  recall(userId: string, key: string): MemoryEntry | undefined {
    const row = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND key = ?',
    ).get(userId, key) as Record<string, string> | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  search(userId: string, query: string): MemoryEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC',
    ).all(userId, pattern, pattern) as Record<string, string>[];

    return rows.map((row) => this.mapRow(row));
  }

  listByCategory(userId: string, category: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC',
    ).all(userId, category) as Record<string, string>[];

    return rows.map((row) => this.mapRow(row));
  }

  listAll(userId: string): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC',
    ).all(userId) as Record<string, string>[];

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
    ).all(userId, limit) as Record<string, string>[];

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, string>): MemoryEntry {
    return {
      id: row.id,
      userId: row.user_id,
      key: row.key,
      value: row.value,
      category: row.category,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
