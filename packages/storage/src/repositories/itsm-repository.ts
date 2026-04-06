import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type {
  CmdbIncident, CmdbService, CmdbChangeRequest,
  IncidentSeverity, IncidentStatus,
  ServiceCategory, ServiceHealthStatus, ServiceCriticality,
  ChangeRequestType, ChangeRequestStatus,
  CmdbEnvironment,
} from '@alfred/types';

// ── Row → Domain Mappers ─────────────────────────────────────

function parseJsonArray(val: unknown): string[] {
  if (!val) return [];
  try { return JSON.parse(val as string); } catch { return []; }
}

function rowToIncident(r: DbRow): CmdbIncident {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    title: r.title as string,
    description: r.description as string | undefined,
    severity: r.severity as IncidentSeverity,
    status: r.status as IncidentStatus,
    priority: r.priority as number,
    affectedAssetIds: parseJsonArray(r.affected_asset_ids),
    affectedServiceIds: parseJsonArray(r.affected_service_ids),
    symptoms: r.symptoms as string | undefined,
    rootCause: r.root_cause as string | undefined,
    resolution: r.resolution as string | undefined,
    workaround: r.workaround as string | undefined,
    postmortem: r.postmortem as string | undefined,
    detectedBy: r.detected_by as string | undefined,
    relatedIncidentId: r.related_incident_id as string | undefined,
    openedAt: r.opened_at as string,
    acknowledgedAt: r.acknowledged_at as string | undefined,
    resolvedAt: r.resolved_at as string | undefined,
    closedAt: r.closed_at as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToService(r: DbRow): CmdbService {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    description: r.description as string | undefined,
    category: r.category as ServiceCategory | undefined,
    environment: r.environment as CmdbEnvironment | undefined,
    url: r.url as string | undefined,
    healthCheckUrl: r.health_check_url as string | undefined,
    healthStatus: r.health_status as ServiceHealthStatus,
    lastHealthCheck: r.last_health_check as string | undefined,
    criticality: r.criticality as ServiceCriticality | undefined,
    dependencies: parseJsonArray(r.dependencies),
    assetIds: parseJsonArray(r.asset_ids),
    owner: r.owner as string | undefined,
    documentation: r.documentation as string | undefined,
    slaNotes: r.sla_notes as string | undefined,
    maintenanceWindow: r.maintenance_window as string | undefined,
    tags: r.tags as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToChangeRequest(r: DbRow): CmdbChangeRequest {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    title: r.title as string,
    description: r.description as string | undefined,
    type: r.type as ChangeRequestType,
    status: r.status as ChangeRequestStatus,
    riskLevel: r.risk_level as IncidentSeverity,
    affectedAssetIds: parseJsonArray(r.affected_asset_ids),
    affectedServiceIds: parseJsonArray(r.affected_service_ids),
    implementationPlan: r.implementation_plan as string | undefined,
    rollbackPlan: r.rollback_plan as string | undefined,
    testPlan: r.test_plan as string | undefined,
    scheduledAt: r.scheduled_at as string | undefined,
    startedAt: r.started_at as string | undefined,
    completedAt: r.completed_at as string | undefined,
    result: r.result as string | undefined,
    linkedIncidentId: r.linked_incident_id as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ── Repository ───────────────────────────────────────────────

export class ItsmRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  // ── Incidents ──────────────────────────────────────────────

  async createIncident(userId: string, data: {
    title: string; description?: string; severity?: IncidentSeverity; priority?: number;
    affectedAssetIds?: string[]; affectedServiceIds?: string[];
    symptoms?: string; detectedBy?: string; relatedIncidentId?: string;
  }): Promise<CmdbIncident> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO cmdb_incidents (
        id, user_id, title, description, severity, status, priority,
        affected_asset_ids, affected_service_ids, symptoms, detected_by,
        related_incident_id, opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, data.title, data.description ?? null,
        data.severity ?? 'medium', data.priority ?? 3,
        JSON.stringify(data.affectedAssetIds ?? []),
        JSON.stringify(data.affectedServiceIds ?? []),
        data.symptoms ?? null, data.detectedBy ?? null,
        data.relatedIncidentId ?? null, now, now, now,
      ],
    );
    return (await this.getIncidentById(userId, id))!;
  }

  async getIncidentById(userId: string, id: string): Promise<CmdbIncident | null> {
    const row = await this.db.queryOne(
      `SELECT * FROM cmdb_incidents WHERE id = ? AND user_id = ?`, [id, userId],
    );
    return row ? rowToIncident(row) : null;
  }

  async listIncidents(userId: string, filters?: {
    status?: IncidentStatus; severity?: IncidentSeverity; since?: string; limit?: number;
  }): Promise<CmdbIncident[]> {
    let sql = `SELECT * FROM cmdb_incidents WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    if (filters?.severity) { sql += ` AND severity = ?`; params.push(filters.severity); }
    if (filters?.since) { sql += ` AND created_at >= ?`; params.push(filters.since); }
    sql += ` ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.db.query(sql, params);
    return rows.map(rowToIncident);
  }

  async updateIncident(userId: string, id: string, updates: Partial<{
    title: string; description: string; severity: IncidentSeverity; status: IncidentStatus;
    priority: number; affectedAssetIds: string[]; affectedServiceIds: string[];
    symptoms: string; rootCause: string; resolution: string; workaround: string;
  }>): Promise<CmdbIncident | null> {
    const existing = await this.getIncidentById(userId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];
    const now = new Date().toISOString();

    const simple: Record<string, string> = {
      title: 'title', description: 'description', severity: 'severity',
      priority: 'priority', symptoms: 'symptoms', rootCause: 'root_cause',
      resolution: 'resolution', workaround: 'workaround', postmortem: 'postmortem',
      relatedIncidentId: 'related_incident_id',
    };

    for (const [key, col] of Object.entries(simple)) {
      if (key in updates) { fields.push(`${col} = ?`); params.push((updates as any)[key] ?? null); }
    }

    if (updates.affectedAssetIds) { fields.push(`affected_asset_ids = ?`); params.push(JSON.stringify(updates.affectedAssetIds)); }
    if (updates.affectedServiceIds) { fields.push(`affected_service_ids = ?`); params.push(JSON.stringify(updates.affectedServiceIds)); }

    // Status transitions with timestamps
    if (updates.status && updates.status !== existing.status) {
      fields.push(`status = ?`); params.push(updates.status);
      if (updates.status === 'acknowledged' && !existing.acknowledgedAt) { fields.push(`acknowledged_at = ?`); params.push(now); }
      if (updates.status === 'resolved' && !existing.resolvedAt) { fields.push(`resolved_at = ?`); params.push(now); }
      if (updates.status === 'closed' && !existing.closedAt) { fields.push(`closed_at = ?`); params.push(now); }
    }

    if (fields.length === 0) return existing;
    fields.push(`updated_at = ?`); params.push(now);
    params.push(id, userId);

    await this.db.execute(`UPDATE cmdb_incidents SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return this.getIncidentById(userId, id);
  }

  async closeIncident(userId: string, id: string, resolution: string): Promise<CmdbIncident | null> {
    return this.updateIncident(userId, id, { status: 'closed', resolution });
  }

  async findOpenIncidentForAsset(userId: string, sourceLabel: string, titleKeywords: string[]): Promise<CmdbIncident | null> {
    const open = await this.listIncidents(userId, { status: 'open' });
    const investigating = await this.listIncidents(userId, { status: 'investigating' });
    const acknowledged = await this.listIncidents(userId, { status: 'acknowledged' });
    const mitigating = await this.listIncidents(userId, { status: 'mitigating' });
    const all = [...open, ...investigating, ...acknowledged, ...mitigating];

    for (const inc of all) {
      const titleLower = inc.title.toLowerCase();
      const sourceMatch = titleLower.includes(sourceLabel.toLowerCase());
      const matchCount = titleKeywords.filter(kw => titleLower.includes(kw.toLowerCase())).length;
      if (sourceMatch && matchCount >= 1) return inc;
      if (matchCount >= Math.min(2, titleKeywords.length)) return inc;
    }
    return null;
  }

  /** Find any open incident from the same source within a time window. */
  async findRecentIncidentForSource(userId: string, sourceLabel: string, withinHours = 4): Promise<CmdbIncident | null> {
    const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString();
    const rows = await this.db.query(
      `SELECT * FROM cmdb_incidents WHERE user_id = ? AND status NOT IN ('closed', 'cancelled', 'resolved') AND opened_at >= ? ORDER BY opened_at DESC`,
      [userId, cutoff],
    );
    const incidents = rows.map(rowToIncident);
    const srcLower = sourceLabel.toLowerCase();
    return incidents.find(inc => inc.title.toLowerCase().includes(srcLower)) ?? null;
  }

  /** Append a new alert message to an existing incident's symptoms. */
  async appendSymptoms(userId: string, id: string, newSymptom: string): Promise<void> {
    const existing = await this.getIncidentById(userId, id);
    if (!existing) return;
    const updated = existing.symptoms
      ? `${existing.symptoms}\n---\n${new Date().toISOString().slice(0, 16)} ${newSymptom}`
      : newSymptom;
    await this.updateIncident(userId, id, { symptoms: updated });
  }

  // ── Services ───────────────────────────────────────────────

  async createService(userId: string, data: {
    name: string; description?: string; category?: ServiceCategory;
    environment?: CmdbEnvironment; url?: string; healthCheckUrl?: string;
    criticality?: ServiceCriticality; dependencies?: string[]; assetIds?: string[];
    owner?: string; documentation?: string; slaNotes?: string;
    maintenanceWindow?: string; tags?: string;
  }): Promise<CmdbService> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO cmdb_services (
        id, user_id, name, description, category, environment, url, health_check_url,
        health_status, criticality, dependencies, asset_ids, owner, documentation,
        sla_notes, maintenance_window, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, data.name, data.description ?? null,
        data.category ?? null, data.environment ?? null,
        data.url ?? null, data.healthCheckUrl ?? null,
        data.criticality ?? 'medium',
        JSON.stringify(data.dependencies ?? []),
        JSON.stringify(data.assetIds ?? []),
        data.owner ?? null, data.documentation ?? null,
        data.slaNotes ?? null, data.maintenanceWindow ?? null,
        data.tags ?? null, now, now,
      ],
    );
    return (await this.getServiceById(userId, id))!;
  }

  async getServiceById(userId: string, id: string): Promise<CmdbService | null> {
    const row = await this.db.queryOne(`SELECT * FROM cmdb_services WHERE id = ? AND user_id = ?`, [id, userId]);
    return row ? rowToService(row) : null;
  }

  async listServices(userId: string, filters?: {
    category?: ServiceCategory; healthStatus?: ServiceHealthStatus; environment?: CmdbEnvironment;
  }): Promise<CmdbService[]> {
    let sql = `SELECT * FROM cmdb_services WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.category) { sql += ` AND category = ?`; params.push(filters.category); }
    if (filters?.healthStatus) { sql += ` AND health_status = ?`; params.push(filters.healthStatus); }
    if (filters?.environment) { sql += ` AND environment = ?`; params.push(filters.environment); }
    sql += ` ORDER BY CASE criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, name`;
    const rows = await this.db.query(sql, params);
    return rows.map(rowToService);
  }

  async updateService(userId: string, id: string, updates: Partial<CmdbService>): Promise<CmdbService | null> {
    const existing = await this.getServiceById(userId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];

    const simple: Record<string, string> = {
      name: 'name', description: 'description', category: 'category',
      environment: 'environment', url: 'url', healthCheckUrl: 'health_check_url',
      healthStatus: 'health_status', criticality: 'criticality',
      owner: 'owner', documentation: 'documentation', slaNotes: 'sla_notes',
      maintenanceWindow: 'maintenance_window', tags: 'tags',
    };

    for (const [key, col] of Object.entries(simple)) {
      if (key in updates) { fields.push(`${col} = ?`); params.push((updates as any)[key] ?? null); }
    }

    if (updates.dependencies) { fields.push(`dependencies = ?`); params.push(JSON.stringify(updates.dependencies)); }
    if (updates.assetIds) { fields.push(`asset_ids = ?`); params.push(JSON.stringify(updates.assetIds)); }
    if (updates.lastHealthCheck) { fields.push(`last_health_check = ?`); params.push(updates.lastHealthCheck); }

    if (fields.length === 0) return existing;
    fields.push(`updated_at = ?`); params.push(new Date().toISOString());
    params.push(id, userId);

    await this.db.execute(`UPDATE cmdb_services SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return this.getServiceById(userId, id);
  }

  async updateServiceHealth(userId: string, id: string, status: ServiceHealthStatus): Promise<void> {
    await this.db.execute(
      `UPDATE cmdb_services SET health_status = ?, last_health_check = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [status, new Date().toISOString(), new Date().toISOString(), id, userId],
    );
  }

  // ── Change Requests ────────────────────────────────────────

  async createChangeRequest(userId: string, data: {
    title: string; description?: string; type?: ChangeRequestType;
    riskLevel?: IncidentSeverity; affectedAssetIds?: string[]; affectedServiceIds?: string[];
    implementationPlan?: string; rollbackPlan?: string; testPlan?: string;
    scheduledAt?: string; linkedIncidentId?: string;
  }): Promise<CmdbChangeRequest> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO cmdb_change_requests (
        id, user_id, title, description, type, status, risk_level,
        affected_asset_ids, affected_service_ids, implementation_plan, rollback_plan,
        test_plan, scheduled_at, linked_incident_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, data.title, data.description ?? null,
        data.type ?? 'normal', data.riskLevel ?? 'medium',
        JSON.stringify(data.affectedAssetIds ?? []),
        JSON.stringify(data.affectedServiceIds ?? []),
        data.implementationPlan ?? null, data.rollbackPlan ?? null,
        data.testPlan ?? null, data.scheduledAt ?? null,
        data.linkedIncidentId ?? null, now, now,
      ],
    );
    return (await this.getChangeRequestById(userId, id))!;
  }

  async getChangeRequestById(userId: string, id: string): Promise<CmdbChangeRequest | null> {
    const row = await this.db.queryOne(`SELECT * FROM cmdb_change_requests WHERE id = ? AND user_id = ?`, [id, userId]);
    return row ? rowToChangeRequest(row) : null;
  }

  async listChangeRequests(userId: string, filters?: {
    status?: ChangeRequestStatus; type?: ChangeRequestType; limit?: number;
  }): Promise<CmdbChangeRequest[]> {
    let sql = `SELECT * FROM cmdb_change_requests WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    if (filters?.type) { sql += ` AND type = ?`; params.push(filters.type); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.db.query(sql, params);
    return rows.map(rowToChangeRequest);
  }

  async updateChangeRequest(userId: string, id: string, updates: Partial<{
    title: string; description: string; type: ChangeRequestType;
    status: ChangeRequestStatus; riskLevel: IncidentSeverity;
    affectedAssetIds: string[]; affectedServiceIds: string[];
    implementationPlan: string; rollbackPlan: string; testPlan: string;
    scheduledAt: string; result: string;
  }>): Promise<CmdbChangeRequest | null> {
    const existing = await this.getChangeRequestById(userId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];
    const now = new Date().toISOString();

    const simple: Record<string, string> = {
      title: 'title', description: 'description', type: 'type',
      riskLevel: 'risk_level', implementationPlan: 'implementation_plan',
      rollbackPlan: 'rollback_plan', testPlan: 'test_plan',
      scheduledAt: 'scheduled_at', result: 'result',
    };

    for (const [key, col] of Object.entries(simple)) {
      if (key in updates) { fields.push(`${col} = ?`); params.push((updates as any)[key] ?? null); }
    }

    if (updates.affectedAssetIds) { fields.push(`affected_asset_ids = ?`); params.push(JSON.stringify(updates.affectedAssetIds)); }
    if (updates.affectedServiceIds) { fields.push(`affected_service_ids = ?`); params.push(JSON.stringify(updates.affectedServiceIds)); }

    if (updates.status && updates.status !== existing.status) {
      fields.push(`status = ?`); params.push(updates.status);
      if (updates.status === 'in_progress' && !existing.startedAt) { fields.push(`started_at = ?`); params.push(now); }
      if (['completed', 'failed', 'rolled_back'].includes(updates.status) && !existing.completedAt) { fields.push(`completed_at = ?`); params.push(now); }
    }

    if (fields.length === 0) return existing;
    fields.push(`updated_at = ?`); params.push(now);
    params.push(id, userId);

    await this.db.execute(`UPDATE cmdb_change_requests SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return this.getChangeRequestById(userId, id);
  }

  // ── Dashboard ──────────────────────────────────────────────

  async getDashboard(userId: string): Promise<{
    openIncidents: number; criticalIncidents: number;
    pendingChanges: number; scheduledChanges: number;
    servicesHealthy: number; servicesDegraded: number; servicesDown: number;
  }> {
    const incRows = await this.db.query(
      `SELECT status, severity, COUNT(*) as cnt FROM cmdb_incidents WHERE user_id = ? AND status NOT IN ('closed', 'cancelled', 'resolved') GROUP BY status, severity`,
      [userId],
    );
    let openIncidents = 0, criticalIncidents = 0;
    for (const r of incRows) {
      openIncidents += r.cnt as number;
      if (r.severity === 'critical') criticalIncidents += r.cnt as number;
    }

    const crRows = await this.db.query(
      `SELECT status, COUNT(*) as cnt FROM cmdb_change_requests WHERE user_id = ? AND status IN ('draft', 'submitted', 'approved', 'in_progress') GROUP BY status`,
      [userId],
    );
    let pendingChanges = 0, scheduledChanges = 0;
    for (const r of crRows) {
      pendingChanges += r.cnt as number;
      if (r.status === 'approved') scheduledChanges += r.cnt as number;
    }

    const svcRows = await this.db.query(
      `SELECT health_status, COUNT(*) as cnt FROM cmdb_services WHERE user_id = ? GROUP BY health_status`,
      [userId],
    );
    let servicesHealthy = 0, servicesDegraded = 0, servicesDown = 0;
    for (const r of svcRows) {
      if (r.health_status === 'healthy') servicesHealthy = r.cnt as number;
      else if (r.health_status === 'degraded') servicesDegraded = r.cnt as number;
      else if (r.health_status === 'down') servicesDown = r.cnt as number;
    }

    return { openIncidents, criticalIncidents, pendingChanges, scheduledChanges, servicesHealthy, servicesDegraded, servicesDown };
  }
}
