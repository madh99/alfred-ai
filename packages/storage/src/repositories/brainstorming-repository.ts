import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface BrainstormingSession {
  id: string;
  userId: string;
  topic: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrainstormingItem {
  id: string;
  sessionId: string;
  phase: 'ideas' | 'analysis' | 'action_plan';
  category?: string;
  content: string;
  status: 'open' | 'selected' | 'rejected' | 'done';
  linkedEntityId?: string;
  linkedActionId?: string;
  createdAt: string;
}

export class BrainstormingRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async createSession(userId: string, topic: string, context?: Record<string, unknown>): Promise<BrainstormingSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      'INSERT INTO brainstorming_sessions (id, user_id, topic, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, topic, 'active', JSON.stringify(context ?? {}), now, now],
    );
    return { id, userId, topic, status: 'active', context: context ?? {}, createdAt: now, updatedAt: now };
  }

  async getSession(id: string): Promise<BrainstormingSession | undefined> {
    const row = await this.adapter.queryOne('SELECT * FROM brainstorming_sessions WHERE id = ?', [id]) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  async getActiveSession(userId: string, topic?: string): Promise<BrainstormingSession | undefined> {
    const sql = topic
      ? "SELECT * FROM brainstorming_sessions WHERE user_id = ? AND status = 'active' AND lower(topic) LIKE ? ORDER BY updated_at DESC LIMIT 1"
      : "SELECT * FROM brainstorming_sessions WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1";
    const params = topic ? [userId, `%${topic.toLowerCase()}%`] : [userId];
    const row = await this.adapter.queryOne(sql, params) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  async listSessions(userId: string, limit = 10): Promise<BrainstormingSession[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM brainstorming_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
      [userId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapSession(r));
  }

  async updateSessionStatus(id: string, status: BrainstormingSession['status']): Promise<void> {
    await this.adapter.execute(
      'UPDATE brainstorming_sessions SET status = ?, updated_at = ? WHERE id = ?',
      [status, new Date().toISOString(), id],
    );
  }

  async touchSession(id: string): Promise<void> {
    await this.adapter.execute(
      'UPDATE brainstorming_sessions SET updated_at = ? WHERE id = ?',
      [new Date().toISOString(), id],
    );
  }

  async addItem(sessionId: string, phase: BrainstormingItem['phase'], content: string, category?: string): Promise<BrainstormingItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      'INSERT INTO brainstorming_items (id, session_id, phase, category, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, phase, category ?? null, content, 'open', now],
    );
    return { id, sessionId, phase, category: category ?? undefined, content, status: 'open', createdAt: now };
  }

  async getItems(sessionId: string, phase?: string): Promise<BrainstormingItem[]> {
    const sql = phase
      ? 'SELECT * FROM brainstorming_items WHERE session_id = ? AND phase = ? ORDER BY created_at'
      : 'SELECT * FROM brainstorming_items WHERE session_id = ? ORDER BY created_at';
    const rows = await this.adapter.query(sql, phase ? [sessionId, phase] : [sessionId]) as Record<string, unknown>[];
    return rows.map(r => this.mapItem(r));
  }

  async updateItemStatus(id: string, status: BrainstormingItem['status']): Promise<void> {
    await this.adapter.execute('UPDATE brainstorming_items SET status = ? WHERE id = ?', [status, id]);
  }

  async linkItemToAction(id: string, actionId: string): Promise<void> {
    await this.adapter.execute('UPDATE brainstorming_items SET linked_action_id = ?, status = ? WHERE id = ?', [actionId, 'done', id]);
  }

  private mapSession(row: Record<string, unknown>): BrainstormingSession {
    let context: Record<string, unknown> = {};
    try { context = JSON.parse(row.context as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      topic: row.topic as string,
      status: row.status as BrainstormingSession['status'],
      context,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapItem(row: Record<string, unknown>): BrainstormingItem {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      phase: row.phase as BrainstormingItem['phase'],
      category: row.category as string | undefined,
      content: row.content as string,
      status: row.status as BrainstormingItem['status'],
      linkedEntityId: row.linked_entity_id as string | undefined,
      linkedActionId: row.linked_action_id as string | undefined,
      createdAt: row.created_at as string,
    };
  }
}
