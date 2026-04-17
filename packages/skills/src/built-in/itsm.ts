import type { SkillMetadata, SkillContext, SkillResult, IncidentSeverity, ServiceHealthStatus } from '@alfred/types';
import type { ItsmRepository, ProblemRepository } from '@alfred/storage';
import type { CmdbRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action =
  | 'create_incident' | 'update_incident' | 'list_incidents' | 'get_incident' | 'close_incident'
  | 'create_change_request' | 'update_change' | 'get_change' | 'approve_change' | 'start_change' | 'complete_change' | 'rollback_change' | 'list_changes'
  | 'create_problem' | 'update_problem' | 'get_problem' | 'list_problems' | 'link_incident_to_problem' | 'unlink_incident_from_problem' | 'promote_to_problem' | 'create_fix_change' | 'mark_known_error' | 'detect_problem_patterns' | 'problem_dashboard'
  | 'add_service' | 'update_service' | 'add_component' | 'remove_component' | 'health_check' | 'impact_analysis' | 'dashboard';

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
      '"dashboard" zeigt ITSM-Übersicht.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_incident', 'update_incident', 'list_incidents', 'get_incident', 'close_incident', 'create_change_request', 'update_change', 'get_change', 'approve_change', 'start_change', 'complete_change', 'rollback_change', 'list_changes', 'create_problem', 'update_problem', 'get_problem', 'list_problems', 'link_incident_to_problem', 'unlink_incident_from_problem', 'promote_to_problem', 'create_fix_change', 'mark_known_error', 'detect_problem_patterns', 'problem_dashboard', 'add_service', 'update_service', 'add_component', 'remove_component', 'health_check', 'impact_analysis', 'dashboard'] },
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

  constructor(itsmRepo: ItsmRepository, cmdbRepo: CmdbRepository, problemRepo?: ProblemRepository) {
    super();
    this.itsm = itsmRepo;
    this.cmdb = cmdbRepo;
    this.problem = problemRepo;
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

      // Layer 2: Component health (assets + external URLs + dependent services)
      const visited = new Set<string>(); // Circular dependency guard
      for (let ci = 0; ci < updatedComponents.length; ci++) {
        const comp = updatedComponents[ci];
        let compStatus: ServiceHealthStatus = 'healthy';
        let compReason = '';

        if (comp.assetId) {
          // Check CMDB asset status
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
          // Check dependent service health (with circular guard)
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

        if (compStatus === 'down') {
          if (comp.required) { worstStatus = 'down'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`); }
          else if (worstStatus !== 'down') { worstStatus = 'degraded'; reasons.push(`${comp.name} (${comp.role}): DOWN — ${compReason}`); }
        } else if (compStatus === 'degraded' && worstStatus === 'healthy') {
          worstStatus = 'degraded'; reasons.push(`${comp.name} (${comp.role}): degraded — ${compReason}`);
        }
      }

      // Aggregate and update
      const reason = reasons.length > 0 ? reasons.join('; ') : undefined;
      await this.itsm.updateServiceHealth(userId, svc.id, worstStatus, reason, updatedComponents.length > 0 ? updatedComponents : undefined);

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
}
