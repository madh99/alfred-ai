import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export interface ProjectAgentCommit {
  id: string;
  sessionId: string;
  projectId?: string;
  sha: string;
  message: string;
  phaseIdx?: number;
  phaseDescription?: string;
  filesChanged: number;
  branch?: string;
  committedAt: string;
  pushedAt?: string;
  pushUrl?: string;
}

/**
 * v643 — Project-Agent macht pro Phase 1 commit. Vorher wurde nur `last_commit_sha`
 * auf der Session gespeichert → bei 24-Phasen-Läufen waren 23 Commits "verschwunden".
 * Repository speichert jeden Commit mit Phase-Kontext + (sofern erkennbar) MR/PR-URL.
 */
export class ProjectAgentCommitsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async record(input: Omit<ProjectAgentCommit, 'id' | 'committedAt'> & { committedAt?: string }): Promise<ProjectAgentCommit> {
    const id = randomUUID();
    const committedAt = input.committedAt ?? new Date().toISOString();
    await this.db.execute(
      `INSERT INTO project_agent_commits (id, session_id, project_id, sha, message, phase_idx, phase_description, files_changed, branch, committed_at, pushed_at, push_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.sessionId, input.projectId ?? null, input.sha, input.message,
        input.phaseIdx ?? null, input.phaseDescription ?? null, input.filesChanged,
        input.branch ?? null, committedAt, input.pushedAt ?? null, input.pushUrl ?? null,
      ],
    );
    return { ...input, id, committedAt };
  }

  /** v643 — Bei git push: alle Commits dieser Session als pushed markieren + URL. */
  async markSessionPushed(sessionId: string, pushUrl?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_agent_commits SET pushed_at = ?, push_url = COALESCE(push_url, ?) WHERE session_id = ? AND pushed_at IS NULL`,
      [now, pushUrl ?? null, sessionId],
    );
  }

  async listBySession(sessionId: string): Promise<ProjectAgentCommit[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_agent_commits WHERE session_id = ? ORDER BY committed_at ASC`,
      [sessionId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  async listByProject(projectId: string, limit = 50): Promise<ProjectAgentCommit[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_agent_commits WHERE project_id = ? ORDER BY committed_at DESC LIMIT ?`,
      [projectId, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): ProjectAgentCommit {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      projectId: (r.project_id as string) ?? undefined,
      sha: r.sha as string,
      message: r.message as string,
      phaseIdx: r.phase_idx != null ? Number(r.phase_idx) : undefined,
      phaseDescription: (r.phase_description as string) ?? undefined,
      filesChanged: Number(r.files_changed ?? 0),
      branch: (r.branch as string) ?? undefined,
      committedAt: r.committed_at as string,
      pushedAt: (r.pushed_at as string) ?? undefined,
      pushUrl: (r.push_url as string) ?? undefined,
    };
  }
}
