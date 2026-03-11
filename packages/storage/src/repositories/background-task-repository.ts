import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackgroundTask } from '@alfred/types';

export class BackgroundTaskRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(
    userId: string,
    platform: string,
    chatId: string,
    description: string,
    skillName: string,
    skillInput: string,
  ): BackgroundTask {
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

    this.db.prepare(`
      INSERT INTO background_tasks (id, user_id, platform, chat_id, description, skill_name, skill_input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.userId,
      task.platform,
      task.chatId,
      task.description,
      task.skillName,
      task.skillInput,
      task.status,
      task.createdAt,
    );

    return task;
  }

  updateStatus(id: string, status: BackgroundTask['status'], result?: string, error?: string): void {
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

    this.db.prepare(`
      UPDATE background_tasks
      SET status = ?,
          result = COALESCE(?, result),
          error = COALESCE(?, error),
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at),
          checkpoint_at = COALESCE(?, checkpoint_at)
      WHERE id = ?
    `).run(status, result ?? null, error ?? null, startedAt, completedAt, checkpointAt, id);
  }

  getPending(limit = 10): BackgroundTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM background_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  /** Atomically claim pending tasks: SELECT + UPDATE to 'running' in a single transaction. */
  claimPending(limit = 10): BackgroundTask[] {
    const txn = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM background_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      ).all(limit) as Record<string, unknown>[];

      const now = new Date().toISOString();
      const updateStmt = this.db.prepare(
        `UPDATE background_tasks SET status = 'running', started_at = ? WHERE id = ?`,
      );
      for (const row of rows) {
        updateStmt.run(now, row.id as string);
      }

      return rows.map((row) => this.mapRow({ ...row, status: 'running', started_at: now }));
    });
    return txn();
  }

  /** Atomically claim a single task by ID (only if still pending). Returns true if claimed. */
  claimTask(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE background_tasks SET status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    ).run(id);
    return result.changes > 0;
  }

  getById(id: string): BackgroundTask | undefined {
    const row = this.db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getByUser(userId: string): BackgroundTask[] {
    const rows = this.db.prepare(
      `SELECT * FROM background_tasks
       WHERE user_id = ?
         AND (status IN ('pending', 'running', 'checkpointed', 'resuming') OR completed_at > datetime('now', '-1 day'))
       ORDER BY created_at DESC`,
    ).all(userId) as Record<string, unknown>[];

    return rows.map((row) => this.mapRow(row));
  }

  cancel(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE background_tasks
       SET status = 'cancelled', completed_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'running')`,
    ).run(id);
    return result.changes > 0;
  }

  cleanup(olderThanDays = 7): number {
    const result = this.db.prepare(
      `DELETE FROM background_tasks
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND completed_at < datetime('now', '-' || ? || ' days')`,
    ).run(olderThanDays);
    return result.changes;
  }

  checkpoint(id: string, agentState: string): void {
    this.db.prepare(`
      UPDATE background_tasks
      SET agent_state = ?, checkpoint_at = datetime('now')
      WHERE id = ?
    `).run(agentState, id);
  }

  getCheckpointed(): BackgroundTask[] {
    const rows = this.db.prepare(
      "SELECT * FROM background_tasks WHERE status = 'checkpointed' ORDER BY checkpoint_at DESC",
    ).all() as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  markResuming(id: string): void {
    this.db.prepare(`
      UPDATE background_tasks
      SET status = 'resuming', resume_count = resume_count + 1
      WHERE id = ?
    `).run(id);
  }

  getInterrupted(): BackgroundTask[] {
    const rows = this.db.prepare(
      "SELECT * FROM background_tasks WHERE status IN ('running', 'resuming') ORDER BY created_at ASC",
    ).all() as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  cancelTask(id: string): void {
    this.db.prepare(`
      UPDATE background_tasks
      SET status = 'cancelled', completed_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'running', 'checkpointed', 'resuming')
    `).run(id);
  }

  updatePersistentConfig(id: string, maxDurationHours: number): void {
    this.db.prepare('UPDATE background_tasks SET max_duration_hours = ? WHERE id = ?').run(maxDurationHours, id);
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
