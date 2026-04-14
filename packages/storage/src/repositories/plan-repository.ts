import type { AsyncDbAdapter } from '../db-adapter.js';
import type { Plan, PlanStatus } from '@alfred/types';
import { randomUUID } from 'node:crypto';

export class PlanRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(plan: Omit<Plan, 'id' | 'createdAt' | 'updatedAt'>): Promise<Plan> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const full: Plan = { ...plan, id, createdAt: now, updatedAt: now };

    await this.adapter.execute(
      `INSERT INTO plans (id, user_id, goal, status, steps, current_step_index, context, trigger_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, full.userId, full.goal, full.status, JSON.stringify(full.steps), full.currentStepIndex,
       JSON.stringify(full.context), full.triggerSource, now, now],
    );
    return full;
  }

  async update(plan: Plan): Promise<void> {
    plan.updatedAt = new Date().toISOString();
    await this.adapter.execute(
      `UPDATE plans SET status = ?, steps = ?, current_step_index = ?, context = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [plan.status, JSON.stringify(plan.steps), plan.currentStepIndex,
       JSON.stringify(plan.context), plan.updatedAt, plan.completedAt ?? null, plan.id],
    );
  }

  async getById(id: string): Promise<Plan | null> {
    const row = await this.adapter.queryOne('SELECT * FROM plans WHERE id = ?', [id]) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async getActiveByUser(userId: string): Promise<Plan[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM plans WHERE user_id = ? AND status IN ('running', 'paused_at_checkpoint', 'pending_approval')
       ORDER BY created_at DESC`,
      [userId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async getRecentByUser(userId: string, limit = 10): Promise<Plan[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async cancelExpired(timeoutHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60_000).toISOString();
    const result = await this.adapter.execute(
      `UPDATE plans SET status = 'cancelled', updated_at = ?
       WHERE status IN ('running', 'paused_at_checkpoint', 'pending_approval') AND updated_at < ?`,
      [new Date().toISOString(), cutoff],
    );
    return result.changes;
  }

  private mapRow(row: Record<string, unknown>): Plan {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      goal: row.goal as string,
      status: row.status as PlanStatus,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps as Plan['steps'],
      currentStepIndex: (row.current_step_index as number) ?? 0,
      context: typeof row.context === 'string' ? JSON.parse(row.context) : (row.context as Record<string, unknown>) ?? {},
      triggerSource: (row.trigger_source as Plan['triggerSource']) ?? 'reasoning',
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: row.completed_at as string | undefined,
    };
  }
}
