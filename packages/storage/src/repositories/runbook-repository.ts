import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter } from '../db-adapter.js';

export type RunbookSource = 'itsm_incident' | 'project_agent' | 'chat_session' | 'manual';
export type RunbookStatus = 'draft' | 'verified' | 'deprecated';

export interface Runbook {
  id: string;
  userId: string;
  title: string;
  symptom?: string;
  cause?: string;
  steps: string[];               // numbered steps as strings
  verification?: string;
  rollback?: string;
  sourceType?: RunbookSource;
  sourceId?: string;
  assetIds: string[];
  tags: string[];
  confidence: number;
  usageCount: number;
  lastUsedAt?: string;
  status: RunbookStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookCreateInput {
  title: string;
  symptom?: string;
  cause?: string;
  steps: string[];
  verification?: string;
  rollback?: string;
  sourceType?: RunbookSource;
  sourceId?: string;
  assetIds?: string[];
  tags?: string[];
  confidence?: number;
  status?: RunbookStatus;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}

function rowToRunbook(row: Record<string, unknown>): Runbook {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string,
    symptom: (row.symptom as string | null) ?? undefined,
    cause: (row.cause as string | null) ?? undefined,
    steps: parseJsonArray(row.steps),
    verification: (row.verification as string | null) ?? undefined,
    rollback: (row.rollback as string | null) ?? undefined,
    sourceType: (row.source_type as RunbookSource | null) ?? undefined,
    sourceId: (row.source_id as string | null) ?? undefined,
    assetIds: parseJsonArray(row.asset_ids),
    tags: parseJsonArray(row.tags),
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.7,
    usageCount: typeof row.usage_count === 'number' ? row.usage_count : 0,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
    status: (row.status as RunbookStatus) ?? 'draft',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Repository for operational Runbooks — captured procedures from successful incident
 * resolutions, project-agent sessions, and chat-session problem-solving patterns.
 *
 * Source-tracking: every runbook records which event spawned it (sourceType + sourceId)
 * so we can find related incidents, link back to project sessions, etc.
 */
export class RunbookRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  async create(userId: string, input: RunbookCreateInput): Promise<Runbook> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO runbooks (
        id, user_id, title, symptom, cause, steps, verification, rollback,
        source_type, source_id, asset_ids, tags, confidence,
        usage_count, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id, userId, input.title, input.symptom ?? null, input.cause ?? null,
        JSON.stringify(input.steps), input.verification ?? null, input.rollback ?? null,
        input.sourceType ?? null, input.sourceId ?? null,
        JSON.stringify(input.assetIds ?? []), JSON.stringify(input.tags ?? []),
        input.confidence ?? 0.7, input.status ?? 'draft', now, now,
      ],
    );
    return (await this.getById(userId, id))!;
  }

  async getById(userId: string, id: string): Promise<Runbook | null> {
    let row = await this.adapter.queryOne(
      `SELECT * FROM runbooks WHERE id = ? AND user_id = ?`, [id, userId],
    ) as Record<string, unknown> | undefined;
    // 8-char prefix match like ITSM
    if (!row && id.length >= 6 && id.length <= 12 && /^[0-9a-f]+$/i.test(id)) {
      row = await this.adapter.queryOne(
        `SELECT * FROM runbooks WHERE id LIKE ? AND user_id = ?`, [id + '%', userId],
      ) as Record<string, unknown> | undefined;
    }
    return row ? rowToRunbook(row) : null;
  }

  /**
   * v804 — Owner-Filter umgehen für System-Lookups.
   */
  async getByIdAnyOwner(id: string): Promise<Runbook | null> {
    let row = await this.adapter.queryOne(
      `SELECT * FROM runbooks WHERE id = ?`, [id],
    ) as Record<string, unknown> | undefined;
    if (!row && id.length >= 6 && id.length <= 12 && /^[0-9a-f]+$/i.test(id)) {
      row = await this.adapter.queryOne(
        `SELECT * FROM runbooks WHERE id LIKE ?`, [id + '%'],
      ) as Record<string, unknown> | undefined;
    }
    return row ? rowToRunbook(row) : null;
  }

  async list(userId: string, filters?: { status?: RunbookStatus; sourceType?: RunbookSource; limit?: number }): Promise<Runbook[]> {
    let sql = `SELECT * FROM runbooks WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    if (filters?.sourceType) { sql += ` AND source_type = ?`; params.push(filters.sourceType); }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(rowToRunbook);
  }

  /**
   * Find runbooks matching a symptom text via keyword overlap. Used by the
   * reasoning collector to surface relevant runbooks for currently active incidents.
   * Excludes deprecated runbooks.
   */
  async findMatching(userId: string, symptomText: string, limit = 5): Promise<Runbook[]> {
    const keywords = symptomText.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (keywords.length === 0) return [];

    const rows = await this.adapter.query(
      `SELECT * FROM runbooks WHERE user_id = ? AND status != 'deprecated' ORDER BY confidence DESC, usage_count DESC LIMIT 100`,
      [userId],
    ) as Record<string, unknown>[];

    const scored = rows.map(rowToRunbook).map(rb => {
      const haystack = `${rb.title} ${rb.symptom ?? ''} ${rb.tags.join(' ')}`.toLowerCase();
      const matches = keywords.filter(k => haystack.includes(k));
      return { rb, score: matches.length };
    }).filter(x => x.score >= 2)  // at least 2 keyword matches
      .sort((a, b) => b.score - a.score || b.rb.confidence - a.rb.confidence);

    return scored.slice(0, limit).map(x => x.rb);
  }

  async update(userId: string, id: string, patch: Partial<RunbookCreateInput> & { status?: RunbookStatus }): Promise<Runbook | null> {
    const existing = await this.getById(userId, id);
    if (!existing) return null;
    const realId = existing.id;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.symptom !== undefined) { sets.push('symptom = ?'); params.push(patch.symptom); }
    if (patch.cause !== undefined) { sets.push('cause = ?'); params.push(patch.cause); }
    if (patch.steps !== undefined) { sets.push('steps = ?'); params.push(JSON.stringify(patch.steps)); }
    if (patch.verification !== undefined) { sets.push('verification = ?'); params.push(patch.verification); }
    if (patch.rollback !== undefined) { sets.push('rollback = ?'); params.push(patch.rollback); }
    if (patch.assetIds !== undefined) { sets.push('asset_ids = ?'); params.push(JSON.stringify(patch.assetIds)); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(patch.tags)); }
    if (patch.confidence !== undefined) { sets.push('confidence = ?'); params.push(patch.confidence); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(realId);
    await this.adapter.execute(`UPDATE runbooks SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getById(userId, realId);
  }

  async incrementUsage(id: string): Promise<void> {
    await this.adapter.execute(
      `UPDATE runbooks SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), id],
    );
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const existing = await this.getById(userId, id);
    if (!existing) return false;
    const result = await this.adapter.execute(`DELETE FROM runbooks WHERE id = ?`, [existing.id]);
    return result.changes > 0;
  }

  async findBySource(userId: string, sourceType: RunbookSource, sourceId: string): Promise<Runbook | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM runbooks WHERE user_id = ? AND source_type = ? AND source_id = ? LIMIT 1`,
      [userId, sourceType, sourceId],
    ) as Record<string, unknown> | undefined;
    return row ? rowToRunbook(row) : null;
  }
}
