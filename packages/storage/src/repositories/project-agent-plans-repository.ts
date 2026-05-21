import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type PlanPhaseStatus = 'planned' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanPhase {
  id: string;
  sessionId: string;
  phaseIdx: number;
  description: string;
  status: PlanPhaseStatus;
  startedAt?: string;
  endedAt?: string;
}

/**
 * v648 — Persistierter Plan: pro Project-Agent-Session wird beim Start jede geplante Phase
 * eingetragen (Status='planned'). Während des Laufs werden started_at, status='running',
 * ended_at, status='done'/'failed' fortgeschrieben. Bei Crash kann ein Resume-Action genau
 * sehen welche Phasen fertig waren und was noch fehlt.
 */
export class ProjectAgentPlansRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async bulkInsert(sessionId: string, phases: Array<{ phaseIdx: number; description: string }>): Promise<void> {
    for (const p of phases) {
      try {
        await this.db.execute(
          `INSERT INTO project_agent_plans (id, session_id, phase_idx, description, status) VALUES (?, ?, ?, ?, 'planned')`,
          [randomUUID(), sessionId, p.phaseIdx, p.description.slice(0, 4000)],
        );
      } catch { /* UNIQUE violation = phase already exists, ignore */ }
    }
  }

  async markRunning(sessionId: string, phaseIdx: number): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_plans SET status = 'running', started_at = ? WHERE session_id = ? AND phase_idx = ?`,
      [new Date().toISOString(), sessionId, phaseIdx],
    );
  }

  async markDone(sessionId: string, phaseIdx: number): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_plans SET status = 'done', ended_at = ? WHERE session_id = ? AND phase_idx = ?`,
      [new Date().toISOString(), sessionId, phaseIdx],
    );
  }

  async markFailed(sessionId: string, phaseIdx: number): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_plans SET status = 'failed', ended_at = ? WHERE session_id = ? AND phase_idx = ?`,
      [new Date().toISOString(), sessionId, phaseIdx],
    );
  }

  async listBySession(sessionId: string): Promise<PlanPhase[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_agent_plans WHERE session_id = ? ORDER BY phase_idx ASC`,
      [sessionId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): PlanPhase {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      phaseIdx: Number(r.phase_idx),
      description: r.description as string,
      status: r.status as PlanPhaseStatus,
      startedAt: (r.started_at as string) ?? undefined,
      endedAt: (r.ended_at as string) ?? undefined,
    };
  }
}
