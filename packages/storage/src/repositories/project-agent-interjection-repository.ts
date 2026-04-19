import type { AsyncDbAdapter } from '../db-adapter.js';

export interface Interjection {
  id: number;
  taskId: string;
  message: string;
  consumed: boolean;
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
      'SELECT id, message FROM project_agent_interjections WHERE task_id = ? AND consumed = 0 ORDER BY id',
      [taskId],
    ) as Array<{ id: number; message: string }>;

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    await this.adapter.execute(
      `UPDATE project_agent_interjections SET consumed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );

    return rows.map(r => r.message);
  }
}
