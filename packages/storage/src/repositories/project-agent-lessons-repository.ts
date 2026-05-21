import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v652 — Lessons-Learned aus Project-Agent-Failures. Wenn dieselbe Failure
 * 2+ mal in einer cwd auftritt, wird ein "advice" persistiert und in den
 * Plan/Code-Phase-Prompt eingespeist. Spart Tokens vs. KG-Memory weil
 * cwd-scoped und strikt project-agent-domain.
 */
export interface ProjectAgentLesson {
  id: string;
  cwd: string;
  pattern: string;
  advice: string;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
}

export class ProjectAgentLessonsRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /** Upsert: bei existing (cwd, pattern) wird occurrences++, advice ggf. überschrieben. */
  async upsert(opts: { cwd: string; pattern: string; advice: string }): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.adapter.queryOne(
      'SELECT id, occurrences FROM project_agent_lessons WHERE cwd = ? AND pattern = ?',
      [opts.cwd, opts.pattern],
    ) as { id: string; occurrences: number } | undefined;
    if (existing) {
      await this.adapter.execute(
        'UPDATE project_agent_lessons SET occurrences = ?, advice = ?, last_seen_at = ? WHERE id = ?',
        [existing.occurrences + 1, opts.advice, now, existing.id],
      );
      return;
    }
    await this.adapter.execute(
      `INSERT INTO project_agent_lessons (id, cwd, pattern, advice, occurrences, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [randomUUID(), opts.cwd, opts.pattern, opts.advice, now, now],
    );
  }

  /** Lessons für eine cwd (nur die mit occurrences ≥ minOccurrences, default 2). */
  async listByCwd(cwd: string, minOccurrences = 2, limit = 10): Promise<ProjectAgentLesson[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_agent_lessons WHERE cwd = ? AND occurrences >= ? ORDER BY last_seen_at DESC LIMIT ?`,
      [cwd, minOccurrences, limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): ProjectAgentLesson {
    return {
      id: row.id as string,
      cwd: row.cwd as string,
      pattern: row.pattern as string,
      advice: row.advice as string,
      occurrences: row.occurrences as number,
      lastSeenAt: row.last_seen_at as string,
      createdAt: row.created_at as string,
    };
  }
}
