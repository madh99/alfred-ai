import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { CmdbProblem, ProblemStatus, ProblemPriority, ProblemCategory } from '@alfred/types';

function parseJsonArray(val: unknown): string[] {
  if (!val) return [];
  try { return JSON.parse(val as string); } catch { return []; }
}

function rowToProblem(r: DbRow): CmdbProblem {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    title: r.title as string,
    description: r.description as string | undefined,
    status: r.status as ProblemStatus,
    priority: r.priority as ProblemPriority,
    category: r.category as ProblemCategory | undefined,
    rootCauseDescription: r.root_cause_description as string | undefined,
    rootCauseCategory: r.root_cause_category as ProblemCategory | undefined,
    workaround: r.workaround as string | undefined,
    proposedFix: r.proposed_fix as string | undefined,
    isKnownError: Boolean(r.is_known_error),
    knownErrorDescription: r.known_error_description as string | undefined,
    analysisNotes: r.analysis_notes as string | undefined,
    linkedIncidentIds: parseJsonArray(r.linked_incident_ids),
    linkedChangeRequestId: r.linked_change_request_id as string | undefined,
    affectedAssetIds: parseJsonArray(r.affected_asset_ids),
    affectedServiceIds: parseJsonArray(r.affected_service_ids),
    detectedBy: (r.detected_by as CmdbProblem['detectedBy']) ?? 'manual',
    detectionMethod: r.detection_method as string | undefined,
    detectedAt: r.detected_at as string,
    analyzedAt: r.analyzed_at as string | undefined,
    rootCauseIdentifiedAt: r.root_cause_identified_at as string | undefined,
    resolvedAt: r.resolved_at as string | undefined,
    closedAt: r.closed_at as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class ProblemRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async createProblem(userId: string, data: {
    title: string; description?: string; priority?: ProblemPriority; category?: ProblemCategory;
    linkedIncidentIds?: string[]; affectedAssetIds?: string[]; affectedServiceIds?: string[];
    detectedBy?: CmdbProblem['detectedBy']; detectionMethod?: string; workaround?: string;
  }): Promise<CmdbProblem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO cmdb_problems (id, user_id, title, description, priority, category, linked_incident_ids, affected_asset_ids, affected_service_ids, detected_by, detection_method, workaround, detected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, data.title, data.description ?? null, data.priority ?? 'medium', data.category ?? null,
       JSON.stringify(data.linkedIncidentIds ?? []), JSON.stringify(data.affectedAssetIds ?? []),
       JSON.stringify(data.affectedServiceIds ?? []), data.detectedBy ?? 'manual',
       data.detectionMethod ?? null, data.workaround ?? null, now, now, now],
    );
    return (await this.getProblemById(userId, id))!;
  }

  async getProblemById(userId: string, id: string): Promise<CmdbProblem | null> {
    let row = await this.db.queryOne(
      `SELECT * FROM cmdb_problems WHERE id = ? AND user_id = ?`, [id, userId],
    );
    // Prefix match fallback (8-char short IDs)
    if (!row && id.length >= 6 && id.length <= 12 && /^[0-9a-f]+$/i.test(id)) {
      row = await this.db.queryOne(
        `SELECT * FROM cmdb_problems WHERE id LIKE ? AND user_id = ?`, [id + '%', userId],
      );
    }
    return row ? rowToProblem(row as any) : null;
  }

  async listProblems(userId: string, filters?: {
    status?: ProblemStatus; priority?: ProblemPriority; category?: ProblemCategory;
    isKnownError?: boolean; limit?: number;
  }): Promise<CmdbProblem[]> {
    let sql = `SELECT * FROM cmdb_problems WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    if (filters?.priority) { sql += ` AND priority = ?`; params.push(filters.priority); }
    if (filters?.category) { sql += ` AND category = ?`; params.push(filters.category); }
    if (filters?.isKnownError !== undefined) { sql += ` AND is_known_error = ?`; params.push(filters.isKnownError ? 1 : 0); }
    sql += ` ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, detected_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.db.query(sql, params);
    return (rows as any[]).map(rowToProblem);
  }

  async updateProblem(userId: string, id: string, updates: Partial<{
    title: string; description: string; status: ProblemStatus; priority: ProblemPriority;
    category: ProblemCategory; rootCauseDescription: string; rootCauseCategory: ProblemCategory;
    workaround: string; proposedFix: string; isKnownError: boolean; knownErrorDescription: string;
    linkedIncidentIds: string[]; linkedChangeRequestId: string;
    affectedAssetIds: string[]; affectedServiceIds: string[];
  }>): Promise<CmdbProblem | null> {
    const existing = await this.getProblemById(userId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];
    const now = new Date().toISOString();

    const simple: Record<string, string> = {
      title: 'title', description: 'description', priority: 'priority', category: 'category',
      rootCauseDescription: 'root_cause_description', rootCauseCategory: 'root_cause_category',
      workaround: 'workaround', proposedFix: 'proposed_fix',
      knownErrorDescription: 'known_error_description', linkedChangeRequestId: 'linked_change_request_id',
    };

    for (const [key, col] of Object.entries(simple)) {
      if (key in updates) { fields.push(`${col} = ?`); params.push((updates as any)[key] ?? null); }
    }

    if (updates.isKnownError !== undefined) { fields.push(`is_known_error = ?`); params.push(updates.isKnownError ? 1 : 0); }
    if (updates.linkedIncidentIds) { fields.push(`linked_incident_ids = ?`); params.push(JSON.stringify(updates.linkedIncidentIds)); }
    if (updates.affectedAssetIds) { fields.push(`affected_asset_ids = ?`); params.push(JSON.stringify(updates.affectedAssetIds)); }
    if (updates.affectedServiceIds) { fields.push(`affected_service_ids = ?`); params.push(JSON.stringify(updates.affectedServiceIds)); }

    // Status transitions with timestamps
    if (updates.status && updates.status !== existing.status) {
      fields.push(`status = ?`); params.push(updates.status);
      if (updates.status === 'analyzing' && !existing.analyzedAt) { fields.push(`analyzed_at = ?`); params.push(now); }
      if (updates.status === 'root_cause_identified' && !existing.rootCauseIdentifiedAt) { fields.push(`root_cause_identified_at = ?`); params.push(now); }
      if (updates.status === 'resolved' && !existing.resolvedAt) { fields.push(`resolved_at = ?`); params.push(now); }
      if (updates.status === 'closed' && !existing.closedAt) { fields.push(`closed_at = ?`); params.push(now); }
    }

    if (fields.length === 0) return existing;
    fields.push(`updated_at = ?`); params.push(now);
    params.push(id, userId);

    await this.db.execute(`UPDATE cmdb_problems SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return this.getProblemById(userId, id);
  }

  async appendAnalysisNotes(userId: string, id: string, note: string): Promise<void> {
    const now = new Date().toISOString();
    const entry = `${now.slice(0, 16)} ${note}`;
    await this.db.execute(
      `UPDATE cmdb_problems SET analysis_notes = COALESCE(NULLIF(analysis_notes, '') || ? , ?), updated_at = ? WHERE id = ? AND user_id = ?`,
      [entry, `\n---\n${entry}`, now, id, userId],
    );
  }

  async linkIncident(userId: string, problemId: string, incidentId: string): Promise<CmdbProblem | null> {
    const problem = await this.getProblemById(userId, problemId);
    if (!problem) return null;
    if (problem.linkedIncidentIds.includes(incidentId)) return problem;

    const newIds = [...problem.linkedIncidentIds, incidentId];
    await this.db.execute(
      `UPDATE cmdb_problems SET linked_incident_ids = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(newIds), new Date().toISOString(), problemId, userId],
    );
    // Denormalized: set problem_id on incident
    await this.db.execute(
      `UPDATE cmdb_incidents SET problem_id = ? WHERE id = ? AND user_id = ?`,
      [problemId, incidentId, userId],
    );
    return this.getProblemById(userId, problemId);
  }

  async unlinkIncident(userId: string, problemId: string, incidentId: string): Promise<CmdbProblem | null> {
    const problem = await this.getProblemById(userId, problemId);
    if (!problem) return null;

    const newIds = problem.linkedIncidentIds.filter(id => id !== incidentId);
    await this.db.execute(
      `UPDATE cmdb_problems SET linked_incident_ids = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(newIds), new Date().toISOString(), problemId, userId],
    );
    await this.db.execute(
      `UPDATE cmdb_incidents SET problem_id = NULL WHERE id = ? AND user_id = ?`,
      [incidentId, userId],
    );
    return this.getProblemById(userId, problemId);
  }

  async linkChangeRequest(userId: string, problemId: string, changeRequestId: string): Promise<CmdbProblem | null> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE cmdb_problems SET linked_change_request_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [changeRequestId, now, problemId, userId],
    );
    await this.db.execute(
      `UPDATE cmdb_change_requests SET linked_problem_id = ? WHERE id = ? AND user_id = ?`,
      [problemId, changeRequestId, userId],
    );
    return this.getProblemById(userId, problemId);
  }

  async findProblemForIncident(userId: string, incidentId: string): Promise<CmdbProblem | null> {
    // Fast path: use denormalized problem_id on incident
    const incRow = await this.db.queryOne(
      `SELECT problem_id FROM cmdb_incidents WHERE id = ? AND user_id = ?`, [incidentId, userId],
    );
    if (incRow && (incRow as any).problem_id) {
      return this.getProblemById(userId, (incRow as any).problem_id);
    }
    return null;
  }

  async detectPatterns(userId: string, options?: {
    windowDays?: number; minIncidents?: number;
  }): Promise<Array<{
    patternKey: string; incidentIds: string[]; assetIds: string[]; serviceIds: string[];
    keywordCluster: string[]; incidentCount: number; firstSeen: string; lastSeen: string;
    existingProblemId?: string;
  }>> {
    const windowDays = options?.windowDays ?? 7;
    const minIncidents = options?.minIncidents ?? 3;
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60_000).toISOString();

    const rows = await this.db.query(
      `SELECT id, title, affected_asset_ids, affected_service_ids, created_at, problem_id
       FROM cmdb_incidents WHERE user_id = ? AND problem_id IS NULL AND status != 'cancelled' AND created_at >= ?
       ORDER BY created_at ASC LIMIT 500`,
      [userId, cutoff],
    ) as any[];

    if (rows.length < minIncidents) return [];

    const GENERIC = new Set(['device', 'connected', 'state', 'status', 'failed', 'error', 'alert', 'monitor', 'check', 'health', 'warning', 'entities', 'unavailable', 'offline', 'online', 'service', 'critical']);

    // Build per-incident data
    const incidents = rows.map(r => ({
      id: r.id as string,
      keywords: new Set((r.title as string).split(/[\s:_\-]+/).filter((w: string) => w.length >= 4 && !GENERIC.has(w.toLowerCase())).map((w: string) => w.toLowerCase())),
      assetIds: new Set(parseJsonArray(r.affected_asset_ids)),
      serviceIds: new Set(parseJsonArray(r.affected_service_ids)),
      createdAt: r.created_at as string,
    }));

    // Cluster by asset overlap
    const clusters = new Map<string, Set<number>>(); // clusterKey → incident indexes
    for (let i = 0; i < incidents.length; i++) {
      for (const aid of incidents[i].assetIds) {
        const key = `asset:${aid}`;
        if (!clusters.has(key)) clusters.set(key, new Set());
        clusters.get(key)!.add(i);
      }
      for (const sid of incidents[i].serviceIds) {
        const key = `service:${sid}`;
        if (!clusters.has(key)) clusters.set(key, new Set());
        clusters.get(key)!.add(i);
      }
    }

    // Also cluster by keyword overlap (≥3 shared keywords)
    for (let i = 0; i < incidents.length; i++) {
      for (let j = i + 1; j < incidents.length; j++) {
        const shared = [...incidents[i].keywords].filter(k => incidents[j].keywords.has(k));
        if (shared.length >= 3) {
          const key = `kw:${shared.sort().join('_')}`;
          if (!clusters.has(key)) clusters.set(key, new Set());
          clusters.get(key)!.add(i);
          clusters.get(key)!.add(j);
        }
      }
    }

    // Filter clusters by minIncidents
    const results: Array<{
      patternKey: string; incidentIds: string[]; assetIds: string[]; serviceIds: string[];
      keywordCluster: string[]; incidentCount: number; firstSeen: string; lastSeen: string;
      existingProblemId?: string;
    }> = [];

    const usedIncidents = new Set<number>();
    for (const [, indexes] of [...clusters.entries()].sort((a, b) => b[1].size - a[1].size)) {
      if (indexes.size < minIncidents) continue;
      const idxArray = [...indexes].filter(i => !usedIncidents.has(i));
      if (idxArray.length < minIncidents) continue;

      // Collect data
      const incIds = idxArray.map(i => incidents[i].id);
      const allAssets = new Set<string>();
      const allServices = new Set<string>();
      const kwFreq = new Map<string, number>();
      let first = incidents[idxArray[0]].createdAt;
      let last = incidents[idxArray[0]].createdAt;

      for (const i of idxArray) {
        for (const a of incidents[i].assetIds) allAssets.add(a);
        for (const s of incidents[i].serviceIds) allServices.add(s);
        for (const k of incidents[i].keywords) kwFreq.set(k, (kwFreq.get(k) ?? 0) + 1);
        if (incidents[i].createdAt < first) first = incidents[i].createdAt;
        if (incidents[i].createdAt > last) last = incidents[i].createdAt;
        usedIncidents.add(i);
      }

      const topKw = [...kwFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

      results.push({
        patternKey: incIds.sort().join(':'),
        incidentIds: incIds,
        assetIds: [...allAssets],
        serviceIds: [...allServices],
        keywordCluster: topKw,
        incidentCount: incIds.length,
        firstSeen: first,
        lastSeen: last,
      });
    }

    return results.sort((a, b) => b.incidentCount - a.incidentCount);
  }

  async getDashboard(userId: string): Promise<{
    openProblems: number; knownErrors: number;
    problemsByStatus: Record<string, number>; problemsByPriority: Record<string, number>;
  }> {
    const rows = await this.db.query(
      `SELECT status, priority, is_known_error FROM cmdb_problems WHERE user_id = ?`, [userId],
    ) as any[];

    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let open = 0;
    let ke = 0;

    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
      if (!['resolved', 'closed'].includes(r.status)) open++;
      if (r.is_known_error) ke++;
    }

    return { openProblems: open, knownErrors: ke, problemsByStatus: byStatus, problemsByPriority: byPriority };
  }
}
