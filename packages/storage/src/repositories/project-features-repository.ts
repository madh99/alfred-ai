/**
 * v851 — ProjectFeaturesRepository
 *
 * Cross-Project Feature-Library. Persistiert implementierte Features pro
 * Projekt + erlaubt semantische Cross-Project-Suche damit Alfred bei "neu
 * implementieren X" auf bestehende Implementierungen verweisen kann.
 *
 * Schema siehe Migration v103 (SQLite) bzw. v107 (PG).
 *
 * Privacy-Model: visibility-field pro Feature
 *  - 'private' (default): nur Owner sieht es
 *  - 'role-shared': alle in derselben Alfred-Role sehen es
 *  - 'global': alle User sehen es
 */

import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

export type FeatureVisibility = 'private' | 'role-shared' | 'global';
export type FeatureStatus = 'pending' | 'confirmed' | 'rejected';
export type FeatureSource = 'auto' | 'manual' | 'imported';

export interface ProjectFeature {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string;
  techStack: string[];
  sourceFiles: string[];
  gitShaIntroduced: string | null;
  version: number;
  visibility: FeatureVisibility;
  confidence: number;
  source: FeatureSource;
  status: FeatureStatus;
  embeddingId: string | null;
  derivedFromFeatureId: string | null;
  /** v898 — Roadmap-Milestone, in den das Feature beim Planen überführt wurde (für "übernommen in"-Historie). */
  plannedMilestone: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface CreateFeatureInput {
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  techStack?: string[];
  sourceFiles?: string[];
  gitShaIntroduced?: string;
  visibility?: FeatureVisibility;
  confidence?: number;
  source?: FeatureSource;
  status?: FeatureStatus;
  derivedFromFeatureId?: string;
  plannedMilestone?: string;
}

export interface FeatureSearchOptions {
  /** Owner-User-ID (für visibility-Filter). */
  userId: string;
  /** Optional: nur Features dieses Projekts (für Project-Detail-View). */
  projectId?: string;
  /** Maximale Anzahl. Default 50, max 200. */
  limit?: number;
  /** Status-Filter. Default: nur 'confirmed'. */
  status?: FeatureStatus;
  /** Include retired features. Default false. */
  includeRetired?: boolean;
}

function parseJsonArray<T>(s: unknown): T[] {
  if (typeof s !== 'string' || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
}

function rowToFeature(r: DbRow): ProjectFeature {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    userId: r.user_id as string,
    name: r.name as string,
    description: (r.description as string) ?? '',
    techStack: parseJsonArray<string>(r.tech_stack),
    sourceFiles: parseJsonArray<string>(r.source_files),
    gitShaIntroduced: (r.git_sha_introduced as string | null) ?? null,
    version: Number(r.version ?? 1),
    visibility: ((r.visibility as string) ?? 'private') as FeatureVisibility,
    confidence: Number(r.confidence ?? 0.5),
    source: ((r.source as string) ?? 'auto') as FeatureSource,
    status: ((r.status as string) ?? 'confirmed') as FeatureStatus,
    embeddingId: (r.embedding_id as string | null) ?? null,
    derivedFromFeatureId: (r.derived_from_feature_id as string | null) ?? null,
    plannedMilestone: (r.planned_milestone as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    retiredAt: (r.retired_at as string | null) ?? null,
  };
}

export class ProjectFeaturesRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async create(input: CreateFeatureInput): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO project_features
       (id, project_id, user_id, name, description, tech_stack, source_files,
        git_sha_introduced, version, visibility, confidence, source, status,
        derived_from_feature_id, planned_milestone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.projectId, input.userId, input.name,
        input.description ?? '',
        JSON.stringify(input.techStack ?? []),
        JSON.stringify(input.sourceFiles ?? []),
        input.gitShaIntroduced ?? null,
        input.visibility ?? 'private',
        input.confidence ?? 0.5,
        input.source ?? 'auto',
        input.status ?? 'confirmed',
        input.derivedFromFeatureId ?? null,
        input.plannedMilestone ?? null,
        now, now,
      ],
    );
    return id;
  }

  /**
   * Insert oder bump-version. Wenn (project_id, name) bereits existiert:
   * alte Version in history archivieren, version+1 in main-Tabelle.
   */
  async upsertOrBumpVersion(input: CreateFeatureInput): Promise<{ id: string; version: number; isNew: boolean }> {
    const existing = await this.findByProjectAndName(input.projectId, input.name);
    if (!existing) {
      const id = await this.create(input);
      return { id, version: 1, isNew: true };
    }
    // archive existing snapshot before bump
    await this.archiveVersion(existing, 'replaced-by-extraction');
    const newVersion = existing.version + 1;
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_features
         SET description = ?, tech_stack = ?, source_files = ?,
             git_sha_introduced = ?, version = ?, confidence = ?,
             source = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.description ?? existing.description,
        JSON.stringify(input.techStack ?? existing.techStack),
        JSON.stringify(input.sourceFiles ?? existing.sourceFiles),
        input.gitShaIntroduced ?? existing.gitShaIntroduced,
        newVersion,
        input.confidence ?? existing.confidence,
        input.source ?? existing.source,
        input.status ?? existing.status,
        now,
        existing.id,
      ],
    );
    return { id: existing.id, version: newVersion, isNew: false };
  }

  async findByProjectAndName(projectId: string, name: string): Promise<ProjectFeature | null> {
    const rows = await this.db.query(
      `SELECT * FROM project_features WHERE project_id = ? AND name = ? AND retired_at IS NULL`,
      [projectId, name],
    );
    return rows[0] ? rowToFeature(rows[0]) : null;
  }

  async getById(featureId: string): Promise<ProjectFeature | null> {
    const rows = await this.db.query(`SELECT * FROM project_features WHERE id = ?`, [featureId]);
    return rows[0] ? rowToFeature(rows[0]) : null;
  }

  /**
   * Liste Features pro Projekt (respektiert User-Owner-Check via userId).
   */
  async listByProject(projectId: string, options?: { status?: FeatureStatus; includeRetired?: boolean }): Promise<ProjectFeature[]> {
    const params: unknown[] = [projectId];
    let sql = `SELECT * FROM project_features WHERE project_id = ?`;
    if (!options?.includeRetired) sql += ` AND retired_at IS NULL`;
    if (options?.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    }
    sql += ` ORDER BY confidence DESC, updated_at DESC`;
    const rows = await this.db.query(sql, params);
    return rows.map(rowToFeature);
  }

  /**
   * Cross-Project-Search: findet Features mit visibility-Filter.
   * Owner sieht private+role-shared+global eigene; andere User sehen
   * nur role-shared (gleicher user) + global.
   */
  async search(query: string, opts: FeatureSearchOptions): Promise<ProjectFeature[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const params: unknown[] = [`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`];
    let sql = `SELECT * FROM project_features
               WHERE (LOWER(name) LIKE ? OR LOWER(description) LIKE ?)`;
    if (!opts.includeRetired) sql += ` AND retired_at IS NULL`;
    sql += ` AND status = ?`;
    params.push(opts.status ?? 'confirmed');

    if (opts.projectId) {
      sql += ` AND project_id = ?`;
      params.push(opts.projectId);
    } else {
      // Cross-Project: visibility-Filter
      sql += ` AND (visibility = 'global' OR (user_id = ? AND visibility IN ('private','role-shared','global')) OR visibility = 'role-shared')`;
      params.push(opts.userId);
    }
    sql += ` ORDER BY confidence DESC, version DESC LIMIT ?`;
    params.push(limit);

    const rows = await this.db.query(sql, params);
    return rows.map(rowToFeature);
  }

  async setVisibility(featureId: string, visibility: FeatureVisibility): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_features SET visibility = ?, updated_at = ? WHERE id = ?`,
      [visibility, now, featureId],
    );
  }

  async setStatus(featureId: string, status: FeatureStatus): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_features SET status = ?, updated_at = ? WHERE id = ?`,
      [status, now, featureId],
    );
  }

  /**
   * v898 — Roadmap-Milestone setzen, in den dieses Feature beim Planen
   * überführt wurde (für die "übernommen in"-Anzeige der Feature-Historie).
   */
  async setPlannedMilestone(featureId: string, milestone: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_features SET planned_milestone = ?, updated_at = ? WHERE id = ?`,
      [milestone, now, featureId],
    );
  }

  /**
   * v898 — Feature-Vorschlag aus der Discovery als 'pending' festhalten, damit
   * die Vorschlags-Historie auch unentschiedene Vorschläge zeigt. Idempotent:
   * existiert (project_id, name) bereits, bleibt der bestehende Eintrag inkl.
   * seines Status (confirmed/rejected/pending) UNVERÄNDERT — ein einmal
   * angenommener oder abgelehnter Vorschlag wird nie auf 'pending' zurückgesetzt.
   */
  async recordSuggestionPending(input: CreateFeatureInput): Promise<{ id: string; isNew: boolean }> {
    const existing = await this.findByProjectAndName(input.projectId, input.name);
    if (existing) return { id: existing.id, isNew: false };
    const id = await this.create({ ...input, status: 'pending', source: input.source ?? 'auto' });
    return { id, isNew: true };
  }

  /** v851.1 — embedding_id-Spalte populieren nach EmbeddingService.embedAndStore. */
  async setEmbeddingId(featureId: string, embeddingId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_features SET embedding_id = ?, updated_at = ? WHERE id = ?`,
      [embeddingId, now, featureId],
    );
  }

  /** v851.1 — Lookup mehrerer Features by IDs (für semantic-search-Resolve). */
  async getByIds(ids: string[]): Promise<ProjectFeature[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.db.query(
      `SELECT * FROM project_features WHERE id IN (${placeholders}) AND retired_at IS NULL`,
      ids,
    );
    return rows.map(rowToFeature);
  }

  async retire(featureId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    // Snapshot in history bevor wir retire setzen
    const existing = await this.getById(featureId);
    if (existing) await this.archiveVersion(existing, reason ?? 'retired');
    await this.db.execute(
      `UPDATE project_features SET retired_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, featureId],
    );
  }

  /** Snapshot vor Bump/Retire in project_feature_history archivieren. */
  private async archiveVersion(feature: ProjectFeature, reason: string): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO project_feature_history
       (id, feature_id, version, snapshot_json, archived_at, archived_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, feature.id, feature.version, JSON.stringify(feature), now, reason],
    );
  }

  async listHistory(featureId: string): Promise<Array<{ version: number; snapshot: ProjectFeature; archivedAt: string; reason: string | null }>> {
    const rows = await this.db.query(
      `SELECT * FROM project_feature_history WHERE feature_id = ? ORDER BY version DESC`,
      [featureId],
    );
    return rows.map(r => ({
      version: Number(r.version),
      snapshot: JSON.parse(r.snapshot_json as string) as ProjectFeature,
      archivedAt: r.archived_at as string,
      reason: (r.archived_reason as string | null) ?? null,
    }));
  }

  /** Pending-Features für UI-Confirm-Tab. */
  async listPendingForUser(userId: string): Promise<ProjectFeature[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_features
       WHERE user_id = ? AND status = 'pending' AND retired_at IS NULL
       ORDER BY created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map(rowToFeature);
  }
}
