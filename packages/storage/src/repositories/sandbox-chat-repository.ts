import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

export type SandboxChatRole = 'user' | 'agent';

export interface SandboxChatMessage {
  id: string;
  sandboxId: string;
  userId: string;
  role: SandboxChatRole;
  text: string;
  taskId: string | null;
  taskPhase: string | null;
  createdAt: string;
}

/**
 * v703 — Chat-History pro Sandbox für Interactive-Mode.
 * User-Messages werden persistiert, Agent-Replies (= Project-Agent-Task-Resultate)
 * werden mit task_id verknüpft damit die Live-View den Output streamen kann.
 */
export class SandboxChatRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async append(input: { sandboxId: string; userId: string; role: SandboxChatRole; text: string; taskId?: string | null; taskPhase?: string | null }): Promise<SandboxChatMessage> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO sandbox_chat_messages (id, sandbox_id, user_id, role, text, task_id, task_phase, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.sandboxId, input.userId, input.role, input.text, input.taskId ?? null, input.taskPhase ?? null, now],
    );
    return { id, sandboxId: input.sandboxId, userId: input.userId, role: input.role, text: input.text, taskId: input.taskId ?? null, taskPhase: input.taskPhase ?? null, createdAt: now };
  }

  async list(sandboxId: string, limit = 200): Promise<SandboxChatMessage[]> {
    const rows = await this.db.query(
      `SELECT * FROM sandbox_chat_messages WHERE sandbox_id = ? ORDER BY created_at ASC LIMIT ?`,
      [sandboxId, limit],
    );
    return rows.map(r => this.mapRow(r));
  }

  async updateTaskPhase(taskId: string, phase: string): Promise<void> {
    await this.db.execute(
      `UPDATE sandbox_chat_messages SET task_phase = ? WHERE task_id = ?`,
      [phase, taskId],
    );
  }

  async deleteBySandbox(sandboxId: string): Promise<void> {
    await this.db.execute(`DELETE FROM sandbox_chat_messages WHERE sandbox_id = ?`, [sandboxId]);
  }

  private mapRow(row: DbRow): SandboxChatMessage {
    return {
      id: String(row.id),
      sandboxId: String(row.sandbox_id),
      userId: String(row.user_id),
      role: row.role as SandboxChatRole,
      text: String(row.text),
      taskId: row.task_id ? String(row.task_id) : null,
      taskPhase: row.task_phase ? String(row.task_phase) : null,
      createdAt: String(row.created_at),
    };
  }
}
