import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface ProjectAgentSession {
  id: string;
  taskId: string;
  goal: string;
  cwd: string;
  agentName: string;
  currentPhase: string;
  currentIteration: number;
  totalFilesChanged: number;
  lastBuildPassed: boolean;
  lastCommitSha?: string;
  /** v643 — Merge-Request / Pull-Request URL extracted from `git push` output. */
  lastPushUrl?: string;
  /** v648 — Linked source-session if this is a Resume-Session. */
  resumedFromTaskId?: string;
  /** v652 — LLM-generierter "Lessons Learned"-Text bei Done/Failed. */
  failureInsight?: string;
  /** v652 — Counter wie oft diese Session bereits Auto-Resumed wurde. */
  autoResumeCount?: number;
  lastProgressAt?: string;
  milestones: string[];
  createdAt: string;
  updatedAt: string;
}

export class ProjectAgentSessionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(opts: { taskId: string; goal: string; cwd: string; agentName: string; resumedFromTaskId?: string }): Promise<ProjectAgentSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO project_agent_sessions (id, task_id, goal, cwd, agent_name, resumed_from_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, opts.taskId, opts.goal, opts.cwd, opts.agentName, opts.resumedFromTaskId ?? null, now, now]);
    return {
      id, taskId: opts.taskId, goal: opts.goal, cwd: opts.cwd, agentName: opts.agentName,
      currentPhase: 'planning', currentIteration: 0, totalFilesChanged: 0,
      lastBuildPassed: false, milestones: [], createdAt: now, updatedAt: now,
      resumedFromTaskId: opts.resumedFromTaskId,
    };
  }

  async getByTaskId(taskId: string): Promise<ProjectAgentSession | undefined> {
    const row = await this.adapter.queryOne(
      'SELECT * FROM project_agent_sessions WHERE task_id = ?',
      [taskId],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async updateProgress(taskId: string, update: {
    currentPhase?: string;
    currentIteration?: number;
    totalFilesChanged?: number;
    lastBuildPassed?: boolean;
    lastCommitSha?: string;
    lastPushUrl?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (update.currentPhase !== undefined) { sets.push('current_phase = ?'); values.push(update.currentPhase); }
    if (update.currentIteration !== undefined) { sets.push('current_iteration = ?'); values.push(update.currentIteration); }
    if (update.totalFilesChanged !== undefined) { sets.push('total_files_changed = ?'); values.push(update.totalFilesChanged); }
    if (update.lastBuildPassed !== undefined) { sets.push('last_build_passed = ?'); values.push(update.lastBuildPassed ? 1 : 0); }
    if (update.lastCommitSha !== undefined) { sets.push('last_commit_sha = ?'); values.push(update.lastCommitSha); }
    if (update.lastPushUrl !== undefined) { sets.push('last_push_url = ?'); values.push(update.lastPushUrl); }
    sets.push('last_progress_at = ?');
    values.push(now);
    values.push(taskId);
    await this.adapter.execute(`UPDATE project_agent_sessions SET ${sets.join(', ')} WHERE task_id = ?`, values);
  }

  /** v652 — Persistiert den LLM-generierten Lessons-Learned-Text. */
  async setFailureInsight(taskId: string, insight: string): Promise<void> {
    const now = new Date().toISOString();
    await this.adapter.execute(
      'UPDATE project_agent_sessions SET failure_insight = ?, updated_at = ? WHERE task_id = ?',
      [insight, now, taskId],
    );
  }

  /** v652 — Inkrementiert auto_resume_count atomic (per RMW). */
  async incrementAutoResumeCount(taskId: string): Promise<number> {
    const current = await this.getByTaskId(taskId);
    if (!current) return 0;
    const next = (current.autoResumeCount ?? 0) + 1;
    const now = new Date().toISOString();
    await this.adapter.execute(
      'UPDATE project_agent_sessions SET auto_resume_count = ?, updated_at = ? WHERE task_id = ?',
      [next, now, taskId],
    );
    return next;
  }

  async addMilestone(taskId: string, milestone: string): Promise<void> {
    const session = await this.getByTaskId(taskId);
    if (!session) return;
    const milestones = [...session.milestones, milestone];
    const now = new Date().toISOString();
    await this.adapter.execute(
      'UPDATE project_agent_sessions SET milestones = ?, updated_at = ? WHERE task_id = ?',
      [JSON.stringify(milestones), now, taskId],
    );
  }

  /**
   * v605 M7 — list all sessions that are NOT in a terminal state. Used by
   * the message-pipeline to scope which task_ids the LLM may target with
   * `project_agent interject`. Sessions in 'done' / 'failed' are excluded.
   */
  async listRunning(): Promise<ProjectAgentSession[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_agent_sessions WHERE current_phase NOT IN ('done', 'failed') ORDER BY created_at DESC LIMIT 50`,
      [],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  /**
   * v609 — list all sessions across the lifecycle, optional phase filter.
   * Used by the WebUI to inspect what the project-agent has done historically.
   */
  async listAll(opts?: { phase?: string; limit?: number }): Promise<ProjectAgentSession[]> {
    const limit = opts?.limit ?? 200;
    if (opts?.phase) {
      const rows = await this.adapter.query(
        `SELECT * FROM project_agent_sessions WHERE current_phase = ? ORDER BY updated_at DESC LIMIT ?`,
        [opts.phase, limit],
      ) as Array<Record<string, unknown>>;
      return rows.map(r => this.mapRow(r));
    }
    const rows = await this.adapter.query(
      `SELECT * FROM project_agent_sessions ORDER BY updated_at DESC LIMIT ?`,
      [limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async findActiveByCwd(cwd: string): Promise<ProjectAgentSession | undefined> {
    // v613 — Both 'done' AND 'failed' are terminal phases. The original v605 M6
    // filter `!= 'done'` was inconsistent with listRunning() and getHistoryByCwd()
    // which both treat 'failed' as terminal too. As a result, a project-agent
    // that crashed and was marked 'failed' still blocked new starts on the same
    // cwd until the row was deleted manually.
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_agent_sessions WHERE cwd = ? AND current_phase NOT IN ('done', 'failed') ORDER BY created_at DESC LIMIT 1`,
      [cwd],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async getCompletedByCwd(cwd: string): Promise<Array<{ goal: string; milestones: string[] }>> {
    const rows = await this.adapter.query(
      `SELECT goal, milestones FROM project_agent_sessions WHERE cwd = ? AND current_phase = 'done' ORDER BY updated_at DESC LIMIT 3`,
      [cwd],
    ) as Array<{ goal: string; milestones: string }>;
    return rows.map(r => ({
      goal: r.goal.slice(0, 200),
      milestones: [],  // omit milestones — goals are sufficient context and keep prompt short
    }));
  }

  /**
   * v608 F7 — Richer history per cwd: includes terminated runs (done OR failed)
   * with build-status, commit SHA and recent milestones. The Planning-LLM needs
   * to know if the previous attempt actually built (then this is an enhancement,
   * not a rewrite) and what milestones it reached.
   */
  async getHistoryByCwd(cwd: string): Promise<Array<{
    taskId: string;
    goal: string;
    phase: string;
    lastBuildPassed: boolean;
    lastCommitSha?: string;
    milestones: string[];
    createdAt: string;
    updatedAt: string;
  }>> {
    const rows = await this.adapter.query(
      `SELECT id, task_id, goal, current_phase, last_build_passed, last_commit_sha, milestones, created_at, updated_at
       FROM project_agent_sessions
       WHERE cwd = ? AND current_phase IN ('done', 'failed')
       ORDER BY updated_at DESC LIMIT 5`,
      [cwd],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => {
      let milestones: string[] = [];
      try { milestones = JSON.parse((r.milestones as string) ?? '[]'); } catch { /* empty */ }
      return {
        taskId: r.task_id as string,
        goal: (r.goal as string).slice(0, 200),
        phase: r.current_phase as string,
        lastBuildPassed: (r.last_build_passed as number) === 1,
        lastCommitSha: (r.last_commit_sha as string | null) ?? undefined,
        milestones: milestones.slice(-5),
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      };
    });
  }

  private mapRow(row: Record<string, unknown>): ProjectAgentSession {
    let milestones: string[] = [];
    try { milestones = JSON.parse(row.milestones as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      goal: row.goal as string,
      cwd: row.cwd as string,
      agentName: row.agent_name as string,
      currentPhase: row.current_phase as string,
      currentIteration: row.current_iteration as number,
      totalFilesChanged: row.total_files_changed as number,
      lastBuildPassed: (row.last_build_passed as number) === 1,
      lastCommitSha: row.last_commit_sha as string | undefined,
      lastPushUrl: (row.last_push_url as string | null) ?? undefined,
      resumedFromTaskId: (row.resumed_from_task_id as string | null) ?? undefined,
      failureInsight: (row.failure_insight as string | null) ?? undefined,
      autoResumeCount: (row.auto_resume_count as number | null) ?? 0,
      lastProgressAt: row.last_progress_at as string | undefined,
      milestones,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
