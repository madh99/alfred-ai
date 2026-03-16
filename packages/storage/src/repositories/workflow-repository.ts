import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { WorkflowChain, WorkflowExecution } from '@alfred/types';

export class WorkflowRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(chain: Omit<WorkflowChain, 'id' | 'createdAt'>): Promise<WorkflowChain> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO workflow_chains (id, name, user_id, chat_id, platform, steps, trigger_type, trigger_config, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, chain.name, chain.userId, chain.chatId, chain.platform,
      JSON.stringify(chain.steps), chain.triggerType,
      chain.triggerConfig ? JSON.stringify(chain.triggerConfig) : null,
      chain.enabled ? 1 : 0, now,
    ]);
    return { ...chain, id, createdAt: now };
  }

  async getById(id: string): Promise<WorkflowChain | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM workflow_chains WHERE id = ?', [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapChain(row) : undefined;
  }

  async findByUser(userId: string): Promise<WorkflowChain[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM workflow_chains WHERE user_id = ? ORDER BY created_at DESC', [userId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapChain(r));
  }

  async findByChatId(chatId: string, platform: string): Promise<WorkflowChain[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM workflow_chains WHERE chat_id = ? AND platform = ? ORDER BY created_at DESC', [chatId, platform],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapChain(r));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM workflow_chains WHERE id = ?', [id],
    );
    return result.changes > 0;
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    await this.adapter.execute(
      'UPDATE workflow_chains SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id],
    );
  }

  async createExecution(chainId: string, totalSteps: number): Promise<WorkflowExecution> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO workflow_executions (id, chain_id, status, steps_completed, total_steps, started_at)
      VALUES (?, ?, 'running', 0, ?, ?)
    `, [id, chainId, totalSteps, now]);
    return {
      id, chainId, status: 'running', stepsCompleted: 0,
      totalSteps, startedAt: now,
    };
  }

  async updateExecution(id: string, updates: Partial<Pick<WorkflowExecution, 'status' | 'stepsCompleted' | 'stepResults' | 'error' | 'completedAt'>>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.stepsCompleted !== undefined) { sets.push('steps_completed = ?'); values.push(updates.stepsCompleted); }
    if (updates.stepResults !== undefined) { sets.push('step_results = ?'); values.push(updates.stepResults); }
    if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error); }
    if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(updates.completedAt); }
    if (sets.length === 0) return;
    values.push(id);
    await this.adapter.execute(
      `UPDATE workflow_executions SET ${sets.join(', ')} WHERE id = ?`, values,
    );
  }

  async getExecution(id: string): Promise<WorkflowExecution | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM workflow_executions WHERE id = ?', [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapExecution(row) : undefined;
  }

  async getRecentExecutions(chainId: string, limit = 10): Promise<WorkflowExecution[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM workflow_executions WHERE chain_id = ? ORDER BY started_at DESC LIMIT ?', [chainId, limit],
    ) as Record<string, unknown>[];
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
