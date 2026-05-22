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
  // v671 — Spiegel-Link zu Project-Open-Item (optional)
  linkedProjectId?: string;
  linkedOpenItemId?: string;
}

/** v670 — Arbeits-/Fortschritts-Notiz an einem Todo. */
export interface TodoNote {
  id: string;
  todoId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export class TodoRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async add(
    userId: string,
    title: string,
    opts?: { list?: string; description?: string; priority?: string; dueDate?: string; linkedProjectId?: string; linkedOpenItemId?: string },
  ): Promise<TodoEntry> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const list = opts?.list ?? 'default';
    const priority = opts?.priority ?? 'normal';

    // v671 — linked_project_id / linked_open_item_id mitanlegen
    await this.adapter.execute(
      'INSERT INTO todos (id, user_id, list, title, description, priority, due_date, completed, created_at, updated_at, linked_project_id, linked_open_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [id, userId, list, title, opts?.description ?? null, priority, opts?.dueDate ?? null, now, now, opts?.linkedProjectId ?? null, opts?.linkedOpenItemId ?? null],
    );

    return { id, userId, list, title, description: opts?.description, priority: priority as TodoEntry['priority'], dueDate: opts?.dueDate, completed: false, createdAt: now, updatedAt: now, linkedProjectId: opts?.linkedProjectId, linkedOpenItemId: opts?.linkedOpenItemId };
  }

  /** v671 — Spiegel-Link explizit setzen oder entfernen. Wird vom alfred.ts-Layer
   *  benutzt nachdem ein Open-Item parallel angelegt wurde, damit die Referenz
   *  in beiden Tabellen konsistent ist. */
  async setLink(todoId: string, linkedProjectId: string | null, linkedOpenItemId: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      `UPDATE todos SET linked_project_id = ?, linked_open_item_id = ?, updated_at = ? WHERE id = ?`,
      [linkedProjectId, linkedOpenItemId, now, todoId],
    );
  }

  /** v671 — Finde Todo per linked_open_item_id (Reverse-Lookup für Cross-Sync). */
  async findByLinkedOpenItem(openItemId: string): Promise<TodoEntry | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM todos WHERE linked_open_item_id = ?`, [openItemId],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
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

  /** v670 — alle bearbeitbaren Felder aktualisieren. Nur die in patch enthaltenen Keys werden überschrieben. */
  async update(todoId: string, userId: string, patch: {
    title?: string;
    description?: string | null;
    priority?: TodoEntry['priority'];
    dueDate?: string | null;
    list?: string;
  }): Promise<TodoEntry | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (patch.priority !== undefined) { sets.push('priority = ?'); params.push(patch.priority); }
    if (patch.dueDate !== undefined) { sets.push('due_date = ?'); params.push(patch.dueDate); }
    if (patch.list !== undefined) { sets.push('list = ?'); params.push(patch.list); }
    if (sets.length === 0) return (await this.getByIdForUser(todoId, userId)) ?? null;
    const now = new Date().toISOString();
    sets.push('updated_at = ?'); params.push(now);
    params.push(todoId, userId);
    await this.adapter.execute(
      `UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      params,
    );
    return (await this.getByIdForUser(todoId, userId)) ?? null;
  }

  // ── v670: Arbeits-/Fortschritts-Notizen ─────────────────────────────────

  async addNote(todoId: string, userId: string, content: string): Promise<TodoNote> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      'INSERT INTO todo_notes (id, todo_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, todoId, userId, content, now],
    );
    // updated_at am Parent bumpen, damit Todo-Sortierung den letzten Aktivitätsstand reflektiert
    await this.adapter.execute('UPDATE todos SET updated_at = ? WHERE id = ?', [now, todoId]);
    return { id, todoId, userId, content, createdAt: now };
  }

  async listNotes(todoId: string): Promise<TodoNote[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM todo_notes WHERE todo_id = ? ORDER BY created_at DESC',
      [todoId],
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      todoId: r.todo_id as string,
      userId: r.user_id as string,
      content: r.content as string,
      createdAt: r.created_at as string,
    }));
  }

  async deleteNote(noteId: string, userId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM todo_notes WHERE id = ? AND user_id = ?',
      [noteId, userId],
    );
    return result.changes > 0;
  }

  // ── v672: M:N-Verknüpfung Todo ↔ Note (User-Notes aus notes-Tabelle, nicht todo_notes) ──

  async linkNote(todoId: string, noteId: string): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await this.adapter.execute(
        'INSERT INTO todo_note_links (todo_id, note_id, created_at) VALUES (?, ?, ?)',
        [todoId, noteId, now],
      );
      return true;
    } catch {
      // Duplikat (Composite-PK) → schon verknüpft, gilt als erfolgreich
      return false;
    }
  }

  async unlinkNote(todoId: string, noteId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM todo_note_links WHERE todo_id = ? AND note_id = ?',
      [todoId, noteId],
    );
    return result.changes > 0;
  }

  /** Liste der noteIds die mit einem Todo verknüpft sind, neueste Verknüpfung zuerst. */
  async listLinkedNoteIds(todoId: string): Promise<string[]> {
    const rows = await this.adapter.query(
      'SELECT note_id FROM todo_note_links WHERE todo_id = ? ORDER BY created_at DESC',
      [todoId],
    ) as Array<{ note_id: string }>;
    return rows.map(r => r.note_id);
  }

  /** Liste der todoIds die eine bestimmte Note referenzieren. */
  async listLinkedTodoIds(noteId: string): Promise<string[]> {
    const rows = await this.adapter.query(
      'SELECT todo_id FROM todo_note_links WHERE note_id = ? ORDER BY created_at DESC',
      [noteId],
    ) as Array<{ todo_id: string }>;
    return rows.map(r => r.todo_id);
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
      // SQLite: 1/0; Postgres kann auch boolean liefern
      completed: row.completed === 1 || row.completed === true || row.completed === '1',
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      linkedProjectId: (row.linked_project_id as string | null) ?? undefined,
      linkedOpenItemId: (row.linked_open_item_id as string | null) ?? undefined,
    };
  }
}
