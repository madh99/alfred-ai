import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { BackgroundTask } from '@alfred/types';

export class BackgroundTaskRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(
    userId: string,
    platform: string,
    chatId: string,
    description: string,
    skillName: string,
    skillInput: string,
  ): Promise<BackgroundTask> {
    const task: BackgroundTask = {
      id: randomUUID(),
      userId,
      platform,
      chatId,
      description,
      skillName,
      skillInput,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await this.adapter.execute(`
      INSERT INTO background_tasks (id, user_id, platform, chat_id, description, skill_name, skill_input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      task.id,
      task.userId,
      task.platform,
      task.chatId,
      task.description,
      task.skillName,
      task.skillInput,
      task.status,
      task.createdAt,
    ]);

    return task;
  }

  async updateStatus(id: string, status: BackgroundTask['status'], result?: string, error?: string): Promise<void> {
    const now = new Date().toISOString();
    let startedAt: string | null = null;
    let completedAt: string | null = null;
    let checkpointAt: string | null = null;

    if (status === 'running') {
      startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      completedAt = now;
    }
    if (status === 'checkpointed') {
      checkpointAt = now;
    }

    await this.adapter.execute(`
      UPDATE background_tasks
      SET status = ?,
          result = COALESCE(?, result),
          error = COALESCE(?, error),
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at),
          checkpoint_at = COALESCE(?, checkpoint_at)
      WHERE id = ?
    `, [status, result ?? null, error ?? null, startedAt, completedAt, checkpointAt, id]);
  }

  async getPending(limit = 10): Promise<BackgroundTask[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM background_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      [limit],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  /** Atomically claim pending tasks: SELECT + UPDATE to 'running' in a single transaction. */
  async claimPending(limit = 10): Promise<BackgroundTask[]> {
    return this.adapter.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT * FROM background_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
        [limit],
      ) as Record<string, unknown>[];

      const now = new Date().toISOString();
      for (const row of rows) {
        await tx.execute(
          `UPDATE background_tasks SET status = 'running', started_at = ? WHERE id = ?`,
          [now, row.id as string],
        );
      }

      return rows.map((row) => this.mapRow({ ...row, status: 'running', started_at: now }));
    });
  }

  /** Atomically claim a single task by ID (only if still pending). Returns true if claimed. */
  async claimTask(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      `UPDATE background_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
      [now, id],
    );
    return result.changes > 0;
  }

  async getById(id: string): Promise<BackgroundTask | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM background_tasks WHERE id = ?',
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async getByUser(userId: string): Promise<BackgroundTask[]> {
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const rows = await this.adapter.query(
      `SELECT * FROM background_tasks
       WHERE user_id = ?
         AND (status IN ('pending', 'running', 'checkpointed', 'resuming') OR completed_at > ?)
       ORDER BY created_at DESC`,
      [userId, oneDayAgo],
    ) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  async cancel(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      `UPDATE background_tasks
       SET status = 'cancelled', completed_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
      [now, id],
    );
    return result.changes > 0;
  }

  async cleanup(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = await this.adapter.execute(
      `DELETE FROM background_tasks
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND completed_at < ?`,
      [cutoff],
    );
    return result.changes;
  }

  async checkpoint(id: string, agentState: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      UPDATE background_tasks
      SET agent_state = ?, checkpoint_at = ?
      WHERE id = ?
    `, [agentState, now, id]);
  }

  async getCheckpointed(): Promise<BackgroundTask[]> {
    const rows = await this.adapter.query(
      "SELECT * FROM background_tasks WHERE status = 'checkpointed' ORDER BY checkpoint_at DESC",
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async markResuming(id: string): Promise<void> {
    await this.adapter.execute(`
      UPDATE background_tasks
      SET status = 'resuming', resume_count = resume_count + 1
      WHERE id = ?
    `, [id]);
  }

  async getInterrupted(): Promise<BackgroundTask[]> {
    const rows = await this.adapter.query(
      "SELECT * FROM background_tasks WHERE status IN ('running', 'resuming') ORDER BY created_at ASC",
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async cancelTask(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(`
      UPDATE background_tasks
      SET status = 'cancelled', completed_at = ?
      WHERE id = ? AND status IN ('pending', 'running', 'checkpointed', 'resuming')
    `, [now, id]);
  }

  async updatePersistentConfig(id: string, maxDurationHours: number): Promise<void> {
    await this.adapter.execute(
      'UPDATE background_tasks SET max_duration_hours = ? WHERE id = ?',
      [maxDurationHours, id],
    );
  }

  private mapRow(row: Record<string, unknown>): BackgroundTask {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      platform: row.platform as string,
      chatId: row.chat_id as string,
      description: row.description as string,
      skillName: row.skill_name as string,
      skillInput: row.skill_input as string,
      status: row.status as BackgroundTask['status'],
      result: row.result as string | undefined,
      error: row.error as string | undefined,
      createdAt: row.created_at as string,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      agentState: row.agent_state as string | undefined,
      checkpointAt: row.checkpoint_at as string | undefined,
      resumeCount: (row.resume_count as number | undefined) ?? 0,
      maxDurationHours: row.max_duration_hours as number | undefined,
    };
  }
}
