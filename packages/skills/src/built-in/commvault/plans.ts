/**
 * Commvault Plans Module — 8 actions for plan management
 *
 * V4 API response field mapping (from OpenAPI3.yaml):
 *   GET  /V4/Plan/Summary        → { plans: PlanSummary[], plansCount: number }
 *   GET  /V4/PlanIds              → { entities: IdName[] }
 *   GET  /V4/ServerPlan/{planId}  → ServerPlan (plan, backupDestinations, rpo, settings, …)
 *   POST /V4/ServerPlan           → PlanResp  (required: planName)
 *   POST /V4/LaptopPlan           → LaptopPlanResp (required: planName)
 *   DELETE /V4/ServerPlan/{planId}→ GenericResp
 *   GET  /V4/Plan/Rule            → { rules: PlanEntityRuleInfo[] }
 *   GET  /V4/Plan/Rule/Entities   → { entities: PlanRuleApplicableEntity[] }
 *   PUT  /V4/Plan/Rule/Entities   → GenericResp (body: ExecutePlanRules)
 *
 * PlanSummary: { plan: IdName, planType, associatedEntities, RPO, numberOfCopies, status }
 * PlanEntityRuleInfo: { rule: IdName, plan: IdName, workloads, regions, tags, serverGroups, rank }
 * PlanRuleApplicableEntity: { subclient, backupset, instance, client, apptype, evaluatedPlan, currentPlan }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { requireId, optionalString } from './types.js';

export class CommvaultPlans {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Alle Plans mit Summary ──────────────────────

  async list(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/Plan/Summary');
    const plans = data.plans ?? [];

    const lines = ['## Commvault Plans', `${plans.length} Plans gefunden`, ''];
    for (const p of plans) {
      const name = p.plan?.name ?? '?';
      const id = p.plan?.id ?? '?';
      const type = p.planType ?? '?';
      const entities = p.associatedEntities ?? 0;
      const status = p.status ?? '';
      const rpo = p.RPO !== undefined ? ` | RPO: ${p.RPO} Min` : '';
      const copies = p.numberOfCopies !== undefined ? ` | ${p.numberOfCopies} Copies` : '';
      lines.push(
        `**${name}** [${type}] (ID: ${id})${status ? ` [${status}]` : ''}`,
      );
      lines.push(`  ${entities} Clients${rpo}${copies}`);
      if (p.parentPlan?.name) lines.push(`  Parent: ${p.parentPlan.name}`);
    }

    return {
      success: true,
      data: { total: plans.length, plans },
      display: lines.join('\n'),
    };
  }

  // ── 2. ids — Schnelle ID/Name-Paare ──────────────────────

  async ids(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/PlanIds');
    const entities = data.entities ?? [];

    const lines = ['## Plan IDs', `${entities.length} Plans`, ''];
    for (const e of entities) {
      lines.push(`- **${e.name ?? '?'}** (ID: ${e.id ?? '?'})`);
    }

    return {
      success: true,
      data: { total: entities.length, entities },
      display: lines.join('\n'),
    };
  }

  // ── 3. detail — Server Plan Details ───────────────────────

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const planId = requireId(input, 'plan_id');
    const data = await this.api.get<any>(`/V4/ServerPlan/${planId}`);

    const lines = [`## Server Plan Detail (ID: ${planId})`, ''];
    const name = data.plan?.name ?? '?';
    lines.push(`**Name:** ${name}`);

    // Backup destinations
    const destinations = data.backupDestinations ?? [];
    if (destinations.length > 0) {
      lines.push('', `**Backup Destinations:** ${destinations.length}`);
      for (const d of destinations) {
        const dName = d.destinationName ?? d.backupDestinationName ?? d.name ?? '?';
        const dId = d.destinationId ?? d.id ?? '';
        const storage = d.storagePool?.name ?? d.storage?.name ?? '';
        const retDays = d.retentionPeriodDays ?? d.retentionPeriod ?? '';
        lines.push(
          `  - ${dName}${dId ? ` (ID: ${dId})` : ''}${storage ? ` — Storage: ${storage}` : ''}${retDays ? ` | Retention: ${retDays} Tage` : ''}`,
        );
      }
    }

    // RPO / Schedules
    const rpo = data.rpo;
    if (rpo) {
      lines.push('', '**RPO / Schedules:**');
      if (rpo.backupFrequency) {
        const freq = rpo.backupFrequency;
        lines.push(`  Backup-Frequenz: ${freq.schedules?.length ?? 0} Schedule(s)`);
        for (const s of freq.schedules ?? []) {
          const sName = s.scheduleName ?? s.name ?? '?';
          const pattern = s.pattern ?? {};
          const freqType = pattern.scheduleFrequencyType ?? pattern.frequency ?? '';
          lines.push(`    - ${sName}${freqType ? ` (${freqType})` : ''}`);
        }
      }
      if (rpo.SLA !== undefined) {
        lines.push(`  SLA: ${rpo.SLA}`);
      }
    }

    // Settings
    const settings = data.settings;
    if (settings) {
      lines.push('', '**Einstellungen:**');
      if (settings.enableAdvancedView !== undefined) lines.push(`  Advanced View: ${settings.enableAdvancedView ? 'ja' : 'nein'}`);
    }

    // Override
    if (data.allowPlanOverride !== undefined) {
      lines.push(`**Plan-Override:** ${data.allowPlanOverride ? 'erlaubt' : 'nicht erlaubt'}`);
    }

    // Associated entities
    const associated = data.associatedEntities ?? [];
    if (associated.length > 0) {
      lines.push('', '**Assoziierte Entitaten:**');
      for (const e of associated) {
        lines.push(`  - ${e.name ?? '?'} (ID: ${e.id ?? '?'})${e.count !== undefined ? ` — ${e.count} Elemente` : ''}`);
      }
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── 4. createServer — Server Plan erstellen (HIGH_RISK) ──

  async createServer(input: Record<string, unknown>): Promise<SkillResult> {
    const planName = optionalString(input, 'planName') ?? optionalString(input, 'plan_name');
    if (!planName) return { success: false, error: 'Parameter "planName" ist erforderlich' };

    const body: Record<string, unknown> = { planName };

    // backupDestinations — array of { backupDestinationName, storagePool: { id } } or IDs
    if (Array.isArray(input.backupDestinations)) {
      body.backupDestinations = input.backupDestinations;
    } else if (Array.isArray(input.backupDestinationIds)) {
      body.backupDestinationIds = input.backupDestinationIds;
    }

    if (input.rpo) body.rpo = input.rpo;
    if (input.backupContent) body.backupContent = input.backupContent;
    if (input.snapshotOptions) body.snapshotOptions = input.snapshotOptions;
    if (input.databaseOptions) body.databaseOptions = input.databaseOptions;
    if (input.settings) body.settings = input.settings;
    if (input.allowPlanOverride !== undefined) body.allowPlanOverride = input.allowPlanOverride;
    if (input.overrideRestrictions) body.overrideRestrictions = input.overrideRestrictions;
    if (input.parentPlan) body.parentPlan = input.parentPlan;
    if (input.workload) body.workload = input.workload;
    if (input.filesystemAddon !== undefined) body.filesystemAddon = input.filesystemAddon;

    const result = await this.api.post<any>('/V4/ServerPlan', body);
    const newId = result.plan?.id ?? result.planId ?? result.id ?? '?';
    return {
      success: true,
      data: result,
      display: `Server Plan "${planName}" erstellt (ID: ${newId}).`,
    };
  }

  // ── 5. createLaptop — Laptop Plan erstellen (HIGH_RISK) ──

  async createLaptop(input: Record<string, unknown>): Promise<SkillResult> {
    const planName = optionalString(input, 'planName') ?? optionalString(input, 'plan_name');
    if (!planName) return { success: false, error: 'Parameter "planName" ist erforderlich' };

    const body: Record<string, unknown> = { planName };

    if (input.backupContent) body.backupContent = input.backupContent;
    if (input.storageAndSchedule) body.storageAndSchedule = input.storageAndSchedule;
    if (input.retention) body.retention = input.retention;
    if (input.networkResources) body.networkResources = input.networkResources;
    if (input.allowedFeatures) body.allowedFeatures = input.allowedFeatures;
    if (input.alerts) body.alerts = input.alerts;
    if (input.allowPlanOverride !== undefined) body.allowPlanOverride = input.allowPlanOverride;
    if (input.overrideRestrictions) body.overrideRestrictions = input.overrideRestrictions;
    if (input.inviteUsersOrGroups) body.inviteUsersOrGroups = input.inviteUsersOrGroups;
    if (input.parentPlan) body.parentPlan = input.parentPlan;

    const result = await this.api.post<any>('/V4/LaptopPlan', body);
    const newId = result.plan?.id ?? result.planId ?? result.id ?? '?';
    return {
      success: true,
      data: result,
      display: `Laptop Plan "${planName}" erstellt (ID: ${newId}).`,
    };
  }

  // ── 6. delete — Server Plan loschen (HIGH_RISK) ──────────

  async delete(input: Record<string, unknown>): Promise<SkillResult> {
    const planId = requireId(input, 'plan_id');
    const result = await this.api.delete<any>(`/V4/ServerPlan/${planId}`);
    return {
      success: true,
      data: result,
      display: `Server Plan ${planId} geloscht.`,
    };
  }

  // ── 7. rules — Plan Auto-Assignment Rules ─────────────────

  async rules(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/Plan/Rule');
    const rules = data.rules ?? [];

    const lines = ['## Plan Rules (Auto-Assignment)', `${rules.length} Regeln`, ''];
    for (const r of rules) {
      const ruleName = r.rule?.name ?? '?';
      const ruleId = r.rule?.id ?? '?';
      const planName = r.plan?.name ?? '?';
      const planId = r.plan?.id ?? '';
      const rank = r.rank !== undefined ? ` | Rang: ${r.rank}` : '';
      const status = r.ruleStatus ?? '';
      lines.push(
        `**${ruleName}** (ID: ${ruleId})${status ? ` [${status}]` : ''}${rank}`,
      );
      lines.push(`  Plan: ${planName}${planId ? ` (ID: ${planId})` : ''}`);

      const workloads = r.workloads ?? [];
      if (workloads.length > 0) {
        lines.push(`  Workloads: ${workloads.map((w: any) => w.name ?? w.id).join(', ')}`);
      }
      const regions = r.regions ?? [];
      if (regions.length > 0) {
        lines.push(`  Regionen: ${regions.map((rg: any) => rg.name ?? rg.id).join(', ')}`);
      }
      const serverGroups = r.serverGroups ?? [];
      if (serverGroups.length > 0) {
        lines.push(`  Server-Gruppen: ${serverGroups.map((sg: any) => sg.name ?? sg.id).join(', ')}`);
      }
      const solutions = r.solutions ?? [];
      if (solutions.length > 0) {
        lines.push(`  Solutions: ${solutions.map((s: any) => s.name ?? s.id).join(', ')}`);
      }
    }

    return {
      success: true,
      data: { total: rules.length, rules },
      display: lines.join('\n'),
    };
  }

  // ── 8. ruleEntities — Entities fuer Rule-Auswertung ──────

  async ruleEntities(input: Record<string, unknown>): Promise<SkillResult> {
    // If body entities are provided, execute rule evaluation (PUT)
    const hasEntities =
      Array.isArray(input.subclients) ||
      Array.isArray(input.backupsets) ||
      Array.isArray(input.instances) ||
      Array.isArray(input.clients);

    if (hasEntities) {
      const body: Record<string, unknown> = {};
      if (input.subclients) body.subclients = input.subclients;
      if (input.backupsets) body.backupsets = input.backupsets;
      if (input.instances) body.instances = input.instances;
      if (input.clients) body.clients = input.clients;
      if (input.ignorePreviousPlanAssociation !== undefined) {
        body.ignorePreviousPlanAssociation = input.ignorePreviousPlanAssociation;
      }
      if (input.isPreviewOnly !== undefined) {
        body.isPreviewOnly = input.isPreviewOnly;
      }

      const result = await this.api.put<any>('/V4/Plan/Rule/Entities', body);
      return {
        success: true,
        data: result,
        display: `Plan-Rule-Auswertung ausgefuhrt. ${result.errorMessage ?? result.warningMessage ?? 'Erfolgreich.'}`,
      };
    }

    // Otherwise list applicable entities (GET)
    const data = await this.api.get<any>('/V4/Plan/Rule/Entities');
    const entities = data.entities ?? [];

    const lines = ['## Plan Rule — Applicable Entities', `${entities.length} Entities`, ''];
    for (const e of entities) {
      const client = e.client?.name ?? '?';
      const clientId = e.client?.id ?? '';
      const subclient = e.subclient?.name ?? '';
      const apptype = e.apptype?.name ?? '';
      const evalPlan = e.evaluatedPlan?.name ?? '';
      const currPlan = e.currentPlan?.name ?? '';

      lines.push(
        `- **${client}**${clientId ? ` (ID: ${clientId})` : ''}${subclient ? ` / ${subclient}` : ''}${apptype ? ` [${apptype}]` : ''}`,
      );
      if (evalPlan) lines.push(`  Evaluated Plan: ${evalPlan}`);
      if (currPlan) lines.push(`  Current Plan: ${currPlan}`);
    }

    return {
      success: true,
      data: { total: entities.length, entities },
      display: lines.join('\n'),
    };
  }
}
