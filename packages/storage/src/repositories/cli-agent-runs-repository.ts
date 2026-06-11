/**
 * v866 — Usage-Tracking für CLI-Agents (claude-code, codex, …).
 *
 * BEWUSST getrennt von llm_usage/service_usage: CLI-Agents laufen auf eigenen
 * Subscriptions/API-Keys des Users — ihre Tokens/Kosten gehören NICHT in
 * Alfreds Betriebskosten-Dashboard. cost_usd ist der vom CLI gemeldete
 * API-Äquivalent-Wert (bei Subscription-Accounts informativ).
 *
 * Eine Zeile pro Agent-Lauf:
 *  - project_agent: eine Zeile pro Session (Runner summiert Phasen + Fix-Läufe)
 *  - code_agent:    eine Zeile pro run-Action
 */
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface CliAgentRunInput {
  userId: string;
  projectId?: string;
  sessionType: 'project_agent' | 'code_agent';
  sourceId: string;
  agentName: string;
  agentVersion?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number;
  durationS: number;
  success: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface CliUsageGroupRow {
  key: string;
  /** Zweite Dimension (z.B. agent_version/model bei byAgent, Projekt-Name bei byProject). */
  subKey?: string;
  runs: number;
  durationS: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface CliUsageOverview {
  totals: { runs: number; durationS: number; tokensIn: number; tokensOut: number; cacheReadTokens: number; costUsd: number };
  byUser: CliUsageGroupRow[];
  byProject: CliUsageGroupRow[];
  byType: CliUsageGroupRow[];
  /** key=agent_name, subKey=`${agent_version ?? '?'} · ${model ?? '?'}` */
  byAgent: CliUsageGroupRow[];
  byModel: CliUsageGroupRow[];
}

const AGG = `COUNT(*) AS runs, COALESCE(SUM(duration_s),0) AS duration_s,
  COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cost_usd),0) AS cost_usd`;

function mapGroup(r: DbRow, key: string, subKey?: string): CliUsageGroupRow {
  return {
    key,
    subKey,
    runs: Number(r.runs ?? 0),
    durationS: Number(r.duration_s ?? 0),
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
    cacheReadTokens: Number(r.cache_read ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
  };
}

export class CliAgentRunsRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async record(input: CliAgentRunInput): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO cli_agent_runs
        (id, user_id, project_id, session_type, source_id, agent_name, agent_version, model,
         tokens_in, tokens_out, cache_read_tokens, cost_usd, duration_s, success, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), input.userId, input.projectId ?? null, input.sessionType, input.sourceId,
        input.agentName, input.agentVersion ?? null, input.model ?? null,
        Math.round(input.tokensIn), Math.round(input.tokensOut), Math.round(input.cacheReadTokens),
        input.costUsd, Math.round(input.durationS), input.success ? 1 : 0,
        input.startedAt, input.endedAt ?? null, now,
      ],
    );
  }

  /** Globale Übersicht; days=0/undefined → alles. */
  async overview(days?: number): Promise<CliUsageOverview> {
    const where = days && days > 0 ? `WHERE started_at >= ?` : '';
    const params = days && days > 0 ? [new Date(Date.now() - days * 86_400_000).toISOString()] : [];

    const totalRows = await this.adapter.query(`SELECT ${AGG} FROM cli_agent_runs ${where}`, params);
    const t = mapGroup(totalRows[0] ?? {}, 'total');

    const byUser = (await this.adapter.query(
      `SELECT user_id, ${AGG} FROM cli_agent_runs ${where} GROUP BY user_id ORDER BY duration_s DESC`, params,
    )).map(r => mapGroup(r, String(r.user_id)));

    // Projekt-Name best-effort via LEFT JOIN (Projekt kann gelöscht sein → ID als
    // Fallback). Die Aggregat-Spalten sind unambiguous — nur cli_agent_runs hat sie.
    const byProject = (await this.adapter.query(
      `SELECT r.project_id, MAX(p.name) AS project_name, ${AGG}
       FROM cli_agent_runs r LEFT JOIN projects p ON p.id = r.project_id
       ${where ? where.replace('started_at', 'r.started_at') : ''}
       GROUP BY r.project_id ORDER BY duration_s DESC`, params,
    )).map(r => mapGroup(r, String(r.project_name ?? r.project_id ?? '(ohne Projekt)'), r.project_id ? String(r.project_id) : undefined));

    const byType = (await this.adapter.query(
      `SELECT session_type, ${AGG} FROM cli_agent_runs ${where} GROUP BY session_type ORDER BY duration_s DESC`, params,
    )).map(r => mapGroup(r, String(r.session_type)));

    const byAgent = (await this.adapter.query(
      `SELECT agent_name, agent_version, model, ${AGG} FROM cli_agent_runs ${where}
       GROUP BY agent_name, agent_version, model ORDER BY duration_s DESC`, params,
    )).map(r => mapGroup(r, String(r.agent_name), `${r.agent_version ?? '?'} · ${r.model ?? '?'}`));

    const byModel = (await this.adapter.query(
      `SELECT COALESCE(model, '(unbekannt)') AS model, ${AGG} FROM cli_agent_runs ${where}
       GROUP BY COALESCE(model, '(unbekannt)') ORDER BY duration_s DESC`, params,
    )).map(r => mapGroup(r, String(r.model)));

    return { totals: { runs: t.runs, durationS: t.durationS, tokensIn: t.tokensIn, tokensOut: t.tokensOut, cacheReadTokens: t.cacheReadTokens, costUsd: t.costUsd }, byUser, byProject, byType, byAgent, byModel };
  }

  /** Projekt-scoped Aggregation für die Arbeitszeit-Statistik (Work-Stats). */
  async forProject(projectId: string): Promise<{
    byType: CliUsageGroupRow[];
    byAgent: CliUsageGroupRow[];
  }> {
    const byType = (await this.adapter.query(
      `SELECT session_type, ${AGG} FROM cli_agent_runs WHERE project_id = ? GROUP BY session_type`, [projectId],
    )).map(r => mapGroup(r, String(r.session_type)));
    const byAgent = (await this.adapter.query(
      `SELECT agent_name, agent_version, model, ${AGG} FROM cli_agent_runs WHERE project_id = ?
       GROUP BY agent_name, agent_version, model ORDER BY duration_s DESC`, [projectId],
    )).map(r => mapGroup(r, String(r.agent_name), `${r.agent_version ?? '?'} · ${r.model ?? '?'}`));
    return { byType, byAgent };
  }
}
