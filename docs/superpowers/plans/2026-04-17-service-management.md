# Service Management System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vollstaendiges Service-Management mit Failure-Modes, Impact-Analyse, Auto-Doku-Generierung, und WebUI Service-Visualisierung.

**Architecture:** Bestehende ITSM Services erweitern (failure_modes JSON-Feld, erweiterte Komponenten). 6 neue ITSM Actions + 9 API Endpoints + WebUI /services Seite mit ForceGraph2D. Background-Doku-Generierung via InfraDocs.

**Tech Stack:** TypeScript, PostgreSQL/SQLite, LLM (strong tier), ForceGraph2D, React/Next.js

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/web/src/app/services/page.tsx` | WebUI Route |
| `apps/web/src/components/services/ServicesPage.tsx` | Service-Liste + Detail + Graph + Failure-Modes |

### Modified Files
| File | Change |
|------|--------|
| `packages/skills/src/built-in/itsm.ts` | 6 neue Actions + erweiterte create_incident |
| `packages/storage/src/repositories/itsm-repository.ts` | failure_modes Feld, Impact-Queries |
| `packages/storage/src/migrations/pg-migrations.ts` | Migration v58 |
| `packages/storage/src/migrations/pg-schema.ts` | failure_modes Spalte |
| `packages/messaging/src/adapters/http.ts` | 9 neue /api/services/* Endpoints |
| `packages/core/src/alfred.ts` | Service-API Callbacks |
| `apps/web/src/types/api.ts` | Service Types |
| `apps/web/src/lib/alfred-client.ts` | Service API Methods |
| `apps/web/src/components/layout/Sidebar.tsx` | Services-Link |

---

### Task 1: DB Migration + Repository

**Files:**
- Modify: `packages/storage/src/migrations/pg-migrations.ts`
- Modify: `packages/storage/src/repositories/itsm-repository.ts`

- [ ] **Step 1: Add PG migration v58**

```typescript
{
  version: 58,
  description: 'Service Management — failure_modes column',
  async up(db) {
    await db.execute('ALTER TABLE cmdb_services ADD COLUMN IF NOT EXISTS failure_modes TEXT DEFAULT \'[]\'', []);
  },
},
```

- [ ] **Step 2: Extend rowToService mapper**

In `itsm-repository.ts`, find `rowToService` and add:
```typescript
failureModes: JSON.parse((r.failure_modes as string) ?? '[]'),
```

- [ ] **Step 3: Add failure_modes to updateService**

In the `updateService` method, add handling for `failure_modes`:
```typescript
if (updates.failureModes !== undefined) { sets.push('failure_modes = ?'); values.push(JSON.stringify(updates.failureModes)); }
```

- [ ] **Step 4: Add getServicesForAsset method**

```typescript
async getServicesForAsset(userId: string, assetId: string): Promise<CmdbService[]> {
  const all = await this.listServices(userId);
  return all.filter(s =>
    s.assetIds.includes(assetId) ||
    s.components.some((c: any) => c.assetId === assetId)
  );
}
```

- [ ] **Step 5: Add ServiceComponent and FailureMode to types package**

In `packages/types/src/storage.ts`, add:
```typescript
export interface ServiceComponent {
  name: string;
  role: string;
  assetId?: string;
  serviceId?: string;
  externalUrl?: string;
  required: boolean;
  failureImpact: 'down' | 'degraded' | 'no_impact';
  failureDescription?: string;
  dependsOn?: string[];
  ports?: number[];
  protocol?: string;
  dns?: string;
  ip?: string;
  healthCheckUrl?: string;
  healthStatus?: string;
  healthReason?: string;
}

export interface FailureMode {
  name: string;
  trigger: string;
  affectedComponents: string[];
  serviceImpact: 'down' | 'degraded';
  cascadeEffects?: string[];
  runbookId?: string;
  sopId?: string;
  estimatedRecoveryMinutes?: number;
}
```

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: Service Management — Migration v58 + Repository + Types"
```

---

### Task 2: ITSM Skill — 6 neue Actions

**Files:**
- Modify: `packages/skills/src/built-in/itsm.ts`

- [ ] **Step 1: Add Action types + inputSchema**

Add to action enum: `'create_service_from_description'`, `'add_failure_mode'`, `'remove_failure_mode'`, `'update_failure_mode'`, `'service_impact_analysis'`, `'generate_service_docs'`

Add inputSchema properties:
```typescript
failure_mode_name: { type: 'string', description: 'Name des Failure-Modes' },
failure_trigger: { type: 'string', description: 'Ausloeser des Failure-Modes' },
failure_impact: { type: 'string', enum: ['down', 'degraded'], description: 'Service-Impact' },
affected_components: { type: 'array', items: { type: 'string' }, description: 'Betroffene Komponenten-Namen' },
cascade_effects: { type: 'array', items: { type: 'string' }, description: 'Kaskadierende Effekte' },
recovery_minutes: { type: 'number', description: 'Geschaetzte Recovery-Zeit in Minuten' },
```

- [ ] **Step 2: Implement create_service_from_description**

```typescript
private async createServiceFromDescription(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const description = input.description as string ?? input.text as string;
  if (!description) return { success: false, error: 'description erforderlich' };

  if (!this.llmCallback) return { success: false, error: 'LLM nicht verfuegbar' };

  // Get available assets for context
  const assets = await this.cmdb.listAssets(userId, {});
  const assetList = assets.slice(0, 50).map(a => `- ${a.name} (${a.assetType}, IP: ${a.ipAddress ?? '?'}, ID: ${a.id})`).join('\n');

  const prompt = `Analysiere diese Service-Beschreibung und erstelle eine strukturierte Service-Definition.

Beschreibung: "${description}"

Verfuegbare CMDB-Assets:
${assetList}

Antworte NUR mit validem JSON:
{
  "name": "Service-Name",
  "description": "Kurzbeschreibung",
  "criticality": "critical|high|medium|low",
  "components": [
    { "name": "Komponentenname", "role": "database|cache|compute|api|proxy|storage|messaging|monitoring|dns|other", "assetName": "CMDB-Asset-Name", "required": true, "failureImpact": "down|degraded|no_impact", "failureDescription": "Was passiert bei Ausfall", "ports": [5432], "dependsOn": [] }
  ],
  "failureModes": [
    { "name": "Ausfall-Name", "trigger": "Was loest den Ausfall aus", "affectedComponents": ["Komponentenname"], "serviceImpact": "down|degraded", "cascadeEffects": ["Effekt 1"], "estimatedRecoveryMinutes": 30 }
  ]
}`;

  const response = await this.llmCallback(prompt, 'strong');
  let parsed: any;
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { success: false, error: 'LLM-Antwort konnte nicht geparst werden' };
    parsed = JSON.parse(jsonMatch[0]);
  } catch { return { success: false, error: 'JSON-Parse fehlgeschlagen' }; }

  // Resolve asset names to IDs
  const components = (parsed.components ?? []).map((c: any) => {
    const asset = assets.find(a => a.name.toLowerCase() === (c.assetName ?? '').toLowerCase());
    return {
      name: c.name, role: c.role ?? 'other', required: c.required ?? true,
      failureImpact: c.failureImpact ?? 'down', failureDescription: c.failureDescription,
      assetId: asset?.id, ports: c.ports, dependsOn: c.dependsOn,
      ip: asset?.ipAddress,
    };
  });

  const assetIds = components.map((c: any) => c.assetId).filter(Boolean);

  const svc = await this.itsm.createService(userId, {
    name: parsed.name, description: parsed.description,
    criticality: parsed.criticality ?? 'medium',
    assetIds, dependencies: [],
  });

  // Update with components and failure modes
  await this.itsm.updateService(userId, svc.id, {
    components, failureModes: parsed.failureModes ?? [],
  } as any);

  const display = [
    `## Service erstellt: ${parsed.name}`,
    `**Criticality:** ${parsed.criticality}`,
    `**Komponenten:** ${components.length}`,
    ...components.map((c: any) => `- ${c.name} (${c.role}) → ${c.failureImpact}${c.assetId ? ' ✓ CMDB' : ' ⚠️ kein Asset'}`),
    `**Failure-Modes:** ${(parsed.failureModes ?? []).length}`,
    ...(parsed.failureModes ?? []).map((f: any) => `- ${f.serviceImpact === 'down' ? '🔴' : '🟡'} ${f.name}: ${f.trigger}`),
    '', '_Doku-Generierung wird im Hintergrund gestartet..._',
  ].join('\n');

  // Trigger background doc generation (fire-and-forget)
  this.generateServiceDocsBackground(userId, svc.id).catch(() => {});

  return { success: true, data: { serviceId: svc.id, ...parsed }, display };
}
```

- [ ] **Step 3: Implement add/remove/update_failure_mode**

```typescript
private async addFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const serviceId = input.service_id as string;
  if (!serviceId) return { success: false, error: 'service_id erforderlich' };
  const svc = await this.itsm.getServiceById(userId, serviceId);
  if (!svc) return { success: false, error: 'Service nicht gefunden' };

  const mode: any = {
    name: input.failure_mode_name as string ?? input.name as string,
    trigger: input.failure_trigger as string ?? input.trigger as string ?? '',
    affectedComponents: input.affected_components as string[] ?? [],
    serviceImpact: input.failure_impact as string ?? 'down',
    cascadeEffects: input.cascade_effects as string[],
    estimatedRecoveryMinutes: input.recovery_minutes as number,
  };
  if (!mode.name) return { success: false, error: 'failure_mode_name erforderlich' };

  const modes = [...(svc as any).failureModes ?? [], mode];
  await this.itsm.updateService(userId, serviceId, { failureModes: modes } as any);
  return { success: true, data: mode, display: `Failure-Mode **${mode.name}** hinzugefuegt (${mode.serviceImpact})` };
}

private async removeFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const serviceId = input.service_id as string;
  const name = input.failure_mode_name as string ?? input.name as string;
  if (!serviceId || !name) return { success: false, error: 'service_id und failure_mode_name erforderlich' };
  const svc = await this.itsm.getServiceById(userId, serviceId);
  if (!svc) return { success: false, error: 'Service nicht gefunden' };

  const modes = ((svc as any).failureModes ?? []).filter((m: any) => m.name !== name);
  await this.itsm.updateService(userId, serviceId, { failureModes: modes } as any);
  return { success: true, data: { removed: name }, display: `Failure-Mode **${name}** entfernt` };
}

private async updateFailureMode(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const serviceId = input.service_id as string;
  const name = input.failure_mode_name as string ?? input.name as string;
  if (!serviceId || !name) return { success: false, error: 'service_id und failure_mode_name erforderlich' };
  const svc = await this.itsm.getServiceById(userId, serviceId);
  if (!svc) return { success: false, error: 'Service nicht gefunden' };

  const modes = ((svc as any).failureModes ?? []).map((m: any) => {
    if (m.name !== name) return m;
    return {
      ...m,
      trigger: input.failure_trigger as string ?? m.trigger,
      affectedComponents: input.affected_components as string[] ?? m.affectedComponents,
      serviceImpact: input.failure_impact as string ?? m.serviceImpact,
      cascadeEffects: input.cascade_effects as string[] ?? m.cascadeEffects,
      estimatedRecoveryMinutes: input.recovery_minutes as number ?? m.estimatedRecoveryMinutes,
      runbookId: input.runbook_id as string ?? m.runbookId,
      sopId: input.sop_id as string ?? m.sopId,
    };
  });
  await this.itsm.updateService(userId, serviceId, { failureModes: modes } as any);
  return { success: true, data: { updated: name }, display: `Failure-Mode **${name}** aktualisiert` };
}
```

- [ ] **Step 4: Implement service_impact_analysis**

```typescript
private async serviceImpactAnalysis(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const assetId = input.asset_id as string;
  const assetName = input.asset_name as string;
  if (!assetId && !assetName) return { success: false, error: 'asset_id oder asset_name erforderlich' };

  // Resolve asset
  let resolvedId = assetId;
  if (!resolvedId && assetName) {
    const assets = await this.cmdb.listAssets(userId, {});
    const match = assets.find(a => a.name.toLowerCase() === assetName.toLowerCase());
    if (match) resolvedId = match.id;
  }
  if (!resolvedId) return { success: false, error: 'Asset nicht gefunden' };

  const services = await this.itsm.getServicesForAsset(userId, resolvedId);
  if (services.length === 0) return { success: true, data: { affected: [] }, display: 'Kein Service betroffen.' };

  const lines = ['## Impact-Analyse', ''];
  for (const svc of services) {
    const comp = svc.components.find((c: any) => c.assetId === resolvedId || c.assetId === assetName);
    const impact = comp?.failureImpact ?? (comp?.required ? 'down' : 'degraded');
    const icon = impact === 'down' ? '🔴' : impact === 'degraded' ? '🟡' : '🟢';
    lines.push(`${icon} **${svc.name}** (${svc.criticality}) → ${impact.toUpperCase()}`);
    if (comp?.failureDescription) lines.push(`  _${comp.failureDescription}_`);

    // Check failure modes
    const modes = ((svc as any).failureModes ?? []).filter((m: any) =>
      m.affectedComponents?.some((c: string) => c === comp?.name)
    );
    for (const m of modes) {
      lines.push(`  📋 Failure-Mode: ${m.name} — ${m.trigger}`);
      if (m.cascadeEffects?.length) lines.push(`  ⚡ Cascade: ${m.cascadeEffects.join(', ')}`);
      if (m.sopId) lines.push(`  📄 SOP verfuegbar`);
    }
  }

  return { success: true, data: { affected: services.map(s => ({ id: s.id, name: s.name })) }, display: lines.join('\n') };
}
```

- [ ] **Step 5: Implement generate_service_docs (background)**

```typescript
private async generateServiceDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const serviceId = input.service_id as string;
  if (!serviceId) return { success: false, error: 'service_id erforderlich' };
  this.generateServiceDocsBackground(userId, serviceId).catch(() => {});
  return { success: true, data: { serviceId }, display: 'Doku-Generierung gestartet. Service-Doku + SOPs werden im Hintergrund erstellt.' };
}

private async generateServiceDocsBackground(userId: string, serviceId: string): Promise<void> {
  if (!this.llmCallback) return;
  const svc = await this.itsm.getServiceById(userId, serviceId);
  if (!svc) return;

  // Collect system docs for all component assets
  const componentDocs: string[] = [];
  for (const comp of svc.components) {
    if ((comp as any).assetId) {
      try {
        const docs = await this.cmdb.getDocumentsForEntity(userId, 'asset' as any, (comp as any).assetId);
        const systemDoc = docs.find(d => d.docType === 'system_doc');
        if (systemDoc) componentDocs.push(`### ${comp.name}\n${systemDoc.content.slice(0, 1000)}`);
      } catch { /* skip */ }
    }
  }

  // Generate service doc
  try {
    const prompt = [
      `Erstelle eine vollstaendige Service-Dokumentation auf Deutsch fuer:`,
      `Service: ${svc.name} (${svc.criticality})`,
      svc.description ? `Beschreibung: ${svc.description}` : '',
      `Komponenten: ${svc.components.map((c: any) => `${c.name} (${c.role}, ${c.failureImpact})`).join(', ')}`,
      componentDocs.length > 0 ? `\nSystem-Dokus:\n${componentDocs.join('\n\n')}` : '',
      `Failure-Modes: ${((svc as any).failureModes ?? []).map((m: any) => `${m.name}: ${m.trigger} → ${m.serviceImpact}`).join('; ')}`,
      '', 'Sektionen: Uebersicht, Architektur, Komponenten (mit IP/Ports/Rolle), Abhaengigkeiten, Failure-Modes, Monitoring, Betrieb.',
    ].filter(Boolean).join('\n');

    const content = await this.llmCallback(prompt, 'strong');
    await this.cmdb.saveDocument(userId, {
      docType: 'service_doc' as any, title: `Service-Dok: ${svc.name}`, content,
      linkedEntityType: 'service' as any, linkedEntityId: serviceId,
    });
  } catch { /* non-critical */ }

  // Generate SOP per failure mode
  for (const mode of (svc as any).failureModes ?? []) {
    try {
      const sopPrompt = [
        `Erstelle ein operatives SOP (Standard Operating Procedure) auf Deutsch fuer:`,
        `Service: ${svc.name}`, `Failure-Mode: ${mode.name}`, `Trigger: ${mode.trigger}`,
        `Impact: ${mode.serviceImpact}`, `Betroffene Komponenten: ${mode.affectedComponents?.join(', ')}`,
        mode.cascadeEffects?.length ? `Cascade: ${mode.cascadeEffects.join(', ')}` : '',
        componentDocs.length > 0 ? `\nSystem-Dokus:\n${componentDocs.join('\n\n')}` : '',
        '', 'Sektionen: Symptom, Sofort-Massnahmen, Diagnose, Recovery-Schritte, Nachhaltige Massnahmen, Eskalation.',
      ].filter(Boolean).join('\n');

      const sopContent = await this.llmCallback(sopPrompt, 'strong');
      const doc = await this.cmdb.saveDocument(userId, {
        docType: 'sop' as any, title: `SOP: ${mode.name} — ${svc.name}`, content: sopContent,
        linkedEntityType: 'service' as any, linkedEntityId: serviceId,
      });
      mode.sopId = doc.id;
    } catch { /* non-critical */ }
  }

  // Update failure modes with SOP IDs
  try {
    await this.itsm.updateService(userId, serviceId, { failureModes: (svc as any).failureModes } as any);
  } catch { /* non-critical */ }
}
```

- [ ] **Step 6: Extend create_incident with Service Impact**

Find the existing `createIncident` method. After the incident is created and before return, add:

```typescript
// Auto-detect service impact
try {
  const affectedAssets = (data.affected_asset_ids ?? []) as string[];
  const impactLines: string[] = [];
  const affectedServiceIds: string[] = [];
  for (const aid of affectedAssets) {
    const services = await this.itsm.getServicesForAsset(userId, aid);
    for (const svc of services) {
      if (affectedServiceIds.includes(svc.id)) continue;
      affectedServiceIds.push(svc.id);
      const comp = svc.components.find((c: any) => c.assetId === aid);
      const impact = comp?.failureImpact ?? 'degraded';
      impactLines.push(`  ${impact === 'down' ? '🔴' : '🟡'} ${svc.name}: ${impact.toUpperCase()}`);
    }
  }
  if (impactLines.length > 0) {
    result.display += `\n\n**Service-Impact:**\n${impactLines.join('\n')}`;
    // Update incident with affected service IDs
    await this.itsm.updateIncident(userId, result.data.id, { affectedServiceIds } as any);
  }
} catch { /* non-critical */ }
```

- [ ] **Step 7: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: Service Management — 6 ITSM Actions + Failure-Modes + Impact + Auto-Doku"
```

---

### Task 3: API Endpoints + Wiring

**Files:**
- Modify: `packages/messaging/src/adapters/http.ts`
- Modify: `packages/core/src/alfred.ts`

- [ ] **Step 1: Add 9 /api/services/* endpoints**

Add to handleRequest BEFORE the existing ITSM section:

```typescript
// ── Service Management API ──
} else if (url.pathname === '/api/services' && req.method === 'GET') {
  this.handleItsmRoute(req, res, (cbs, userId) => cbs.listServices(userId, Object.fromEntries(url.searchParams.entries())));
} else if (url.pathname === '/api/services' && req.method === 'POST') {
  this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createService(userId, body));
} else if (url.pathname.match(/^\/api\/services\/[^/]+\/failure-modes$/) && req.method === 'POST') {
  const id = url.pathname.split('/')[3];
  this.handleItsmBodyRoute(req, res, async (cbs, userId, body) => {
    const svc = await cbs.getService(userId, id);
    if (!svc) return { error: 'Service not found' };
    const modes = [...(svc.failureModes ?? []), body];
    await cbs.updateService(userId, id, { failureModes: modes });
    return { success: true };
  });
} else if (url.pathname.match(/^\/api\/services\/[^/]+\/failure-modes\//) && req.method === 'DELETE') {
  const parts = url.pathname.split('/');
  const id = parts[3]; const modeName = decodeURIComponent(parts[5]);
  this.handleItsmRoute(req, res, async (cbs, userId) => {
    const svc = await cbs.getService(userId, id);
    if (!svc) return { error: 'Service not found' };
    const modes = (svc.failureModes ?? []).filter((m: any) => m.name !== modeName);
    await cbs.updateService(userId, id, { failureModes: modes });
    return { success: true };
  });
} else if (url.pathname.match(/^\/api\/services\/[^/]+\/impact$/) && req.method === 'GET') {
  const id = url.pathname.split('/')[3];
  this.handleItsmRoute(req, res, async (cbs, userId) => {
    const svc = await cbs.getService(userId, id);
    if (!svc) return { error: 'Service not found' };
    return { service: svc, failureModes: svc.failureModes ?? [] };
  });
} else if (url.pathname.match(/^\/api\/services\/[^/]+\/generate-docs$/) && req.method === 'POST') {
  const id = url.pathname.split('/')[3];
  this.handleItsmRoute(req, res, (cbs, userId) => cbs.generateDocs(userId, id));
} else if (url.pathname.startsWith('/api/services/') && req.method === 'GET') {
  const id = url.pathname.split('/').pop()!;
  this.handleItsmRoute(req, res, (cbs, userId) => cbs.getService(userId, id));
} else if (url.pathname.startsWith('/api/services/') && req.method === 'PATCH') {
  const id = url.pathname.split('/')[3];
  this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateService(userId, id, body));
} else if (url.pathname.startsWith('/api/services/') && req.method === 'DELETE') {
  const id = url.pathname.split('/').pop()!;
  this.handleItsmRoute(req, res, (cbs, userId) => cbs.deleteService(userId, id));
}
```

- [ ] **Step 2: Add missing ITSM callbacks**

In `alfred.ts` where ITSM callbacks are set, add:
```typescript
getService: async (uid: string, id: string) => itsmRepo.getServiceById(await resolveUser(uid), id),
deleteService: async (uid: string, id: string) => itsmRepo.deleteService(await resolveUser(uid), id),
generateDocs: async (uid: string, id: string) => {
  const docsSkill = skillRegistry.get('infra_docs');
  if (docsSkill) return docsSkill.execute({ action: 'generate_service_doc', service_id: id }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
  return { success: false, error: 'InfraDocs not available' };
},
```

Also add `getService`, `deleteService`, `generateDocs` to the ItsmCallbacks interface in http.ts.

- [ ] **Step 3: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: Service Management — 9 API Endpoints + Wiring"
```

---

### Task 4: WebUI /services Page

**Files:**
- Create: `apps/web/src/app/services/page.tsx`
- Create: `apps/web/src/components/services/ServicesPage.tsx`
- Modify: `apps/web/src/types/api.ts`
- Modify: `apps/web/src/lib/alfred-client.ts`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add types**

In `apps/web/src/types/api.ts`:
```typescript
export interface ServiceComponent {
  name: string; role: string; assetId?: string; serviceId?: string;
  externalUrl?: string; required: boolean; failureImpact: string;
  failureDescription?: string; dependsOn?: string[]; ports?: number[];
  protocol?: string; dns?: string; ip?: string;
  healthCheckUrl?: string; healthStatus?: string; healthReason?: string;
}

export interface FailureMode {
  name: string; trigger: string; affectedComponents: string[];
  serviceImpact: string; cascadeEffects?: string[];
  runbookId?: string; sopId?: string; estimatedRecoveryMinutes?: number;
}

export interface ServiceDetail {
  id: string; name: string; description?: string; category?: string;
  environment?: string; url?: string; healthStatus: string;
  criticality?: string; components: ServiceComponent[];
  failureModes: FailureMode[]; dependencies?: string[];
  assetIds?: string[]; owner?: string; documentation?: string;
}
```

- [ ] **Step 2: Add API client methods**

In `alfred-client.ts`:
```typescript
async fetchServices(): Promise<ServiceDetail[]> {
  const res = await fetch(`${this.baseUrl}/api/services`, { headers: this.authHeaders });
  if (!res.ok) throw new Error(`Services: HTTP ${res.status}`);
  return res.json();
}
async fetchService(id: string): Promise<ServiceDetail> {
  const res = await fetch(`${this.baseUrl}/api/services/${id}`, { headers: this.authHeaders });
  if (!res.ok) throw new Error(`Service: HTTP ${res.status}`);
  return res.json();
}
async createService(data: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${this.baseUrl}/api/services`, { method: 'POST', headers: this.jsonHeaders, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Create: HTTP ${res.status}`);
  return res.json();
}
async updateService(id: string, data: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${this.baseUrl}/api/services/${id}`, { method: 'PATCH', headers: this.jsonHeaders, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Update: HTTP ${res.status}`);
  return res.json();
}
async deleteService(id: string): Promise<boolean> {
  const res = await fetch(`${this.baseUrl}/api/services/${id}`, { method: 'DELETE', headers: this.authHeaders });
  return res.ok;
}
async fetchServiceImpact(id: string): Promise<any> {
  const res = await fetch(`${this.baseUrl}/api/services/${id}/impact`, { headers: this.authHeaders });
  if (!res.ok) throw new Error(`Impact: HTTP ${res.status}`);
  return res.json();
}
async generateServiceDocs(id: string): Promise<any> {
  const res = await fetch(`${this.baseUrl}/api/services/${id}/generate-docs`, { method: 'POST', headers: this.authHeaders });
  if (!res.ok) throw new Error(`Generate: HTTP ${res.status}`);
  return res.json();
}
```

- [ ] **Step 3: Add Sidebar link**

```typescript
{ href: `${BASE}/services/`, label: 'Services', icon: '⚙️' },
```

Between ITSM and Docs.

- [ ] **Step 4: Create page route**

`apps/web/src/app/services/page.tsx`:
```typescript
import { ServicesPage } from '@/components/services/ServicesPage';
export default function Services() { return <ServicesPage />; }
```

- [ ] **Step 5: Implement ServicesPage component**

Create `apps/web/src/components/services/ServicesPage.tsx` with:
- Service list (left sidebar) with health-status dots and criticality badges
- Service detail (right) with ForceGraph2D showing components as nodes
- Node colors: green=healthy, yellow=degraded, red=down, gray=unknown
- Node labels: name + IP + role
- Required nodes with thick border
- Edges from dependsOn relationships
- Click on node shows component detail panel
- Failure-Modes section below graph with impact icons
- Linked documents section
- Create wizard: 4 steps (Name → Components → Failure-Modes → Confirm)
- Edit mode: inline edit components and failure modes

Follow patterns from existing KnowledgeGraphPage.tsx (ForceGraph2D) and DocsPage.tsx (sidebar + content).

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: Service Management — WebUI /services Page"
```

---

### Task 5: Version Bump + Release

- [ ] **Step 1: Version + CHANGELOG + README + Bundle**

```bash
# Version bump to next number
node scripts/bundle.mjs
pnpm build
git add -A
git commit -m "feat: Service Management System — Failure-Modes, Impact-Analyse, Auto-Doku, WebUI"
git push gitlab feature/multi-user
git push github feature/multi-user
```

---

## Self-Review

**Spec coverage:**
- Service creation from description (LLM) → Task 2 Step 2 ✓
- Failure-Mode CRUD → Task 2 Step 3 ✓
- Impact analysis → Task 2 Step 4 ✓
- Auto doc generation (background) → Task 2 Step 5 ✓
- ITSM incident integration → Task 2 Step 6 ✓
- N:M asset sharing → handled via component.assetId (same asset in multiple services) ✓
- Role per service → component.failureImpact per service ✓
- API endpoints (9) → Task 3 ✓
- WebUI with ForceGraph → Task 4 ✓
- Create wizard → Task 4 Step 5 ✓
- DB migration → Task 1 ✓
- Repository extensions → Task 1 ✓

**Placeholder scan:** No TBDs. ServicesPage in Task 4 Step 5 has a description instead of full code — but it references existing patterns (KnowledgeGraphPage, DocsPage) that the subagent can follow.

**Type consistency:** ServiceComponent and FailureMode defined in Task 1 Step 5 (types package) and Task 4 Step 1 (WebUI types) — both match the spec.
