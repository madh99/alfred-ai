import type BetterSqlite3 from 'better-sqlite3';
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
  constructor(private readonly db: BetterSqlite3.Database) {}

  add(
    userId: string,
    title: string,
    opts?: { list?: string; description?: string; priority?: string; dueDate?: string },
  ): TodoEntry {
    const now = new Date().toISOString();
    const id = randomUUID();
    const list = opts?.list ?? 'default';
    const priority = opts?.priority ?? 'normal';

    this.db.prepare(
      'INSERT INTO todos (id, user_id, list, title, description, priority, due_date, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    ).run(id, userId, list, title, opts?.description ?? null, priority, opts?.dueDate ?? null, now, now);

    return { id, userId, list, title, description: opts?.description, priority: priority as TodoEntry['priority'], dueDate: opts?.dueDate, completed: false, createdAt: now, updatedAt: now };
  }

  list(userId: string, list?: string, includeCompleted = false): TodoEntry[] {
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

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  getById(todoId: string): TodoEntry | undefined {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  complete(todoId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'UPDATE todos SET completed = 1, updated_at = ? WHERE id = ? AND completed = 0',
    ).run(now, todoId);
    return result.changes > 0;
  }

  uncomplete(todoId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'UPDATE todos SET completed = 0, updated_at = ? WHERE id = ? AND completed = 1',
    ).run(now, todoId);
    return result.changes > 0;
  }

  delete(todoId: string): boolean {
    const result = this.db.prepare('DELETE FROM todos WHERE id = ?').run(todoId);
    return result.changes > 0;
  }

  clearCompleted(userId: string, list?: string): number {
    let sql = 'DELETE FROM todos WHERE user_id = ? AND completed = 1';
    const params: unknown[] = [userId];
    if (list) {
      sql += ' AND list = ?';
      params.push(list);
    }
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  getLists(userId: string): { list: string; open: number; completed: number; total: number }[] {
    const rows = this.db.prepare(
      `SELECT list,
        SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
        COUNT(*) as total
       FROM todos WHERE user_id = ? GROUP BY list ORDER BY list`,
    ).all(userId) as Record<string, unknown>[];

    return rows.map(r => ({
      list: r.list as string,
      open: Number(r.open),
      completed: Number(r.completed),
      total: Number(r.total),
    }));
  }

  /** Returns open todos with a due_date between now and windowEndIso (ISO strings). */
  getDueInWindow(windowEndIso: string): TodoEntry[] {
    const nowIso = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM todos
       WHERE completed = 0 AND due_date IS NOT NULL
         AND due_date >= ? AND due_date <= ?
       ORDER BY due_date ASC`,
    ).all(nowIso, windowEndIso) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /** Returns open todos where due_date has already passed (overdue). */
  getOverdue(): TodoEntry[] {
    const nowIso = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM todos
       WHERE completed = 0 AND due_date IS NOT NULL AND due_date < ?
       ORDER BY due_date ASC`,
    ).all(nowIso) as Record<string, unknown>[];
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
