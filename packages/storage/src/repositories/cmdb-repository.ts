import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type {
  CmdbAsset, CmdbAssetRelation, CmdbChange, CmdbDocument,
  CmdbAssetType, CmdbAssetStatus, CmdbRelationType,
  CmdbChangeType, CmdbChangeCategory, CmdbEnvironment,
  CmdbDocType, CmdbDocFormat, CmdbLinkedEntityType,
} from '@alfred/types';

// ── Row → Domain Mappers ─────────────────────────────────────

function rowToAsset(r: DbRow): CmdbAsset {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    assetType: r.asset_type as CmdbAssetType,
    name: r.name as string,
    identifier: r.identifier as string | undefined,
    sourceSkill: r.source_skill as string | undefined,
    sourceId: r.source_id as string | undefined,
    environment: r.environment as CmdbEnvironment | undefined,
    status: r.status as CmdbAssetStatus,
    ipAddress: r.ip_address as string | undefined,
    hostname: r.hostname as string | undefined,
    fqdn: r.fqdn as string | undefined,
    location: r.location as string | undefined,
    owner: r.owner as string | undefined,
    purpose: r.purpose as string | undefined,
    attributes: JSON.parse((r.attributes as string) || '{}'),
    tags: r.tags as string | undefined,
    notes: r.notes as string | undefined,
    discoveredAt: r.discovered_at as string | undefined,
    lastSeenAt: r.last_seen_at as string | undefined,
    lastVerifiedAt: r.last_verified_at as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToRelation(r: DbRow): CmdbAssetRelation {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    sourceAssetId: r.source_asset_id as string,
    targetAssetId: r.target_asset_id as string,
    relationType: r.relation_type as CmdbRelationType,
    autoDiscovered: !!(r.auto_discovered as number),
    attributes: JSON.parse((r.attributes as string) || '{}'),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToChange(r: DbRow): CmdbChange {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    assetId: r.asset_id as string | undefined,
    changeType: r.change_type as CmdbChangeType,
    category: r.category as CmdbChangeCategory,
    fieldName: r.field_name as string | undefined,
    oldValue: r.old_value as string | undefined,
    newValue: r.new_value as string | undefined,
    description: r.description as string | undefined,
    source: r.source as string | undefined,
    createdAt: r.created_at as string,
  };
}

function rowToDocument(r: DbRow): CmdbDocument {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    docType: r.doc_type as CmdbDocType,
    title: r.title as string,
    content: r.content as string,
    format: (r.format as CmdbDocFormat) ?? 'markdown',
    linkedEntityType: r.linked_entity_type as CmdbLinkedEntityType | undefined,
    linkedEntityId: r.linked_entity_id as string | undefined,
    version: r.version as number,
    generatedBy: r.generated_by as string | undefined,
    createdAt: r.created_at as string,
  };
}

// ── Repository ───────────────────────────────────────────────

export class CmdbRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  // ── Assets ─────────────────────────────────────────────────

  async upsertAsset(userId: string, asset: Partial<CmdbAsset> & { name: string; assetType: CmdbAssetType }): Promise<CmdbAsset> {
    const now = new Date().toISOString();
    const id = asset.id || randomUUID();
    const attrs = JSON.stringify(asset.attributes || {});

    // Try update by source_skill + source_id first (discovery merge)
    // For manual assets (no source), dedup by name + asset_type
    if (!asset.sourceSkill) {
      const existing = await this.db.queryOne(
        `SELECT id FROM cmdb_assets WHERE user_id = ? AND name = ? AND asset_type = ? AND source_skill IS NULL`,
        [userId, asset.name, asset.assetType],
      );
      if (existing) {
        await this.db.execute(
          `UPDATE cmdb_assets SET
            identifier = ?, environment = ?, status = ?,
            ip_address = ?, hostname = ?, fqdn = ?, location = ?, owner = ?, purpose = ?,
            attributes = ?, tags = ?, notes = ?, updated_at = ?
          WHERE id = ?`,
          [
            asset.identifier ?? null, asset.environment ?? null, asset.status ?? 'active',
            asset.ipAddress ?? null, asset.hostname ?? null, asset.fqdn ?? null,
            asset.location ?? null, asset.owner ?? null, asset.purpose ?? null,
            attrs, asset.tags ?? null, asset.notes ?? null, now,
            existing.id as string,
          ],
        );
        return this.getAssetById(userId, existing.id as string) as Promise<CmdbAsset>;
      }
    }
    if (asset.sourceSkill && asset.sourceId) {
      const existing = await this.db.queryOne(
        `SELECT id FROM cmdb_assets WHERE user_id = ? AND source_skill = ? AND source_id = ?`,
        [userId, asset.sourceSkill, asset.sourceId],
      );
      if (existing) {
        await this.db.execute(
          `UPDATE cmdb_assets SET
            name = ?, asset_type = ?, identifier = ?, environment = ?, status = ?,
            ip_address = ?, hostname = ?, fqdn = ?, location = ?, owner = ?, purpose = ?,
            attributes = ?, tags = ?, notes = ?,
            last_seen_at = ?, last_verified_at = ?, updated_at = ?
          WHERE id = ?`,
          [
            asset.name, asset.assetType, asset.identifier ?? null,
            asset.environment ?? null, asset.status ?? 'active',
            asset.ipAddress ?? null, asset.hostname ?? null, asset.fqdn ?? null,
            asset.location ?? null, asset.owner ?? null, asset.purpose ?? null,
            attrs, asset.tags ?? null, asset.notes ?? null,
            now, now, now,
            existing.id as string,
          ],
        );
        return this.getAssetById(userId, existing.id as string) as Promise<CmdbAsset>;
      }
    }

    // Insert new
    await this.db.execute(
      `INSERT INTO cmdb_assets (
        id, user_id, asset_type, name, identifier, source_skill, source_id,
        environment, status, ip_address, hostname, fqdn, location, owner, purpose,
        attributes, tags, notes, discovered_at, last_seen_at, last_verified_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, asset.assetType, asset.name, asset.identifier ?? null,
        asset.sourceSkill ?? null, asset.sourceId ?? null,
        asset.environment ?? null, asset.status ?? 'active',
        asset.ipAddress ?? null, asset.hostname ?? null, asset.fqdn ?? null,
        asset.location ?? null, asset.owner ?? null, asset.purpose ?? null,
        attrs, asset.tags ?? null, asset.notes ?? null,
        now, now, now, now, now,
      ],
    );

    return this.getAssetById(userId, id) as Promise<CmdbAsset>;
  }

  async getAssetById(userId: string, id: string): Promise<CmdbAsset | null> {
    const row = await this.db.queryOne(
      `SELECT * FROM cmdb_assets WHERE id = ? AND user_id = ?`, [id, userId],
    );
    return row ? rowToAsset(row) : null;
  }

  async findAssetByName(userId: string, name: string, assetType?: CmdbAssetType): Promise<CmdbAsset | null> {
    const sql = assetType
      ? `SELECT * FROM cmdb_assets WHERE user_id = ? AND name = ? AND asset_type = ? LIMIT 1`
      : `SELECT * FROM cmdb_assets WHERE user_id = ? AND name = ? LIMIT 1`;
    const params = assetType ? [userId, name, assetType] : [userId, name];
    const row = await this.db.queryOne(sql, params);
    return row ? rowToAsset(row) : null;
  }

  async listAssets(userId: string, filters?: {
    assetType?: CmdbAssetType; status?: CmdbAssetStatus; environment?: CmdbEnvironment;
    sourceSkill?: string; search?: string; tags?: string;
  }): Promise<CmdbAsset[]> {
    let sql = `SELECT * FROM cmdb_assets WHERE user_id = ?`;
    const params: unknown[] = [userId];

    if (filters?.assetType) { sql += ` AND asset_type = ?`; params.push(filters.assetType); }
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    if (filters?.environment) { sql += ` AND environment = ?`; params.push(filters.environment); }
    if (filters?.sourceSkill) { sql += ` AND source_skill = ?`; params.push(filters.sourceSkill); }
    if (filters?.tags) { sql += ` AND tags LIKE ?`; params.push(`%${filters.tags}%`); }
    if (filters?.search) {
      sql += ` AND (name LIKE ? OR purpose LIKE ? OR notes LIKE ? OR hostname LIKE ? OR ip_address LIKE ?)`;
      const s = `%${filters.search}%`;
      params.push(s, s, s, s, s);
    }

    sql += ` ORDER BY asset_type, name`;
    const rows = await this.db.query(sql, params);
    return rows.map(rowToAsset);
  }

  async updateAsset(userId: string, id: string, updates: Partial<CmdbAsset>): Promise<CmdbAsset | null> {
    const existing = await this.getAssetById(userId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: unknown[] = [];

    const map: Record<string, string> = {
      name: 'name', assetType: 'asset_type', identifier: 'identifier',
      environment: 'environment', status: 'status', ipAddress: 'ip_address',
      hostname: 'hostname', fqdn: 'fqdn', location: 'location',
      owner: 'owner', purpose: 'purpose', tags: 'tags', notes: 'notes',
    };

    for (const [key, col] of Object.entries(map)) {
      if (key in updates) { fields.push(`${col} = ?`); params.push((updates as any)[key] ?? null); }
    }
    if (updates.attributes) { fields.push(`attributes = ?`); params.push(JSON.stringify(updates.attributes)); }
    if ((updates as any).sla !== undefined) { fields.push('sla = ?'); params.push(JSON.stringify((updates as any).sla)); }

    if (fields.length === 0) return existing;

    fields.push(`updated_at = ?`);
    params.push(new Date().toISOString());
    params.push(id, userId);

    await this.db.execute(`UPDATE cmdb_assets SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);

    // Log changes
    for (const [key, col] of Object.entries(map)) {
      if (key in updates && (updates as any)[key] !== (existing as any)[key]) {
        await this.logChange(userId, id, 'updated', 'manual', col, String((existing as any)[key] ?? ''), String((updates as any)[key] ?? ''));
      }
    }

    return this.getAssetById(userId, id);
  }

  async decommissionAsset(userId: string, id: string): Promise<boolean> {
    const existing = await this.getAssetById(userId, id);
    const oldStatus = existing?.status ?? 'unknown';
    const result = await this.db.execute(
      `UPDATE cmdb_assets SET status = 'decommissioned', updated_at = ? WHERE id = ? AND user_id = ?`,
      [new Date().toISOString(), id, userId],
    );
    if (result.changes > 0) {
      await this.logChange(userId, id, 'decommissioned', 'manual', 'status', oldStatus, 'decommissioned');
    }
    return result.changes > 0;
  }

  async deleteAsset(userId: string, id: string): Promise<boolean> {
    const result = await this.db.execute(`DELETE FROM cmdb_assets WHERE id = ? AND user_id = ?`, [id, userId]);
    if (result.changes > 0) {
      await this.logChange(userId, null, 'deleted', 'manual', undefined, id, undefined, `Asset ${id} gelöscht`);
    }
    return result.changes > 0;
  }

  async getAssetBySource(userId: string, sourceSkill: string, sourceId: string): Promise<CmdbAsset | null> {
    const row = await this.db.queryOne(
      `SELECT * FROM cmdb_assets WHERE user_id = ? AND source_skill = ? AND source_id = ?`,
      [userId, sourceSkill, sourceId],
    );
    return row ? rowToAsset(row) : null;
  }

  async markStaleAssets(userId: string, sourceSkill: string, _runStart: string, thresholdDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - thresholdDays * 86_400_000).toISOString();
    const result = await this.db.execute(
      `UPDATE cmdb_assets SET status = 'unknown', updated_at = ?
       WHERE user_id = ? AND source_skill = ? AND last_verified_at < ? AND status NOT IN ('decommissioned', 'unknown')`,
      [new Date().toISOString(), userId, sourceSkill, cutoff],
    );
    return result.changes;
  }

  async getStats(userId: string): Promise<{ byType: Record<string, number>; byStatus: Record<string, number>; bySource: Record<string, number>; total: number }> {
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    const typeRows = await this.db.query(`SELECT asset_type, COUNT(*) as cnt FROM cmdb_assets WHERE user_id = ? GROUP BY asset_type`, [userId]);
    for (const r of typeRows) byType[r.asset_type as string] = r.cnt as number;

    const statusRows = await this.db.query(`SELECT status, COUNT(*) as cnt FROM cmdb_assets WHERE user_id = ? GROUP BY status`, [userId]);
    for (const r of statusRows) byStatus[r.status as string] = r.cnt as number;

    const sourceRows = await this.db.query(`SELECT COALESCE(source_skill, 'manual') as src, COUNT(*) as cnt FROM cmdb_assets WHERE user_id = ? GROUP BY src`, [userId]);
    for (const r of sourceRows) bySource[r.src as string] = r.cnt as number;

    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    return { byType, byStatus, bySource, total };
  }

  // ── Relations ──────────────────────────────────────────────

  async upsertRelation(userId: string, sourceAssetId: string, targetAssetId: string, relationType: CmdbRelationType, autoDiscovered = false, attributes: Record<string, unknown> = {}): Promise<CmdbAssetRelation> {
    const existing = await this.db.queryOne(
      `SELECT id FROM cmdb_asset_relations WHERE user_id = ? AND source_asset_id = ? AND target_asset_id = ? AND relation_type = ?`,
      [userId, sourceAssetId, targetAssetId, relationType],
    );

    const now = new Date().toISOString();
    if (existing) {
      await this.db.execute(
        `UPDATE cmdb_asset_relations SET attributes = ?, auto_discovered = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(attributes), autoDiscovered ? 1 : 0, now, existing.id],
      );
      const row = await this.db.queryOne(`SELECT * FROM cmdb_asset_relations WHERE id = ?`, [existing.id]);
      return rowToRelation(row!);
    }

    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO cmdb_asset_relations (id, user_id, source_asset_id, target_asset_id, relation_type, auto_discovered, attributes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, sourceAssetId, targetAssetId, relationType, autoDiscovered ? 1 : 0, JSON.stringify(attributes), now, now],
    );

    await this.logChange(userId, sourceAssetId, 'relation_added', autoDiscovered ? 'auto_discovery' : 'manual', 'relation', undefined, `${relationType} → ${targetAssetId}`);

    const row = await this.db.queryOne(`SELECT * FROM cmdb_asset_relations WHERE id = ?`, [id]);
    return rowToRelation(row!);
  }

  async getRelationsForAsset(userId: string, assetId: string): Promise<CmdbAssetRelation[]> {
    const rows = await this.db.query(
      `SELECT * FROM cmdb_asset_relations WHERE user_id = ? AND (source_asset_id = ? OR target_asset_id = ?)`,
      [userId, assetId, assetId],
    );
    return rows.map(rowToRelation);
  }

  async getAllRelations(userId: string): Promise<CmdbAssetRelation[]> {
    const rows = await this.db.query(`SELECT * FROM cmdb_asset_relations WHERE user_id = ?`, [userId]);
    return rows.map(rowToRelation);
  }

  async removeRelation(userId: string, id: string): Promise<boolean> {
    const rel = await this.db.queryOne(`SELECT * FROM cmdb_asset_relations WHERE id = ? AND user_id = ?`, [id, userId]);
    if (!rel) return false;
    await this.db.execute(`DELETE FROM cmdb_asset_relations WHERE id = ?`, [id]);
    await this.logChange(userId, rel.source_asset_id as string, 'relation_removed', 'manual', 'relation', `${rel.relation_type} → ${rel.target_asset_id}`, undefined);
    return true;
  }

  async clearAutoRelations(userId: string): Promise<number> {
    const result = await this.db.execute(`DELETE FROM cmdb_asset_relations WHERE user_id = ? AND auto_discovered = 1`, [userId]);
    return result.changes;
  }

  // ── Topology (graph traversal) ─────────────────────────────

  async getTopology(userId: string, assetId: string, depth = 3): Promise<{ assets: CmdbAsset[]; relations: CmdbAssetRelation[] }> {
    const visited = new Set<string>();
    const queue = [assetId];
    const allRelations: CmdbAssetRelation[] = [];

    const MAX_ASSETS = 200;
    for (let d = 0; d < depth && queue.length > 0; d++) {
      const batch = [...queue];
      queue.length = 0;
      for (const id of batch) {
        if (visited.has(id) || visited.size >= MAX_ASSETS) continue;
        visited.add(id);
        const rels = await this.getRelationsForAsset(userId, id);
        for (const rel of rels) {
          allRelations.push(rel);
          const otherId = rel.sourceAssetId === id ? rel.targetAssetId : rel.sourceAssetId;
          if (!visited.has(otherId)) queue.push(otherId);
        }
      }
    }

    const assets: CmdbAsset[] = [];
    for (const id of visited) {
      const a = await this.getAssetById(userId, id);
      if (a) assets.push(a);
    }

    // Deduplicate relations
    const seenRels = new Set<string>();
    const uniqueRels = allRelations.filter(r => {
      if (seenRels.has(r.id)) return false;
      seenRels.add(r.id);
      return true;
    });

    return { assets, relations: uniqueRels };
  }

  // ── Change Log ─────────────────────────────────────────────

  async logChange(
    userId: string, assetId: string | null | undefined,
    changeType: CmdbChangeType, category: CmdbChangeCategory,
    fieldName?: string, oldValue?: string, newValue?: string, description?: string, source?: string,
  ): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO cmdb_changes (id, user_id, asset_id, change_type, category, field_name, old_value, new_value, description, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), userId, assetId ?? null, changeType, category, fieldName ?? null, oldValue ?? null, newValue ?? null, description ?? null, source ?? null, new Date().toISOString()],
      );
    } catch {
      // Non-critical — don't break operations if change logging fails
    }
  }

  async getChangesForAsset(userId: string, assetId: string, limit = 50): Promise<CmdbChange[]> {
    const rows = await this.db.query(
      `SELECT * FROM cmdb_changes WHERE user_id = ? AND asset_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, assetId, limit],
    );
    return rows.map(rowToChange);
  }

  async getRecentChanges(userId: string, limit = 100, since?: string): Promise<CmdbChange[]> {
    let sql = `SELECT * FROM cmdb_changes WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (since) { sql += ` AND created_at >= ?`; params.push(since); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = await this.db.query(sql, params);
    return rows.map(rowToChange);
  }

  // ── Search ─────────────────────────────────────────────────

  async searchAssets(userId: string, query: string): Promise<CmdbAsset[]> {
    const q = `%${query}%`;
    const rows = await this.db.query(
      `SELECT * FROM cmdb_assets WHERE user_id = ? AND (
        name LIKE ? OR purpose LIKE ? OR notes LIKE ? OR hostname LIKE ? OR ip_address LIKE ? OR fqdn LIKE ? OR tags LIKE ?
      ) ORDER BY name LIMIT 50`,
      [userId, q, q, q, q, q, q, q],
    );
    return rows.map(rowToAsset);
  }

  // ── Documents ──────────────────────────────────────────────

  async saveDocument(userId: string, doc: {
    docType: CmdbDocType; title: string; content: string;
    format?: CmdbDocFormat; linkedEntityType?: CmdbLinkedEntityType;
    linkedEntityId?: string; generatedBy?: string;
  }): Promise<CmdbDocument> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const contentTrimmed = doc.content.slice(0, 50_000);

    // Use transaction to prevent version race condition
    return this.db.transaction(async (tx) => {
      // Determine next version inside transaction
      let version = 1;
      if (doc.linkedEntityId) {
        const prev = await tx.queryOne(
          `SELECT MAX(version) as max_v FROM cmdb_documents WHERE user_id = ? AND doc_type = ? AND linked_entity_id = ?`,
          [userId, doc.docType, doc.linkedEntityId],
        );
        if (prev?.max_v) version = (prev.max_v as number) + 1;
      } else {
        const prev = await tx.queryOne(
          `SELECT MAX(version) as max_v FROM cmdb_documents WHERE user_id = ? AND doc_type = ? AND linked_entity_id IS NULL`,
          [userId, doc.docType],
        );
        if (prev?.max_v) version = (prev.max_v as number) + 1;
      }

      await tx.execute(
        `INSERT INTO cmdb_documents (id, user_id, doc_type, title, content, format, linked_entity_type, linked_entity_id, version, generated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, doc.docType, doc.title, contentTrimmed, doc.format ?? 'markdown',
       doc.linkedEntityType ?? null, doc.linkedEntityId ?? null, version, doc.generatedBy ?? 'infra_docs', now],
      );

      return { id, userId, docType: doc.docType, title: doc.title, content: contentTrimmed,
        format: (doc.format ?? 'markdown') as CmdbDocFormat, linkedEntityType: doc.linkedEntityType,
        linkedEntityId: doc.linkedEntityId, version, generatedBy: doc.generatedBy ?? 'infra_docs', createdAt: now };
    });
  }

  async getDocumentsForEntity(userId: string, entityType: CmdbLinkedEntityType, entityId: string): Promise<CmdbDocument[]> {
    const rows = await this.db.query(
      `SELECT * FROM cmdb_documents WHERE user_id = ? AND linked_entity_type = ? AND linked_entity_id = ? ORDER BY version DESC`,
      [userId, entityType, entityId],
    );
    return rows.map(rowToDocument);
  }

  async getLatestDocument(userId: string, docType: CmdbDocType, entityId?: string): Promise<CmdbDocument | null> {
    let sql = `SELECT * FROM cmdb_documents WHERE user_id = ? AND doc_type = ?`;
    const params: unknown[] = [userId, docType];
    if (entityId) { sql += ` AND linked_entity_id = ?`; params.push(entityId); }
    else { sql += ` AND linked_entity_id IS NULL`; }
    sql += ` ORDER BY version DESC LIMIT 1`;
    const row = await this.db.queryOne(sql, params);
    return row ? rowToDocument(row) : null;
  }

  async listDocuments(userId: string, filters?: { docType?: CmdbDocType; entityType?: CmdbLinkedEntityType; limit?: number }): Promise<CmdbDocument[]> {
    let sql = `SELECT * FROM cmdb_documents WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.docType) { sql += ` AND doc_type = ?`; params.push(filters.docType); }
    if (filters?.entityType) { sql += ` AND linked_entity_type = ?`; params.push(filters.entityType); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.db.query(sql, params);
    return rows.map(rowToDocument);
  }

  async getDocumentById(userId: string, id: string): Promise<CmdbDocument | null> {
    const row = await this.db.queryOne(`SELECT * FROM cmdb_documents WHERE id = ? AND user_id = ?`, [id, userId]);
    return row ? rowToDocument(row) : null;
  }

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
    const rows = await this.db.query(
      `SELECT * FROM cmdb_documents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map(rowToDocument);
  }

  async getDocumentVersions(userId: string, entityType: string, entityId: string, docType: string): Promise<CmdbDocument[]> {
    const rows = await this.db.query(
      'SELECT * FROM cmdb_documents WHERE user_id = ? AND linked_entity_type = ? AND linked_entity_id = ? AND doc_type = ? ORDER BY version DESC',
      [userId, entityType, entityId, docType],
    );
    return rows.map(rowToDocument);
  }

  async updateDocument(userId: string, docId: string, updates: { title?: string; content: string }): Promise<CmdbDocument | null> {
    const existing = await this.getDocumentById(userId, docId);
    if (!existing) return null;
    return this.saveDocument(userId, {
      docType: existing.docType as any,
      title: updates.title ?? existing.title,
      content: updates.content,
      format: existing.format as any,
      linkedEntityType: existing.linkedEntityType as any,
      linkedEntityId: existing.linkedEntityId ?? undefined,
      generatedBy: 'infra_docs',
    });
  }

  async deleteDocument(userId: string, docId: string): Promise<boolean> {
    const result = await this.db.execute(
      'DELETE FROM cmdb_documents WHERE id = ? AND user_id = ?', [docId, userId],
    );
    return result.changes > 0;
  }

  async getDocumentTree(userId: string): Promise<Record<string, any>> {
    const docs = await this.listDocuments(userId, { limit: 500 });
    const assets = await this.listAssets(userId, { status: 'active' });
    const services = await this.db.query(
      'SELECT id, name, category FROM cmdb_services WHERE user_id = ? ORDER BY name', [userId],
    ) as any[];
    return {
      assets: assets.map(a => ({
        id: a.id, name: a.name, type: a.assetType,
        docs: docs.filter(d => d.linkedEntityType === 'asset' && (d.linkedEntityId === a.id || d.linkedEntityId === a.name))
          .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt })),
      })).filter(a => a.docs.length > 0),
      services: services.map((s: any) => ({
        id: s.id, name: s.name, category: s.category,
        docs: docs.filter(d => d.linkedEntityType === 'service' && (d.linkedEntityId === s.id || d.linkedEntityId === s.name))
          .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt })),
      })).filter((s: any) => s.docs.length > 0),
      // Track which docs are linked (by ID or name)
      unlinked: (() => {
        const linkedIds = new Set<string>();
        for (const a of assets) {
          for (const d of docs) {
            if (d.linkedEntityType === 'asset' && (d.linkedEntityId === a.id || d.linkedEntityId === a.name)) linkedIds.add(d.id);
          }
        }
        for (const s of services) {
          for (const d of docs) {
            if (d.linkedEntityType === 'service' && (d.linkedEntityId === (s as any).id || d.linkedEntityId === (s as any).name)) linkedIds.add(d.id);
          }
        }
        return docs.filter(d => !linkedIds.has(d.id) && (!d.linkedEntityType || !d.linkedEntityId))
          .map(d => ({ id: d.id, title: d.title, docType: d.docType, version: d.version, createdAt: d.createdAt }));
      })(),
    };
  }

  async pruneDocumentVersions(userId: string, maxVersions = 10): Promise<number> {
    // For each (doc_type, linked_entity_id), keep only the newest N versions
    const groups = await this.db.query(
      `SELECT doc_type, linked_entity_id, COUNT(*) as cnt FROM cmdb_documents WHERE user_id = ? GROUP BY doc_type, linked_entity_id HAVING cnt > ?`,
      [userId, maxVersions],
    );
    let pruned = 0;
    for (const g of groups) {
      const oldest = await this.db.query(
        `SELECT id FROM cmdb_documents WHERE user_id = ? AND doc_type = ? AND (linked_entity_id = ? OR (linked_entity_id IS NULL AND ? IS NULL))
         ORDER BY version ASC LIMIT ?`,
        [userId, g.doc_type, g.linked_entity_id, g.linked_entity_id, (g.cnt as number) - maxVersions],
      );
      for (const r of oldest) {
        await this.db.execute(`DELETE FROM cmdb_documents WHERE id = ?`, [r.id]);
        pruned++;
      }
    }
    return pruned;
  }
}
