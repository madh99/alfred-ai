/**
 * Commvault Commcell Module — 12 actions for Commcell Operations, DR & Restore
 *
 * API response field mapping:
 *   POST /V4/Commcell/{op}/Action/{Enable|Disable} → { errorCode, errorMessage }
 *   GET  /V4/GlobalSettings                        → { GlobalSettings: [...] }
 *   GET  /V4/License                               → { licenseSummary: {...} }
 *   GET  /V4/Schedule/list                          → { schedules: [...] }
 *   GET  /V4/SchedulePolicy/list                    → { policies: [...] }
 *   GET  /V4/ReplicationGroup                       → { replicationGroups: [...] }
 *   GET  /V4/ArrayReplicationMonitor                → { replications: [...] }
 *   POST /V4/FailoverGroups                         → { taskId, jobId, ... }
 *   GET  /V4/RecoveryTargets                        → { recoveryTargets: [...] }
 *   GET  /V4/AnomalousConditions                    → { anomalousConditions: [...] }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';

const VALID_OPERATIONS = [
  'Backup',
  'Restore',
  'Scheduler',
  'DataAging',
  'DDB',
  'DataVerification',
  'AuxillaryCopy',
  'ContentIndexing',
  'AllJobActivity',
] as const;

type CommcellOperation = (typeof VALID_OPERATIONS)[number];

function validateOperation(input: Record<string, unknown>): CommcellOperation {
  const op = input.operation;
  if (!op || typeof op !== 'string') {
    throw new Error(`Parameter "operation" ist erforderlich. Gueltige Werte: ${VALID_OPERATIONS.join(', ')}`);
  }
  const match = VALID_OPERATIONS.find((v) => v.toLowerCase() === op.toLowerCase());
  if (!match) {
    throw new Error(`Ungueltige Operation "${op}". Gueltige Werte: ${VALID_OPERATIONS.join(', ')}`);
  }
  return match;
}

export class CommvaultCommcell {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. status — Commcell-Operationen Status ─────────────────

  async status(): Promise<SkillResult> {
    const results: Array<{ operation: string; enabled: boolean | null; error?: string }> = [];

    // Query each operation by trying to read its state.
    // The API doesn't have a dedicated "get status" endpoint — we check
    // the global settings for operation flags.
    const data = await this.api.get<any>('/V4/GlobalSettings');
    const settings: any[] = data.GlobalSettings ?? data.globalSettings ?? [];

    // Build a lookup map for operation-related settings
    const settingsMap = new Map<string, any>();
    for (const s of settings) {
      const name = (s.name ?? s.settingName ?? '').toLowerCase();
      settingsMap.set(name, s);
    }

    for (const op of VALID_OPERATIONS) {
      // Try common setting name patterns
      const key = op.toLowerCase();
      const setting = settingsMap.get(key)
        ?? settingsMap.get(`${key}activity`)
        ?? settingsMap.get(`${key}_activity`)
        ?? settingsMap.get(`enable${key}`);

      if (setting) {
        const val = setting.value ?? setting.settingValue;
        results.push({
          operation: op,
          enabled: val === true || val === 'true' || val === 1 || val === '1',
        });
      } else {
        results.push({ operation: op, enabled: null });
      }
    }

    const lines = ['## Commcell Operations Status', ''];

    for (const r of results) {
      const icon = r.enabled === true ? '[ON]' : r.enabled === false ? '[OFF]' : '[??]';
      const label = r.enabled === true ? 'Aktiviert' : r.enabled === false ? 'Deaktiviert' : 'Unbekannt';
      lines.push(`${icon} **${r.operation}** — ${label}`);
    }

    return {
      success: true,
      data: { operations: results, settings },
      display: lines.join('\n'),
    };
  }

  // ── 2. enable — Commcell-Operation aktivieren (HIGH_RISK) ───

  async enable(input: Record<string, unknown>): Promise<SkillResult> {
    const op = validateOperation(input);

    const result = await this.api.post<any>(`/V4/Commcell/${op}/Action/Enable`);

    const errCode = result.errorCode ?? result.error?.errorCode ?? 0;
    if (errCode !== 0) {
      const errMsg = result.errorMessage ?? result.error?.errorMessage ?? 'Unbekannter Fehler';
      return {
        success: false,
        data: result,
        error: `Operation "${op}" konnte nicht aktiviert werden: ${errMsg} (Code ${errCode})`,
      };
    }

    return {
      success: true,
      data: result,
      display: `[ON] Commcell-Operation **${op}** wurde aktiviert.`,
    };
  }

  // ── 3. disable — Commcell-Operation deaktivieren (HIGH_RISK)

  async disable(input: Record<string, unknown>): Promise<SkillResult> {
    const op = validateOperation(input);

    const result = await this.api.post<any>(`/V4/Commcell/${op}/Action/Disable`);

    const errCode = result.errorCode ?? result.error?.errorCode ?? 0;
    if (errCode !== 0) {
      const errMsg = result.errorMessage ?? result.error?.errorMessage ?? 'Unbekannter Fehler';
      return {
        success: false,
        data: result,
        error: `Operation "${op}" konnte nicht deaktiviert werden: ${errMsg} (Code ${errCode})`,
      };
    }

    return {
      success: true,
      data: result,
      display: `[OFF] Commcell-Operation **${op}** wurde deaktiviert.`,
    };
  }

  // ── 4. globalSettings — Globale Einstellungen ───────────────

  async globalSettings(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/GlobalSettings');
    const settings: any[] = data.GlobalSettings ?? data.globalSettings ?? [];

    const lines = ['## Commcell Global Settings', `${settings.length} Einstellungen`, ''];

    for (const s of settings.slice(0, 50)) {
      const name = s.name ?? s.settingName ?? '?';
      const value = s.value ?? s.settingValue ?? '-';
      const comment = s.comment ?? s.description ?? '';
      lines.push(`- **${name}**: ${value}${comment ? ` _(${comment})_` : ''}`);
    }

    if (settings.length > 50) lines.push(`\n... und ${settings.length - 50} weitere Einstellungen`);

    return {
      success: true,
      data: { total: settings.length, settings },
      display: lines.join('\n'),
    };
  }

  // ── 5. license — Lizenz-Informationen ───────────────────────

  async license(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/License');
    const summary = data.licenseSummary ?? data;
    const licenses: any[] = summary.licenses ?? data.licenses ?? [];

    const lines = ['## Commvault Lizenzen', ''];

    if (summary.commcellName) lines.push(`**CommCell:** ${summary.commcellName}`);
    if (summary.csHostname) lines.push(`**Hostname:** ${summary.csHostname}`);
    if (summary.expiryDate) lines.push(`**Ablaufdatum:** ${summary.expiryDate}`);
    if (summary.registrationStatus !== undefined) {
      lines.push(`**Registrierung:** ${summary.registrationStatus}`);
    }

    if (licenses.length > 0) {
      lines.push('', '### Lizenzen');
      for (const lic of licenses.slice(0, 30)) {
        const name = lic.licenseName ?? lic.appTypeName ?? '?';
        const status = lic.licenseStatus ?? lic.status ?? '-';
        const count = lic.totalLicenseCount ?? lic.licensedCount ?? '';
        const used = lic.usedLicenseCount ?? lic.usedCount ?? '';
        lines.push(`- **${name}**: ${status}${count ? ` (${used}/${count})` : ''}`);
      }
      if (licenses.length > 30) lines.push(`\n... und ${licenses.length - 30} weitere Lizenzen`);
    }

    return {
      success: true,
      data: { summary, licenses },
      display: lines.join('\n'),
    };
  }

  // ── 6. schedules — Alle Schedules auflisten ─────────────────

  async schedules(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/Schedule/list');
    const schedules: any[] = data.schedules ?? [];

    const lines = ['## Commvault Schedules', `${schedules.length} Schedules`, ''];

    for (const s of schedules.slice(0, 50)) {
      const name = s.scheduleName ?? s.name ?? '?';
      const id = s.scheduleId ?? s.id ?? '?';
      const policyName = s.schedulePolicyName ?? s.policyName ?? '';
      const freq = s.frequency?.freq_type ?? s.freq_type ?? '';
      const nextRun = s.nextRunTime ?? '';
      lines.push(
        `- **${name}** (ID ${id})${policyName ? ` | Policy: ${policyName}` : ''}${freq ? ` | Freq: ${freq}` : ''}${nextRun ? ` | Naechster Lauf: ${nextRun}` : ''}`,
      );
    }

    if (schedules.length > 50) lines.push(`\n... und ${schedules.length - 50} weitere Schedules`);

    return {
      success: true,
      data: { total: schedules.length, schedules },
      display: lines.join('\n'),
    };
  }

  // ── 7. schedulePolicies — Schedule Policies auflisten ───────

  async schedulePolicies(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/SchedulePolicy/list');
    const policies: any[] = data.policies ?? data.schedulePolicies ?? [];

    const lines = ['## Commvault Schedule Policies', `${policies.length} Policies`, ''];

    for (const p of policies.slice(0, 50)) {
      const name = p.policyName ?? p.name ?? '?';
      const id = p.policyId ?? p.id ?? '?';
      const type = p.policyType ?? p.type ?? '';
      const schedCount = p.schedules?.length ?? p.associations?.length ?? '';
      lines.push(
        `- **${name}** (ID ${id})${type ? ` | Typ: ${type}` : ''}${schedCount ? ` | ${schedCount} Schedules` : ''}`,
      );
    }

    if (policies.length > 50) lines.push(`\n... und ${policies.length - 50} weitere Policies`);

    return {
      success: true,
      data: { total: policies.length, policies },
      display: lines.join('\n'),
    };
  }

  // ── 8. replicationGroups — Replikationsgruppen ──────────────

  async replicationGroups(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/ReplicationGroup');
    const groups: any[] = data.replicationGroups ?? [];

    const lines = ['## Commvault Replication Groups', `${groups.length} Gruppen`, ''];

    for (const g of groups.slice(0, 50)) {
      const name = g.name ?? g.replicationGroupName ?? '?';
      const id = g.id ?? g.replicationGroupId ?? '?';
      const state = g.state ?? g.status ?? '-';
      const source = g.sourceName ?? g.source?.name ?? '';
      const dest = g.destinationName ?? g.destination?.name ?? '';
      lines.push(
        `- **${name}** (ID ${id}) — ${state}${source ? ` | Quelle: ${source}` : ''}${dest ? ` | Ziel: ${dest}` : ''}`,
      );
    }

    if (groups.length > 50) lines.push(`\n... und ${groups.length - 50} weitere Gruppen`);

    return {
      success: true,
      data: { total: groups.length, groups },
      display: lines.join('\n'),
    };
  }

  // ── 9. replicationStatus — Replikations-Monitor ─────────────

  async replicationStatus(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/ArrayReplicationMonitor');
    const replications: any[] = data.replications ?? data.replicationMonitor ?? [];

    const lines = ['## Commvault Replication Monitor', `${replications.length} Eintraege`, ''];

    for (const r of replications.slice(0, 50)) {
      const name = r.name ?? r.pairName ?? '?';
      const state = r.state ?? r.status ?? '-';
      const rpo = r.RPO ?? r.rpo ?? '';
      const lag = r.replicationLag ?? r.lag ?? '';
      const icon = (state ?? '').toLowerCase().includes('healthy') ? '[OK]'
        : (state ?? '').toLowerCase().includes('error') || (state ?? '').toLowerCase().includes('critical') ? '[!!]'
        : '[--]';
      lines.push(
        `${icon} **${name}** — ${state}${rpo ? ` | RPO: ${rpo}` : ''}${lag ? ` | Lag: ${lag}` : ''}`,
      );
    }

    if (replications.length > 50) lines.push(`\n... und ${replications.length - 50} weitere Eintraege`);

    return {
      success: true,
      data: { total: replications.length, replications },
      display: lines.join('\n'),
    };
  }

  // ── 10. failover — Failover ausfuehren (HIGH_RISK) ──────────

  async failover(input: Record<string, unknown>): Promise<SkillResult> {
    const groupId = input.group_id ?? input.groupId ?? input.failoverGroupId;
    if (!groupId) {
      throw new Error('Parameter "group_id" ist erforderlich');
    }

    const operationType = typeof input.operation_type === 'string'
      ? input.operation_type
      : 'Planned Failover';

    const body: Record<string, unknown> = {
      failoverGroupId: Number(groupId),
      operationType,
    };

    if (input.replication_group_id !== undefined) {
      body.replicationGroupId = Number(input.replication_group_id);
    }

    const result = await this.api.post<any>('/V4/FailoverGroups', body);

    const errCode = result.errorCode ?? result.error?.errorCode ?? 0;
    if (errCode !== 0) {
      const errMsg = result.errorMessage ?? result.error?.errorMessage ?? 'Unbekannter Fehler';
      return {
        success: false,
        data: result,
        error: `Failover fehlgeschlagen: ${errMsg} (Code ${errCode})`,
      };
    }

    const taskId = result.taskId ?? result.jobId ?? '?';
    return {
      success: true,
      data: result,
      display: `Failover gestartet fuer Gruppe ${groupId} (${operationType}).\nTask-ID: ${taskId}`,
    };
  }

  // ── 11. recoveryTargets — Recovery Targets auflisten ────────

  async recoveryTargets(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/RecoveryTargets');
    const targets: any[] = data.recoveryTargets ?? [];

    const lines = ['## Commvault Recovery Targets', `${targets.length} Targets`, ''];

    for (const t of targets.slice(0, 50)) {
      const name = t.name ?? '?';
      const id = t.id ?? '?';
      const type = t.destinationType ?? t.type ?? '-';
      const policy = t.policyName ?? t.policy?.name ?? '';
      lines.push(
        `- **${name}** (ID ${id}) — ${type}${policy ? ` | Policy: ${policy}` : ''}`,
      );
    }

    if (targets.length > 50) lines.push(`\n... und ${targets.length - 50} weitere Targets`);

    return {
      success: true,
      data: { total: targets.length, targets },
      display: lines.join('\n'),
    };
  }

  // ── 12. anomalies — Anomalie-Erkennung ──────────────────────

  async anomalies(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/AnomalousConditions');
    const conditions: any[] = data.anomalousConditions ?? [];

    const lines = ['## Commvault Anomalien', `${conditions.length} Anomalien erkannt`, ''];

    if (conditions.length === 0) {
      lines.push('Keine Anomalien erkannt.');
    }

    for (const c of conditions.slice(0, 50)) {
      const type = c.anomalyType ?? c.type ?? '?';
      const severity = c.severity ?? '-';
      const desc = c.description ?? c.message ?? '';
      const entity = c.entityName ?? c.entity?.name ?? '';
      const time = c.detectedTime ?? c.timestamp ?? '';
      const icon = (severity ?? '').toLowerCase().includes('critical') ? '[!!]'
        : (severity ?? '').toLowerCase().includes('warning') ? '[!]'
        : '[--]';
      lines.push(
        `${icon} **${type}** (${severity})${entity ? ` — ${entity}` : ''}${desc ? `: ${desc}` : ''}${time ? ` | ${time}` : ''}`,
      );
    }

    if (conditions.length > 50) lines.push(`\n... und ${conditions.length - 50} weitere Anomalien`);

    return {
      success: true,
      data: { total: conditions.length, conditions },
      display: lines.join('\n'),
    };
  }
}
