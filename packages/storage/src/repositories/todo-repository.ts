import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface TodoEntry {
  id: string;
  userId: string;
  list: string;
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export class TodoRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async add(
    userId: string,
    title: string,
    opts?: { list?: string; description?: string; priority?: string; dueDate?: string },
  ): Promise<TodoEntry> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const list = opts?.list ?? 'default';
    const priority = opts?.priority ?? 'normal';

    await this.adapter.execute(
      'INSERT INTO todos (id, user_id, list, title, description, priority, due_date, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [id, userId, list, title, opts?.description ?? null, priority, opts?.dueDate ?? null, now, now],
    );

    return { id, userId, list, title, description: opts?.description, priority: priority as TodoEntry['priority'], dueDate: opts?.dueDate, completed: false, createdAt: now, updatedAt: now };
  }

  async list(userId: string, list?: string, includeCompleted = false): Promise<TodoEntry[]> {
    let sql = 'SELECT * FROM todos WHERE user_id = ?';
    const params: unknown[] = [userId];

    if (list) {
      sql += ' AND list = ?';
      params.push(list);
    }
    if (!includeCompleted) {
      sql += ' AND completed = 0';
    }
    sql += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'normal\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC';

    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getById(todoId: string): Promise<TodoEntry | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM todos WHERE id = ?', [todoId]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** Get a todo by ID, but only if it belongs to the specified user. */
  async getByIdForUser(todoId: string, userId: string): Promise<TodoEntry | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM todos WHERE id = ? AND user_id = ?', [todoId, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async complete(todoId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      'UPDATE todos SET completed = 1, updated_at = ? WHERE id = ? AND completed = 0',
      [now, todoId],
    );
    return result.changes > 0;
  }

  async uncomplete(todoId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      'UPDATE todos SET completed = 0, updated_at = ? WHERE id = ? AND completed = 1',
      [now, todoId],
    );
    return result.changes > 0;
  }

  async delete(todoId: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM todos WHERE id = ?', [todoId]);
    return result.changes > 0;
  }

  async clearCompleted(userId: string, list?: string): Promise<number> {
    let sql = 'DELETE FROM todos WHERE user_id = ? AND completed = 1';
    const params: unknown[] = [userId];
    if (list) {
      sql += ' AND list = ?';
      params.push(list);
    }
    const result = await this.adapter.execute(sql, params);
    return result.changes;
  }

  async getLists(userId: string): Promise<{ list: string; open: number; completed: number; total: number }[]> {
    const rows = await this.adapter.query(
      `SELECT list,
        SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
        COUNT(*) as total
       FROM todos WHERE user_id = ? GROUP BY list ORDER BY list`,
      [userId],
    ) as Record<string, unknown>[];

    return rows.map(r => ({
      list: r.list as string,
      open: Number(r.open),
      completed: Number(r.completed),
      total: Number(r.total),
    }));
  }

  /** Returns todos for a given list name, regardless of userId (used for shared lists). */
  async listByListName(listName: string, includeCompleted = false): Promise<TodoEntry[]> {
    let sql = 'SELECT * FROM todos WHERE list = ?';
    const params: unknown[] = [listName];
    if (!includeCompleted) {
      sql += ' AND completed = 0';
    }
    sql += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'normal\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC';
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /** Returns open todos with a due_date between now and windowEndIso (ISO strings). */
  async getDueInWindow(windowEndIso: string, userId?: string): Promise<TodoEntry[]> {
    const nowIso = new Date().toISOString();
    const sql = userId
      ? `SELECT * FROM todos WHERE user_id = ? AND completed = 0 AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date ASC`
      : `SELECT * FROM todos WHERE completed = 0 AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date ASC`;
    const params = userId ? [userId, nowIso, windowEndIso] : [nowIso, windowEndIso];
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /** Returns open todos where due_date has already passed (overdue). */
  async getOverdue(userId?: string): Promise<TodoEntry[]> {
    const nowIso = new Date().toISOString();
    const sql = userId
      ? `SELECT * FROM todos WHERE user_id = ? AND completed = 0 AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date ASC`
      : `SELECT * FROM todos WHERE completed = 0 AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date ASC`;
    const params = userId ? [userId, nowIso] : [nowIso];
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): TodoEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      list: row.list as string,
      title: row.title as string,
      description: row.description as string | undefined,
      priority: row.priority as TodoEntry['priority'],
      dueDate: row.due_date as string | undefined,
      completed: row.completed === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
