import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter } from '../db-adapter.js';

/**
 * v779 — Persistente CLI-Coding-Agent-Sessions.
 *
 * Pro (sandbox_id, agent_name)-Paar genau eine Session. Die Session hält die CLI-eigene
 * session_id (z.B. claude-Code's UUID, codex' thread_id, vibe's session-name) damit beim
 * nächsten User-Klick `--resume <id>` an den CLI gegeben werden kann und der CLI seinen
 * vorherigen Tool-Call-Cache + Conversation behält.
 *
 * Status-Werte:
 *  - 'active': Session existiert, kann mit resume reused werden
 *  - 'stopped': Session wurde explizit beendet
 *  - 'expired': Session war zu lange unused oder Health-Check failed
 *  - 'failed': Session in einem irreversibel kaputten Zustand (corrupted state-file etc.)
 */

export type AgentSessionStatus = 'active' | 'stopped' | 'expired' | 'failed';

export interface AgentSession {
  id: string;
  sandboxId: string;
  /** 'claude-code' | 'codex' | 'vibe' | 'aider' | 'generic-plain' etc. */
  agentName: string;
  /** Die CLI-eigene session-id (was an `--resume` übergeben wird). */
  cliSessionId?: string;
  /** Optional: bei Adapter mit Disk-State, Pfad zum State-File. */
  statePath?: string;
  /** JSON-blob mit Adapter-Capabilities zum Zeitpunkt der Session-Creation. */
  capabilities?: {
    persistence: 'flag-resume' | 'long-process' | 'disk-state' | 'none';
    structuredOutput: boolean;
    streamingTokens: boolean;
    supportsAbort: boolean;
  };
  messageCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  /** Unix-ms: letzter Health-Check-Erfolg, oder null falls noch nie geprüft. */
  lastHealthOk?: number;
  status: AgentSessionStatus;
  startedAt: string;
  lastUsedAt: string;
}

export interface CreateAgentSessionInput {
  sandboxId: string;
  agentName: string;
  cliSessionId?: string;
  statePath?: string;
  capabilities?: AgentSession['capabilities'];
}

export interface UpdateAgentSessionInput {
  cliSessionId?: string;
  messageCount?: number;
  addTokensInput?: number;
  addTokensOutput?: number;
  addCachedTokens?: number;
  addCostUsd?: number;
  lastHealthOk?: number;
  status?: AgentSessionStatus;
}

export class AgentSessionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: CreateAgentSessionInput): Promise<AgentSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO agent_sessions
         (id, sandbox_id, agent_name, cli_session_id, state_path, capabilities_json,
          message_count, total_tokens_input, total_tokens_output, total_cached_tokens, total_cost_usd,
          status, started_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'active', ?, ?)`,
      [
        id, input.sandboxId, input.agentName,
        input.cliSessionId ?? null,
        input.statePath ?? null,
        input.capabilities ? JSON.stringify(input.capabilities) : null,
        now, now,
      ],
    );
    return {
      id, sandboxId: input.sandboxId, agentName: input.agentName,
      cliSessionId: input.cliSessionId, statePath: input.statePath,
      capabilities: input.capabilities,
      messageCount: 0, totalTokensInput: 0, totalTokensOutput: 0, totalCachedTokens: 0, totalCostUsd: 0,
      status: 'active', startedAt: now, lastUsedAt: now,
    };
  }

  async getById(id: string): Promise<AgentSession | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM agent_sessions WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** Sucht aktive Session für (sandbox_id, agent_name). null wenn keine. */
  async findActive(sandboxId: string, agentName: string): Promise<AgentSession | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM agent_sessions WHERE sandbox_id = ? AND agent_name = ? AND status = 'active'`,
      [sandboxId, agentName],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** Alle Sessions für eine Sandbox (egal Status). Z.B. für UI-Stats. */
  async listBySandbox(sandboxId: string): Promise<AgentSession[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM agent_sessions WHERE sandbox_id = ? ORDER BY last_used_at DESC`,
      [sandboxId],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  /** Älteste active Sessions liefern — für LRU-Eviction. */
  async listOldestActive(sandboxId: string, limit: number = 10): Promise<AgentSession[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM agent_sessions WHERE sandbox_id = ? AND status = 'active' ORDER BY last_used_at ASC LIMIT ?`,
      [sandboxId, limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, patch: UpdateAgentSessionInput): Promise<boolean> {
    const sets: string[] = ['last_used_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (patch.cliSessionId !== undefined) { sets.push('cli_session_id = ?'); values.push(patch.cliSessionId); }
    if (patch.messageCount !== undefined) { sets.push('message_count = ?'); values.push(patch.messageCount); }
    if (patch.addTokensInput !== undefined) { sets.push('total_tokens_input = total_tokens_input + ?'); values.push(patch.addTokensInput); }
    if (patch.addTokensOutput !== undefined) { sets.push('total_tokens_output = total_tokens_output + ?'); values.push(patch.addTokensOutput); }
    if (patch.addCachedTokens !== undefined) { sets.push('total_cached_tokens = total_cached_tokens + ?'); values.push(patch.addCachedTokens); }
    if (patch.addCostUsd !== undefined) { sets.push('total_cost_usd = total_cost_usd + ?'); values.push(patch.addCostUsd); }
    if (patch.lastHealthOk !== undefined) { sets.push('last_health_ok = ?'); values.push(patch.lastHealthOk); }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }

    values.push(id);
    const r = await this.adapter.execute(
      `UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`,
      values,
    );
    return (r.changes ?? 0) > 0;
  }

  async delete(id: string): Promise<void> {
    await this.adapter.execute(`DELETE FROM agent_session_events WHERE session_id = ?`, [id]);
    await this.adapter.execute(`DELETE FROM agent_sessions WHERE id = ?`, [id]);
  }

  /** Alle Sessions einer Sandbox löschen — beim Sandbox-Discard. */
  async deleteBySandbox(sandboxId: string): Promise<number> {
    const sessions = await this.adapter.query(
      `SELECT id FROM agent_sessions WHERE sandbox_id = ?`,
      [sandboxId],
    ) as Array<{ id: string }>;
    for (const s of sessions) {
      await this.adapter.execute(`DELETE FROM agent_session_events WHERE session_id = ?`, [s.id]);
    }
    const r = await this.adapter.execute(
      `DELETE FROM agent_sessions WHERE sandbox_id = ?`,
      [sandboxId],
    );
    return r.changes ?? 0;
  }

  /** Append Event für Audit/Replay. iteration zählt durch Runs der Session. */
  async appendEvent(sessionId: string, iteration: number, eventType: string, eventData: unknown): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO agent_session_events (id, session_id, iteration, event_type, event_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sessionId, iteration, eventType, JSON.stringify(eventData), now],
    );
  }

  async listEvents(sessionId: string, iteration?: number, limit: number = 200): Promise<Array<{ id: string; iteration: number; eventType: string; eventData: unknown; createdAt: string }>> {
    let sql = `SELECT id, iteration, event_type, event_data, created_at FROM agent_session_events WHERE session_id = ?`;
    const params: unknown[] = [sessionId];
    if (iteration !== undefined) {
      sql += ` AND iteration = ?`;
      params.push(iteration);
    }
    sql += ` ORDER BY created_at ASC LIMIT ?`;
    params.push(limit);
    const rows = await this.adapter.query(sql, params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      iteration: r.iteration as number,
      eventType: r.event_type as string,
      eventData: this.safeJson(r.event_data as string),
      createdAt: r.created_at as string,
    }));
  }

  private mapRow(row: Record<string, unknown>): AgentSession {
    return {
      id: row.id as string,
      sandboxId: row.sandbox_id as string,
      agentName: row.agent_name as string,
      cliSessionId: (row.cli_session_id as string | null) ?? undefined,
      statePath: (row.state_path as string | null) ?? undefined,
      capabilities: this.safeJson(row.capabilities_json as string | null),
      messageCount: Number(row.message_count) || 0,
      totalTokensInput: Number(row.total_tokens_input) || 0,
      totalTokensOutput: Number(row.total_tokens_output) || 0,
      totalCachedTokens: Number(row.total_cached_tokens) || 0,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      lastHealthOk: row.last_health_ok != null ? Number(row.last_health_ok) : undefined,
      status: (row.status as AgentSessionStatus) ?? 'active',
      startedAt: row.started_at as string,
      lastUsedAt: row.last_used_at as string,
    };
  }

  private safeJson(s: string | null): any {
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
  }
}
