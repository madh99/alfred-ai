import type { SkillMetadata, SkillContext, SkillResult, IncidentSeverity, ServiceHealthStatus } from '@alfred/types';
import type { ItsmRepository, ProblemRepository } from '@alfred/storage';
import type { CmdbRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type LlmCallback = (prompt: string, tier?: string) => Promise<string>;

type Action =
  | 'create_incident' | 'update_incident' | 'list_incidents' | 'get_incident' | 'close_incident'
  | 'create_change_request' | 'update_change' | 'get_change' | 'approve_change' | 'start_change' | 'complete_change' | 'rollback_change' | 'list_changes'
  | 'create_problem' | 'update_problem' | 'get_problem' | 'list_problems' | 'link_incident_to_problem' | 'unlink_incident_from_problem' | 'promote_to_problem' | 'create_fix_change' | 'mark_known_error' | 'detect_problem_patterns' | 'problem_dashboard'
  | 'add_service' | 'update_service' | 'add_component' | 'remove_component' | 'health_check' | 'impact_analysis' | 'dashboard'
  | 'create_service_from_description' | 'add_failure_mode' | 'remove_failure_mode' | 'update_failure_mode' | 'service_impact_analysis' | 'generate_service_docs'
  | 'set_sla' | 'get_sla_report' | 'check_sla_compliance' | 'list_sla_breaches';

export class ItsmSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'itsm',
    category: 'infrastructure',
    description:
      'IT Service Management — Incident-, Change- und Service-Verwaltung. ' +
      '"create_incident" erstellt einen Incident (title, severity, affected_asset_ids, symptoms). ' +
      '"update_incident" aktualisiert (incident_id, status, root_cause, resolution, workaround, investigation_notes, postmortem). ' +
      '"list_incidents" zeigt Incidents (filter: status, severity). ' +
      '"get_incident" zeigt Incident-Details (incident_id). ' +
      '"close_incident" schließt mit Resolution (incident_id, resolution). ' +
      '"create_change_request" plant eine Änderung (title, type, risk_level, implementation_plan, rollback_plan). ' +
      '"update_change" aktualisiert (change_id, description, implementation_plan, rollback_plan, test_plan, risk_level, result). ' +
      '"get_change" zeigt Change-Details (change_id). ' +
      '"approve_change" genehmigt (change_id). ' +
      '"start_change" markiert als in Arbeit (change_id). ' +
      '"complete_change" schließt ab (change_id, result). ' +
      '"rollback_change" Rollback (change_id, result). ' +
      '"list_changes" zeigt Change Requests (filter: status, type). ' +
      '"create_problem" erstellt Problem (title, priority, category, linked_incident_ids, workaround). ' +
      '"update_problem" aktualisiert (problem_id, root_cause_description, workaround, proposed_fix, analysis_notes, is_known_error). ' +
      '"get_problem" zeigt Problem-Details (problem_id). ' +
      '"list_problems" listet Probleme (filter: status, priority, is_known_error). ' +
      '"link_incident_to_problem" verknüpft Incident→Problem (problem_id, incident_id). ' +
      '"promote_to_problem" erstellt Problem aus Incident(s) (incident_id, linked_incident_ids). ' +
      '"create_fix_change" erstellt Change Request als Fix (problem_id, title, implementation_plan). ' +
      '"mark_known_error" setzt Known-Error-Flag (problem_id, known_error_description). ' +
      '"detect_problem_patterns" erkennt Incident-Muster (pattern_window_days, min_incidents). ' +
      '"problem_dashboard" zeigt Problem-Übersicht. ' +
      '"add_service" registriert einen Service (name, category, url, health_check_url, criticality, asset_ids, dependencies). ' +
      '"update_service" aktualisiert (service_id + Felder). ' +
      '"add_component" fügt eine Komponente zu einem Service hinzu (service_id, component_name, component_role, component_asset_id oder component_external_url, component_required). ' +
      '"remove_component" entfernt eine Komponente (service_id, component_name). ' +
      '"health_check" prüft Health aller Services (3-Layer: URL + Asset-Status + Dependencies). ' +
      '"impact_analysis" analysiert Auswirkungen bei Asset-Ausfall (asset_id). ' +
      '"dashboard" zeigt ITSM-Übersicht. ' +
      '"create_service_from_description" erstellt Service aus Freitext-Beschreibung per LLM (description). ' +
      '"add_failure_mode" fuegt Failure-Mode zu Service hinzu (service_id, failure_mode_name, failure_trigger, affected_components, failure_impact, cascade_effects, recovery_minutes). ' +
      '"remove_failure_mode" entfernt Failure-Mode (service_id, failure_mode_name). ' +
      '"update_failure_mode" aktualisiert Failure-Mode (service_id, failure_mode_name + partielle Updates). ' +
      '"service_impact_analysis" zeigt alle Services die ein Asset nutzen inkl. Failure-Modes (asset_id oder name). ' +
      '"generate_service_docs" generiert Service-Doku + SOP per Failure-Mode im Hintergrund (service_id). ' +
      '"set_sla" setzt SLA auf Service oder Asset (sla_target_type, sla_target_id, sla_name, sla_availability, sla_mttr_minutes, sla_response_minutes, sla_resolution_minutes, sla_breach_alert). ' +
      '"get_sla_report" zeigt SLA-Verfügbarkeits-Report (sla_target_type, sla_target_id, sla_period). ' +
      '"check_sla_compliance" prüft alle aktiven SLAs auf Einhaltung. ' +
      '"list_sla_breaches" listet SLA-Verletzungen (sla_period).',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_incident', 'update_incident', 'list_incidents', 'get_incident', 'close_incident', 'create_change_request', 'update_change', 'get_change', 'approve_change', 'start_change', 'complete_change', 'rollback_change', 'list_changes', 'create_problem', 'update_problem', 'get_problem', 'list_problems', 'link_incident_to_problem', 'unlink_incident_from_problem', 'promote_to_problem', 'create_fix_change', 'mark_known_error', 'detect_problem_patterns', 'problem_dashboard', 'add_service', 'update_service', 'add_component', 'remove_component', 'health_check', 'impact_analysis', 'dashboard', 'create_service_from_description', 'add_failure_mode', 'remove_failure_mode', 'update_failure_mode', 'service_impact_analysis', 'generate_service_docs', 'set_sla', 'get_sla_report', 'check_sla_compliance', 'list_sla_breaches'] },
        incident_id: { type: 'string' },
        change_id: { type: 'string' },
        problem_id: { type: 'string' },
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
        investigation_notes: { type: 'string', description: 'Chronologische Untersuchungsnotizen (wird angehängt, nicht ersetzt)' },
        lessons_learned: { type: 'string', description: 'Erkenntnisse / Lessons Learned' },
        action_items: { type: 'string', description: 'TODOs / Action Items (Markdown-Checkliste)' },
        postmortem: { type: 'string' },
        related_incident_id: { type: 'string' },
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
        component_name: { type: 'string', description: 'Name der Komponente (z.B. PostgreSQL, Redis)' },
        component_role: { type: 'string', enum: ['database', 'cache', 'storage', 'compute', 'api', 'proxy', 'messaging', 'monitoring', 'dns', 'other'] },
        component_asset_id: { type: 'string', description: 'CMDB Asset-ID der Komponente' },
        component_service_id: { type: 'string', description: 'Service-ID einer Service-Dependency' },
        component_external_url: { type: 'string', description: 'Externe URL (z.B. https://api.telegram.org)' },
        component_required: { type: 'boolean', description: 'true = Service down wenn Komponente down, false = degraded' },
        // Failure Mode Management
        failure_mode_name: { type: 'string', description: 'Name des Failure-Modes' },
        failure_trigger: { type: 'string', description: 'Ausloeser des Failure-Modes' },
        failure_impact: { type: 'string', enum: ['down', 'degraded'], description: 'Service-Impact bei Ausfall' },
        affected_components: { type: 'array', items: { type: 'string' }, description: 'Betroffene Komponenten-Namen' },
        cascade_effects: { type: 'array', items: { type: 'string' }, description: 'Kaskadierende Effekte' },
        recovery_minutes: { type: 'number', description: 'Geschaetzte Recovery-Zeit in Minuten' },
        // SLA Management
        sla_target_type: { type: 'string', enum: ['service', 'asset'], description: 'SLA auf Service oder Asset' },
        sla_target_id: { type: 'string', description: 'ID des Service/Asset' },
        sla_name: { type: 'string', description: 'Name des SLA (z.B. "Gold SLA")' },
        sla_availability: { type: 'number', description: 'Verfügbarkeits-Ziel in Prozent (z.B. 99.9)' },
        sla_mttr_minutes: { type: 'number', description: 'Max. Mean Time To Repair in Minuten' },
        sla_response_minutes: { type: 'number', description: 'Max. Response-Zeit in Minuten' },
        sla_resolution_minutes: { type: 'number', description: 'Max. Resolution-Zeit in Minuten' },
        sla_breach_alert: { type: 'boolean', description: 'Alarm bei SLA-Verletzung (default: true)' },
        sla_warning_threshold: { type: 'number', description: 'Warnschwelle in Prozent (z.B. 99.5 bei 99.9% Ziel)' },
        sla_period: { type: 'string', description: 'Berichtszeitraum (z.B. "2026-04", default: aktueller Monat)' },
        // Component Hierarchy
        component_parent: { type: 'string', description: 'Name der übergeordneten Komponente (Hierarchie: VM → Container)' },
        component_failure_impact: { type: 'string', enum: ['down', 'degraded', 'no_impact'], description: 'Service-Impact bei Komponentenausfall' },
        // Problem Management
        root_cause_description: { type: 'string' },
        root_cause_category: { type: 'string', enum: ['infrastructure', 'software', 'configuration', 'capacity', 'security', 'network', 'data', 'process', 'external', 'unknown'] },
        proposed_fix: { type: 'string' },
        analysis_notes: { type: 'string', description: 'Chronologische Analyse-Notizen (wird angehängt)' },
        is_known_error: { type: 'boolean' },
        known_error_description: { type: 'string' },
        linked_incident_ids: { type: 'array', items: { type: 'string' } },
        pattern_window_days: { type: 'number', description: 'Zeitfenster für Pattern-Erkennung (default: 7 Tage)' },
        min_incidents: { type: 'number', description: 'Mindestanzahl Incidents für Pattern (default: 3)' },
      },
      required: ['action'],
    },
    timeoutMs: 60_000,
  };

  private readonly itsm: ItsmRepository;
  private readonly cmdb: CmdbRepository;
  private readonly problem?: ProblemRepository;
  private llmCallback?: LlmCallback;

  constructor(itsmRepo: ItsmRepository, cmdbRepo: CmdbRepository, problemRepo?: ProblemRepository) {
    super();
    this.itsm = itsmRepo;
    this.cmdb = cmdbRepo;
    this.problem = problemRepo;
  }

  setLlmCallback(cb: LlmCallback): void {
    this.llmCallback = cb;
  }

  /**
   * Topologically sort components so parents are processed before children.
   * Returns indices in parent-first order.
   */
  private topoSortComponents(components: Array<{ name: string; parentComponent?: string }>): number[] {
    const nameToIdx = new Map(components.map((c, i) => [c.name, i]));
    const visited = new Set<number>();
    const order: number[] = [];

    const visit = (idx: number) => {
      if (visited.has(idx)) return;
      visited.add(idx);
      const parent = (components[idx] as any).parentComponent;
      if (parent) {
        const parentIdx = nameToIdx.get(parent);
        if (parentIdx !== undefined) visit(parentIdx);
      }
      order.push(idx);
    };

    for (let i = 0; i < components.length; i++) visit(i);
    return order;
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
        case 'update_change': return await this.updateChange(userId, input);
        case 'get_change': return await this.getChange(userId, input.change_id as string);
        case 'approve_change': return await this.approveChange(userId, input.change_id as string);
        case 'start_change': return await this.startChange(userId, input.change_id as string);
        case 'complete_change': return await this.completeChange(userId, input);
        case 'rollback_change': return await this.rollbackChange(userId, input);
        case 'list_changes': return await this.listChanges(userId, input);
        // Problem Management
        case 'create_problem': return await this.createProblem(userId, input);
        case 'update_problem': return await this.updateProblemAction(userId, input);
        case 'get_problem': return await this.getProblem(userId, input.problem_id as string);
        case 'list_problems': return await this.listProblemsAction(userId, input);
        case 'link_incident_to_problem': return await this.linkIncidentToProblem(userId, input);
        case 'unlink_incident_from_problem': return await this.unlinkIncidentFromProblem(userId, input);
        case 'promote_to_problem': return await this.promoteToProblem(userId, input);
        case 'create_fix_change': return await this.createFixChange(userId, input);
        case 'mark_known_error': return await this.markKnownError(userId, input);
        case 'detect_problem_patterns': return await this.detectProblemPatterns(userId, input);
        case 'problem_dashboard': return await this.problemDashboardAction(userId);
        case 'add_service': return await this.addService(userId, input);
        case 'update_service': return await this.updateService(userId, input);
        case 'add_component': return await this.addComponent(userId, input);
        case 'remove_component': return await this.removeComponent(userId, input);
        case 'health_check': return await this.healthCheck(userId);
        case 'impact_analysis': return await this.impactAnalysis(userId, input.asset_id as string);
        case 'dashboard': return await this.dashboard(userId);
        case 'create_service_from_description': return await this.createServiceFromDescription(userId, input);
        case 'add_failure_mode': return await this.addFailureMode(userId, input);
        case 'remove_failure_mode': return await this.removeFailureMode(userId, input);
        case 'update_failure_mode': return await this.updateFailureMode(userId, input);
        case 'service_impact_analysis': return await this.serviceImpactAnalysis(userId, input);
        case 'generate_service_docs': return await this.generateServiceDocs(userId, input);
        case 'set_sla': return await this.setSla(userId, input);
        case 'get_sla_report': return await this.getSlaReport(userId, input);
        case 'check_sla_compliance': return await this.checkSlaCompliance(userId);
        case 'list_sla_breaches': return await this.listSlaBreaches(userId, input);
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
    // Use content after ':' for keywords (strip generic prefix like "Monitor:", "homeassistant:")
    const afterColon = title.includes(':') ? title.split(':').slice(1).join(':').trim() : title;
    const GENERIC_KEYWORDS = new Set(['device', 'state', 'status', 'check', 'alert', 'monitor', 'connected', 'failed', 'error', 'down', 'unavailable']);
    const keywords = afterColon.split(/\s+/).filter(w => w.length >= 4 && !GENERIC_KEYWORDS.has(w.toLowerCase())).map(w => w.toLowerCase());
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
    const result: SkillResult = { success: true, data: inc, display: `${sevIcon} Incident erstellt: **${inc.title}** (${inc.severity})${related} — ID: ${inc.id}` };

    // Auto-suggest matching runbooks
    try {
      if (this.cmdb) {
        const searchTerms = `${input.title ?? ''} ${input.symptoms ?? ''}`;
        const runbooks = await this.cmdb.searchDocuments(userId, searchTerms, { docType: 'runbook', limit: 3 });
        if (runbooks.length > 0) {
          const suggestions = runbooks.map(r => `  📋 ${r.title} (v${r.version})`).join('\n');
          if (result.display) result.display += `\n\n**Passende Runbooks:**\n${suggestions}`;
        }
      }
    } catch { /* non-critical */ }

    // Service impact detection
    try {
      const affectedIds = input.affected_asset_ids as string[] ?? [];
      if (affectedIds.length > 0) {
        const impactedServices: { name: string; impact: string; criticality: string }[] = [];
        for (const aid of affectedIds) {
          const svcs = await this.itsm.getServicesForAsset(userId, aid);
          for (const svc of svcs) {
            const comp = svc.components.find(c => c.assetId === aid);
            const impact = comp?.required !== false ? 'down' : 'degraded';
            if (!impactedServices.some(s => s.name === svc.name)) {
              impactedServices.push({ name: svc.name, impact, criticality: svc.criticality ?? 'medium' });
            }
          }
        }
        if (impactedServices.length > 0) {
          const critIcon = (c: string) => ({ critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[c] ?? '⚪');
          const svcLines = impactedServices.map(s => `  ${critIcon(s.criticality)} **${s.name}** → ${s.impact}`).join('\n');
          if (result.display) result.display += `\n\n**Betroffene Services (${impactedServices.length}):**\n${svcLines}`;
        }
      }
    } catch { /* non-critical */ }

    return result;
  }

  private async updateIncident(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.incident_id as string;
    if (!id) return { success: false, error: 'incident_id erforderlich' };

    const updates: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'severity', 'status', 'priority', 'symptoms', 'investigation_notes', 'root_cause', 'resolution', 'workaround', 'lessons_learned', 'action_items', 'postmortem', 'related_incident_id']) {
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
      `| ${i.id.slice(0, 8)} | ${sevIcon(i.severity)} ${i.severity} | ${i.title.slice(0, 60)} | ${i.status} | ${i.openedAt?.slice(0, 10)} |`,
    );

    const display = `## Incidents (${incidents.length})\nNutze die ID für update_incident, get_incident, close_incident.\n\n| ID | Sev | Titel | Status | Datum |\n|----|-----|-------|--------|-------|\n${lines.join('\n')}`;
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
      inc.investigationNotes ? `### Untersuchungsnotizen\n${inc.investigationNotes}` : '',
      inc.rootCause ? `### Root Cause\n${inc.rootCause}` : '',
      inc.resolution ? `### Resolution\n${inc.resolution}` : '',
      inc.workaround ? `### Workaround\n${inc.workaround}` : '',
      inc.lessonsLearned ? `### Lessons Learned\n${inc.lessonsLearned}` : '',
      inc.actionItems ? `### Action Items\n${inc.actionItems}` : '',
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

  private async updateChange(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.change_id as string;
    if (!id) return { success: false, error: 'change_id erforderlich' };

    const updates: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'type', 'risk_level', 'status', 'implementation_plan', 'rollback_plan', 'test_plan', 'result', 'scheduled_at']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.affected_asset_ids) updates.affectedAssetIds = input.affected_asset_ids;
    if (input.affected_service_ids) updates.affectedServiceIds = input.affected_service_ids;

    const result = await this.itsm.updateChangeRequest(userId, id, updates as any);
    if (!result) return { success: false, error: `Change ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Change **${result.title}** aktualisiert (Status: ${result.status})` };
  }

  private async getChange(userId: string, changeId: string): Promise<SkillResult> {
    if (!changeId) return { success: false, error: 'change_id erforderlich' };
    const changes = await this.itsm.listChangeRequests(userId, {});
    const cr = changes.find(c => c.id === changeId || c.id.startsWith(changeId));
    if (!cr) return { success: false, error: `Change ${changeId} nicht gefunden` };

    const display = [
      `## ${cr.title}`,
      `**Typ:** ${cr.type} | **Risiko:** ${cr.riskLevel} | **Status:** ${cr.status}`,
      cr.scheduledAt ? `**Geplant:** ${cr.scheduledAt.slice(0, 16)}` : '',
      cr.startedAt ? `**Gestartet:** ${cr.startedAt.slice(0, 16)}` : '',
      cr.completedAt ? `**Abgeschlossen:** ${cr.completedAt.slice(0, 16)}` : '',
      '',
      cr.description ? `### Beschreibung\n${cr.description}` : '',
      cr.implementationPlan ? `### Implementation Plan\n${cr.implementationPlan}` : '',
      cr.rollbackPlan ? `### Rollback Plan\n${cr.rollbackPlan}` : '',
      cr.testPlan ? `### Test Plan\n${cr.testPlan}` : '',
      cr.result ? `### Ergebnis\n${cr.result}` : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: cr, display };
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

  // ── Problem Management ─────────────────────────────────────

  private async createProblem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const title = input.title as string;
    if (!title) return { success: false, error: 'title erforderlich' };

    const prob = await this.problem.createProblem(userId, {
      title, description: input.description as string,
      priority: input.priority as any, category: input.category as any,
      linkedIncidentIds: input.linked_incident_ids as string[],
      affectedAssetIds: input.affected_asset_ids as string[],
      affectedServiceIds: input.affected_service_ids as string[],
      workaround: input.workaround as string,
      detectedBy: input.detected_by as any ?? 'manual',
    });

    // Link incidents bidirectionally
    for (const incId of (input.linked_incident_ids as string[] ?? [])) {
      await this.problem.linkIncident(userId, prob.id, incId);
    }

    const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[prob.priority] ?? '📋';
    return { success: true, data: prob, display: `${icon} Problem erstellt: **${prob.title}** (${prob.priority}) — ID: ${prob.id}` };
  }

  private async updateProblemAction(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const id = input.problem_id as string;
    if (!id) return { success: false, error: 'problem_id erforderlich' };

    // Handle analysis_notes as append-only
    if (input.analysis_notes) {
      await this.problem.appendAnalysisNotes(userId, id, input.analysis_notes as string);
    }

    const updates: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'status', 'priority', 'category', 'root_cause_description', 'root_cause_category', 'workaround', 'proposed_fix', 'is_known_error', 'known_error_description']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.affected_asset_ids) updates.affectedAssetIds = input.affected_asset_ids;
    if (input.affected_service_ids) updates.affectedServiceIds = input.affected_service_ids;

    const result = await this.problem.updateProblem(userId, id, updates as any);
    if (!result) return { success: false, error: `Problem ${id} nicht gefunden` };
    return { success: true, data: result, display: `✅ Problem **${result.title}** aktualisiert (${result.status})` };
  }

  private async getProblem(userId: string, problemId: string): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    if (!problemId) return { success: false, error: 'problem_id erforderlich' };
    const prob = await this.problem.getProblemById(userId, problemId);
    if (!prob) return { success: false, error: `Problem ${problemId} nicht gefunden` };

    const display = [
      `## ${prob.title}`,
      `**Priority:** ${prob.priority} | **Status:** ${prob.status} | **Category:** ${prob.category ?? '—'}`,
      prob.isKnownError ? `**⚠️ KNOWN ERROR**${prob.knownErrorDescription ? `: ${prob.knownErrorDescription}` : ''}` : '',
      `**Detected:** ${prob.detectedAt?.slice(0, 16)} by ${prob.detectedBy}`,
      prob.analyzedAt ? `**Analyzed:** ${prob.analyzedAt.slice(0, 16)}` : '',
      prob.rootCauseIdentifiedAt ? `**Root Cause identified:** ${prob.rootCauseIdentifiedAt.slice(0, 16)}` : '',
      prob.resolvedAt ? `**Resolved:** ${prob.resolvedAt.slice(0, 16)}` : '',
      '',
      prob.description ? `### Beschreibung\n${prob.description}` : '',
      prob.rootCauseDescription ? `### Root Cause\n${prob.rootCauseDescription}` : '',
      prob.workaround ? `### Workaround\n${prob.workaround}` : '',
      prob.proposedFix ? `### Proposed Fix\n${prob.proposedFix}` : '',
      prob.analysisNotes ? `### Analyse-Notizen\n${prob.analysisNotes}` : '',
      prob.linkedIncidentIds.length > 0 ? `### Verknüpfte Incidents (${prob.linkedIncidentIds.length})\n${prob.linkedIncidentIds.map(id => `- ${id.slice(0, 8)}`).join('\n')}` : '',
      prob.linkedChangeRequestId ? `### Fix-Change: ${prob.linkedChangeRequestId.slice(0, 8)}` : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: prob, display };
  }

  private async listProblemsAction(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const problems = await this.problem.listProblems(userId, {
      status: input.status as any, priority: input.priority as any,
      isKnownError: input.is_known_error as boolean | undefined,
    });
    if (problems.length === 0) return { success: true, data: [], display: 'Keine Probleme gefunden.' };

    const icon = (p: string) => ({ critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[p] ?? '📋');
    const lines = problems.map(p =>
      `| ${icon(p.priority)} ${p.priority} | ${p.title} | ${p.status} | ${p.isKnownError ? 'KE' : '—'} | ${p.linkedIncidentIds.length} | ${p.detectedAt?.slice(0, 10)} |`,
    );
    const display = `## Probleme (${problems.length})\n\n| Prio | Titel | Status | KE | Incidents | Erkannt |\n|------|-------|--------|----|-----------|---------|\n${lines.join('\n')}`;
    return { success: true, data: problems, display };
  }

  private async linkIncidentToProblem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const problemId = input.problem_id as string;
    const incidentId = input.incident_id as string;
    if (!problemId || !incidentId) return { success: false, error: 'problem_id + incident_id erforderlich' };
    const result = await this.problem.linkIncident(userId, problemId, incidentId);
    if (!result) return { success: false, error: `Problem ${problemId} nicht gefunden` };
    return { success: true, data: result, display: `🔗 Incident ${incidentId.slice(0, 8)} mit Problem **${result.title}** verknüpft (${result.linkedIncidentIds.length} Incidents)` };
  }

  private async unlinkIncidentFromProblem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const problemId = input.problem_id as string;
    const incidentId = input.incident_id as string;
    if (!problemId || !incidentId) return { success: false, error: 'problem_id + incident_id erforderlich' };
    const result = await this.problem.unlinkIncident(userId, problemId, incidentId);
    if (!result) return { success: false, error: `Problem ${problemId} nicht gefunden` };
    return { success: true, data: result, display: `🔓 Incident ${incidentId.slice(0, 8)} von Problem **${result.title}** getrennt` };
  }

  private async promoteToProblem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const sourceId = input.incident_id as string;
    const linkedIds = input.linked_incident_ids as string[] ?? [];
    if (!sourceId && linkedIds.length === 0) return { success: false, error: 'incident_id oder linked_incident_ids erforderlich' };

    // Read source incident for defaults
    const allIds = sourceId ? [sourceId, ...linkedIds] : linkedIds;
    const sourceInc = await this.itsm.getIncidentById(userId, allIds[0]);
    const title = input.title as string ?? sourceInc?.title ?? 'Problem';
    const sevMap: Record<string, string> = { critical: 'high', high: 'high', medium: 'medium', low: 'low' };
    const priority = input.priority as string ?? sevMap[sourceInc?.severity ?? 'medium'] ?? 'medium';

    const prob = await this.problem.createProblem(userId, {
      title, priority: priority as any,
      affectedAssetIds: sourceInc?.affectedAssetIds, affectedServiceIds: sourceInc?.affectedServiceIds,
      detectedBy: 'manual', detectionMethod: 'promote_from_incident',
      workaround: sourceInc?.workaround,
    });

    for (const incId of allIds) {
      await this.problem.linkIncident(userId, prob.id, incId);
    }

    return { success: true, data: prob, display: `📋 Problem aus ${allIds.length} Incident(s) erstellt: **${prob.title}** — ID: ${prob.id}` };
  }

  private async createFixChange(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const problemId = input.problem_id as string;
    if (!problemId) return { success: false, error: 'problem_id erforderlich' };
    const prob = await this.problem.getProblemById(userId, problemId);
    if (!prob) return { success: false, error: `Problem ${problemId} nicht gefunden` };

    const cr = await this.itsm.createChangeRequest(userId, {
      title: input.title as string ?? `Fix: ${prob.title}`,
      description: prob.proposedFix ?? prob.rootCauseDescription,
      type: 'normal' as any, riskLevel: prob.priority as any,
      implementationPlan: input.implementation_plan as string,
      rollbackPlan: input.rollback_plan as string,
      testPlan: input.test_plan as string,
      scheduledAt: input.scheduled_at as string,
      affectedAssetIds: prob.affectedAssetIds,
      affectedServiceIds: prob.affectedServiceIds,
    });

    await this.problem.linkChangeRequest(userId, prob.id, cr.id);
    // Advance problem to fix_in_progress if appropriate
    if (prob.status === 'root_cause_identified' || prob.status === 'analyzing') {
      await this.problem.updateProblem(userId, prob.id, { status: 'fix_in_progress' });
    }

    return { success: true, data: { problem: prob, changeRequest: cr }, display: `🔧 Fix-Change **${cr.title}** erstellt für Problem **${prob.title}** — Change-ID: ${cr.id.slice(0, 8)}` };
  }

  private async markKnownError(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const id = input.problem_id as string;
    if (!id) return { success: false, error: 'problem_id erforderlich' };
    const result = await this.problem.updateProblem(userId, id, {
      isKnownError: true, knownErrorDescription: input.known_error_description as string,
    });
    if (!result) return { success: false, error: `Problem ${id} nicht gefunden` };
    return { success: true, data: result, display: `⚠️ Problem **${result.title}** als Known Error markiert` };
  }

  private async detectProblemPatterns(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const patterns = await this.problem.detectPatterns(userId, {
      windowDays: input.pattern_window_days as number,
      minIncidents: input.min_incidents as number,
    });
    if (patterns.length === 0) return { success: true, data: [], display: 'Keine Incident-Muster erkannt.' };

    const lines = patterns.map((p, i) =>
      `| ${i + 1} | ${p.keywordCluster.join(', ')} | ${p.incidentCount} | ${p.assetIds.length} Assets | ${p.firstSeen.slice(0, 10)}–${p.lastSeen.slice(0, 10)} | ${p.existingProblemId ? p.existingProblemId.slice(0, 8) : 'Neu'} |`,
    );
    const display = `## Erkannte Incident-Muster (${patterns.length})\n\n| # | Keywords | Incidents | Scope | Zeitraum | Problem |\n|---|----------|-----------|-------|----------|--------|\n${lines.join('\n')}`;
    return { success: true, data: patterns, display };
  }

  private async problemDashboardAction(userId: string): Promise<SkillResult> {
    if (!this.problem) return { success: false, error: 'Problem Management nicht konfiguriert' };
    const dash = await this.problem.getDashboard(userId);
    const display = [
      '## Problem Dashboard',
      `**Offene Probleme:** ${dash.openProblems} | **Known Errors:** ${dash.knownErrors}`,
      '',
      '### Nach Status',
      ...Object.entries(dash.problemsByStatus).map(([s, c]) => `- ${s}: ${c}`),
      '',
      '### Nach Priorität',
      ...Object.entries(dash.problemsByPriority).map(([p, c]) => `- ${p}: ${c}`),
    ].join('\n');
    return { success: true, data: dash, display };
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

  private async addComponent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    if (!serviceId) return { success: false, error: 'service_id erforderlich' };
    const name = input.component_name as string;
    const role = input.component_role as string ?? 'other';
    if (!name) return { success: false, error: 'component_name erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    const component: any = { name, role, required: input.component_required !== false };
    if (input.component_asset_id) component.assetId = input.component_asset_id;
    if (input.component_service_id) component.serviceId = input.component_service_id;
    if (input.component_external_url) component.externalUrl = input.component_external_url;
    if (input.component_parent) component.parentComponent = input.component_parent;
    if (input.component_failure_impact) component.failureImpact = input.component_failure_impact;

    // Validate parent exists and no circular reference
    if (component.parentComponent) {
      if (!svc.components.some((c: any) => c.name === component.parentComponent)) {
        return { success: false, error: `Parent-Komponente "${component.parentComponent}" nicht gefunden im Service` };
      }
      let depth = 1;
      let current = component.parentComponent;
      while (current && depth <= 3) {
        const parent = svc.components.find((c: any) => c.name === current);
        if (!(parent as any)?.parentComponent) break;
        current = (parent as any).parentComponent;
        depth++;
      }
      if (depth > 3) {
        return { success: false, error: 'Maximale Hierarchie-Tiefe (3 Ebenen) überschritten' };
      }
    }

    const components = [...svc.components, component];
    // Sync assetId into flat asset_ids for backward compat
    const assetIds = [...new Set([...svc.assetIds, ...(component.assetId ? [component.assetId] : [])])];
    await this.itsm.updateService(userId, serviceId, { components, assetIds } as any);

    return { success: true, data: component, display: `✅ Komponente **${name}** (${role}) zu Service **${svc.name}** hinzugefügt` };
  }

  private async removeComponent(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    const name = input.component_name as string;
    if (!serviceId || !name) return { success: false, error: 'service_id und component_name erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    const components = svc.components.filter(c => c.name !== name);
    if (components.length === svc.components.length) return { success: false, error: `Komponente ${name} nicht gefunden` };
    await this.itsm.updateService(userId, serviceId, { components } as any);

    return { success: true, display: `✅ Komponente **${name}** von Service **${svc.name}** entfernt` };
  }

  private async healthCheck(userId: string): Promise<SkillResult> {
    const services = await this.itsm.listServices(userId);
    const results: { name: string; status: ServiceHealthStatus; reason?: string; latencyMs?: number; error?: string }[] = [];

    for (const svc of services) {
      const reasons: string[] = [];
      let worstStatus = 'healthy' as ServiceHealthStatus;
      const updatedComponents = [...svc.components];

      // Layer 1: URL health check (if configured)
      if (svc.healthCheckUrl) {
        const start = Date.now();
        try {
          const res = await fetch(svc.healthCheckUrl, { signal: AbortSignal.timeout(10_000) });
          const latencyMs = Date.now() - start;
          if (!res.ok) {
            const urlStatus: ServiceHealthStatus = res.status >= 500 ? 'down' : 'degraded';
            if (urlStatus === 'down') worstStatus = 'down';
            else if (worstStatus !== 'down') worstStatus = 'degraded';
            reasons.push(`URL ${svc.healthCheckUrl}: HTTP ${res.status}`);
          }
          results.push({ name: svc.name, status: worstStatus, latencyMs });
        } catch (err: any) {
          worstStatus = 'down';
          reasons.push(`URL ${svc.healthCheckUrl}: ${err.message?.slice(0, 60)}`);
          results.push({ name: svc.name, status: 'down', error: err.message?.slice(0, 80) });
        }
      }

      // Layer 2: Component health (topologically sorted — parents first)
      const visited = new Set<string>(); // Circular dependency guard
      const sortOrder = this.topoSortComponents(updatedComponents);

      for (const ci of sortOrder) {
        const comp = updatedComponents[ci];
        let compStatus: ServiceHealthStatus = 'healthy';
        let compReason = '';

        // Check parent status first — if parent down, child is down
        if ((comp as any).parentComponent) {
          const parent = updatedComponents.find((c: any) => c.name === (comp as any).parentComponent);
          if (parent?.healthStatus === 'down') {
            compStatus = 'down';
            compReason = `Parent ${parent.name} down`;
            updatedComponents[ci] = { ...comp, healthStatus: compStatus, healthReason: compReason };
            const impact = (comp as any).failureImpact ?? (comp.required ? 'down' : 'degraded');
            if (impact === 'down') {
              worstStatus = 'down'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`);
            } else if (impact === 'degraded' && worstStatus !== 'down') {
              worstStatus = 'degraded'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`);
            }
            continue;
          }
        }

        if (comp.assetId) {
          const asset = await this.cmdb.getAssetById(userId, comp.assetId);
          if (asset) {
            if (asset.status === 'inactive' || asset.status === 'decommissioned') {
              compStatus = 'down'; compReason = `${asset.name} (${asset.status})`;
            } else if (asset.status === 'degraded' || asset.status === 'unknown') {
              compStatus = 'degraded'; compReason = `${asset.name} (${asset.status})`;
            }
          } else {
            compStatus = 'unknown'; compReason = 'Asset nicht gefunden';
          }
        } else if (comp.serviceId && !visited.has(comp.serviceId)) {
          visited.add(comp.serviceId);
          const depSvc = await this.itsm.getServiceById(userId, comp.serviceId);
          if (depSvc) {
            if (depSvc.healthStatus === 'down') { compStatus = 'down'; compReason = `Service ${depSvc.name} down`; }
            else if (depSvc.healthStatus === 'degraded') { compStatus = 'degraded'; compReason = `Service ${depSvc.name} degraded`; }
          }
        } else if (comp.externalUrl) {
          try {
            const res = await fetch(comp.externalUrl, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) { compStatus = res.status >= 500 ? 'down' : 'degraded'; compReason = `HTTP ${res.status}`; }
          } catch (err: any) {
            compStatus = 'down'; compReason = err.message?.slice(0, 60);
          }
        }

        updatedComponents[ci] = { ...comp, healthStatus: compStatus, healthReason: compReason || undefined };

        // Determine service impact from failureImpact field or required flag
        const impact = (comp as any).failureImpact ?? (comp.required ? 'down' : 'degraded');
        if (compStatus === 'down') {
          if (impact === 'down') { worstStatus = 'down'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`); }
          else if (impact === 'degraded' && worstStatus !== 'down') { worstStatus = 'degraded'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`); }
        } else if (compStatus === 'degraded' && worstStatus === 'healthy') {
          worstStatus = 'degraded'; reasons.push(`${comp.name} (${comp.role}): degraded — ${compReason}`);
        }
      }

      // Aggregate and update
      const reason = reasons.length > 0 ? reasons.join('; ') : undefined;
      await this.itsm.updateServiceHealth(userId, svc.id, worstStatus, reason, updatedComponents.length > 0 ? updatedComponents : undefined);

      // SLA event tracking
      if (svc.sla?.enabled && svc.sla.monitoring.trackAvailability) {
        try {
          const openEvent = await this.itsm.getOpenSlaEvent(userId, 'service', svc.id);
          const prevStatus = openEvent?.eventType ?? 'up';
          const newStatus = worstStatus === 'healthy' ? 'up' : worstStatus;

          if (prevStatus !== newStatus) {
            if (openEvent) await this.itsm.closeSlaEvent(userId, 'service', svc.id, openEvent.eventType);
            await this.itsm.createSlaEvent(userId, {
              targetType: 'service', targetId: svc.id,
              eventType: newStatus as any,
              details: JSON.stringify({ reason, previousStatus: prevStatus }),
            });

            if (newStatus === 'down' && svc.sla.targets.availabilityPercent) {
              const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
              const periodEnd = new Date().toISOString();
              const avail = await this.itsm.calculateAvailability(userId, 'service', svc.id, periodStart, periodEnd);
              const target = svc.sla.targets.availabilityPercent;
              const warning = svc.sla.monitoring.warningThresholdPercent ?? (target - 0.1);

              if (avail.uptimePercent < target) {
                await this.itsm.createSlaEvent(userId, {
                  targetType: 'service', targetId: svc.id, eventType: 'breach',
                  details: JSON.stringify({ target, actual: avail.uptimePercent, month: periodStart }),
                });
              } else if (avail.uptimePercent < warning) {
                await this.itsm.createSlaEvent(userId, {
                  targetType: 'service', targetId: svc.id, eventType: 'warning',
                  details: JSON.stringify({ target, warning, actual: avail.uptimePercent, month: periodStart }),
                });
              }
            }
          }
        } catch { /* SLA tracking non-critical */ }
      }

      if (!results.some(r => r.name === svc.name)) {
        results.push({ name: svc.name, status: worstStatus, reason });
      } else {
        const existing = results.find(r => r.name === svc.name)!;
        existing.status = worstStatus;
        existing.reason = reason;
      }
    }

    const icon = (s: ServiceHealthStatus) => ({ healthy: '🟢', degraded: '🟡', down: '🔴', unknown: '⚫' }[s]);
    const lines = results.map(r =>
      `| ${icon(r.status)} ${r.status} | ${r.name} | ${r.reason ?? '—'} |`,
    );

    const display = `## Health Check (3-Layer)\n\n| Status | Service | Reason |\n|--------|---------|--------|\n${lines.join('\n')}`;
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
      s.assetIds.some(aid => topo.assets.some(a => a.id === aid)) ||
      s.components.some(c => c.assetId && topo.assets.some(a => a.id === c.assetId)),
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

  // ── Service Management (Extended) ─────────────────────────

  private async createServiceFromDescription(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const description = input.description as string;
    if (!description) return { success: false, error: 'description erforderlich' };
    if (!this.llmCallback) return { success: false, error: 'LLM nicht verfügbar' };

    // Ask LLM to parse the description into a service structure
    const prompt = [
      'Parse the following service description into a JSON structure.',
      'Return ONLY valid JSON, no markdown fences, no explanation.',
      'Schema:',
      '{',
      '  "name": "string",',
      '  "description": "string",',
      '  "category": "web_app|api|database|messaging|monitoring|infrastructure|other",',
      '  "criticality": "critical|high|medium|low",',
      '  "components": [{ "name": "string", "role": "database|cache|storage|compute|api|proxy|messaging|monitoring|dns|other", "required": true/false }],',
      '  "failureModes": [{ "name": "string", "trigger": "string", "affectedComponents": ["comp-name"], "serviceImpact": "down|degraded", "cascadeEffects": ["string"], "estimatedRecoveryMinutes": number }]',
      '}',
      '',
      'Service description:',
      description,
    ].join('\n');

    const raw = await this.llmCallback(prompt, 'strong');
    let parsed: any;
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { success: false, error: `LLM-Antwort konnte nicht geparst werden: ${raw.slice(0, 200)}` };
    }

    // Match component names against CMDB assets
    const allAssets = await this.cmdb.listAssets(userId, {});
    const assetMap = new Map(allAssets.map(a => [a.name.toLowerCase(), a]));

    const components: any[] = [];
    const matchedAssetIds: string[] = [];
    for (const comp of (parsed.components ?? [])) {
      const matched = assetMap.get(comp.name?.toLowerCase());
      const component: any = {
        name: comp.name,
        role: comp.role ?? 'other',
        required: comp.required !== false,
      };
      if (matched) {
        component.assetId = matched.id;
        matchedAssetIds.push(matched.id);
      }
      components.push(component);
    }

    // Create the service
    const svc = await this.itsm.createService(userId, {
      name: parsed.name ?? 'Unnamed Service',
      description: parsed.description,
      category: parsed.category as any,
      criticality: parsed.criticality as any,
      assetIds: matchedAssetIds,
    });

    // Update with components and failure modes
    await this.itsm.updateService(userId, svc.id, {
      components,
      failureModes: parsed.failureModes ?? [],
    } as any);

    // Fire-and-forget background doc generation
    this.generateServiceDocsBackground(userId, svc.id).catch(() => {});

    const compInfo = components.map(c => {
      const linked = c.assetId ? ' ✅' : ' ⚠️';
      return `  - ${c.name} (${c.role})${linked}`;
    }).join('\n');
    const fmCount = (parsed.failureModes ?? []).length;

    const display = [
      `📦 Service **${parsed.name}** erstellt aus Beschreibung — ID: ${svc.id}`,
      '',
      `**Komponenten (${components.length}):**`,
      compInfo,
      `✅ = CMDB-Asset verknüpft, ⚠️ = kein Match`,
      '',
      `**Failure Modes:** ${fmCount}`,
      fmCount > 0 ? (parsed.failureModes as any[]).map((fm: any) => `  - ${fm.name} → ${fm.serviceImpact}`).join('\n') : '',
      '',
      '📝 Service-Dokumentation wird im Hintergrund generiert...',
    ].filter(Boolean).join('\n');

    return { success: true, data: { service: svc, parsed }, display };
  }

  private async addFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    const name = input.failure_mode_name as string;
    if (!serviceId) return { success: false, error: 'service_id erforderlich' };
    if (!name) return { success: false, error: 'failure_mode_name erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    const failureModes = [...(svc.failureModes ?? [])];
    if (failureModes.some(fm => fm.name === name)) {
      return { success: false, error: `Failure-Mode "${name}" existiert bereits` };
    }

    failureModes.push({
      name,
      trigger: input.failure_trigger as string ?? '',
      affectedComponents: input.affected_components as string[] ?? [],
      serviceImpact: (input.failure_impact as 'down' | 'degraded') ?? 'degraded',
      cascadeEffects: input.cascade_effects as string[] ?? undefined,
      estimatedRecoveryMinutes: input.recovery_minutes as number ?? undefined,
    });

    await this.itsm.updateService(userId, serviceId, { failureModes } as any);
    return { success: true, data: { failureMode: failureModes[failureModes.length - 1] }, display: `✅ Failure-Mode **${name}** zu Service **${svc.name}** hinzugefügt` };
  }

  private async removeFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    const name = input.failure_mode_name as string;
    if (!serviceId || !name) return { success: false, error: 'service_id und failure_mode_name erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    const before = svc.failureModes ?? [];
    const failureModes = before.filter(fm => fm.name !== name);
    if (failureModes.length === before.length) {
      return { success: false, error: `Failure-Mode "${name}" nicht gefunden` };
    }

    await this.itsm.updateService(userId, serviceId, { failureModes } as any);
    return { success: true, display: `✅ Failure-Mode **${name}** von Service **${svc.name}** entfernt` };
  }

  private async updateFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    const name = input.failure_mode_name as string;
    if (!serviceId || !name) return { success: false, error: 'service_id und failure_mode_name erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    let found = false;
    const failureModes = (svc.failureModes ?? []).map(fm => {
      if (fm.name !== name) return fm;
      found = true;
      return {
        ...fm,
        ...(input.failure_trigger !== undefined ? { trigger: input.failure_trigger as string } : {}),
        ...(input.affected_components !== undefined ? { affectedComponents: input.affected_components as string[] } : {}),
        ...(input.failure_impact !== undefined ? { serviceImpact: input.failure_impact as 'down' | 'degraded' } : {}),
        ...(input.cascade_effects !== undefined ? { cascadeEffects: input.cascade_effects as string[] } : {}),
        ...(input.recovery_minutes !== undefined ? { estimatedRecoveryMinutes: input.recovery_minutes as number } : {}),
      };
    });

    if (!found) return { success: false, error: `Failure-Mode "${name}" nicht gefunden` };

    await this.itsm.updateService(userId, serviceId, { failureModes } as any);
    return { success: true, data: { failureModes }, display: `✅ Failure-Mode **${name}** aktualisiert` };
  }

  private async serviceImpactAnalysis(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    let assetId = input.asset_id as string | undefined;
    const assetName = input.name as string | undefined;

    // Resolve by name if no ID given
    if (!assetId && assetName) {
      const allAssets = await this.cmdb.listAssets(userId, { search: assetName });
      const match = allAssets.find(a => a.name.toLowerCase() === assetName.toLowerCase())
        ?? allAssets[0];
      if (match) assetId = match.id;
    }
    if (!assetId) return { success: false, error: 'asset_id oder name erforderlich' };

    const asset = await this.cmdb.getAssetById(userId, assetId);
    if (!asset) return { success: false, error: `Asset ${assetId} nicht gefunden` };

    // Find ALL services containing that asset
    const services = await this.itsm.getServicesForAsset(userId, assetId);
    if (services.length === 0) {
      return { success: true, data: { asset, services: [] }, display: `## Service Impact: ${asset.name}\n\nKeine Services nutzen dieses Asset.` };
    }

    const svcDetails: string[] = [];
    for (const svc of services) {
      const comp = svc.components.find(c => c.assetId === assetId);
      const compImpact = comp?.required !== false ? 'down' : 'degraded';
      const critIcon = ({ critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' } as Record<string, string>)[svc.criticality ?? 'medium'] ?? '⚪';

      const lines: string[] = [
        `### ${critIcon} ${svc.name} (${svc.criticality ?? 'medium'})`,
        `**Component:** ${comp?.name ?? '—'} (${comp?.role ?? '—'}) → **${compImpact}**`,
      ];

      // Find matching failure modes
      const matchingFMs = (svc.failureModes ?? []).filter(fm =>
        fm.affectedComponents.some(ac =>
          ac.toLowerCase() === (comp?.name ?? '').toLowerCase(),
        ),
      );

      if (matchingFMs.length > 0) {
        lines.push('**Failure Modes:**');
        for (const fm of matchingFMs) {
          lines.push(`  - **${fm.name}** (${fm.serviceImpact}) — Trigger: ${fm.trigger}`);
          if (fm.cascadeEffects?.length) lines.push(`    Cascade: ${fm.cascadeEffects.join(', ')}`);
          if (fm.estimatedRecoveryMinutes) lines.push(`    Recovery: ~${fm.estimatedRecoveryMinutes} Min`);
        }
      }

      svcDetails.push(lines.join('\n'));
    }

    const display = [
      `## Service Impact Analysis: ${asset.name} (${asset.assetType})`,
      '',
      `**${services.length} Service(s) betroffen:**`,
      '',
      ...svcDetails,
    ].join('\n');

    return { success: true, data: { asset, services }, display };
  }

  private async generateServiceDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    if (!serviceId) return { success: false, error: 'service_id erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };
    if (!this.llmCallback) return { success: false, error: 'LLM nicht verfügbar' };

    // Start background generation
    this.generateServiceDocsBackground(userId, serviceId).catch(() => {});

    return { success: true, data: { serviceId }, display: `📝 Dokumentation für Service **${svc.name}** wird im Hintergrund generiert (Service-Doku + SOP pro Failure-Mode).` };
  }

  private async generateServiceDocsBackground(userId: string, serviceId: string): Promise<void> {
    if (!this.llmCallback) return;

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return;

    // Collect system docs from component assets
    const componentDocs: string[] = [];
    for (const comp of svc.components) {
      if (!comp.assetId) continue;
      try {
        const docs = await this.cmdb.getDocumentsForEntity(userId, 'asset' as any, comp.assetId);
        if (docs.length > 0) {
          componentDocs.push(`### ${comp.name}\n${docs[0].content.slice(0, 1500)}`);
        }
      } catch { /* skip */ }
    }

    const contextBlock = componentDocs.length > 0
      ? `\n\nKomponenten-Dokumentation:\n${componentDocs.join('\n\n')}`
      : '';

    // 1. Generate Service Documentation
    const servicePrompt = [
      `Erstelle eine Service-Dokumentation fuer: ${svc.name}`,
      `Beschreibung: ${svc.description ?? '—'}`,
      `Kategorie: ${svc.category ?? '—'} | Criticality: ${svc.criticality ?? 'medium'}`,
      `Komponenten: ${svc.components.map(c => `${c.name} (${c.role}, ${c.required !== false ? 'required' : 'optional'})`).join(', ')}`,
      `Dependencies: ${svc.dependencies.join(', ') || 'keine'}`,
      svc.slaNotes ? `SLA: ${svc.slaNotes}` : '',
      svc.maintenanceWindow ? `Maintenance Window: ${svc.maintenanceWindow}` : '',
      contextBlock,
      '',
      'Erstelle eine vollstaendige Service-Dokumentation mit:',
      '1. Uebersicht und Zweck',
      '2. Architektur (Komponenten und deren Zusammenspiel)',
      '3. Abhaengigkeiten',
      '4. Monitoring und Health-Checks',
      '5. Bekannte Risiken',
      '6. Kontakt / Verantwortlich',
      '',
      'Schreibe in Markdown.',
    ].filter(Boolean).join('\n');

    try {
      const serviceDoc = await this.llmCallback(servicePrompt, 'strong');
      await this.cmdb.saveDocument(userId, {
        docType: 'service_doc' as any,
        title: `Service-Dok: ${svc.name}`,
        content: serviceDoc,
        linkedEntityType: 'service' as any,
        linkedEntityId: serviceId,
        generatedBy: 'itsm',
      });
    } catch { /* non-critical */ }

    // 2. Generate SOP for each Failure Mode
    for (const fm of (svc.failureModes ?? [])) {
      try {
        const sopPrompt = [
          `Erstelle ein Standard Operating Procedure (SOP) fuer den Failure-Mode: "${fm.name}"`,
          `Service: ${svc.name}`,
          `Trigger: ${fm.trigger}`,
          `Impact: ${fm.serviceImpact}`,
          `Betroffene Komponenten: ${fm.affectedComponents.join(', ')}`,
          fm.cascadeEffects?.length ? `Kaskaden-Effekte: ${fm.cascadeEffects.join(', ')}` : '',
          fm.estimatedRecoveryMinutes ? `Geschaetzte Recovery: ${fm.estimatedRecoveryMinutes} Min` : '',
          contextBlock,
          '',
          'Erstelle ein SOP mit:',
          '1. Erkennung / Alarme',
          '2. Sofortmassnahmen (erste 5 Minuten)',
          '3. Diagnose-Schritte',
          '4. Recovery-Prozedur',
          '5. Verifikation',
          '6. Post-Incident Aufgaben',
          '',
          'Schreibe in Markdown, nutze Checklisten.',
        ].filter(Boolean).join('\n');

        const sopDoc = await this.llmCallback(sopPrompt, 'strong');
        await this.cmdb.saveDocument(userId, {
          docType: 'runbook' as any,
          title: `SOP: ${svc.name} — ${fm.name}`,
          content: sopDoc,
          linkedEntityType: 'service' as any,
          linkedEntityId: serviceId,
          generatedBy: 'itsm',
        });
      } catch { /* skip individual SOP failures */ }
    }
  }

  // ── SLA Management ────────────────────────────────────────

  private async setSla(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const targetType = input.sla_target_type as 'service' | 'asset';
    const targetId = input.sla_target_id as string ?? input.service_id as string ?? input.asset_id as string;
    if (!targetId) return { success: false, error: 'sla_target_id (oder service_id/asset_id) erforderlich' };
    if (!targetType) return { success: false, error: 'sla_target_type erforderlich (service oder asset)' };

    const sla: import('@alfred/types').SlaDefinition = {
      name: (input.sla_name as string) ?? 'Standard SLA',
      enabled: true,
      targets: {
        availabilityPercent: input.sla_availability as number | undefined,
        mttrMinutes: input.sla_mttr_minutes as number | undefined,
        responseTimeMinutes: input.sla_response_minutes as number | undefined,
        resolutionTimeMinutes: input.sla_resolution_minutes as number | undefined,
      },
      monitoring: {
        trackAvailability: true,
        breachAlertEnabled: input.sla_breach_alert !== false,
        warningThresholdPercent: input.sla_warning_threshold as number | undefined,
      },
    };

    if (sla.targets.availabilityPercent) {
      sla.targets.maxDowntimeMinutesPerMonth = Math.round((1 - sla.targets.availabilityPercent / 100) * 30 * 24 * 60 * 100) / 100;
    }

    if (targetType === 'service') {
      const svc = await this.itsm.getServiceById(userId, targetId);
      if (!svc) return { success: false, error: `Service ${targetId} nicht gefunden` };
      await this.itsm.updateService(userId, targetId, { sla } as any);
      return { success: true, data: sla, display: `✅ SLA **${sla.name}** auf Service **${svc.name}** gesetzt (${sla.targets.availabilityPercent ?? '—'}% Verfügbarkeit)` };
    } else {
      const asset = await this.cmdb.getAssetById(userId, targetId);
      if (!asset) return { success: false, error: `Asset ${targetId} nicht gefunden` };
      await this.cmdb.updateAsset(userId, targetId, { sla } as any);
      return { success: true, data: sla, display: `✅ SLA **${sla.name}** auf Asset **${asset.name}** gesetzt (${sla.targets.availabilityPercent ?? '—'}% Verfügbarkeit)` };
    }
  }

  private async getSlaReport(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const targetType = input.sla_target_type as 'service' | 'asset' ?? 'service';
    const targetId = input.sla_target_id as string ?? input.service_id as string ?? input.asset_id as string;
    if (!targetId) return { success: false, error: 'sla_target_id erforderlich' };

    const periodStr = input.sla_period as string;
    let periodStart: string;
    let periodEnd: string;
    if (periodStr && /^\d{4}-\d{2}$/.test(periodStr)) {
      const [y, m] = periodStr.split('-').map(Number);
      periodStart = new Date(y, m - 1, 1).toISOString();
      periodEnd = new Date(y, m, 0, 23, 59, 59).toISOString();
    } else {
      const now = new Date();
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      periodEnd = now.toISOString();
    }

    let targetName = targetId;
    let sla: import('@alfred/types').SlaDefinition | undefined;

    if (targetType === 'service') {
      const svc = await this.itsm.getServiceById(userId, targetId);
      if (!svc) return { success: false, error: `Service ${targetId} nicht gefunden` };
      targetName = svc.name;
      sla = svc.sla;
    } else {
      const asset = await this.cmdb.getAssetById(userId, targetId);
      if (!asset) return { success: false, error: `Asset ${targetId} nicht gefunden` };
      targetName = asset.name;
      sla = (asset as any).sla;
    }

    const avail = await this.itsm.calculateAvailability(userId, targetType, targetId, periodStart, periodEnd);
    const breaches = await this.itsm.getSlaEvents(userId, targetType, targetId, periodStart, periodEnd);
    const breachEvents = breaches.filter(e => e.eventType === 'breach' || e.eventType === 'warning');

    const target = sla?.targets?.availabilityPercent;
    const compliant = target ? avail.uptimePercent >= target : true;

    const display = [
      `## SLA Report: ${targetName}`,
      '',
      sla ? `**SLA:** ${sla.name} (Ziel: ${target ?? '—'}%)` : '**SLA:** nicht konfiguriert',
      '',
      `**Zeitraum:** ${periodStart.slice(0, 10)} — ${periodEnd.slice(0, 10)}`,
      `**Verfügbarkeit:** ${avail.uptimePercent.toFixed(3)}%`,
      `**Downtime:** ${avail.downtimeMinutes.toFixed(1)} Min. von ${avail.totalMinutes} Min.`,
      target ? `**Status:** ${compliant ? '✅ Compliant' : '❌ SLA BREACH'}` : '',
      '',
      breachEvents.length > 0 ? `**Breaches/Warnings:** ${breachEvents.length}` : '**Breaches:** keine',
      ...breachEvents.slice(0, 5).map(e => {
        const icon = e.eventType === 'breach' ? '🔴' : '🟡';
        return `  ${icon} ${e.startedAt.slice(0, 16)} — ${e.eventType}`;
      }),
    ].filter(Boolean).join('\n');

    return { success: true, data: { targetName, sla, avail, breachEvents, compliant }, display };
  }

  private async checkSlaCompliance(userId: string): Promise<SkillResult> {
    const services = await this.itsm.listServices(userId);
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = now.toISOString();

    const results: { name: string; type: string; target: number; actual: number; compliant: boolean }[] = [];

    for (const svc of services) {
      if (!svc.sla?.enabled || !svc.sla.targets.availabilityPercent) continue;
      const avail = await this.itsm.calculateAvailability(userId, 'service', svc.id, periodStart, periodEnd);
      results.push({
        name: svc.name,
        type: 'service',
        target: svc.sla.targets.availabilityPercent,
        actual: avail.uptimePercent,
        compliant: avail.uptimePercent >= svc.sla.targets.availabilityPercent,
      });
    }

    const icon = (c: boolean) => c ? '✅' : '❌';
    const lines = results.map(r =>
      `| ${icon(r.compliant)} | ${r.name} | ${r.target}% | ${r.actual.toFixed(3)}% | ${r.compliant ? 'OK' : 'BREACH'} |`,
    );

    const breachCount = results.filter(r => !r.compliant).length;
    const display = [
      `## SLA Compliance Check`,
      '',
      results.length === 0 ? 'Keine aktiven SLAs konfiguriert.' : '',
      results.length > 0 ? `| Status | Service | Ziel | Aktuell | Ergebnis |\n|--------|---------|------|---------|----------|\n${lines.join('\n')}` : '',
      '',
      breachCount > 0 ? `⚠️ **${breachCount} SLA-Verletzung(en)!**` : results.length > 0 ? '✅ Alle SLAs eingehalten' : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: results, display };
  }

  private async listSlaBreaches(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const periodStr = input.sla_period as string;
    let since: string | undefined;
    if (periodStr && /^\d{4}-\d{2}$/.test(periodStr)) {
      const [y, m] = periodStr.split('-').map(Number);
      since = new Date(y, m - 1, 1).toISOString();
    } else {
      since = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    }

    const breaches = await this.itsm.getSlaBreaches(userId, since);
    if (breaches.length === 0) {
      return { success: true, data: [], display: '✅ Keine SLA-Verletzungen im Zeitraum.' };
    }

    const lines = breaches.map(b => {
      const icon = b.eventType === 'breach' ? '🔴' : '🟡';
      let detail = '';
      try { const d = JSON.parse(b.details ?? '{}'); detail = ` — Ziel: ${d.target}%, Aktuell: ${d.actual?.toFixed(3)}%`; } catch { /* ignore */ }
      return `${icon} ${b.startedAt.slice(0, 16)} [${b.targetType}:${b.targetId.slice(0, 8)}] ${b.eventType}${detail}`;
    });

    return { success: true, data: breaches, display: `## SLA Breaches\n\n${lines.join('\n')}` };
  }
}
