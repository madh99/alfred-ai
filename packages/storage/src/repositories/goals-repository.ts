import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';
export type GoalCategory = 'fitness' | 'finance' | 'relationships' | 'work' | 'health' | 'learning' | 'home' | 'other';
export type GoalCadence = 'daily' | 'weekly' | 'monthly' | 'one-time';
export type CheckpointStatus = 'on-track' | 'drifting' | 'achieved' | 'no-data' | 'paused';

export interface Goal {
  id: string;
  userId: string;
  title: string;
  description?: string;
  category?: GoalCategory;
  cadence?: GoalCadence;
  targetMetric?: string;
  source: 'user' | 'extracted-chat';
  sourceConversationId?: string;
  sourceMessageId?: string;
  status: GoalStatus;
  checkFrequencyDays: number;
  lastCheckedAt?: string;
  lastStatus?: CheckpointStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCheckpoint {
  id: string;
  goalId: string;
  checkedAt: string;
  status?: CheckpointStatus;
  evidence?: Record<string, unknown>;
  notes?: string;
}

export class GoalsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async create(userId: string, data: Partial<Goal> & { title: string }): Promise<Goal> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO alfred_goals
        (id, user_id, title, description, category, cadence, target_metric, source,
         source_conversation_id, source_message_id, status, check_frequency_days,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, data.title, data.description ?? null,
       data.category ?? null, data.cadence ?? null, data.targetMetric ?? null,
       data.source ?? 'user', data.sourceConversationId ?? null, data.sourceMessageId ?? null,
       data.status ?? 'active', data.checkFrequencyDays ?? 7,
       now, now],
    );
    return (await this.getById(userId, id))!;
  }

  async getById(userId: string, id: string): Promise<Goal | null> {
    const row = await this.db.queryOne(`SELECT * FROM alfred_goals WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * v804 — Owner-Filter umgehen. Wird vom IdentityResolver + System-internen
   * Lookups (z.B. Pipeline) verwendet wenn ownership-check anderswo passiert.
   * Wer normal user-scoped lesen will: getById(userId, id) bleibt der Default.
   */
  async getByIdAnyOwner(id: string): Promise<Goal | null> {
    const row = await this.db.queryOne(`SELECT * FROM alfred_goals WHERE id = ?`, [id]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async list(userId: string, filters?: { status?: GoalStatus; category?: GoalCategory; limit?: number }): Promise<Goal[]> {
    const where: string[] = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters?.status) { where.push('status = ?'); params.push(filters.status); }
    if (filters?.category) { where.push('category = ?'); params.push(filters.category); }
    params.push(filters?.limit ?? 200);
    const rows = await this.db.query(
      `SELECT * FROM alfred_goals WHERE ${where.join(' AND ')} ORDER BY status, created_at DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async update(userId: string, id: string, updates: Partial<Goal>): Promise<Goal | null> {
    const existing = await this.getById(userId, id);
    if (!existing) return null;
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    const simple: Record<string, string> = {
      title: 'title', description: 'description', category: 'category',
      cadence: 'cadence', targetMetric: 'target_metric', status: 'status',
      lastStatus: 'last_status', checkFrequencyDays: 'check_frequency_days',
    };
    for (const [k, col] of Object.entries(simple)) {
      if (k in updates) { fields.push(`${col} = ?`); params.push((updates as any)[k] ?? null); }
    }
    if (updates.lastCheckedAt !== undefined) { fields.push('last_checked_at = ?'); params.push(updates.lastCheckedAt); }
    params.push(id, userId);
    await this.db.execute(`UPDATE alfred_goals SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return this.getById(userId, id);
  }

  async findGoalsDueForCheck(userId: string): Promise<Goal[]> {
    const goals = await this.list(userId, { status: 'active' });
    const now = Date.now();
    return goals.filter(g => {
      if (!g.lastCheckedAt) return true;
      const elapsedDays = (now - new Date(g.lastCheckedAt).getTime()) / 86400_000;
      return elapsedDays >= g.checkFrequencyDays;
    });
  }

  async recordCheckpoint(goalId: string, status: CheckpointStatus, evidence?: Record<string, unknown>, notes?: string): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO alfred_goal_checkpoints (id, goal_id, checked_at, status, evidence, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, goalId, now, status, evidence ? JSON.stringify(evidence) : null, notes ?? null],
    );
    await this.db.execute(
      `UPDATE alfred_goals SET last_checked_at = ?, last_status = ?, updated_at = ? WHERE id = ?`,
      [now, status, now, goalId],
    );
  }

  async listCheckpoints(goalId: string, limit = 20): Promise<GoalCheckpoint[]> {
    const rows = await this.db.query(
      `SELECT * FROM alfred_goal_checkpoints WHERE goal_id = ? ORDER BY checked_at DESC LIMIT ?`,
      [goalId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      goalId: r.goal_id as string,
      checkedAt: r.checked_at as string,
      status: r.status as CheckpointStatus | undefined,
      evidence: r.evidence ? safeJson(r.evidence as string) : undefined,
      notes: r.notes as string | undefined,
    }));
  }

  private mapRow(r: Record<string, unknown>): Goal {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      title: r.title as string,
      description: r.description as string | undefined,
      category: r.category as GoalCategory | undefined,
      cadence: r.cadence as GoalCadence | undefined,
      targetMetric: r.target_metric as string | undefined,
      source: r.source as Goal['source'],
      sourceConversationId: r.source_conversation_id as string | undefined,
      sourceMessageId: r.source_message_id as string | undefined,
      status: r.status as GoalStatus,
      checkFrequencyDays: Number(r.check_frequency_days ?? 7),
      lastCheckedAt: r.last_checked_at as string | undefined,
      lastStatus: r.last_status as CheckpointStatus | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
