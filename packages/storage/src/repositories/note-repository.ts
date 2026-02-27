import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface NoteEntry {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export class NoteRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  save(userId: string, title: string, content: string): NoteEntry {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(
      'INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, userId, title, content, now, now);

    return { id, userId, title, content, createdAt: now, updatedAt: now };
  }

  getById(noteId: string): NoteEntry | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as Record<string, string> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(userId: string, limit = 50): NoteEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(userId, limit) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  search(userId: string, query: string): NoteEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      'SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC',
    ).all(userId, pattern, pattern) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  update(noteId: string, title?: string, content?: string): NoteEntry | undefined {
    const existing = this.getById(noteId);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const newTitle = title ?? existing.title;
    const newContent = content ?? existing.content;

    this.db.prepare(
      'UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?',
    ).run(newTitle, newContent, now, noteId);

    return { ...existing, title: newTitle, content: newContent, updatedAt: now };
  }

  delete(noteId: string): boolean {
    const result = this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, string>): NoteEntry {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
