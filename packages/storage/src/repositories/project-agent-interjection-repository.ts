import type { AsyncDbAdapter } from '../db-adapter.js';

export interface Interjection {
  id: number;
  taskId: string;
  message: string;
  createdAt: string;
}

export class ProjectAgentInterjectionRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async push(taskId: string, message: string): Promise<void> {
    await this.adapter.execute(
      'INSERT INTO project_agent_interjections (task_id, message, created_at) VALUES (?, ?, ?)',
      [taskId, message, new Date().toISOString()],
    );
  }

  async drain(taskId: string): Promise<string[]> {
    const rows = await this.adapter.query(
      'SELECT id, message FROM project_agent_interjections WHERE task_id = ? ORDER BY id',
      [taskId],
    ) as Array<{ id: number; message: string }>;

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    await this.adapter.execute(
      `DELETE FROM project_agent_interjections WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );

    return rows.map(r => r.message);
  }
}
