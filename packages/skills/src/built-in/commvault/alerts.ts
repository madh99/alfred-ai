/**
 * Commvault Alerts Module — 8 actions for triggered alert & alert definition management
 *
 * V4 API response field mapping (from OpenAPI3.yaml):
 *   GET  /V4/TriggeredAlerts              → { totalCount, unreadCount, alertsTriggered: AlertTriggeredSummary[] }
 *   GET  /V4/TriggeredAlerts/{id}         → TriggeredAlertsDetails (id, severity, alertType, description, detectedCriteria, ...)
 *   PUT  /V4/TriggeredAlerts/{id}/Read    → mark as read
 *   PUT  /V4/TriggeredAlerts/{id}/Unread  → mark as unread
 *   PUT  /V4/TriggeredAlerts/{id}/Pin     → pin alert
 *   PUT  /V4/TriggeredAlerts/{id}/Unpin   → unpin alert
 *   PUT  /V4/TriggeredAlerts/{id}/Notes   → add/clear notes (body: { notes: string })
 *   PUT  /V4/TriggeredAlerts/Action/Delete → bulk delete (body: { alertId: number[] })
 *   GET  /V4/AlertDefinitions             → { alertDefinitions: AlertDefinition[] }
 *   GET  /V4/AlertType                    → { alertTypes: AlertTypeItem[] }
 *   POST /V4/AlertDefinitions/{id}/Enable → enable rule
 *   POST /V4/AlertDefinitions/{id}/Disable → disable rule
 *
 * AlertTriggeredSummary: id, severity (AUTO_PICK|CRITICAL|MAJOR|INFORMATION), detectedCriterion,
 *   info, notes, type, detectedTime (unix epoch), client: {id, name}, readStatus, pinStatus, jobId
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { requireId, optionalString } from './types.js';

// ── Severity display mapping ──────────────────────────────────
const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: '\u{1F534}',    // 🔴
  MAJOR: '\u{1F7E1}',       // 🟡
  INFORMATION: '\u{1F535}',  // 🔵
  AUTO_PICK: '\u26AA',       // ⚪
};

function severityIcon(severity?: string): string {
  return severity ? (SEVERITY_ICON[severity] ?? '\u26AA') : '\u26AA';
}

/** Format a unix epoch timestamp to a readable date string. */
function formatEpoch(epoch?: number): string {
  if (!epoch) return '?';
  return new Date(epoch * 1000).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export class CommvaultAlerts {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Triggered Alerts auflisten ────────────────────

  async list(input: Record<string, unknown>): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/TriggeredAlerts');
    const totalCount: number = data.totalCount ?? 0;
    const unreadCount: number = data.unreadCount ?? 0;
    let alerts: any[] = data.alertsTriggered ?? [];

    // Optional severity filter
    const severityFilter = optionalString(input, 'severity')?.toUpperCase();
    if (severityFilter) {
      alerts = alerts.filter((a: any) => a.severity === severityFilter);
    }

    const lines = [
      '## Commvault Triggered Alerts',
      `Gesamt: ${totalCount} | Ungelesen: ${unreadCount}${severityFilter ? ` | Filter: ${severityFilter}` : ''}`,
      '',
    ];

    if (alerts.length === 0) {
      lines.push('Keine Alerts gefunden.');
    } else {
      for (const a of alerts) {
        const icon = severityIcon(a.severity);
        const info = a.info ?? a.detectedCriterion ?? '?';
        const client = a.client?.name ?? '';
        const time = formatEpoch(a.detectedTime);
        const flags: string[] = [];
        if (a.readStatus === true) flags.push('gelesen');
        if (a.readStatus === false) flags.push('ungelesen');
        if (a.pinStatus === true) flags.push('\u{1F4CC}');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

        lines.push(
          `${icon} **${info}**${client ? ` — ${client}` : ''} (ID: ${a.id ?? '?'})`,
          `  ${time}${a.type ? ` | ${a.type}` : ''}${flagStr}`,
        );
        if (a.notes) lines.push(`  Notiz: ${a.notes}`);
      }
    }

    return {
      success: true,
      data: { totalCount, unreadCount, count: alerts.length, alerts },
      display: lines.join('\n'),
    };
  }

  // ── 2. detail — Triggered Alert Details ─────────────────────

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'alert_id');
    const data = await this.api.get<any>(`/V4/TriggeredAlerts/${id}`);

    const icon = severityIcon(data.severity);
    const lines = [
      `## ${icon} Alert Detail (ID: ${id})`,
      '',
    ];

    if (data.severity) lines.push(`**Severity:** ${data.severity}`);
    if (data.alertType) lines.push(`**Typ:** ${data.alertType}`);
    if (data.detectedCriteria) lines.push(`**Kriterium:** ${data.detectedCriteria}`);
    if (data.description) {
      // Strip HTML tags for plain-text display
      const plainDesc = String(data.description).replace(/<[^>]*>/g, '').trim();
      if (plainDesc) lines.push(`**Beschreibung:** ${plainDesc}`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── 3. read — Alert als gelesen markieren ───────────────────

  async read(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'alert_id');
    const unread = input.unread === true || input.unread === 'true';

    if (unread) {
      await this.api.put(`/V4/TriggeredAlerts/${id}/Unread`);
      return { success: true, display: `Alert ${id} als ungelesen markiert.` };
    }

    await this.api.put(`/V4/TriggeredAlerts/${id}/Read`);
    return { success: true, display: `Alert ${id} als gelesen markiert.` };
  }

  // ── 4. pin — Alert pinnen / entpinnen ───────────────────────

  async pin(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'alert_id');
    const unpin = input.unpin === true || input.unpin === 'true';

    if (unpin) {
      await this.api.put(`/V4/TriggeredAlerts/${id}/Unpin`);
      return { success: true, display: `Alert ${id} entpinnt.` };
    }

    await this.api.put(`/V4/TriggeredAlerts/${id}/Pin`);
    return { success: true, display: `\u{1F4CC} Alert ${id} gepinnt.` };
  }

  // ── 5. delete — Alerts loschen (einzeln oder mehrere) ───────

  async delete(input: Record<string, unknown>): Promise<SkillResult> {
    let ids: number[];

    if (Array.isArray(input.alert_ids)) {
      ids = (input.alert_ids as unknown[]).map((v) => {
        const n = typeof v === 'number' ? v : parseInt(String(v), 10);
        if (isNaN(n)) throw new Error(`Ungueltige Alert-ID: ${v}`);
        return n;
      });
    } else {
      ids = [requireId(input, 'alert_id')];
    }

    await this.api.put('/V4/TriggeredAlerts/Action/Delete', { alertId: ids });

    return {
      success: true,
      data: { deletedIds: ids },
      display: `${ids.length} Alert(s) geloescht (IDs: ${ids.join(', ')}).`,
    };
  }

  // ── 6. addNote — Notiz zu Alert hinzufuegen ─────────────────

  async addNote(input: Record<string, unknown>): Promise<SkillResult> {
    const id = requireId(input, 'alert_id');
    const notes = optionalString(input, 'notes') ?? '';

    await this.api.put(`/V4/TriggeredAlerts/${id}/Notes`, { notes });

    return {
      success: true,
      display: notes
        ? `Notiz zu Alert ${id} hinzugefuegt.`
        : `Notiz von Alert ${id} entfernt.`,
    };
  }

  // ── 7. rules — Alert Definitions auflisten ─────────────────

  async rules(input: Record<string, unknown>): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/AlertDefinitions');
    const defs: any[] = data.alertDefinitions ?? [];

    // Optional: enable/disable a rule inline
    const enableId = input.enable_id !== undefined ? requireId(input, 'enable_id') : undefined;
    const disableId = input.disable_id !== undefined ? requireId(input, 'disable_id') : undefined;

    if (enableId !== undefined) {
      await this.api.post(`/V4/AlertDefinitions/${enableId}/Enable`);
      return { success: true, display: `Alert-Regel ${enableId} aktiviert.` };
    }
    if (disableId !== undefined) {
      await this.api.post(`/V4/AlertDefinitions/${disableId}/Disable`);
      return { success: true, display: `Alert-Regel ${disableId} deaktiviert.` };
    }

    const lines = ['## Commvault Alert Definitions', `${defs.length} Regeln`, ''];

    for (const d of defs) {
      const status = d.enabled === true ? '\u2705' : d.enabled === false ? '\u274C' : '\u2753';
      const category = d.category ? ` [${d.category}]` : '';
      const typ = d.type ? ` — ${d.type}` : '';
      lines.push(`${status} **${d.name ?? '?'}** (ID: ${d.id ?? '?'})${category}${typ}`);
    }

    return {
      success: true,
      data: { total: defs.length, alertDefinitions: defs },
      display: lines.join('\n'),
    };
  }

  // ── 8. types — Alert Types auflisten ────────────────────────

  async types(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/AlertType');
    const types: any[] = data.alertTypes ?? [];

    const lines = ['## Commvault Alert Types', `${types.length} Typen`, ''];

    for (const t of types) {
      const category = t.category?.name ?? t.categoryType?.name ?? '?';
      const criteria = t.criteria?.name ?? '';
      lines.push(`- **${category}**${criteria ? `: ${criteria}` : ''}`);
    }

    return {
      success: true,
      data: { total: types.length, alertTypes: types },
      display: lines.join('\n'),
    };
  }
}
