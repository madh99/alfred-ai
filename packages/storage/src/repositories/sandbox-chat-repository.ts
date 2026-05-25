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

  /**
   * v793 — Update text and/or phase of a single message by id.
   * Genutzt von Code-Agent-Runner um die initiale "läuft"-Bubble in-place mit
   * Summary zu überschreiben (statt separate "✓ Fertig"-Bubble anzuhängen).
   */
  async updateMessage(id: string, fields: { text?: string; phase?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.text !== undefined) { sets.push('text = ?'); params.push(fields.text); }
    if (fields.phase !== undefined) { sets.push('task_phase = ?'); params.push(fields.phase); }
    if (sets.length === 0) return;
    params.push(id);
    await this.db.execute(
      `UPDATE sandbox_chat_messages SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  /**
   * v763/v765 — Startup-Cleanup: alle nicht-terminalen Agent-Chat-Messages als
   * failed markieren. Wird beim Alfred-Init aufgerufen damit Tasks die durch
   * Crash/Restart unterbrochen wurden, nicht ewig als "running" in der UI bleiben.
   *
   * Deckt v765 auch Project-Agent-Tasks ab (UUID-taskId ohne 'code-' Prefix) —
   * nach Restart läuft kein Project-Agent-Runner mehr für eingefrorene Sessions,
   * also sind alle non-terminal Phases real orphan.
   * 'awaiting_user' bleibt erhalten (pausierte Sessions warten auf User-Input).
   */
  async failOrphanedCodeAgentTasks(): Promise<number> {
    const r = await this.db.execute(
      `UPDATE sandbox_chat_messages
         SET task_phase = 'failed'
       WHERE role = 'agent'
         AND task_id IS NOT NULL
         AND task_phase IS NOT NULL
         AND task_phase NOT IN ('done', 'failed', 'stopped', 'awaiting_user')`,
      [],
    );
    return r.changes ?? 0;
  }

  /**
   * v763 — Prüfen ob ein bestimmter Code-Agent-Task laut DB noch nicht terminal ist.
   * Genutzt vom Stop-Endpoint um auch orphane Tasks (nicht mehr im Memory-Map) als stopped zu markieren.
   */
  async hasActiveTaskPhase(taskId: string): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM sandbox_chat_messages WHERE task_id = ? AND task_phase IS NOT NULL AND task_phase NOT IN ('done','failed','stopped') LIMIT 1`,
      [taskId],
    );
    return rows.length > 0;
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
