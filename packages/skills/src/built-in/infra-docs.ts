import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { CmdbRepository } from '@alfred/storage';
import type { ItsmRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action =
  | 'inventory_report' | 'topology_diagram' | 'service_map' | 'runbook' | 'change_log' | 'incident_report' | 'export'
  // CRUD
  | 'create_doc' | 'get_doc' | 'update_doc' | 'delete_doc' | 'list_docs' | 'search_docs'
  // Auto-Generate
  | 'generate_system_doc' | 'generate_service_doc' | 'generate_network_doc' | 'generate_config_snapshot'
  // Runbook Management
  | 'create_runbook' | 'get_runbook' | 'update_runbook' | 'suggest_runbook' | 'execute_runbook'
  // Versioning
  | 'doc_versions' | 'doc_diff' | 'doc_revert';

type LlmCallback = (prompt: string, tier?: string) => Promise<string>;

export class InfraDocsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'infra_docs',
    category: 'infrastructure',
    description:
      'Infrastruktur-Dokumentation — Generiert, verwaltet und versioniert IT-Dokumentation aus CMDB/ITSM-Daten. ' +
      'Reports: "inventory_report", "topology_diagram" (Mermaid), "service_map" (Mermaid), "change_log", "incident_report", "export". ' +
      'CRUD: "create_doc", "get_doc", "update_doc", "delete_doc", "list_docs", "search_docs". ' +
      'Auto-Generate: "generate_system_doc" (asset_id, deep_scan=true fuer SSH-Scan mit OS/Pakete/Services/Docker/Ports), "generate_service_doc" (service_id), "generate_network_doc" (scope), "generate_config_snapshot" (asset_id). Wenn der User "deep scan", "vollstaendig", "detailliert", "komplett" sagt → deep_scan=true setzen. ' +
      'Runbooks: "create_runbook", "get_runbook", "update_runbook", "suggest_runbook", "execute_runbook". ' +
      'Versioning: "doc_versions", "doc_diff" (version_a/version_b), "doc_revert" (target_version). ' +
      '"runbook" generiert ein Runbook für einen Service via LLM (service_id).',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'inventory_report', 'topology_diagram', 'service_map', 'runbook', 'change_log', 'incident_report', 'export',
            'create_doc', 'get_doc', 'update_doc', 'delete_doc', 'list_docs', 'search_docs',
            'generate_system_doc', 'generate_service_doc', 'generate_network_doc', 'generate_config_snapshot',
            'create_runbook', 'get_runbook', 'update_runbook', 'suggest_runbook', 'execute_runbook',
            'doc_versions', 'doc_diff', 'doc_revert',
          ],
        },
        service_id: { type: 'string' },
        incident_id: { type: 'string' },
        since: { type: 'string', description: 'ISO Datum für change_log Filter' },
        limit: { type: 'number' },
        format: { type: 'string', enum: ['json', 'yaml'], description: 'Export-Format (default: json)' },
        doc_id: { type: 'string', description: 'Document ID' },
        doc_type: { type: 'string', enum: ['system_doc', 'service_doc', 'setup_guide', 'config_snapshot', 'runbook', 'sop', 'network_doc', 'policy', 'postmortem', 'custom'] },
        title: { type: 'string', description: 'Dokument-Titel' },
        content: { type: 'string', description: 'Dokument-Inhalt (Markdown)' },
        linked_entity_type: { type: 'string', enum: ['asset', 'service', 'incident', 'change_request', 'problem'] },
        linked_entity_id: { type: 'string' },
        query: { type: 'string', description: 'Suchbegriff' },
        asset_id: { type: 'string', description: 'Asset ID oder Name' },
        deep_scan: { type: 'boolean', description: 'SSH Deep Scan — liest OS, Pakete, Services, Docker, Netzwerk direkt vom System. Setze auf true wenn User "deep scan", "vollstaendig", "detailliert", "komplett" sagt.' },
        runbook_id: { type: 'string', description: 'Runbook ID' },
        auto_generate: { type: 'boolean', description: 'LLM-generierter Inhalt' },
        scope: { type: 'string', enum: ['full', 'vlan', 'firewall', 'dns'] },
        version_a: { type: 'number' },
        version_b: { type: 'number' },
        target_version: { type: 'number' },
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

  private sshCallback?: (host: string, command: string) => Promise<string>;
  setSshCallback(cb: (host: string, command: string) => Promise<string>): void {
    this.sshCallback = cb;
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
        // CRUD
        case 'create_doc': return await this.createDoc(userId, input);
        case 'get_doc': return await this.getDoc(userId, input);
        case 'update_doc': return await this.updateDoc(userId, input);
        case 'delete_doc': return await this.deleteDoc(userId, input);
        case 'list_docs': return await this.listDocs(userId, input);
        case 'search_docs': return await this.searchDocs(userId, input);
        // Auto-Generate
        case 'generate_system_doc': return await this.generateSystemDoc(userId, input);
        case 'generate_service_doc': return await this.generateServiceDoc(userId, input);
        case 'generate_network_doc': return await this.generateNetworkDoc(userId, input);
        case 'generate_config_snapshot': return await this.generateConfigSnapshot(userId, input);
        // Runbook Management
        case 'create_runbook': return await this.createRunbook(userId, input);
        case 'get_runbook': return await this.getRunbook(userId, input);
        case 'update_runbook': return await this.updateRunbook(userId, input);
        case 'suggest_runbook': return await this.suggestRunbook(userId, input);
        case 'execute_runbook': return await this.executeRunbook(userId, input);
        // Versioning
        case 'doc_versions': return await this.docVersions(userId, input);
        case 'doc_diff': return await this.docDiff(userId, input);
        case 'doc_revert': return await this.docRevert(userId, input);
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
        cluster: `${label}[["${a.name}"]]`,        // subroutine shape
        server: `${label}[["${a.name}"]]`,        // stadium
        vm: `${label}["${a.name}"]`,              // rect
        lxc: `${label}["${a.name}"]`,
        container: `${label}("${a.name}")`,       // rounded
        storage: `${label}[("${a.name}")]`,       // cylinder
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
    lines.push('    classDef cluster fill:#8e44ad,stroke:#6c3483,color:white');
    lines.push('    classDef server fill:#e74c3c,stroke:#c0392b,color:white');
    lines.push('    classDef vm fill:#3498db,stroke:#2980b9,color:white');
    lines.push('    classDef lxc fill:#3498db,stroke:#2980b9,color:white');
    lines.push('    classDef container fill:#2ecc71,stroke:#27ae60,color:white');
    lines.push('    classDef storage fill:#95a5a6,stroke:#7f8c8d,color:white');
    lines.push('    classDef dns fill:#f1c40f,stroke:#f39c12,color:black');
    lines.push('    classDef proxy fill:#e67e22,stroke:#d35400,color:white');
    lines.push('    classDef firewall fill:#9b59b6,stroke:#8e44ad,color:white');
    lines.push('    classDef network fill:#1abc9c,stroke:#16a085,color:white');

    for (const a of assets) {
      const label = idLabel.get(a.id);
      if (!label) continue;
      const cssClass: Record<string, string> = {
        cluster: 'cluster', server: 'server', vm: 'vm', lxc: 'lxc', container: 'container',
        storage: 'storage', dns_record: 'dns', proxy_host: 'proxy', firewall_rule: 'firewall',
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

  // ── CRUD ───────────────────────────────────────────────────

  private async createDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    const content = input.content as string;
    const docType = (input.doc_type as string) || 'custom';
    if (!title || !content) return { success: false, error: 'title und content erforderlich' };

    const doc = await this.cmdb.saveDocument(userId, {
      docType: docType as any,
      title,
      content,
      format: (input.format as any) ?? 'markdown',
      linkedEntityType: input.linked_entity_type as any,
      linkedEntityId: input.linked_entity_id as string | undefined,
      generatedBy: 'user',
    });
    return { success: true, data: doc, display: `Dokument erstellt: **${doc.title}** (ID: ${doc.id}, Version ${doc.version})` };
  }

  private async getDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = (input.doc_id ?? input.runbook_id) as string;
    if (!docId) return { success: false, error: 'doc_id erforderlich' };

    const doc = await this.cmdb.getDocumentById(userId, docId);
    if (!doc) return { success: false, error: `Dokument ${docId} nicht gefunden` };
    return { success: true, data: doc, display: `## ${doc.title}\n\n${doc.content}` };
  }

  private async updateDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = (input.doc_id ?? input.runbook_id) as string;
    const content = input.content as string;
    if (!docId || !content) return { success: false, error: 'doc_id und content erforderlich' };

    const doc = await this.cmdb.updateDocument(userId, docId, {
      title: input.title as string | undefined,
      content,
    });
    if (!doc) return { success: false, error: `Dokument ${docId} nicht gefunden` };
    return { success: true, data: doc, display: `Dokument aktualisiert: **${doc.title}** (Version ${doc.version})` };
  }

  private async deleteDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = input.doc_id as string;
    if (!docId) return { success: false, error: 'doc_id erforderlich' };

    const deleted = await this.cmdb.deleteDocument(userId, docId);
    if (!deleted) return { success: false, error: `Dokument ${docId} nicht gefunden oder bereits gelöscht` };
    return { success: true, display: `Dokument ${docId} gelöscht.` };
  }

  private async listDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docs = await this.cmdb.listDocuments(userId, {
      docType: input.doc_type as any,
      entityType: input.linked_entity_type as any,
      limit: (input.limit as number) ?? 50,
    });

    if (docs.length === 0) return { success: true, data: [], display: 'Keine Dokumente gefunden.' };

    const lines = docs.map(d =>
      `| ${d.id.slice(0, 8)}… | ${d.docType} | ${d.title} | v${d.version} | ${d.createdAt?.slice(0, 16)} |`,
    );
    const display = `## Dokumente (${docs.length})\n\n| ID | Typ | Titel | Version | Erstellt |\n|----|-----|-------|---------|----------|\n${lines.join('\n')}`;
    return { success: true, data: docs, display };
  }

  private async searchDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) return { success: false, error: 'query erforderlich' };

    const docs = await this.cmdb.searchDocuments(userId, query, {
      docType: input.doc_type as string | undefined,
      limit: (input.limit as number) ?? 20,
    });

    if (docs.length === 0) return { success: true, data: [], display: `Keine Dokumente für "${query}" gefunden.` };

    const lines = docs.map(d =>
      `| ${d.id.slice(0, 8)}… | ${d.docType} | ${d.title} | v${d.version} |`,
    );
    const display = `## Suchergebnisse: "${query}" (${docs.length})\n\n| ID | Typ | Titel | Version |\n|----|-----|-------|---------|\n${lines.join('\n')}`;
    return { success: true, data: docs, display };
  }

  // ── Auto-Generate ─────────────────────────────────────────

  private async resolveAsset(userId: string, input: Record<string, unknown>): Promise<any | null> {
    const id = (input.asset_id ?? input.asset_name) as string;
    if (!id) return null;
    // Try by ID first (UUID), then by name
    const byId = await this.cmdb.getAssetById(userId, id);
    if (byId) return byId;
    // Search by name (case-insensitive)
    const all = await this.cmdb.listAssets(userId, {});
    return all.find(a => a.name.toLowerCase() === id.toLowerCase()) ?? null;
  }

  private async generateSystemDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const asset = await this.resolveAsset(userId, input);
    if (!asset) return { success: false, error: `Asset "${input.asset_id ?? input.asset_name}" nicht gefunden` };
    const assetId = asset.id;
    const deepScan = input.deep_scan === true || input.deep === true;

    const relations = await this.cmdb.getRelationsForAsset(userId, assetId);
    const relatedAssets: string[] = [];
    for (const r of relations) {
      const otherId = r.sourceAssetId === assetId ? r.targetAssetId : r.sourceAssetId;
      const other = await this.cmdb.getAssetById(userId, otherId);
      if (other) relatedAssets.push(`- ${other.name} (${other.assetType}, ${r.relationType})`);
    }

    // Deep scan: SSH into the VM to read OS, packages, services, network, docker
    let sshData = '';
    if (deepScan && this.sshCallback) {
      const host = asset.ipAddress ?? asset.hostname ?? asset.fqdn ?? asset.name;
      try {
        const commands: Record<string, string> = {
          'OS': 'cat /etc/os-release 2>/dev/null | head -5',
          'Hostname': 'hostname -f 2>/dev/null',
          'IP-Adressen': 'ip -4 addr show 2>/dev/null | grep inet | grep -v 127.0.0.1',
          'CPU': 'nproc 2>/dev/null && cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1',
          'RAM': 'free -h 2>/dev/null | head -2',
          'Disk': 'df -h 2>/dev/null | grep -E "^/dev|Filesystem"',
          'Laufende Services': 'systemctl list-units --type=service --state=running --no-pager 2>/dev/null | head -30',
          'Installierte Pakete (Top 30)': 'dpkg -l 2>/dev/null | tail -n +6 | head -30 || rpm -qa 2>/dev/null | sort | head -30',
          'Docker Container': 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || sudo docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(kein Docker)"',
          'Offene Ports': 'ss -tlnp 2>/dev/null | head -20',
          'Uptime': 'uptime 2>/dev/null',
        };

        const sections: string[] = [];
        let dockerOutput = '';
        for (const [label, cmd] of Object.entries(commands)) {
          try {
            const output = await this.sshCallback(host, cmd);
            if (output.trim()) {
              sections.push(`### ${label}\n\`\`\`\n${output.trim()}\n\`\`\``);
              if (label === 'Docker Container') dockerOutput = output.trim();
            }
          } catch { /* skip individual command */ }
        }
        if (sections.length > 0) sshData = '\n\n## Live-Daten (SSH Deep Scan)\n\n' + sections.join('\n\n');

        // Auto-register discovered Docker containers as CMDB assets
        if (dockerOutput && !dockerOutput.includes('(kein Docker)')) {
          try {
            const lines = dockerOutput.split('\n').slice(1); // skip header
            for (const line of lines) {
              const parts = line.split(/\t+/).map(s => s.trim());
              if (parts.length < 2 || !parts[0]) continue;
              const containerName = parts[0];
              const image = parts[1] ?? '';
              const status = parts[2] ?? '';
              const ports = parts[3] ?? '';
              const isRunning = status.toLowerCase().startsWith('up');
              await this.cmdb.upsertAsset(userId, {
                name: containerName,
                assetType: 'container' as any,
                sourceSkill: 'deep_scan',
                sourceId: `${assetId}:${containerName}`,
                ipAddress: asset.ipAddress,
                status: isRunning ? 'active' as any : 'inactive' as any,
                attributes: { image, status, ports, host_ip: asset.ipAddress, host_asset_id: assetId },
              });
              // Link container → host asset
              const container = await this.cmdb.getAssetBySource(userId, 'deep_scan', `${assetId}:${containerName}`);
              if (container) {
                await this.cmdb.upsertRelation(userId, container.id, assetId, 'runs_on' as any, true);
              }
            }
          } catch { /* non-critical — asset registration failed */ }
        }
      } catch {
        sshData = '\n\n_SSH Deep Scan fehlgeschlagen — Host nicht erreichbar._';
      }
    }

    if (!this.llmCallback) {
      // Fallback: generate a structured template without LLM
      const doc = [
        `# System-Dokumentation: ${asset.name}`,
        '',
        '## Übersicht',
        `| Eigenschaft | Wert |`,
        `|-------------|------|`,
        `| **Typ** | ${asset.assetType} |`,
        `| **IP** | ${asset.ipAddress ?? '—'} |`,
        `| **Status** | ${asset.status} |`,
        `| **Environment** | ${asset.environment ?? '—'} |`,
        `| **OS** | ${(asset.attributes as any)?.os ?? '—'} |`,
        `| **Owner** | ${asset.owner ?? '—'} |`,
        `| **Quelle** | ${asset.sourceSkill ?? 'manual'} |`,
        '',
        '## Verbundene Systeme',
        relatedAssets.length > 0 ? relatedAssets.join('\n') : '— keine —',
        '',
        '## Konfiguration',
        '— manuell ergänzen —',
        '',
        '## Betriebshinweise',
        '— manuell ergänzen —',
        sshData,
      ].filter(Boolean).join('\n');
      await this.persistDoc(userId, 'system_doc', `System-Dok: ${asset.name}`, doc, { linkedEntityType: 'asset', linkedEntityId: assetId });
      return { success: true, data: { asset }, display: doc };
    }

    const prompt = [
      'Erstelle eine vollständige System-Dokumentation auf Deutsch für folgendes Asset:',
      '',
      `## Asset: ${asset.name}`,
      `Typ: ${asset.assetType}`,
      `IP: ${asset.ipAddress ?? '—'}`,
      `Status: ${asset.status}`,
      `Environment: ${asset.environment ?? '—'}`,
      `OS: ${(asset.attributes as any)?.os ?? '—'}`,
      `Owner: ${asset.owner ?? '—'}`,
      `Quelle: ${asset.sourceSkill ?? 'manual'}`,
      asset.attributes ? `Attributes: ${JSON.stringify(asset.attributes).slice(0, 500)}` : '',
      '',
      '## Verbundene Systeme',
      relatedAssets.length > 0 ? relatedAssets.join('\n') : '— keine —',
      '',
      sshData ? `\n## Live-Daten (vom System ausgelesen)\n${sshData}` : '',
      '',
      sshData
        ? 'Erstelle eine VOLLSTÄNDIGE System-Dokumentation basierend auf den CMDB-Daten UND den Live-Daten. Sektionen: Übersicht, OS & Hardware, Netzwerk, Installierte Software, Laufende Services, Docker Container, Disk & Storage, Monitoring, Betriebshinweise, Backup/Recovery.'
        : 'Erstelle Sektionen: Übersicht, Architektur, Netzwerk, Konfiguration, Monitoring, Betriebshinweise, Backup/Recovery.',
    ].filter(Boolean).join('\n');

    const generated = await this.llmCallback(prompt, 'strong');
    await this.persistDoc(userId, 'system_doc', `System-Dok: ${asset.name}`, generated, { linkedEntityType: 'asset', linkedEntityId: assetId });
    return { success: true, data: { asset }, display: `## System-Dokumentation: ${asset.name}\n\n${generated}` };
  }

  private async generateServiceDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const serviceId = input.service_id as string;
    if (!serviceId) return { success: false, error: 'service_id erforderlich' };

    const svc = await this.itsm.getServiceById(userId, serviceId);
    if (!svc) return { success: false, error: `Service ${serviceId} nicht gefunden` };

    const assetDetails: string[] = [];
    for (const aid of svc.assetIds) {
      const a = await this.cmdb.getAssetById(userId, aid);
      if (a) assetDetails.push(`- ${a.name} (${a.assetType}, IP: ${a.ipAddress ?? '—'})`);
    }

    const depNames: string[] = [];
    for (const depId of svc.dependencies) {
      const dep = await this.itsm.getServiceById(userId, depId);
      if (dep) depNames.push(dep.name);
    }

    if (!this.llmCallback) {
      const doc = [
        `# Service-Dokumentation: ${svc.name}`,
        '',
        `**Beschreibung:** ${svc.description ?? '—'}`,
        `**Kategorie:** ${svc.category ?? '—'}`,
        `**Criticality:** ${svc.criticality ?? '—'}`,
        `**Health:** ${svc.healthStatus}`,
        svc.url ? `**URL:** ${svc.url}` : '',
        '',
        '## Komponenten',
        assetDetails.length > 0 ? assetDetails.join('\n') : '— keine registriert —',
        '',
        '## Abhängigkeiten',
        depNames.length > 0 ? depNames.map(n => `- ${n}`).join('\n') : '— keine —',
      ].filter(Boolean).join('\n');
      await this.persistDoc(userId, 'service_doc', `Service-Dok: ${svc.name}`, doc, { linkedEntityType: 'service', linkedEntityId: serviceId });
      return { success: true, data: { service: svc }, display: doc };
    }

    const prompt = [
      'Erstelle eine vollständige Service-Dokumentation auf Deutsch:',
      '',
      `## Service: ${svc.name}`,
      svc.description ? `Beschreibung: ${svc.description}` : '',
      `Kategorie: ${svc.category ?? '—'}`,
      `Criticality: ${svc.criticality ?? '—'}`,
      `Health: ${svc.healthStatus}`,
      svc.url ? `URL: ${svc.url}` : '',
      svc.healthCheckUrl ? `Health-Check: ${svc.healthCheckUrl}` : '',
      '',
      '## Unterliegende Assets',
      assetDetails.length > 0 ? assetDetails.join('\n') : '— keine registriert —',
      '',
      depNames.length > 0 ? `## Abhängigkeiten\n${depNames.map(n => `- ${n}`).join('\n')}` : '',
      '',
      'Erstelle Sektionen: Übersicht, Architektur, Komponenten, API/Endpunkte, Monitoring, SLA, Betrieb, Troubleshooting.',
    ].filter(Boolean).join('\n');

    const generated = await this.llmCallback(prompt, 'strong');
    await this.persistDoc(userId, 'service_doc', `Service-Dok: ${svc.name}`, generated, { linkedEntityType: 'service', linkedEntityId: serviceId });
    return { success: true, data: { service: svc }, display: `## Service-Dokumentation: ${svc.name}\n\n${generated}` };
  }

  private async generateNetworkDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const scope = (input.scope as string) || 'full';

    // Load network-relevant assets
    const allAssets = await this.cmdb.listAssets(userId);
    const networkTypes = new Set(['network', 'network_device', 'firewall_rule', 'dns_record', 'proxy_host', 'server', 'vm', 'lxc']);
    const scopeFilter: Record<string, Set<string>> = {
      full: networkTypes,
      vlan: new Set(['network', 'network_device', 'server', 'vm', 'lxc']),
      firewall: new Set(['firewall_rule', 'network_device']),
      dns: new Set(['dns_record', 'proxy_host']),
    };
    const allowed = scopeFilter[scope] ?? networkTypes;
    const assets = allAssets.filter(a => allowed.has(a.assetType));

    if (!this.llmCallback) {
      const sections: string[] = [
        `# Netzwerk-Dokumentation (Scope: ${scope})`,
        '',
        `${assets.length} relevante Assets gefunden.`,
        '',
      ];
      const grouped = new Map<string, typeof assets>();
      for (const a of assets) {
        const list = grouped.get(a.assetType) || [];
        list.push(a);
        grouped.set(a.assetType, list);
      }
      for (const [type, items] of grouped) {
        sections.push(`## ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`);
        for (const a of items) {
          sections.push(`- ${a.name} — IP: ${a.ipAddress ?? '—'}, Status: ${a.status}`);
        }
        sections.push('');
      }
      const doc = sections.join('\n');
      await this.persistDoc(userId, 'network_doc', `Netzwerk-Dok (${scope})`, doc);
      return { success: true, data: { assetCount: assets.length, scope }, display: doc };
    }

    const assetSummary = assets.map(a =>
      `- ${a.name} (${a.assetType}, IP: ${a.ipAddress ?? '—'}, Status: ${a.status})`,
    ).join('\n');

    const prompt = [
      `Erstelle eine Netzwerk-Dokumentation auf Deutsch. Scope: ${scope}.`,
      '',
      '## Verfügbare Netzwerk-Assets',
      assetSummary || '— keine —',
      '',
      'Erstelle Sektionen je nach Scope:',
      scope === 'full' || scope === 'vlan' ? '- VLAN/Subnetz-Übersicht' : '',
      scope === 'full' || scope === 'firewall' ? '- Firewall-Regeln und Sicherheitszonen' : '',
      scope === 'full' || scope === 'dns' ? '- DNS-Konfiguration und Proxy-Hosts' : '',
      '- Netzwerk-Topologie-Beschreibung',
      '- Empfehlungen',
    ].filter(Boolean).join('\n');

    const generated = await this.llmCallback(prompt, 'strong');
    await this.persistDoc(userId, 'network_doc', `Netzwerk-Dok (${scope})`, generated);
    return { success: true, data: { assetCount: assets.length, scope }, display: `## Netzwerk-Dokumentation (${scope})\n\n${generated}` };
  }

  private async generateConfigSnapshot(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const asset = await this.resolveAsset(userId, input);
    if (!asset) return { success: false, error: `Asset "${input.asset_id ?? input.asset_name}" nicht gefunden` };
    const assetId = asset.id;

    const relations = await this.cmdb.getRelationsForAsset(userId, assetId);
    const snapshot = {
      snapshotAt: new Date().toISOString(),
      asset: {
        id: asset.id,
        name: asset.name,
        type: asset.assetType,
        ip: asset.ipAddress,
        status: asset.status,
        environment: asset.environment,
        owner: asset.owner,
        source: asset.sourceSkill,
        attributes: asset.attributes,
      },
      relations: relations.map(r => ({
        type: r.relationType,
        sourceId: r.sourceAssetId,
        targetId: r.targetAssetId,
      })),
    };

    const content = JSON.stringify(snapshot, null, 2);
    const doc = await this.cmdb.saveDocument(userId, {
      docType: 'config_snapshot' as any,
      title: `Config-Snapshot: ${asset.name} — ${snapshot.snapshotAt.slice(0, 16)}`,
      content,
      format: 'json' as any,
      linkedEntityType: 'asset' as any,
      linkedEntityId: assetId,
      generatedBy: 'infra_docs',
    });

    return {
      success: true,
      data: { doc, snapshot },
      display: `Config-Snapshot erstellt: **${asset.name}** (Version ${doc.version}, ID: ${doc.id})`,
    };
  }

  // ── Runbook Management ────────────────────────────────────

  private async createRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    const serviceId = input.service_id as string;
    const incidentId = input.incident_id as string;
    const autoGenerate = input.auto_generate as boolean;

    if (!title && !serviceId && !incidentId) {
      return { success: false, error: 'title, service_id oder incident_id erforderlich' };
    }

    // If content is provided manually, save directly
    if (input.content && !autoGenerate) {
      const doc = await this.cmdb.saveDocument(userId, {
        docType: 'runbook' as any,
        title: title || 'Runbook',
        content: input.content as string,
        format: 'markdown' as any,
        linkedEntityType: serviceId ? 'service' as any : incidentId ? 'incident' as any : undefined,
        linkedEntityId: serviceId || incidentId || undefined,
        generatedBy: 'user',
      });
      return { success: true, data: doc, display: `Runbook erstellt: **${doc.title}** (ID: ${doc.id})` };
    }

    // Auto-generate from context
    if (!this.llmCallback) return { success: false, error: 'LLM nicht verfügbar für Auto-Generierung' };

    let context = '';
    let runbookTitle = title || 'Runbook';

    if (serviceId) {
      const svc = await this.itsm.getServiceById(userId, serviceId);
      if (svc) {
        runbookTitle = title || `Runbook: ${svc.name}`;
        context = `Service: ${svc.name}\nBeschreibung: ${svc.description ?? '—'}\nCriticality: ${svc.criticality ?? '—'}`;
      }
    }

    if (incidentId) {
      const inc = await this.itsm.getIncidentById(userId, incidentId);
      if (inc) {
        runbookTitle = title || `Runbook: ${inc.title}`;
        context += `\n\nIncident: ${inc.title}\nSeverity: ${inc.severity}\nRoot Cause: ${inc.rootCause ?? '—'}\nResolution: ${inc.resolution ?? '—'}`;
      }
    }

    const prompt = [
      'Erstelle ein operatives Runbook auf Deutsch basierend auf folgendem Kontext:',
      '',
      context,
      '',
      'Erstelle Sektionen: Voraussetzungen, Schritt-für-Schritt-Anleitung, Verifizierung, Rollback, Eskalation.',
    ].join('\n');

    const generated = await this.llmCallback(prompt, 'strong');
    const doc = await this.cmdb.saveDocument(userId, {
      docType: 'runbook' as any,
      title: runbookTitle,
      content: generated,
      format: 'markdown' as any,
      linkedEntityType: serviceId ? 'service' as any : incidentId ? 'incident' as any : undefined,
      linkedEntityId: serviceId || incidentId || undefined,
      generatedBy: 'llm',
    });

    return { success: true, data: doc, display: `## ${runbookTitle}\n\n${generated}` };
  }

  private async getRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    input.doc_id = input.doc_id ?? input.runbook_id;
    return this.getDoc(userId, input);
  }

  private async updateRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    input.doc_id = input.doc_id ?? input.runbook_id;
    return this.updateDoc(userId, input);
  }

  private async suggestRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    const incidentId = input.incident_id as string;

    let searchTerm = query || '';

    // Enrich search from incident context
    if (incidentId) {
      const inc = await this.itsm.getIncidentById(userId, incidentId);
      if (inc) {
        const keywords = [inc.title, inc.symptoms, inc.rootCause].filter(Boolean).join(' ');
        searchTerm = searchTerm ? `${searchTerm} ${keywords}` : keywords;
      }
    }

    if (!searchTerm) return { success: false, error: 'query oder incident_id erforderlich' };

    const docs = await this.cmdb.searchDocuments(userId, searchTerm, { docType: 'runbook', limit: 10 });

    if (docs.length === 0) return { success: true, data: [], display: `Keine passenden Runbooks für "${searchTerm.slice(0, 50)}" gefunden.` };

    const lines = docs.map(d =>
      `| ${d.id.slice(0, 8)}… | ${d.title} | v${d.version} | ${d.createdAt?.slice(0, 16)} |`,
    );
    const display = `## Passende Runbooks (${docs.length})\n\n| ID | Titel | Version | Erstellt |\n|----|-------|---------|----------|\n${lines.join('\n')}`;
    return { success: true, data: docs, display };
  }

  private async executeRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const runbookId = (input.runbook_id ?? input.doc_id) as string;
    if (!runbookId) return { success: false, error: 'runbook_id erforderlich' };

    const doc = await this.cmdb.getDocumentById(userId, runbookId);
    if (!doc) return { success: false, error: `Runbook ${runbookId} nicht gefunden` };

    // Parse steps from markdown content (look for numbered lists or ## headings)
    const lines = doc.content.split('\n');
    const steps: Array<{ step: number; title: string; description: string }> = [];
    let currentStep = 0;
    let currentTitle = '';
    let currentDesc: string[] = [];

    for (const line of lines) {
      // Match numbered list items: "1. ", "2. " etc.
      const numbered = line.match(/^(\d+)\.\s+(.+)/);
      // Match step headings: "## Schritt 1:" or "### 1."
      const heading = line.match(/^#{2,3}\s+(?:Schritt\s+)?(\d+)[.:\s]+(.+)/i);

      if (numbered || heading) {
        if (currentStep > 0) {
          steps.push({ step: currentStep, title: currentTitle, description: currentDesc.join('\n').trim() });
        }
        currentStep = parseInt(numbered?.[1] ?? heading?.[1] ?? '0', 10);
        currentTitle = (numbered?.[2] ?? heading?.[2] ?? '').trim();
        currentDesc = [];
      } else if (currentStep > 0 && line.trim()) {
        currentDesc.push(line);
      }
    }
    if (currentStep > 0) {
      steps.push({ step: currentStep, title: currentTitle, description: currentDesc.join('\n').trim() });
    }

    if (steps.length === 0) {
      return {
        success: true,
        data: { runbook: doc, steps: [], note: 'Keine strukturierten Schritte erkannt — Runbook als Freitext.' },
        display: `## Runbook: ${doc.title}\n\nKeine strukturierten Schritte erkannt. Inhalt:\n\n${doc.content.slice(0, 2000)}`,
      };
    }

    const stepList = steps.map(s => `${s.step}. **${s.title}**${s.description ? `\n   ${s.description.slice(0, 200)}` : ''}`).join('\n');
    return {
      success: true,
      data: { runbook: doc, steps, totalSteps: steps.length },
      display: `## Runbook ausführen: ${doc.title}\n\n${steps.length} Schritte erkannt:\n\n${stepList}\n\n_Hinweis: Automatische Ausführung via Workflow-Integration geplant._`,
    };
  }

  // ── Versioning ────────────────────────────────────────────

  private async docVersions(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = input.doc_id as string;
    const entityType = input.linked_entity_type as string;
    const entityId = input.linked_entity_id as string;
    const docType = input.doc_type as string;

    // If doc_id given, look up the document first to get entity info
    if (docId) {
      const doc = await this.cmdb.getDocumentById(userId, docId);
      if (!doc) return { success: false, error: `Dokument ${docId} nicht gefunden` };
      if (!doc.linkedEntityType || !doc.linkedEntityId) {
        return { success: true, data: [doc], display: `Dokument hat keine Entity-Verknüpfung — nur Version ${doc.version} vorhanden.` };
      }
      const versions = await this.cmdb.getDocumentVersions(userId, doc.linkedEntityType, doc.linkedEntityId, doc.docType);
      const lines = versions.map(v => `| v${v.version} | ${v.title} | ${v.createdAt?.slice(0, 16)} | ${v.id.slice(0, 8)}… |`);
      const display = `## Versionen: ${doc.title}\n\n| Version | Titel | Erstellt | ID |\n|---------|-------|----------|----|\n${lines.join('\n')}`;
      return { success: true, data: versions, display };
    }

    if (!entityType || !entityId || !docType) {
      return { success: false, error: 'doc_id oder (linked_entity_type + linked_entity_id + doc_type) erforderlich' };
    }

    const versions = await this.cmdb.getDocumentVersions(userId, entityType, entityId, docType);
    if (versions.length === 0) return { success: true, data: [], display: 'Keine Versionen gefunden.' };

    const lines = versions.map(v => `| v${v.version} | ${v.title} | ${v.createdAt?.slice(0, 16)} | ${v.id.slice(0, 8)}… |`);
    const display = `## Versionen (${versions.length})\n\n| Version | Titel | Erstellt | ID |\n|---------|-------|----------|----|\n${lines.join('\n')}`;
    return { success: true, data: versions, display };
  }

  private async docDiff(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = input.doc_id as string;
    const versionA = input.version_a as number;
    const versionB = input.version_b as number;

    if (!docId) return { success: false, error: 'doc_id erforderlich' };

    // Get the document to find entity info
    const doc = await this.cmdb.getDocumentById(userId, docId);
    if (!doc) return { success: false, error: `Dokument ${docId} nicht gefunden` };
    if (!doc.linkedEntityType || !doc.linkedEntityId) {
      return { success: false, error: 'Dokument hat keine Entity-Verknüpfung — Versionsvergleich nicht möglich' };
    }

    const versions = await this.cmdb.getDocumentVersions(userId, doc.linkedEntityType, doc.linkedEntityId, doc.docType);
    const docA = versions.find(v => v.version === (versionA ?? versions[versions.length - 1]?.version));
    const docB = versions.find(v => v.version === (versionB ?? versions[0]?.version));

    if (!docA || !docB) return { success: false, error: `Version(en) nicht gefunden. Verfügbar: ${versions.map(v => v.version).join(', ')}` };

    // Simple line-based diff
    const linesA = docA.content.split('\n');
    const linesB = docB.content.split('\n');
    const diffLines: string[] = [];
    const maxLen = Math.max(linesA.length, linesB.length);

    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] ?? '';
      const b = linesB[i] ?? '';
      if (a !== b) {
        if (a) diffLines.push(`- ${a}`);
        if (b) diffLines.push(`+ ${b}`);
      }
    }

    const display = diffLines.length > 0
      ? `## Diff: v${docA.version} → v${docB.version}\n\n\`\`\`diff\n${diffLines.slice(0, 200).join('\n')}\n\`\`\``
      : `Keine Unterschiede zwischen v${docA.version} und v${docB.version}.`;

    return { success: true, data: { versionA: docA.version, versionB: docB.version, changes: diffLines.length }, display };
  }

  private async docRevert(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const docId = input.doc_id as string;
    const targetVersion = input.target_version as number;

    if (!docId || targetVersion == null) return { success: false, error: 'doc_id und target_version erforderlich' };

    const doc = await this.cmdb.getDocumentById(userId, docId);
    if (!doc) return { success: false, error: `Dokument ${docId} nicht gefunden` };
    if (!doc.linkedEntityType || !doc.linkedEntityId) {
      return { success: false, error: 'Dokument hat keine Entity-Verknüpfung — Revert nicht möglich' };
    }

    const versions = await this.cmdb.getDocumentVersions(userId, doc.linkedEntityType, doc.linkedEntityId, doc.docType);
    const target = versions.find(v => v.version === targetVersion);
    if (!target) return { success: false, error: `Version ${targetVersion} nicht gefunden. Verfügbar: ${versions.map(v => v.version).join(', ')}` };

    // Create new version with content from target
    const reverted = await this.cmdb.saveDocument(userId, {
      docType: target.docType as any,
      title: target.title,
      content: target.content,
      format: target.format as any,
      linkedEntityType: target.linkedEntityType as any,
      linkedEntityId: target.linkedEntityId ?? undefined,
      generatedBy: 'revert',
    });

    return {
      success: true,
      data: reverted,
      display: `Dokument auf Version ${targetVersion} zurückgesetzt → neue Version ${reverted.version} erstellt.`,
    };
  }
}
