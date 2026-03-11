import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { WorkflowChain, WorkflowExecution } from '@alfred/types';

export class WorkflowRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(chain: Omit<WorkflowChain, 'id' | 'createdAt'>): WorkflowChain {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflow_chains (id, name, user_id, chat_id, platform, steps, trigger_type, trigger_config, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, chain.name, chain.userId, chain.chatId, chain.platform,
      JSON.stringify(chain.steps), chain.triggerType,
      chain.triggerConfig ? JSON.stringify(chain.triggerConfig) : null,
      chain.enabled ? 1 : 0, now,
    );
    return { ...chain, id, createdAt: now };
  }

  getById(id: string): WorkflowChain | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_chains WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapChain(row) : undefined;
  }

  findByUser(userId: string): WorkflowChain[] {
    const rows = this.db.prepare(
      'SELECT * FROM workflow_chains WHERE user_id = ? ORDER BY created_at DESC',
    ).all(userId) as Record<string, unknown>[];
    return rows.map(r => this.mapChain(r));
  }

  findByChatId(chatId: string, platform: string): WorkflowChain[] {
    const rows = this.db.prepare(
      'SELECT * FROM workflow_chains WHERE chat_id = ? AND platform = ? ORDER BY created_at DESC',
    ).all(chatId, platform) as Record<string, unknown>[];
    return rows.map(r => this.mapChain(r));
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workflow_chains WHERE id = ?').run(id);
    return result.changes > 0;
  }

  toggle(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE workflow_chains SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  createExecution(chainId: string, totalSteps: number): WorkflowExecution {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflow_executions (id, chain_id, status, steps_completed, total_steps, started_at)
      VALUES (?, ?, 'running', 0, ?, ?)
    `).run(id, chainId, totalSteps, now);
    return {
      id, chainId, status: 'running', stepsCompleted: 0,
      totalSteps, startedAt: now,
    };
  }

  updateExecution(id: string, updates: Partial<Pick<WorkflowExecution, 'status' | 'stepsCompleted' | 'stepResults' | 'error' | 'completedAt'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.stepsCompleted !== undefined) { sets.push('steps_completed = ?'); values.push(updates.stepsCompleted); }
    if (updates.stepResults !== undefined) { sets.push('step_results = ?'); values.push(updates.stepResults); }
    if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error); }
    if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(updates.completedAt); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE workflow_executions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getExecution(id: string): WorkflowExecution | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapExecution(row) : undefined;
  }

  getRecentExecutions(chainId: string, limit = 10): WorkflowExecution[] {
    const rows = this.db.prepare(
      'SELECT * FROM workflow_executions WHERE chain_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(chainId, limit) as Record<string, unknown>[];
    return rows.map(r => this.mapExecution(r));
  }

  private mapChain(row: Record<string, unknown>): WorkflowChain {
    return {
      id: row.id as string,
      name: row.name as string,
      userId: row.user_id as string,
      chatId: row.chat_id as string,
      platform: row.platform as string,
      steps: JSON.parse(row.steps as string),
      triggerType: row.trigger_type as WorkflowChain['triggerType'],
      triggerConfig: row.trigger_config ? JSON.parse(row.trigger_config as string) : undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at as string,
    };
  }

  private mapExecution(row: Record<string, unknown>): WorkflowExecution {
    return {
      id: row.id as string,
      chainId: row.chain_id as string,
      status: row.status as WorkflowExecution['status'],
      stepsCompleted: row.steps_completed as number,
      totalSteps: row.total_steps as number,
      stepResults: row.step_results as string | undefined,
      error: row.error as string | undefined,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | undefined,
    };
  }
}
