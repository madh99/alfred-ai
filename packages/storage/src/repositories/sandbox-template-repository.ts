import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v751 — SandboxTemplate: wiederverwendbare Sandbox-Konfiguration.
 * Pro User + optional pro Project. project_id=null = globales Template (alle Projekte).
 */
export interface SandboxTemplate {
  id: string;
  userId: string;
  /** null = global (für alle Projects des Users verfügbar) */
  projectId?: string;
  name: string;
  description?: string;
  mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  envStage?: string;
  dbSeedId?: string;
  /** Vorbelegung der ersten Chat-Message (für interactive-chat-Mode). */
  initialGoal?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSandboxTemplateInput {
  userId: string;
  projectId?: string | null;
  name: string;
  description?: string;
  mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  envStage?: string;
  dbSeedId?: string;
  initialGoal?: string;
  tags?: string[];
}

export interface UpdateSandboxTemplateInput {
  name?: string;
  description?: string | null;
  mode?: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
  envStage?: string | null;
  dbSeedId?: string | null;
  initialGoal?: string | null;
  tags?: string[];
}

export class SandboxTemplateRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: CreateSandboxTemplateInput): Promise<SandboxTemplate> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO sandbox_templates (id, user_id, project_id, name, description, mode, env_stage, db_seed_id, initial_goal, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.userId,
        input.projectId ?? null,
        input.name.slice(0, 200),
        input.description?.slice(0, 1000) ?? null,
        input.mode,
        input.envStage ?? null,
        input.dbSeedId ?? null,
        input.initialGoal?.slice(0, 2000) ?? null,
        JSON.stringify(input.tags ?? []),
        now, now,
      ],
    );
    return {
      id, userId: input.userId,
      projectId: input.projectId ?? undefined,
      name: input.name,
      description: input.description,
      mode: input.mode,
      envStage: input.envStage,
      dbSeedId: input.dbSeedId,
      initialGoal: input.initialGoal,
      tags: input.tags ?? [],
      createdAt: now, updatedAt: now,
    };
  }

  async getById(id: string): Promise<SandboxTemplate | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM sandbox_templates WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * List for user. Optional projectId-Filter:
   *  - undefined: alle Templates des Users (global + project-scoped)
   *  - string: project-scoped + global (project_id IS NULL OR project_id = X)
   *  - null: nur globale (project_id IS NULL)
   */
  async listForUser(userId: string, projectId?: string | null): Promise<SandboxTemplate[]> {
    let sql = `SELECT * FROM sandbox_templates WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (projectId === null) {
      sql += ` AND project_id IS NULL`;
    } else if (typeof projectId === 'string') {
      sql += ` AND (project_id IS NULL OR project_id = ?)`;
      params.push(projectId);
    }
    sql += ` ORDER BY updated_at DESC`;
    const rows = await this.adapter.query(sql, params) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, patch: UpdateSandboxTemplateInput): Promise<boolean> {
    const current = await this.getById(id);
    if (!current) return false;
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name.slice(0, 200)); }
    if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description?.slice(0, 1000) ?? null); }
    if (patch.mode !== undefined) { sets.push('mode = ?'); values.push(patch.mode); }
    if (patch.envStage !== undefined) { sets.push('env_stage = ?'); values.push(patch.envStage ?? null); }
    if (patch.dbSeedId !== undefined) { sets.push('db_seed_id = ?'); values.push(patch.dbSeedId ?? null); }
    if (patch.initialGoal !== undefined) { sets.push('initial_goal = ?'); values.push(patch.initialGoal?.slice(0, 2000) ?? null); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
    values.push(id);
    await this.adapter.execute(`UPDATE sandbox_templates SET ${sets.join(', ')} WHERE id = ?`, values);
    return true;
  }

  async delete(id: string): Promise<void> {
    await this.adapter.execute(`DELETE FROM sandbox_templates WHERE id = ?`, [id]);
  }

  private mapRow(row: Record<string, unknown>): SandboxTemplate {
    let tags: string[] = [];
    try { const parsed = JSON.parse((row.tags as string) ?? '[]'); if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string'); } catch { /* */ }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      projectId: (row.project_id as string | null) ?? undefined,
      name: row.name as string,
      description: (row.description as string | null) ?? undefined,
      mode: row.mode as SandboxTemplate['mode'],
      envStage: (row.env_stage as string | null) ?? undefined,
      dbSeedId: (row.db_seed_id as string | null) ?? undefined,
      initialGoal: (row.initial_goal as string | null) ?? undefined,
      tags,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
