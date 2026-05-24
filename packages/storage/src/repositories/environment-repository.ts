import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v726 — EnvironmentRepository
 *
 * Persistiert verschlüsselte Key-Value-ENVs pro Project und Stage.
 * Crypto wird im Skill/Service-Layer gemacht — Repository speichert nur die Bytes.
 */
export interface ProjectEnvironment {
  id: string;
  projectId: string;
  stage: string;
  varsEncrypted: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class EnvironmentRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  /** Upsert: ein Eintrag pro (project_id, stage). */
  async upsert(input: {
    projectId: string;
    stage: string;
    varsEncrypted: Buffer;
    iv: Buffer;
    authTag: Buffer;
    encryptionVersion?: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.adapter.queryOne(
      `SELECT id FROM project_environments WHERE project_id = ? AND stage = ?`,
      [input.projectId, input.stage],
    ) as { id?: string } | undefined;
    if (existing?.id) {
      await this.adapter.execute(
        `UPDATE project_environments
         SET vars_encrypted = ?, iv = ?, auth_tag = ?, encryption_version = ?, updated_at = ?
         WHERE id = ?`,
        [input.varsEncrypted, input.iv, input.authTag, input.encryptionVersion ?? 1, now, existing.id],
      );
    } else {
      await this.adapter.execute(
        `INSERT INTO project_environments
         (id, project_id, stage, vars_encrypted, iv, auth_tag, encryption_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), input.projectId, input.stage, input.varsEncrypted, input.iv, input.authTag, input.encryptionVersion ?? 1, now, now],
      );
    }
  }

  async get(projectId: string, stage: string): Promise<ProjectEnvironment | undefined> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_environments WHERE project_id = ? AND stage = ?`,
      [projectId, stage],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async listForProject(projectId: string): Promise<ProjectEnvironment[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_environments WHERE project_id = ? ORDER BY stage`,
      [projectId],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  async delete(projectId: string, stage: string): Promise<void> {
    await this.adapter.execute(
      `DELETE FROM project_environments WHERE project_id = ? AND stage = ?`,
      [projectId, stage],
    );
  }

  private mapRow(row: Record<string, unknown>): ProjectEnvironment {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      stage: row.stage as string,
      varsEncrypted: this.toBuffer(row.vars_encrypted),
      iv: this.toBuffer(row.iv),
      authTag: this.toBuffer(row.auth_tag),
      encryptionVersion: (row.encryption_version as number | null) ?? 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  /** SQLite gibt BLOBs als Buffer zurück, PG als Buffer (BYTEA). Beide sind kompatibel. */
  private toBuffer(v: unknown): Buffer {
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string') return Buffer.from(v, 'base64');
    throw new Error(`Unexpected blob type: ${typeof v}`);
  }
}
