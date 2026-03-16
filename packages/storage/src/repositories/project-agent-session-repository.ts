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
  lastProgressAt?: string;
  milestones: string[];
  createdAt: string;
  updatedAt: string;
}

export class ProjectAgentSessionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(opts: { taskId: string; goal: string; cwd: string; agentName: string }): Promise<ProjectAgentSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(`
      INSERT INTO project_agent_sessions (id, task_id, goal, cwd, agent_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, opts.taskId, opts.goal, opts.cwd, opts.agentName, now, now]);
    return {
      id, taskId: opts.taskId, goal: opts.goal, cwd: opts.cwd, agentName: opts.agentName,
      currentPhase: 'planning', currentIteration: 0, totalFilesChanged: 0,
      lastBuildPassed: false, milestones: [], createdAt: now, updatedAt: now,
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
  }): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (update.currentPhase !== undefined) { sets.push('current_phase = ?'); values.push(update.currentPhase); }
    if (update.currentIteration !== undefined) { sets.push('current_iteration = ?'); values.push(update.currentIteration); }
    if (update.totalFilesChanged !== undefined) { sets.push('total_files_changed = ?'); values.push(update.totalFilesChanged); }
    if (update.lastBuildPassed !== undefined) { sets.push('last_build_passed = ?'); values.push(update.lastBuildPassed ? 1 : 0); }
    if (update.lastCommitSha !== undefined) { sets.push('last_commit_sha = ?'); values.push(update.lastCommitSha); }
    sets.push('last_progress_at = ?');
    values.push(now);
    values.push(taskId);
    await this.adapter.execute(`UPDATE project_agent_sessions SET ${sets.join(', ')} WHERE task_id = ?`, values);
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
      lastProgressAt: row.last_progress_at as string | undefined,
      milestones,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
