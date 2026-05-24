import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v726 — DbSeedRepository
 *
 * Verwaltet Seed-DB-Konfigurationen pro Project. Drei Kinds:
 *  - 'empty'      : Sandbox startet ohne DB-Datei (App muss eigene migrations laufen)
 *  - 'repo_path'  : Datei aus dem Repo-Worktree wird kopiert (storage_ref = Pfad relativ zu cwd, z.B. 'seeds/dev.sqlite')
 *  - 'upload'     : Datei wurde via WebUI hochgeladen (storage_ref = Pfad zur Datei in Alfred-Storage)
 */
export type DbSeedKind = 'empty' | 'repo_path' | 'upload';

export interface ProjectDbSeed {
  id: string;
  projectId: string;
  name: string;
  kind: DbSeedKind;
  /** Bei 'repo_path': relative Pfad ('seeds/dev.sqlite'). Bei 'upload': Storage-Pfad in Alfred. */
  storageRef: string;
  sizeBytes: number;
  createdAt: string;
}

export class DbSeedRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(input: { projectId: string; name: string; kind: DbSeedKind; storageRef: string; sizeBytes?: number }): Promise<ProjectDbSeed> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_db_seeds (id, project_id, name, kind, storage_ref, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.name, input.kind, input.storageRef, input.sizeBytes ?? 0, now],
    );
    return {
      id, projectId: input.projectId, name: input.name, kind: input.kind,
      storageRef: input.storageRef, sizeBytes: input.sizeBytes ?? 0, createdAt: now,
    };
  }

  async getById(id: string): Promise<ProjectDbSeed | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_db_seeds WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async listForProject(projectId: string): Promise<ProjectDbSeed[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_db_seeds WHERE project_id = ? ORDER BY created_at DESC`,
      [projectId],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async delete(id: string): Promise<void> {
    await this.adapter.execute(`DELETE FROM project_db_seeds WHERE id = ?`, [id]);
  }

  private mapRow(row: Record<string, unknown>): ProjectDbSeed {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      name: row.name as string,
      kind: row.kind as DbSeedKind,
      storageRef: row.storage_ref as string,
      sizeBytes: (row.size_bytes as number | null) ?? 0,
      createdAt: row.created_at as string,
    };
  }
}
