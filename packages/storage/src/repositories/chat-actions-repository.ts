/**
 * v847 — ProjectChatActionsRepository.
 *
 * Persistiert Chat-getriggerte Skill-Arbeit pro Projekt. Schließt die
 * Tracking-Lücke zwischen `project_agent_sessions` (volle Multi-Phase-Runs)
 * und `audit_log` (low-level security log).
 *
 * Ein ChatAction-Record wird erstellt wenn ein User im Project-Chat eine
 * Message sendet die mindestens einen Skill-Call auslöst. Während des
 * LLM-Loops werden Skill-Calls + Cost in den Record akkumuliert. Bei Done
 * wird response_text + Status gesetzt.
 *
 * Schema siehe Migration v101 (SQLite) bzw. v105 (PG).
 */

import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

export interface ChatActionSkillCall {
  /** Skill-Name (z.B. "code_agent", "shell"). */
  skill: string;
  /** Skill-Action (z.B. "orchestrate", "push", "list_alerts"). */
  action?: string;
  /** Dauer in ms. */
  durationMs: number;
  /** Token-/USD-Kosten falls bekannt (LLM-Calls aus dem Skill). */
  costUsd?: number;
  /** True wenn Skill erfolgreich. */
  success: boolean;
  /** Fehler-Message bei success=false. */
  error?: string;
  /** Unix-ms wann der Call startete (für Reihenfolge in UI). */
  startedAt: number;
}

export interface ChatAction {
  id: string;
  projectId: string;
  conversationId: string | null;
  userId: string;
  requestText: string;
  responseText: string | null;
  skillsCalled: ChatActionSkillCall[];
  totalSkillCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  commitShas: string[];
  modifiedFiles: string[];
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  endedAt: string | null;
}

export interface CreateChatActionInput {
  projectId: string;
  conversationId?: string | null;
  userId: string;
  requestText: string;
}

function parseJsonArray<T>(s: unknown): T[] {
  if (typeof s !== 'string' || !s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch { return []; }
}

function rowToAction(r: DbRow): ChatAction {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    userId: r.user_id as string,
    requestText: (r.request_text as string) ?? '',
    responseText: (r.response_text as string | null) ?? null,
    skillsCalled: parseJsonArray<ChatActionSkillCall>(r.skills_called),
    totalSkillCount: Number(r.total_skill_count ?? 0),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    totalDurationMs: Number(r.total_duration_ms ?? 0),
    commitShas: parseJsonArray<string>(r.commit_shas),
    modifiedFiles: parseJsonArray<string>(r.modified_files),
    status: ((r.status as string) ?? 'running') as ChatAction['status'],
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
  };
}

export class ChatActionsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async create(input: CreateChatActionInput): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO project_chat_actions
       (id, project_id, conversation_id, user_id, request_text, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      [id, input.projectId, input.conversationId ?? null, input.userId, input.requestText, now],
    );
    return id;
  }

  /**
   * v1111 — Boot-Reaper: nach einem Neustart hängen abgebrochene Chat-Läufe
   * sonst für immer als „running" in der UI (Realfall 12./13.07.: ~16 h).
   * Alle running-Actions terminal auf 'error' setzen; Anzahl zurückgeben.
   */
  async failOrphanedRunning(note = '[Durch Neustart abgebrochen]'): Promise<number> {
    const endedAt = new Date().toISOString();
    const orphaned = await this.db.query(
      `SELECT id FROM project_chat_actions WHERE status = 'running'`, [],
    ) as Array<{ id: string }>;
    for (const row of orphaned) {
      await this.db.execute(
        `UPDATE project_chat_actions
           SET status = 'error', ended_at = ?,
               response_text = COALESCE(response_text, '') || ?
         WHERE id = ? AND status = 'running'`,
        [endedAt, `\n${note}`, row.id],
      );
    }
    return orphaned.length;
  }

  /**
   * Append a single skill-call to an existing action. Re-reads current
   * array, appends, writes back — atomicity at app-level (single session
   * writes its own record).
   */
  async appendSkillCall(actionId: string, call: ChatActionSkillCall): Promise<void> {
    const row = (await this.db.query(
      `SELECT skills_called, total_skill_count, total_cost_usd, total_duration_ms
       FROM project_chat_actions WHERE id = ?`, [actionId],
    ))[0];
    if (!row) return;
    const existing = parseJsonArray<ChatActionSkillCall>(row.skills_called);
    existing.push(call);
    const newCount = Number(row.total_skill_count ?? 0) + 1;
    const newCost = Number(row.total_cost_usd ?? 0) + (call.costUsd ?? 0);
    const newDur = Number(row.total_duration_ms ?? 0) + call.durationMs;
    await this.db.execute(
      `UPDATE project_chat_actions
         SET skills_called = ?, total_skill_count = ?, total_cost_usd = ?, total_duration_ms = ?
       WHERE id = ?`,
      [JSON.stringify(existing), newCount, newCost, newDur, actionId],
    );
  }

  async appendCommits(actionId: string, shas: string[]): Promise<void> {
    if (shas.length === 0) return;
    const row = (await this.db.query(
      `SELECT commit_shas FROM project_chat_actions WHERE id = ?`, [actionId],
    ))[0];
    if (!row) return;
    const existing = parseJsonArray<string>(row.commit_shas);
    const merged = Array.from(new Set([...existing, ...shas]));
    await this.db.execute(
      `UPDATE project_chat_actions SET commit_shas = ? WHERE id = ?`,
      [JSON.stringify(merged), actionId],
    );
  }

  async appendModifiedFiles(actionId: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const row = (await this.db.query(
      `SELECT modified_files FROM project_chat_actions WHERE id = ?`, [actionId],
    ))[0];
    if (!row) return;
    const existing = parseJsonArray<string>(row.modified_files);
    const merged = Array.from(new Set([...existing, ...files]));
    await this.db.execute(
      `UPDATE project_chat_actions SET modified_files = ? WHERE id = ?`,
      [JSON.stringify(merged), actionId],
    );
  }

  async complete(actionId: string, responseText: string | null, status: 'completed' | 'error' = 'completed'): Promise<void> {
    const endedAt = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_chat_actions
         SET response_text = ?, status = ?, ended_at = ?
       WHERE id = ?`,
      [responseText, status, endedAt, actionId],
    );
  }

  async getById(actionId: string): Promise<ChatAction | null> {
    const rows = await this.db.query(
      `SELECT * FROM project_chat_actions WHERE id = ?`, [actionId],
    );
    return rows[0] ? rowToAction(rows[0]) : null;
  }

  async listByProject(projectId: string, limit = 50, offset = 0): Promise<ChatAction[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_chat_actions
       WHERE project_id = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
      [projectId, limit, offset],
    );
    return rows.map(rowToAction);
  }

  /** v847 — aktive (running) Aktionen für ProjectActiveIndicator. */
  async listRunning(projectId: string): Promise<ChatAction[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_chat_actions
       WHERE project_id = ? AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 10`,
      [projectId],
    );
    return rows.map(rowToAction);
  }

  /**
   * v847 — Aggregierte Stats für ProjectWorkStatsView.
   * Liefert Summen über alle non-running Actions des Projekts.
   */
  async aggregateStats(projectId: string): Promise<{
    count: number;
    totalCostUsd: number;
    totalDurationMs: number;
    totalSkillCount: number;
  }> {
    const rows = await this.db.query(
      `SELECT
         COUNT(*) AS cnt,
         COALESCE(SUM(total_cost_usd), 0) AS cost,
         COALESCE(SUM(total_duration_ms), 0) AS dur,
         COALESCE(SUM(total_skill_count), 0) AS skills
       FROM project_chat_actions
       WHERE project_id = ? AND status IN ('completed','error')`,
      [projectId],
    );
    const r = rows[0] ?? {};
    return {
      count: Number(r.cnt ?? 0),
      totalCostUsd: Number(r.cost ?? 0),
      totalDurationMs: Number(r.dur ?? 0),
      totalSkillCount: Number(r.skills ?? 0),
    };
  }
}
