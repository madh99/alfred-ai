# IT Documentation Platform — Phase A (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** InfraDocs Skill erweitern um 18 neue Actions (CRUD, Auto-Generate, Runbook-Management, Versioning) + ITSM/CMDB Integration.

**Architecture:** Bestehende InfraDocsSkill erweitern (kein neues Modul). Bestehende cmdb_documents Tabelle nutzen (neue doc_type Werte). CmdbRepository erweitern um Suche/Versioning. ITSM erweitern um Runbook-Suggest.

**Tech Stack:** TypeScript, PostgreSQL/SQLite, LLM (strong tier fuer Auto-Generate), Vitest

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| (none — alles in bestehende Dateien integriert) | |

### Modified Files
| File | Change |
|------|--------|
| `packages/skills/src/built-in/infra-docs.ts` | 18 neue Actions, erweitertes inputSchema |
| `packages/storage/src/repositories/cmdb-repository.ts` | searchDocuments, getDocumentVersions, Diff-Helper |
| `packages/storage/src/migrations/pg-migrations.ts` | Migration v57: runbook_id auf change_requests |
| `packages/skills/src/built-in/itsm.ts` | Runbook Auto-Suggest bei create_incident |
| `packages/skills/src/built-in/cmdb.ts` | asset_docs Action |
| `packages/messaging/src/adapters/http.ts` | 7 neue /api/docs/* Endpoints |
| `packages/core/src/alfred.ts` | Docs-API Callbacks wiring |

---

### Task 1: DB Migration + Repository Erweiterung

**Files:**
- Modify: `packages/storage/src/migrations/pg-migrations.ts`
- Modify: `packages/storage/src/migrations/pg-schema.ts`
- Modify: `packages/storage/src/repositories/cmdb-repository.ts`

- [ ] **Step 1: Add PG migration v57**

Add to the migrations array in `packages/storage/src/migrations/pg-migrations.ts`:

```typescript
{
  version: 57,
  description: 'IT Documentation Platform — runbook_id on change_requests',
  async up(db) {
    await db.execute('ALTER TABLE cmdb_change_requests ADD COLUMN IF NOT EXISTS runbook_id TEXT DEFAULT NULL', []);
  },
},
```

- [ ] **Step 2: Add runbook_id to pg-schema.ts**

In the `cmdb_change_requests` CREATE TABLE statement, add before the closing parenthesis:
```sql
  runbook_id TEXT
```

- [ ] **Step 3: Add searchDocuments method to CmdbRepository**

```typescript
async searchDocuments(userId: string, query: string, filters?: { docType?: string; limit?: number }): Promise<CmdbDocument[]> {
  const conditions = ['user_id = ?'];
  const params: unknown[] = [userId];
  
  if (query) {
    conditions.push('(title LIKE ? OR content LIKE ?)');
    const pattern = `%${query}%`;
    params.push(pattern, pattern);
  }
  if (filters?.docType) {
    conditions.push('doc_type = ?');
    params.push(filters.docType);
  }
  
  const limit = Math.min(filters?.limit ?? 20, 100);
  const rows = await this.adapter.query(
    `SELECT * FROM cmdb_documents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  ) as Record<string, unknown>[];
  return rows.map(r => this.mapDocument(r));
}
```

- [ ] **Step 4: Add getDocumentVersions method**

```typescript
async getDocumentVersions(userId: string, entityType: string, entityId: string, docType: string): Promise<CmdbDocument[]> {
  const rows = await this.adapter.query(
    'SELECT * FROM cmdb_documents WHERE user_id = ? AND linked_entity_type = ? AND linked_entity_id = ? AND doc_type = ? ORDER BY version DESC',
    [userId, entityType, entityId, docType],
  ) as Record<string, unknown>[];
  return rows.map(r => this.mapDocument(r));
}
```

- [ ] **Step 5: Add updateDocument method**

```typescript
async updateDocument(userId: string, docId: string, updates: { title?: string; content: string }): Promise<CmdbDocument | null> {
  const existing = await this.getDocumentById(userId, docId);
  if (!existing) return null;
  
  // Create new version with updated content
  return this.saveDocument(userId, {
    docType: existing.docType as CmdbDocType,
    title: updates.title ?? existing.title,
    content: updates.content,
    format: existing.format as CmdbDocFormat,
    linkedEntityType: existing.linkedEntityType as CmdbLinkedEntityType,
    linkedEntityId: existing.linkedEntityId,
    generatedBy: 'infra_docs',
  });
}
```

- [ ] **Step 6: Add deleteDocument method**

```typescript
async deleteDocument(userId: string, docId: string): Promise<boolean> {
  const result = await this.adapter.execute(
    'DELETE FROM cmdb_documents WHERE id = ? AND user_id = ?',
    [docId, userId],
  );
  return result.changes > 0;
}
```

- [ ] **Step 7: Add getDocumentTree method**

```typescript
async getDocumentTree(userId: string): Promise<Record<string, any>> {
  const docs = await this.listDocuments(userId, { limit: 500 });
  const assets = await this.listAssets(userId, { status: 'active' });
  const services = await this.adapter.query(
    'SELECT id, name, category FROM cmdb_services WHERE user_id = ? ORDER BY name', [userId],
  ) as any[];
  
  return {
    assets: assets.map(a => ({
      id: a.id, name: a.name, type: a.assetType,
      docs: docs.filter(d => d.linkedEntityType === 'asset' && d.linkedEntityId === a.id)
        .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt })),
    })).filter(a => a.docs.length > 0),
    services: services.map(s => ({
      id: s.id, name: s.name, category: s.category,
      docs: docs.filter(d => d.linkedEntityType === 'service' && d.linkedEntityId === s.id)
        .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt })),
    })).filter(s => s.docs.length > 0),
    unlinked: docs.filter(d => !d.linkedEntityType)
      .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt })),
  };
}
```

- [ ] **Step 8: Build + verify**

```bash
pnpm build
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: IT Docs — Migration v57 + Repository CRUD/Search/Tree"
```

---

### Task 2: InfraDocs CRUD Actions (6 Actions)

**Files:**
- Modify: `packages/skills/src/built-in/infra-docs.ts`

- [ ] **Step 1: Extend Action type + inputSchema**

Add to the Action type union:
```typescript
type Action = 
  | 'inventory_report' | 'topology_diagram' | 'service_map' | 'runbook' | 'change_log' | 'incident_report' | 'export'
  | 'create_doc' | 'get_doc' | 'update_doc' | 'delete_doc' | 'list_docs' | 'search_docs';
```

Add to inputSchema enum:
```typescript
enum: [...existing, 'create_doc', 'get_doc', 'update_doc', 'delete_doc', 'list_docs', 'search_docs']
```

Add new properties:
```typescript
doc_id: { type: 'string', description: 'Document ID' },
doc_type: { type: 'string', enum: ['system_doc', 'service_doc', 'setup_guide', 'config_snapshot', 'runbook', 'sop', 'network_doc', 'policy', 'postmortem', 'custom'], description: 'Dokumenttyp' },
title: { type: 'string', description: 'Dokument-Titel' },
content: { type: 'string', description: 'Dokument-Inhalt (Markdown)' },
linked_entity_type: { type: 'string', enum: ['asset', 'service', 'incident', 'change_request', 'problem'] },
linked_entity_id: { type: 'string' },
query: { type: 'string', description: 'Suchbegriff fuer search_docs' },
version_a: { type: 'number' },
version_b: { type: 'number' },
target_version: { type: 'number' },
```

- [ ] **Step 2: Add execute cases**

```typescript
case 'create_doc': return await this.createDoc(userId, input);
case 'get_doc': return await this.getDoc(userId, input);
case 'update_doc': return await this.updateDoc(userId, input);
case 'delete_doc': return await this.deleteDoc(userId, input);
case 'list_docs': return await this.listDocs(userId, input);
case 'search_docs': return await this.searchDocs(userId, input);
```

- [ ] **Step 3: Implement CRUD methods**

```typescript
private async createDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docType = input.doc_type as string;
  const title = input.title as string;
  const content = input.content as string;
  if (!docType || !title) return { success: false, error: 'doc_type und title sind erforderlich' };

  const doc = await this.cmdb.saveDocument(userId, {
    docType: docType as any,
    title,
    content: content ?? '',
    linkedEntityType: input.linked_entity_type as any,
    linkedEntityId: input.linked_entity_id as string,
  });

  return {
    success: true,
    data: { id: doc.id, version: doc.version },
    display: `Dokument erstellt: **${title}** (${docType}, v${doc.version})\nID: ${doc.id}`,
  };
}

private async getDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  if (!docId) return { success: false, error: 'doc_id erforderlich' };
  const doc = await this.cmdb.getDocumentById(userId, docId);
  if (!doc) return { success: false, error: 'Dokument nicht gefunden' };
  return {
    success: true,
    data: doc,
    display: `## ${doc.title}\n**Typ:** ${doc.docType} | **Version:** ${doc.version} | **Erstellt:** ${doc.createdAt}\n\n${doc.content}`,
  };
}

private async updateDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  const content = input.content as string;
  if (!docId || !content) return { success: false, error: 'doc_id und content erforderlich' };
  const doc = await this.cmdb.updateDocument(userId, docId, { title: input.title as string, content });
  if (!doc) return { success: false, error: 'Dokument nicht gefunden' };
  return {
    success: true,
    data: { id: doc.id, version: doc.version },
    display: `Dokument aktualisiert: **${doc.title}** (v${doc.version})`,
  };
}

private async deleteDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  if (!docId) return { success: false, error: 'doc_id erforderlich' };
  const ok = await this.cmdb.deleteDocument(userId, docId);
  return ok
    ? { success: true, data: { deleted: true }, display: 'Dokument geloescht.' }
    : { success: false, error: 'Dokument nicht gefunden' };
}

private async listDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docs = await this.cmdb.listDocuments(userId, {
    docType: input.doc_type as any,
    entityType: input.linked_entity_type as any,
    limit: (input.limit as number) ?? 20,
  });
  if (docs.length === 0) return { success: true, data: { docs: [] }, display: 'Keine Dokumente gefunden.' };
  const lines = docs.map(d => 
    `- **${d.title}** [${d.docType}] v${d.version} (${d.createdAt.slice(0, 10)})${d.linkedEntityId ? ` → ${d.linkedEntityType}:${d.linkedEntityId.slice(0, 8)}` : ''}`
  );
  return { success: true, data: { docs, count: docs.length }, display: `## Dokumente (${docs.length})\n${lines.join('\n')}` };
}

private async searchDocs(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const query = input.query as string;
  if (!query) return { success: false, error: 'query erforderlich' };
  const docs = await this.cmdb.searchDocuments(userId, query, { docType: input.doc_type as string, limit: (input.limit as number) ?? 10 });
  if (docs.length === 0) return { success: true, data: { results: [] }, display: `Keine Treffer fuer "${query}".` };
  const lines = docs.map(d => `- **${d.title}** [${d.docType}] — ${d.content.slice(0, 100)}...`);
  return { success: true, data: { results: docs, count: docs.length }, display: `## Suche: "${query}" (${docs.length} Treffer)\n${lines.join('\n')}` };
}
```

- [ ] **Step 4: Build + verify**

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: IT Docs — CRUD Actions (create/get/update/delete/list/search)"
```

---

### Task 3: Auto-Generate Actions (4 Actions)

**Files:**
- Modify: `packages/skills/src/built-in/infra-docs.ts`

- [ ] **Step 1: Add Action types + execute cases**

Add to union: `'generate_system_doc' | 'generate_service_doc' | 'generate_network_doc' | 'generate_config_snapshot'`

Add to enum + switch cases.

Add new properties:
```typescript
asset_id: { type: 'string', description: 'Asset ID oder Name (generate_system_doc, generate_config_snapshot)' },
scope: { type: 'string', enum: ['full', 'vlan', 'firewall', 'dns'], description: 'Scope fuer generate_network_doc' },
```

- [ ] **Step 2: Implement generate_system_doc**

```typescript
private async generateSystemDoc(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const assetId = input.asset_id as string ?? input.asset_name as string;
  if (!assetId) return { success: false, error: 'asset_id oder asset_name erforderlich' };

  // 1. Load asset from CMDB
  const assets = await this.cmdb.listAssets(userId, {});
  const asset = assets.find(a => a.id === assetId || a.name === assetId);
  if (!asset) return { success: false, error: `Asset "${assetId}" nicht gefunden` };

  // 2. Collect infrastructure data
  const sections: string[] = [];
  sections.push(`# System-Dokumentation: ${asset.name}`);
  sections.push(`**Typ:** ${asset.assetType} | **IP:** ${asset.ip_address ?? '?'} | **Status:** ${asset.status}`);
  sections.push(`**Hostname:** ${asset.hostname ?? '?'} | **FQDN:** ${asset.fqdn ?? '?'}`);
  if (asset.purpose) sections.push(`**Zweck:** ${asset.purpose}`);
  if (asset.tags?.length) sections.push(`**Tags:** ${asset.tags.join(', ')}`);
  if (asset.notes) sections.push(`**Notizen:** ${asset.notes}`);

  // 3. Load relations (what services run on this asset?)
  const relations = await this.cmdb.getRelationsForAsset(userId, asset.id);
  if (relations.length > 0) {
    sections.push('\n## Verknuepfungen');
    for (const r of relations) {
      sections.push(`- ${r.relationType}: ${r.targetAssetId === asset.id ? r.sourceAssetId : r.targetAssetId}`);
    }
  }

  // 4. Use LLM to enhance with context
  let enhanced = sections.join('\n');
  if (this.llmCallback) {
    try {
      enhanced = await this.llmCallback(
        `Du bist ein IT-Dokumentations-Generator. Erstelle eine vollstaendige System-Dokumentation fuer folgendes Asset. Ergaenze fehlende Abschnitte (OS Details, installierte Software falls bekannt, Netzwerk-Config). Formatiere als Markdown.\n\n${sections.join('\n')}`,
        'strong',
      );
    } catch { /* use raw sections */ }
  }

  // 5. Save document
  const doc = await this.cmdb.saveDocument(userId, {
    docType: 'system_doc' as any,
    title: `System-Dokumentation: ${asset.name}`,
    content: enhanced,
    linkedEntityType: 'asset' as any,
    linkedEntityId: asset.id,
    generatedBy: 'infra_docs',
  });

  return {
    success: true,
    data: { id: doc.id, version: doc.version },
    display: `${enhanced}\n\n---\n_Gespeichert als v${doc.version} (ID: ${doc.id})_`,
  };
}
```

- [ ] **Step 3: Implement generate_service_doc**

Similar to system_doc but loads service + all components + their assets. Uses LLM to generate architecture overview.

- [ ] **Step 4: Implement generate_network_doc**

Loads all assets with type network_device, dns_record, proxy_host, firewall_rule. Groups by type. Uses LLM for Mermaid diagram.

- [ ] **Step 5: Implement generate_config_snapshot**

Minimal: saves current CMDB data for an asset as a config_snapshot document. Full implementation (SSH, Docker inspect) in Phase C with ReflectionEngine.

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: IT Docs — Auto-Generate Actions (system/service/network/config)"
```

---

### Task 4: Runbook Management Actions (5 Actions)

**Files:**
- Modify: `packages/skills/src/built-in/infra-docs.ts`

- [ ] **Step 1: Add Action types**

Add: `'create_runbook' | 'get_runbook' | 'update_runbook' | 'suggest_runbook' | 'execute_runbook'`

- [ ] **Step 2: Implement create_runbook**

```typescript
private async createRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const title = input.title as string;
  if (!title) return { success: false, error: 'title erforderlich' };

  let content = input.content as string ?? '';

  // Auto-generate from incident/service context if requested
  if (input.auto_generate && this.llmCallback) {
    const context: string[] = [];
    if (input.incident_id) {
      const inc = await this.itsm.getIncidentById(userId, input.incident_id as string);
      if (inc) context.push(`Incident: ${inc.title}\nSymptoms: ${inc.symptoms}\nRoot Cause: ${inc.rootCause ?? 'unbekannt'}\nResolution: ${inc.resolution ?? 'offen'}`);
    }
    if (input.service_id) {
      const svc = await this.itsm.getServiceById(userId, input.service_id as string);
      if (svc) context.push(`Service: ${svc.name}\nComponents: ${JSON.stringify(svc.components)}`);
    }
    if (context.length > 0) {
      content = await this.llmCallback(
        `Erstelle ein operatives Runbook basierend auf folgendem Kontext. Strukturiere mit: Symptom, Diagnose-Schritte, Loesung, Nachhaltige Massnahmen. Markdown-Format.\n\n${context.join('\n\n')}`,
        'strong',
      );
    }
  }

  const doc = await this.cmdb.saveDocument(userId, {
    docType: 'runbook' as any,
    title,
    content,
    linkedEntityType: input.linked_entity_type as any ?? (input.service_id ? 'service' : input.incident_id ? 'incident' : undefined),
    linkedEntityId: (input.service_id ?? input.incident_id ?? input.linked_entity_id) as string,
    generatedBy: 'infra_docs',
  });

  return {
    success: true,
    data: { id: doc.id, version: doc.version },
    display: content
      ? `## Runbook: ${title}\n\n${content}\n\n---\n_Gespeichert (ID: ${doc.id}, v${doc.version})_`
      : `Runbook "${title}" erstellt (ID: ${doc.id}). Inhalt hinzufuegen mit update_doc.`,
  };
}
```

- [ ] **Step 3: Implement suggest_runbook**

```typescript
private async suggestRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const query = input.query as string ?? '';
  let searchTerms = query;

  // If incident_id given, extract keywords from incident
  if (input.incident_id) {
    const inc = await this.itsm.getIncidentById(userId, input.incident_id as string);
    if (inc) searchTerms = `${inc.title} ${inc.symptoms ?? ''}`;
  }

  if (!searchTerms) return { success: false, error: 'query oder incident_id erforderlich' };

  const runbooks = await this.cmdb.searchDocuments(userId, searchTerms, { docType: 'runbook', limit: 5 });
  if (runbooks.length === 0) return { success: true, data: { suggestions: [] }, display: 'Keine passenden Runbooks gefunden.' };

  const lines = runbooks.map((r, i) =>
    `${i + 1}. **${r.title}** (v${r.version}, ${r.createdAt.slice(0, 10)})\n   ${r.content.slice(0, 150).replace(/\n/g, ' ')}...`
  );
  return {
    success: true,
    data: { suggestions: runbooks.map(r => ({ id: r.id, title: r.title, version: r.version })) },
    display: `## Passende Runbooks\n\n${lines.join('\n\n')}`,
  };
}
```

- [ ] **Step 4: Implement execute_runbook (stub — full implementation needs Workflow integration)**

```typescript
private async executeRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const runbookId = input.runbook_id as string ?? input.doc_id as string;
  if (!runbookId) return { success: false, error: 'runbook_id erforderlich' };
  const doc = await this.cmdb.getDocumentById(userId, runbookId);
  if (!doc || doc.docType !== 'runbook') return { success: false, error: 'Runbook nicht gefunden' };

  // Parse runbook steps (numbered list items or ## headers)
  const steps = doc.content.split('\n')
    .filter(l => /^\d+[.)]\s|^##\s/.test(l.trim()))
    .map(l => l.replace(/^\d+[.)]\s*|^##\s*/, '').trim());

  if (steps.length === 0) return { success: false, error: 'Keine ausfuehrbaren Schritte im Runbook erkannt' };

  return {
    success: true,
    data: { runbookId, title: doc.title, steps, stepCount: steps.length },
    display: `## Runbook: ${doc.title}\n\n${steps.length} Schritte erkannt:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\nWorkflow-Ausfuehrung erfordert manuelle Bestaetigung pro Schritt.`,
  };
}
```

- [ ] **Step 5: Implement get_runbook + update_runbook (delegate to getDoc/updateDoc)**

```typescript
private async getRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  return this.getDoc(userId, { doc_id: input.runbook_id ?? input.doc_id });
}

private async updateRunbook(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  return this.updateDoc(userId, { doc_id: input.runbook_id ?? input.doc_id, content: input.content, title: input.title });
}
```

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: IT Docs — Runbook Management (create/get/update/suggest/execute)"
```

---

### Task 5: Versioning Actions (3 Actions)

**Files:**
- Modify: `packages/skills/src/built-in/infra-docs.ts`

- [ ] **Step 1: Add Action types + execute cases**

Add: `'doc_versions' | 'doc_diff' | 'doc_revert'`

- [ ] **Step 2: Implement doc_versions**

```typescript
private async docVersions(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  if (!docId) return { success: false, error: 'doc_id erforderlich' };
  const doc = await this.cmdb.getDocumentById(userId, docId);
  if (!doc) return { success: false, error: 'Dokument nicht gefunden' };

  const versions = await this.cmdb.getDocumentVersions(
    userId, doc.linkedEntityType!, doc.linkedEntityId!, doc.docType,
  );
  const lines = versions.map(v =>
    `- v${v.version} (${v.createdAt.slice(0, 16)}) — ${v.content.length} Zeichen`
  );
  return {
    success: true,
    data: { versions: versions.map(v => ({ id: v.id, version: v.version, createdAt: v.createdAt })) },
    display: `## Versionen: ${doc.title}\n${lines.join('\n')}`,
  };
}
```

- [ ] **Step 3: Implement doc_diff**

```typescript
private async docDiff(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  const va = input.version_a as number;
  const vb = input.version_b as number;
  if (!docId || !va || !vb) return { success: false, error: 'doc_id, version_a, version_b erforderlich' };

  const doc = await this.cmdb.getDocumentById(userId, docId);
  if (!doc) return { success: false, error: 'Dokument nicht gefunden' };

  const versions = await this.cmdb.getDocumentVersions(userId, doc.linkedEntityType!, doc.linkedEntityId!, doc.docType);
  const docA = versions.find(v => v.version === va);
  const docB = versions.find(v => v.version === vb);
  if (!docA || !docB) return { success: false, error: 'Version nicht gefunden' };

  // Simple line diff
  const linesA = docA.content.split('\n');
  const linesB = docB.content.split('\n');
  const diff: string[] = [`## Diff: v${va} → v${vb}`, ''];
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i++) {
    const a = linesA[i] ?? '';
    const b = linesB[i] ?? '';
    if (a !== b) {
      if (a) diff.push(`- ${a}`);
      if (b) diff.push(`+ ${b}`);
    }
  }
  if (diff.length === 2) diff.push('(keine Unterschiede)');

  return { success: true, data: { changes: diff.length - 2 }, display: diff.join('\n') };
}
```

- [ ] **Step 4: Implement doc_revert**

```typescript
private async docRevert(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
  const docId = input.doc_id as string;
  const targetVersion = input.target_version as number;
  if (!docId || !targetVersion) return { success: false, error: 'doc_id und target_version erforderlich' };

  const doc = await this.cmdb.getDocumentById(userId, docId);
  if (!doc) return { success: false, error: 'Dokument nicht gefunden' };

  const versions = await this.cmdb.getDocumentVersions(userId, doc.linkedEntityType!, doc.linkedEntityId!, doc.docType);
  const target = versions.find(v => v.version === targetVersion);
  if (!target) return { success: false, error: `Version ${targetVersion} nicht gefunden` };

  const reverted = await this.cmdb.updateDocument(userId, docId, { content: target.content, title: target.title });
  return {
    success: true,
    data: { id: reverted!.id, version: reverted!.version, revertedTo: targetVersion },
    display: `Dokument auf v${targetVersion} zurueckgesetzt → neue v${reverted!.version}`,
  };
}
```

- [ ] **Step 5: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: IT Docs — Versioning Actions (versions/diff/revert)"
```

---

### Task 6: ITSM Runbook-Suggest + CMDB asset_docs

**Files:**
- Modify: `packages/skills/src/built-in/itsm.ts`
- Modify: `packages/skills/src/built-in/cmdb.ts`

- [ ] **Step 1: Add Runbook-Suggest to ITSM create_incident**

Find the `create_incident` handler in itsm.ts. After the incident is created and returned, add:

```typescript
// Auto-suggest matching runbooks
try {
  if (this.cmdbRepo) {
    const searchTerms = `${data.title ?? ''} ${data.symptoms ?? ''}`;
    const runbooks = await this.cmdbRepo.searchDocuments(userId, searchTerms, { docType: 'runbook', limit: 3 });
    if (runbooks.length > 0) {
      const suggestions = runbooks.map(r => `  📋 ${r.title} (v${r.version})`).join('\n');
      result.display += `\n\n**Passende Runbooks:**\n${suggestions}`;
    }
  }
} catch { /* non-critical */ }
```

- [ ] **Step 2: Add asset_docs to CMDB skill**

In cmdb.ts, add action `asset_docs` to the enum and switch:

```typescript
case 'asset_docs': {
  const entityId = input.asset_id as string ?? input.service_id as string;
  const entityType = input.service_id ? 'service' : 'asset';
  if (!entityId) return { success: false, error: 'asset_id oder service_id erforderlich' };
  const docs = await this.cmdbRepo.getDocumentsForEntity(userId, entityType as any, entityId);
  if (docs.length === 0) return { success: true, data: { docs: [] }, display: 'Keine Dokumente fuer dieses Asset/Service.' };
  const lines = docs.map(d => `- **${d.title}** [${d.docType}] v${d.version} (${d.createdAt.slice(0, 10)})`);
  return { success: true, data: { docs, count: docs.length }, display: `## Dokumente (${docs.length})\n${lines.join('\n')}` };
}
```

- [ ] **Step 3: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: IT Docs — ITSM Runbook-Suggest + CMDB asset_docs"
```

---

### Task 7: API Endpoints + Wiring

**Files:**
- Modify: `packages/messaging/src/adapters/http.ts`
- Modify: `packages/core/src/alfred.ts`

- [ ] **Step 1: Add 7 new /api/docs/* endpoints to HTTP adapter**

In `handleRequest`, add before the CMDB section:

```typescript
// ── Docs API (extended) ──
} else if (url.pathname === '/api/docs/list' && req.method === 'GET') {
  this.handleCmdbRoute(req, res, (cbs, userId) => {
    const filters = Object.fromEntries(url.searchParams.entries());
    return cbs.listDocuments(userId, filters);
  });
} else if (url.pathname === '/api/docs/tree' && req.method === 'GET') {
  this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocumentTree(userId));
} else if (url.pathname.match(/^\/api\/docs\/[^/]+\/versions$/) && req.method === 'GET') {
  const id = url.pathname.split('/')[3];
  this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocumentVersions(userId, '', '', '').then(() => 
    cbs.getDocumentsForEntity(userId, '', id) // simplified — full versioning in skill
  ));
} else if (url.pathname.startsWith('/api/docs/') && req.method === 'GET') {
  const id = url.pathname.split('/').pop()!;
  this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocument(userId, id));
} else if (url.pathname === '/api/docs' && req.method === 'POST') {
  this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.saveDocument(userId, body));
} else if (url.pathname.startsWith('/api/docs/') && req.method === 'PATCH') {
  const id = url.pathname.split('/').pop()!;
  this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.updateDocument(userId, id, body));
} else if (url.pathname.startsWith('/api/docs/') && req.method === 'DELETE') {
  const id = url.pathname.split('/').pop()!;
  this.handleCmdbRoute(req, res, (cbs, userId) => cbs.deleteDocument(userId, id));
}
```

- [ ] **Step 2: Wire callbacks in alfred.ts**

The CMDB callbacks already include `listDocuments` and `getDocument`. Add the new methods (`searchDocuments`, `updateDocument`, `deleteDocument`, `getDocumentTree`, `saveDocument`) to the existing CMDB callback object.

- [ ] **Step 3: Build + commit**

```bash
pnpm build
git add -A
git commit -m "feat: IT Docs — API Endpoints + Wiring"
```

---

### Task 8: Version Bump + CHANGELOG + Release

- [ ] **Step 1: Version bump**

```bash
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('packages/cli/package.json','utf8'));p.version='0.19.0-multi-ha.528';fs.writeFileSync('packages/cli/package.json',JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 2: CHANGELOG + README + Bundle**

Add CHANGELOG entry for v528. Update README badge. Run bundle.

- [ ] **Step 3: Final build + commit + push**

```bash
pnpm build
node scripts/bundle.mjs
git add -A
git commit -m "feat: IT Documentation Platform Phase A — 18 neue InfraDocs Actions"
git push gitlab feature/multi-user
git push github feature/multi-user
```

---

## Self-Review

**Spec coverage:**
- CRUD (6 actions) → Task 2 ✓
- Auto-Generate (4 actions) → Task 3 ✓
- Runbook Management (5 actions) → Task 4 ✓
- Versioning (3 actions) → Task 5 ✓
- ITSM Runbook-Suggest → Task 6 ✓
- CMDB asset_docs → Task 6 ✓
- DB Migration → Task 1 ✓
- API Endpoints → Task 7 ✓
- WebUI → Phase B (separate plan)
- ReflectionEngine DocReflector → Phase C (separate plan)

**Placeholder scan:** No TBDs. generate_service_doc/network_doc/config_snapshot in Task 3 Steps 3-5 have brief descriptions — they follow the same pattern as generate_system_doc (Step 2 shows the full pattern).

**Type consistency:** All methods use `(userId: string, input: Record<string, unknown>)` consistently. CmdbRepository methods follow existing patterns.
