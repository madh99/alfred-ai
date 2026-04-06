import type { SkillMetadata, SkillContext, SkillResult, IncidentSeverity, ServiceHealthStatus } from '@alfred/types';
import type { ItsmRepository } from '@alfred/storage';
import type { CmdbRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action =
  | 'create_incident' | 'update_incident' | 'list_incidents' | 'get_incident' | 'close_incident'
  | 'create_change_request' | 'approve_change' | 'start_change' | 'complete_change' | 'rollback_change' | 'list_changes'
  | 'add_service' | 'update_service' | 'health_check' | 'impact_analysis' | 'dashboard';

export class ItsmSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'itsm',
    category: 'infrastructure',
    description:
      'IT Service Management — Incident-, Change- und Service-Verwaltung. ' +
      '"create_incident" erstellt einen Incident (title, severity, affected_asset_ids, symptoms). ' +
      '"update_incident" aktualisiert (incident_id, status, root_cause, resolution, workaround). ' +
      '"list_incidents" zeigt Incidents (filter: status, severity). ' +
      '"get_incident" zeigt Incident-Details (incident_id). ' +
      '"close_incident" schließt mit Resolution (incident_id, resolution). ' +
      '"create_change_request" plant eine Änderung (title, type, risk_level, implementation_plan, rollback_plan). ' +
      '"approve_change" genehmigt (change_id). ' +
      '"start_change" markiert als in Arbeit (change_id). ' +
      '"complete_change" schließt ab (change_id, result). ' +
      '"rollback_change" Rollback (change_id, result). ' +
      '"list_changes" zeigt Change Requests (filter: status, type). ' +
      '"add_service" registriert einen Service (name, category, url, health_check_url, criticality, asset_ids, dependencies). ' +
      '"update_service" aktualisiert (service_id + Felder). ' +
      '"health_check" prüft Health aller Services. ' +
      '"impact_analysis" analysiert Auswirkungen bei Asset-Ausfall (asset_id). ' +
      '"dashboard" zeigt ITSM-Übersicht.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_incident', 'update_incident', 'list_incidents', 'get_incident', 'close_incident', 'create_change_request', 'approve_change', 'start_change', 'complete_change', 'rollback_change', 'list_changes', 'add_service', 'update_service', 'health_check', 'impact_analysis', 'dashboard'] },
        incident_id: { type: 'string' },
        change_id: { type: 'string' },
        service_id: { type: 'string' },
        asset_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        status: { type: 'string' },
        priority: { type: 'number' },
        affected_asset_ids: { type: 'array', items: { type: 'string' } },
        affected_service_ids: { type: 'array', items: { type: 'string' } },
        symptoms: { type: 'string' },
        root_cause: { type: 'string' },
        resolution: { type: 'string' },
        workaround: { type: 'string' },
        type: { type: 'string', enum: ['standard', 'normal', 'emergency'] },
        risk_level: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        implementation_plan: { type: 'string' },
        rollback_plan: { type: 'string' },
        test_plan: { type: 'string' },
        scheduled_at: { type: 'string' },
        result: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        url: { type: 'string' },
        health_check_url: { type: 'string' },
        criticality: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } },
        asset_ids: { type: 'array', items: { type: 'string' } },
        owner: { type: 'string' },
        documentation: { type: 'string' },
        sla_notes: { type: 'string' },
        maintenance_window: { type: 'string' },
        tags: { type: 'string' },
        environment: { type: 'string' },
      },
      required: ['action'],
    },
    timeoutMs: 60_000,
  };

  private readonly itsm: ItsmRepository;
  private readonly cmdb: CmdbRepository;

  constructor(itsmRepo: ItsmRepository, cmdbRepo: CmdbRepository) {
    super();
    this.itsm = itsmRepo;
    this.cmdb = cmdbRepo;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId || context.userId;

    try {
      switch (action) {
        case 'create_incident': return await this.createIncident(userId, input);
        case 'update_incident': return await this.updateIncident(userId, input);
        case 'list_incidents': return await this.listIncidents(userId, input);
        case 'get_incident': return await this.getIncident(userId, input.incident_id as string);
        case 'close_incident': return await this.closeIncident(userId, input);
        case 'create_change_request': return await this.createChangeRequest(userId, input);
        case 'approve_change': return await this.approveChange(userId, input.change_id as string);
        case 'start_change': return await this.startChange(userId, input.change_id as string);
        case 'complete_change': return await this.completeChange(userId, input);
        case 'rollback_change': return await this.rollbackChange(userId, input);
        case 'list_changes': return await this.listChanges(userId, input);
        case 'add_service': return await this.addService(userId, input);
        case 'update_service': return await this.updateService(userId, input);
        case 'health_check': return await this.healthCheck(userId);
        case 'impact_analysis': return await this.impactAnalysis(userId, input.asset_id as string);
        case 'dashboard': return await this.dashboard(userId);
        default: return { success: false, error: `Unbekannte Aktion: ${String(action)}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  // ── Incidents ──────────────────────────────────────────────

  private async createIncident(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    if (!title) return { success: false, error: 'title erforderlich' };

    // Dedup: check if a similar incident is already open
    const keywords = title.split(/\s+/).filter(w => w.length >= 4).map(w => w.toLowerCase());
    const sourceLabel = title.split(':')[0]?.trim() || '';
    const existing = await this.itsm.findOpenIncidentForAsset(userId, sourceLabel, keywords);
    if (existing) {
      // Append new symptoms if provided
      if (input.symptoms) {
        await this.itsm.appendSymptoms(userId, existing.id, input.symptoms as string);
      }
      const sevIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[existing.severity] ?? '⚪';
      return { success: true, data: existing, display: `${sevIcon} Incident bereits offen: **${existing.title}** (${existing.status}) — ID: ${existing.id}` };
    }

    // Check for related incident from same source within 4h
    const recentSameSource = sourceLabel ? await this.itsm.findRecentIncidentForSource(userId, sourceLabel) : null;

    const inc = await this.itsm.createIncident(userId, {
      title,
      description: input.description as string,
      severity: input.severity as IncidentSeverity,
      priority: input.priority as number,
      affectedAssetIds: input.affected_asset_ids as string[],
      affectedServiceIds: input.affected_service_ids as string[],
      symptoms: input.symptoms as string,
      detectedBy: input.detected_by as string ?? 'user_report',
      relatedIncidentId: (input.related_incident_id as string) ?? recentSameSource?.id,
    });

    const sevIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[inc.severity] ?? '⚪';
    const related = inc.relatedIncidentId ? ` (verwandt mit ${inc.relatedIncidentId.slice(0, 8)})` : '';
    return { success: true, data: inc, display: `${sevIcon} Incident erstellt: **${inc.title}** (${inc.severity})${related} — ID: ${inc.id}` };
  }

  private async updateIncident(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.incident_id as string;
    if (!id) return { success: false, error: 'incident_id erforderlich' };

    const updates: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'severity', 'status', 'priority', 'symptoms', 'root_cause', 'resolution', 'workaround']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.affected_asset_ids) updates.affectedAssetIds = input.affected_asset_ids;
    if (input.affected_service_ids) updates.affectedServiceIds = input.affected_service_ids;

    const result = await this.itsm.updateIncident(userId, id, updates as any);
    if (!result) return { success: false, error: `Incident ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Incident ${result.title} aktualisiert (Status: ${result.status})` };
  }

  private async listIncidents(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const incidents = await this.itsm.listIncidents(userId, {
      status: input.status as any,
      severity: input.severity as any,
    });

    if (incidents.length === 0) return { success: true, data: [], display: 'Keine Incidents gefunden.' };

    const sevIcon = (s: string) => ({ critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[s] ?? '⚪');
    const lines = incidents.map(i =>
      `| ${sevIcon(i.severity)} ${i.severity} | ${i.title} | ${i.status} | ${i.openedAt?.slice(0, 10)} | ${i.affectedAssetIds.length} Assets |`,
    );

    const display = `## Incidents (${incidents.length})\n\n| Sev | Titel | Status | Datum | Betroffene |\n|-----|-------|--------|-------|------------|\n${lines.join('\n')}`;
    return { success: true, data: incidents, display };
  }

  private async getIncident(userId: string, id: string): Promise<SkillResult> {
    if (!id) return { success: false, error: 'incident_id erforderlich' };
    const inc = await this.itsm.getIncidentById(userId, id);
    if (!inc) return { success: false, error: `Incident ${id} nicht gefunden` };

    // Resolve asset names
    const assetNames: string[] = [];
    for (const aid of inc.affectedAssetIds) {
      const a = await this.cmdb.getAssetById(userId, aid);
      assetNames.push(a ? `${a.name} (${a.assetType})` : aid);
    }

    const display = [
      `## ${inc.title}`,
      `**Severity:** ${inc.severity} | **Status:** ${inc.status} | **Priority:** ${inc.priority}`,
      `**Detected by:** ${inc.detectedBy ?? '—'} | **Opened:** ${inc.openedAt?.slice(0, 16)}`,
      inc.acknowledgedAt ? `**Acknowledged:** ${inc.acknowledgedAt.slice(0, 16)}` : '',
      inc.resolvedAt ? `**Resolved:** ${inc.resolvedAt.slice(0, 16)}` : '',
      inc.closedAt ? `**Closed:** ${inc.closedAt.slice(0, 16)}` : '',
      '',
      assetNames.length > 0 ? `### Betroffene Assets\n${assetNames.map(n => `- ${n}`).join('\n')}` : '',
      inc.symptoms ? `### Symptome\n${inc.symptoms}` : '',
      inc.rootCause ? `### Root Cause\n${inc.rootCause}` : '',
      inc.resolution ? `### Resolution\n${inc.resolution}` : '',
      inc.workaround ? `### Workaround\n${inc.workaround}` : '',
      inc.relatedIncidentId ? `### Verwandter Incident\nID: ${inc.relatedIncidentId}` : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: inc, display };
  }

  private async closeIncident(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.incident_id as string;
    if (!id) return { success: false, error: 'incident_id erforderlich' };
    const resolution = input.resolution as string ?? '';

    const result = await this.itsm.closeIncident(userId, id, resolution);
    if (!result) return { success: false, error: `Incident ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Incident **${result.title}** geschlossen` };
  }

  // ── Change Requests ────────────────────────────────────────

  private async createChangeRequest(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    if (!title) return { success: false, error: 'title erforderlich' };

    const cr = await this.itsm.createChangeRequest(userId, {
      title,
      description: input.description as string,
      type: input.type as any,
      riskLevel: input.risk_level as any,
      affectedAssetIds: input.affected_asset_ids as string[],
      affectedServiceIds: input.affected_service_ids as string[],
      implementationPlan: input.implementation_plan as string,
      rollbackPlan: input.rollback_plan as string,
      testPlan: input.test_plan as string,
      scheduledAt: input.scheduled_at as string,
      linkedIncidentId: input.linked_incident_id as string,
    });

    return { success: true, data: cr, display: `📋 Change Request erstellt: **${cr.title}** (${cr.type}, ${cr.riskLevel}) — ID: ${cr.id}` };
  }

  private async approveChange(userId: string, changeId: string): Promise<SkillResult> {
    if (!changeId) return { success: false, error: 'change_id erforderlich' };
    const result = await this.itsm.updateChangeRequest(userId, changeId, { status: 'approved' });
    if (!result) return { success: false, error: `Change ${changeId} nicht gefunden` };
    return { success: true, data: result, display: `✅ Change **${result.title}** genehmigt` };
  }

  private async startChange(userId: string, changeId: string): Promise<SkillResult> {
    if (!changeId) return { success: false, error: 'change_id erforderlich' };
    const result = await this.itsm.updateChangeRequest(userId, changeId, { status: 'in_progress' });
    if (!result) return { success: false, error: `Change ${changeId} nicht gefunden` };
    return { success: true, data: result, display: `🔧 Change **${result.title}** gestartet` };
  }

  private async completeChange(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.change_id as string;
    if (!id) return { success: false, error: 'change_id erforderlich' };
    const result = await this.itsm.updateChangeRequest(userId, id, { status: 'completed', result: input.result as string });
    if (!result) return { success: false, error: `Change ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Change **${result.title}** abgeschlossen` };
  }

  private async rollbackChange(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.change_id as string;
    if (!id) return { success: false, error: 'change_id erforderlich' };
    const result = await this.itsm.updateChangeRequest(userId, id, { status: 'rolled_back', result: input.result as string });
    if (!result) return { success: false, error: `Change ${id} nicht gefunden` };
    return { success: true, data: result, display: `⏪ Change **${result.title}** zurückgerollt` };
  }

  private async listChanges(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const changes = await this.itsm.listChangeRequests(userId, {
      status: input.status as any,
      type: input.type as any,
    });

    if (changes.length === 0) return { success: true, data: [], display: 'Keine Change Requests gefunden.' };

    const lines = changes.map(c => {
      const statusIcon = { draft: '📝', submitted: '📤', approved: '✅', in_progress: '🔧', completed: '✅', failed: '❌', rolled_back: '⏪', cancelled: '🚫' }[c.status] ?? '📋';
      return `| ${statusIcon} | ${c.title} | ${c.type} | ${c.riskLevel} | ${c.status} | ${c.scheduledAt?.slice(0, 10) ?? '—'} |`;
    });

    const display = `## Change Requests (${changes.length})\n\n| | Titel | Typ | Risiko | Status | Geplant |\n|--|-------|-----|--------|--------|--------|\n${lines.join('\n')}`;
    return { success: true, data: changes, display };
  }

  // ── Services ───────────────────────────────────────────────

  private async addService(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.name as string;
    if (!name) return { success: false, error: 'name erforderlich' };

    const svc = await this.itsm.createService(userId, {
      name,
      description: input.description as string,
      category: input.category as any,
      environment: input.environment as any,
      url: input.url as string,
      healthCheckUrl: input.health_check_url as string,
      criticality: input.criticality as any,
      dependencies: input.dependencies as string[],
      assetIds: input.asset_ids as string[],
      owner: input.owner as string,
      documentation: input.documentation as string,
      slaNotes: input.sla_notes as string,
      maintenanceWindow: input.maintenance_window as string,
      tags: input.tags as string,
    });

    return { success: true, data: svc, display: `📦 Service registriert: **${svc.name}** (${svc.category ?? '—'}) — ID: ${svc.id}` };
  }

  private async updateService(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.service_id as string;
    if (!id) return { success: false, error: 'service_id erforderlich' };

    const updates: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'category', 'environment', 'url', 'criticality', 'owner', 'documentation', 'sla_notes', 'maintenance_window', 'tags']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.health_check_url !== undefined) updates.healthCheckUrl = input.health_check_url;
    if (input.dependencies) updates.dependencies = input.dependencies;
    if (input.asset_ids) updates.assetIds = input.asset_ids;

    const result = await this.itsm.updateService(userId, id, updates as any);
    if (!result) return { success: false, error: `Service ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Service **${result.name}** aktualisiert` };
  }

  private async healthCheck(userId: string): Promise<SkillResult> {
    const services = await this.itsm.listServices(userId);
    const results: { name: string; url: string; status: ServiceHealthStatus; latencyMs?: number; error?: string }[] = [];

    for (const svc of services) {
      if (!svc.healthCheckUrl) {
        results.push({ name: svc.name, url: '—', status: svc.healthStatus });
        continue;
      }

      const start = Date.now();
      try {
        const res = await fetch(svc.healthCheckUrl, { signal: AbortSignal.timeout(10_000) });
        const latencyMs = Date.now() - start;
        const status: ServiceHealthStatus = res.ok ? 'healthy' : (res.status >= 500 ? 'down' : 'degraded');
        await this.itsm.updateServiceHealth(userId, svc.id, status);
        results.push({ name: svc.name, url: svc.healthCheckUrl, status, latencyMs });
      } catch (err: any) {
        await this.itsm.updateServiceHealth(userId, svc.id, 'down');
        results.push({ name: svc.name, url: svc.healthCheckUrl, status: 'down', error: err.message?.slice(0, 80) });
      }
    }

    const icon = (s: ServiceHealthStatus) => ({ healthy: '🟢', degraded: '🟡', down: '🔴', unknown: '⚫' }[s]);
    const lines = results.map(r =>
      `| ${icon(r.status)} ${r.status} | ${r.name} | ${r.latencyMs ? `${r.latencyMs}ms` : '—'} | ${r.error ?? '—'} |`,
    );

    const display = `## Health Check\n\n| Status | Service | Latenz | Fehler |\n|--------|---------|--------|--------|\n${lines.join('\n')}`;
    return { success: true, data: results, display };
  }

  private async impactAnalysis(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };

    const asset = await this.cmdb.getAssetById(userId, assetId);
    if (!asset) return { success: false, error: `Asset ${assetId} nicht gefunden` };

    // Find all dependent assets (transitive)
    const topo = await this.cmdb.getTopology(userId, assetId, 5);

    // Find affected services
    const services = await this.itsm.listServices(userId);
    const affectedServices = services.filter(s =>
      s.assetIds.some(aid => topo.assets.some(a => a.id === aid)),
    );

    // Sort by criticality
    const critOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    affectedServices.sort((a, b) => (critOrder[a.criticality ?? 'medium'] ?? 2) - (critOrder[b.criticality ?? 'medium'] ?? 2));

    const assetLines = topo.assets
      .filter(a => a.id !== assetId)
      .map(a => `- ${a.name} (${a.assetType}) [${a.status}]`);

    const svcLines = affectedServices.map(s => {
      const critIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[s.criticality ?? 'medium'] ?? '⚪';
      return `- ${critIcon} **${s.name}** (${s.criticality ?? 'medium'}) — ${s.healthStatus}`;
    });

    const display = [
      `## Impact Analysis: ${asset.name} (${asset.assetType})`,
      '',
      `### Direkt/indirekt betroffene Assets (${assetLines.length})`,
      assetLines.length > 0 ? assetLines.join('\n') : '— keine —',
      '',
      `### Betroffene Services (${affectedServices.length})`,
      svcLines.length > 0 ? svcLines.join('\n') : '— keine —',
      '',
      affectedServices.some(s => s.criticality === 'critical')
        ? '⚠️ **CRITICAL Services betroffen!**'
        : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: { asset, affectedAssets: topo.assets, affectedServices }, display };
  }

  private async dashboard(userId: string): Promise<SkillResult> {
    const db = await this.itsm.getDashboard(userId);
    const stats = await this.cmdb.getStats(userId);

    const display = [
      `## ITSM Dashboard`,
      '',
      '### Infrastruktur',
      `${stats.total} Assets gesamt`,
      Object.entries(stats.byStatus).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
      '',
      '### Incidents',
      `${db.openIncidents} offen${db.criticalIncidents > 0 ? ` (🔴 ${db.criticalIncidents} critical)` : ''}`,
      '',
      '### Change Requests',
      `${db.pendingChanges} ausstehend${db.scheduledChanges > 0 ? `, ${db.scheduledChanges} genehmigt/geplant` : ''}`,
      '',
      '### Services',
      `🟢 ${db.servicesHealthy} healthy | 🟡 ${db.servicesDegraded} degraded | 🔴 ${db.servicesDown} down`,
    ].join('\n');

    return { success: true, data: db, display };
  }
}
