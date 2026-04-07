import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { CmdbRepository } from '@alfred/storage';
import type { ItsmRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action = 'inventory_report' | 'topology_diagram' | 'service_map' | 'runbook' | 'change_log' | 'incident_report' | 'export';

type LlmCallback = (prompt: string, tier?: string) => Promise<string>;

export class InfraDocsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'infra_docs',
    category: 'infrastructure',
    description:
      'Infrastruktur-Dokumentation — Generiert Berichte und Diagramme aus CMDB/ITSM-Daten. ' +
      '"inventory_report" erstellt ein vollständiges Asset-Inventar (Markdown). ' +
      '"topology_diagram" generiert ein Netzwerk-Topologie-Diagramm (Mermaid). ' +
      '"service_map" erstellt eine Service-Dependency-Map (Mermaid). ' +
      '"runbook" generiert ein Runbook für einen Service via LLM (service_id). ' +
      '"change_log" zeigt die Change-History für einen Zeitraum (since, limit). ' +
      '"incident_report" erstellt ein Postmortem-Template für einen Incident (incident_id). ' +
      '"export" exportiert die gesamte CMDB als JSON.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inventory_report', 'topology_diagram', 'service_map', 'runbook', 'change_log', 'incident_report', 'export'] },
        service_id: { type: 'string' },
        incident_id: { type: 'string' },
        since: { type: 'string', description: 'ISO Datum für change_log Filter' },
        limit: { type: 'number' },
        format: { type: 'string', enum: ['json', 'yaml'], description: 'Export-Format (default: json)' },
      },
      required: ['action'],
    },
    timeoutMs: 120_000,
  };

  private readonly cmdb: CmdbRepository;
  private readonly itsm: ItsmRepository;
  private llmCallback?: LlmCallback;

  constructor(cmdbRepo: CmdbRepository, itsmRepo: ItsmRepository) {
    super();
    this.cmdb = cmdbRepo;
    this.itsm = itsmRepo;
  }

  setLlmCallback(cb: LlmCallback): void {
    this.llmCallback = cb;
  }

  /** Persist a generated document to the archive (non-blocking, fire-and-forget). */
  private async persistDoc(userId: string, docType: string, title: string, content: string, opts?: {
    format?: string; linkedEntityType?: string; linkedEntityId?: string;
  }): Promise<void> {
    try {
      await this.cmdb.saveDocument(userId, {
        docType: docType as any, title, content,
        format: (opts?.format as any) ?? 'markdown',
        linkedEntityType: opts?.linkedEntityType as any,
        linkedEntityId: opts?.linkedEntityId,
      });
    } catch { /* non-critical — don't break generation if persist fails */ }
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId || context.userId;

    try {
      switch (action) {
        case 'inventory_report': return await this.inventoryReport(userId);
        case 'topology_diagram': return await this.topologyDiagram(userId);
        case 'service_map': return await this.serviceMap(userId);
        case 'runbook': return await this.runbook(userId, input.service_id as string);
        case 'change_log': return await this.changeLog(userId, input.since as string, input.limit as number);
        case 'incident_report': return await this.incidentReport(userId, input.incident_id as string);
        case 'export': return await this.exportCmdb(userId, input.format as string);
        default: return { success: false, error: `Unbekannte Aktion: ${String(action)}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  // ── Inventory Report ───────────────────────────────────────

  private async inventoryReport(userId: string): Promise<SkillResult> {
    const assets = await this.cmdb.listAssets(userId);
    const stats = await this.cmdb.getStats(userId);
    const now = new Date().toISOString().slice(0, 16);

    // Group by type
    const grouped = new Map<string, typeof assets>();
    for (const a of assets) {
      const list = grouped.get(a.assetType) || [];
      list.push(a);
      grouped.set(a.assetType, list);
    }

    const sections: string[] = [
      `# Infrastruktur-Inventar`,
      `Stand: ${now} | ${stats.total} Assets gesamt`,
      '',
    ];

    for (const [type, items] of grouped) {
      sections.push(`## ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} (${items.length})`);
      sections.push('| Name | IP | Status | Env | Quelle | Owner |');
      sections.push('|------|----|----|-----|--------|-------|');
      for (const a of items) {
        sections.push(`| ${a.name} | ${a.ipAddress ?? '—'} | ${a.status} | ${a.environment ?? '—'} | ${a.sourceSkill ?? 'manual'} | ${a.owner ?? '—'} |`);
      }
      sections.push('');
    }

    const display = sections.join('\n');
    void this.persistDoc(userId, 'inventory', `Inventar — ${now}`, display);
    return { success: true, data: { assets, stats }, display };
  }

  // ── Topology Diagram (Mermaid) ─────────────────────────────

  private async topologyDiagram(userId: string): Promise<SkillResult> {
    const assets = await this.cmdb.listAssets(userId, { status: 'active' as any });
    const relations = await this.cmdb.getAllRelations(userId);

    // Build ID → short label map
    const idLabel = new Map<string, string>();
    const idShape = new Map<string, string>();
    for (const a of assets) {
      const label = `${a.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${a.id.slice(0, 6)}`;
      idLabel.set(a.id, label);
      // Mermaid node shapes by type
      const shapes: Record<string, string> = {
        server: `${label}[["${a.name}"]]`,      // stadium
        vm: `${label}["${a.name}"]`,              // rect
        lxc: `${label}["${a.name}"]`,
        container: `${label}("${a.name}")`,       // rounded
        service: `${label}{{"${a.name}"}}`,        // hexagon
        dns_record: `${label}>"${a.name}"]`,       // flag
        proxy_host: `${label}(["${a.name}"])`,     // cylinder-like
        firewall_rule: `${label}{"${a.name}"}`,    // diamond
        network: `${label}(("${a.name}"))`,        // circle
        network_device: `${label}[/"${a.name}"\\]`, // parallelogram
      };
      idShape.set(a.id, shapes[a.assetType] ?? `${label}["${a.name}"]`);
    }

    const lines = ['graph TD'];

    // Node definitions
    for (const a of assets) {
      const shape = idShape.get(a.id);
      if (shape) lines.push(`    ${shape}`);
    }

    // Edges
    for (const r of relations) {
      const src = idLabel.get(r.sourceAssetId);
      const tgt = idLabel.get(r.targetAssetId);
      if (src && tgt) {
        lines.push(`    ${src} -->|${r.relationType}| ${tgt}`);
      }
    }

    // Style classes
    lines.push('    classDef server fill:#e74c3c,stroke:#c0392b,color:white');
    lines.push('    classDef vm fill:#3498db,stroke:#2980b9,color:white');
    lines.push('    classDef lxc fill:#3498db,stroke:#2980b9,color:white');
    lines.push('    classDef container fill:#2ecc71,stroke:#27ae60,color:white');
    lines.push('    classDef dns fill:#f1c40f,stroke:#f39c12,color:black');
    lines.push('    classDef proxy fill:#e67e22,stroke:#d35400,color:white');
    lines.push('    classDef firewall fill:#9b59b6,stroke:#8e44ad,color:white');
    lines.push('    classDef network fill:#1abc9c,stroke:#16a085,color:white');

    for (const a of assets) {
      const label = idLabel.get(a.id);
      if (!label) continue;
      const cssClass: Record<string, string> = {
        server: 'server', vm: 'vm', lxc: 'lxc', container: 'container',
        dns_record: 'dns', proxy_host: 'proxy', firewall_rule: 'firewall',
        network: 'network', network_device: 'network',
      };
      const cls = cssClass[a.assetType];
      if (cls) lines.push(`    class ${label} ${cls}`);
    }

    const mermaid = lines.join('\n');
    const display = `## Netzwerk-Topologie\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
    void this.persistDoc(userId, 'topology', `Topologie — ${new Date().toISOString().slice(0, 10)}`, mermaid, { format: 'mermaid' });
    return { success: true, data: { mermaid, assetCount: assets.length, relationCount: relations.length }, display };
  }

  // ── Service Map (Mermaid) ──────────────────────────────────

  private async serviceMap(userId: string): Promise<SkillResult> {
    const services = await this.itsm.listServices(userId);

    if (services.length === 0) return { success: true, data: [], display: 'Keine Services registriert.' };

    const lines = ['graph LR'];
    const idLabel = new Map<string, string>();

    for (const s of services) {
      const label = `${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${s.id.slice(0, 6)}`;
      idLabel.set(s.id, label);
      const healthIcon = { healthy: '🟢', degraded: '🟡', down: '🔴', unknown: '⚫' }[s.healthStatus] ?? '⚫';
      lines.push(`    ${label}{{"${healthIcon} ${s.name}"}}`);
    }

    for (const s of services) {
      const srcLabel = idLabel.get(s.id);
      if (!srcLabel) continue;
      for (const depId of s.dependencies) {
        const tgtLabel = idLabel.get(depId);
        if (tgtLabel) lines.push(`    ${srcLabel} -->|depends_on| ${tgtLabel}`);
      }
    }

    // Style by health
    lines.push('    classDef healthy fill:#2ecc71,stroke:#27ae60,color:white');
    lines.push('    classDef degraded fill:#f1c40f,stroke:#f39c12,color:black');
    lines.push('    classDef down fill:#e74c3c,stroke:#c0392b,color:white');
    lines.push('    classDef unknown fill:#95a5a6,stroke:#7f8c8d,color:white');

    for (const s of services) {
      const label = idLabel.get(s.id);
      if (label) lines.push(`    class ${label} ${s.healthStatus}`);
    }

    const mermaid = lines.join('\n');
    const display = `## Service-Dependency-Map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
    void this.persistDoc(userId, 'service_map', `Service-Map — ${new Date().toISOString().slice(0, 10)}`, mermaid, { format: 'mermaid' });
    return { success: true, data: { mermaid, serviceCount: services.length }, display };
  }

  // ── Runbook (LLM-generated) ────────────────────────────────

  private async runbook(userId: string, serviceId: string): Promise<SkillResult> {
    if (!serviceId) return { success: false, error: 'service_id erforderlich' };
    if (!this.llmCallback) return { success: false, error: 'LLM nicht verfügbar' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    // Gather context: assets, dependencies
    const assetDetails: string[] = [];
    for (const aid of svc.assetIds) {
      const a = await this.cmdb.getAssetById(userId, aid);
      if (a) assetDetails.push(`- ${a.name} (${a.assetType}, IP: ${a.ipAddress ?? '—'}, Status: ${a.status})`);
    }

    const depNames: string[] = [];
    for (const depId of svc.dependencies) {
      const dep = await this.itsm.getServiceById(userId, depId);
      if (dep) depNames.push(dep.name);
    }

    const prompt = [
      `Erstelle ein Operations-Runbook für den folgenden Service. Schreibe auf Deutsch.`,
      ``,
      `## Service: ${svc.name}`,
      svc.description ? `Beschreibung: ${svc.description}` : '',
      svc.url ? `URL: ${svc.url}` : '',
      svc.healthCheckUrl ? `Health-Check: ${svc.healthCheckUrl}` : '',
      svc.criticality ? `Criticality: ${svc.criticality}` : '',
      svc.maintenanceWindow ? `Maintenance Window: ${svc.maintenanceWindow}` : '',
      '',
      '## Unterliegende Assets',
      assetDetails.length > 0 ? assetDetails.join('\n') : '— keine registriert —',
      '',
      depNames.length > 0 ? `## Abhängigkeiten\n${depNames.map(n => `- ${n}`).join('\n')}` : '',
      '',
      `## Erwartete Runbook-Sektionen:`,
      `1. Service-Übersicht`,
      `2. Architektur / Komponenten`,
      `3. Normale Betriebsprozeduren (Start, Stop, Restart)`,
      `4. Monitoring & Alerting`,
      `5. Häufige Probleme & Lösungen`,
      `6. Eskalationspfad`,
      `7. Disaster Recovery`,
      `8. Wartungsprozeduren`,
    ].filter(Boolean).join('\n');

    const runbookText = await this.llmCallback(prompt, 'strong');
    const display = `## Runbook: ${svc.name}\n\n${runbookText}`;

    // Persist: write-back to service + archive
    // Write-back to service documentation field (only if empty or previously generated)
    try {
      const current = await this.itsm.getServiceById(userId, serviceId);
      if (!current?.documentation || current.documentation.startsWith('## ')) {
        await this.itsm.updateService(userId, serviceId, { documentation: runbookText } as any);
      }
    } catch { /* non-critical */ }
    void this.persistDoc(userId, 'runbook', `Runbook: ${svc.name}`, runbookText, { linkedEntityType: 'service', linkedEntityId: serviceId });

    return { success: true, data: { service: svc, runbook: runbookText }, display };
  }

  // ── Change Log ─────────────────────────────────────────────

  private async changeLog(userId: string, since?: string, limit?: number): Promise<SkillResult> {
    const changes = await this.cmdb.getRecentChanges(userId, limit ?? 100, since);

    if (changes.length === 0) return { success: true, data: [], display: 'Keine Änderungen im Zeitraum.' };

    const lines = changes.map(c => {
      const icon: Record<string, string> = { discovered: '🔍', created: '➕', updated: '✏️', deleted: '🗑️', decommissioned: '⚫', status_changed: '🔄', relation_added: '🔗', relation_removed: '💔' };
      return `| ${c.createdAt?.slice(0, 16)} | ${icon[c.changeType] ?? '📋'} ${c.changeType} | ${c.fieldName ?? '—'} | ${c.oldValue?.slice(0, 30) ?? '—'} → ${c.newValue?.slice(0, 30) ?? '—'} | ${c.category} |`;
    });

    const display = `## Change Log (${changes.length} Einträge)\n\n| Datum | Typ | Feld | Wert | Kategorie |\n|-------|-----|------|------|-----------|\n${lines.join('\n')}`;
    void this.persistDoc(userId, 'change_log', `Change-Log — ${new Date().toISOString().slice(0, 10)}`, display);
    return { success: true, data: changes, display };
  }

  // ── Incident Report / Postmortem ───────────────────────────

  private async incidentReport(userId: string, incidentId: string): Promise<SkillResult> {
    if (!incidentId) return { success: false, error: 'incident_id erforderlich' };
    const inc = await this.itsm.getIncidentById(userId, incidentId);
    if (!inc) return { success: false, error: `Incident ${incidentId} nicht gefunden` };

    const assetNames: string[] = [];
    for (const aid of inc.affectedAssetIds) {
      const a = await this.cmdb.getAssetById(userId, aid);
      assetNames.push(a ? `${a.name} (${a.assetType})` : aid);
    }

    const svcNames: string[] = [];
    for (const sid of inc.affectedServiceIds) {
      const s = await this.itsm.getServiceById(userId, sid);
      svcNames.push(s ? `${s.name} (${s.criticality ?? '—'})` : sid);
    }

    const duration = inc.resolvedAt && inc.openedAt
      ? `${Math.round((new Date(inc.resolvedAt).getTime() - new Date(inc.openedAt).getTime()) / 60_000)} Minuten`
      : '— noch offen —';

    const display = [
      `# Incident Report: ${inc.title}`,
      '',
      '## Übersicht',
      `| | |`,
      `|---|---|`,
      `| **ID** | ${inc.id} |`,
      `| **Severity** | ${inc.severity} |`,
      `| **Status** | ${inc.status} |`,
      `| **Priority** | ${inc.priority} |`,
      `| **Detected by** | ${inc.detectedBy ?? '—'} |`,
      `| **Opened** | ${inc.openedAt} |`,
      `| **Resolved** | ${inc.resolvedAt ?? '—'} |`,
      `| **Duration** | ${duration} |`,
      '',
      '## Betroffene Assets',
      assetNames.length > 0 ? assetNames.map(n => `- ${n}`).join('\n') : '— keine —',
      '',
      '## Betroffene Services',
      svcNames.length > 0 ? svcNames.map(n => `- ${n}`).join('\n') : '— keine —',
      '',
      '## Symptome',
      inc.symptoms ?? '— nicht dokumentiert —',
      '',
      '## Untersuchung',
      inc.investigationNotes ?? '— keine Untersuchungsnotizen —',
      '',
      '## Root Cause',
      inc.rootCause ?? '— nicht dokumentiert (wird bei Status "resolved" gesetzt) —',
      '',
      '## Resolution',
      inc.resolution ?? '— nicht dokumentiert (wird bei Status "resolved" gesetzt) —',
      '',
      '## Workaround',
      inc.workaround ?? '— nicht dokumentiert (wird bei Status "mitigating" gesetzt) —',
      '',
      '## Timeline',
      `- ${inc.openedAt} — Incident eröffnet`,
      inc.acknowledgedAt ? `- ${inc.acknowledgedAt} — Acknowledged` : '',
      inc.resolvedAt ? `- ${inc.resolvedAt} — Resolved` : '',
      inc.closedAt ? `- ${inc.closedAt} — Closed` : '',
      '',
      '## Lessons Learned',
      inc.lessonsLearned ?? (inc.rootCause && inc.resolution
        ? `Root Cause war: ${inc.rootCause}\nLösung: ${inc.resolution}`
        : '— ausstehend —'),
      '',
      '## Action Items',
      inc.actionItems ?? [
        ...(inc.rootCause ? ['- [x] Root Cause dokumentieren'] : ['- [ ] Root Cause dokumentieren']),
        ...(inc.resolution ? ['- [x] Resolution dokumentieren'] : ['- [ ] Resolution dokumentieren']),
        '- [ ] Monitoring verbessern',
        '- [ ] Runbook aktualisieren',
      ].join('\n'),
    ].filter(Boolean).join('\n');

    // Persist: write-back to incident + archive
    // Write-back to incident postmortem field (only if empty or previously generated)
    try {
      if (!inc.postmortem || inc.postmortem.startsWith('# Incident Report')) {
        await this.itsm.updateIncident(userId, incidentId, { postmortem: display } as any);
      }
    } catch { /* non-critical */ }
    void this.persistDoc(userId, 'postmortem', `Postmortem: ${inc.title}`, display, { linkedEntityType: 'incident', linkedEntityId: incidentId });

    return { success: true, data: inc, display };
  }

  // ── Export ─────────────────────────────────────────────────

  private async exportCmdb(userId: string, format?: string): Promise<SkillResult> {
    const assets = await this.cmdb.listAssets(userId);
    const relations = await this.cmdb.getAllRelations(userId);
    const services = await this.itsm.listServices(userId);
    const incidents = await this.itsm.listIncidents(userId);
    const changeRequests = await this.itsm.listChangeRequests(userId);

    const data = {
      exportedAt: new Date().toISOString(),
      assets,
      relations,
      services,
      incidents,
      changeRequests,
    };

    // YAML format not supported (no dependency) — fall through to JSON

    const json = JSON.stringify(data, null, 2);
    return { success: true, data, display: `## CMDB Export (JSON)\n\n${assets.length} Assets, ${relations.length} Relationen, ${services.length} Services\n\nDaten im data-Feld verfügbar.` };
  }
}
