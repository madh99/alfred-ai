import type { AsyncDbAdapter } from '../db-adapter.js';
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
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async save(userId: string, title: string, content: string): Promise<NoteEntry> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.adapter.execute(
      'INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, userId, title, content, now, now],
    );

    return { id, userId, title, content, createdAt: now, updatedAt: now };
  }

  async getById(noteId: string): Promise<NoteEntry | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM notes WHERE id = ?', [noteId]) as Record<string, string> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async list(userId: string, limit = 50): Promise<NoteEntry[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      [userId, limit],
    ) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  async search(userId: string, query: string): Promise<NoteEntry[]> {
    const pattern = `%${query}%`;
    const rows = await this.adapter.query(
      'SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC',
      [userId, pattern, pattern],
    ) as Record<string, string>[];
    return rows.map(r => this.mapRow(r));
  }

  async update(noteId: string, title?: string, content?: string): Promise<NoteEntry | undefined> {
    const existing = await this.getById(noteId);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const newTitle = title ?? existing.title;
    const newContent = content ?? existing.content;

    await this.adapter.execute(
      'UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?',
      [newTitle, newContent, now, noteId],
    );

    return { ...existing, title: newTitle, content: newContent, updatedAt: now };
  }

  async delete(noteId: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM notes WHERE id = ?', [noteId]);
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
