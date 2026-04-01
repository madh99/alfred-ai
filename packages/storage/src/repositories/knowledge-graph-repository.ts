import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────

export type KGEntityType = 'person' | 'location' | 'item' | 'vehicle' | 'event' | 'organization' | 'metric';

export interface KGEntity {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  entityType: KGEntityType;
  attributes: Record<string, unknown>;
  sources: string[];
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

export interface KGRelation {
  id: string;
  userId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  strength: number;
  context: string | null;
  sourceSection: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

// ── Repository ───────────────────────────────────────────────

export class KnowledgeGraphRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  // ── Entity CRUD ─────────────────────────────────────────────

  /**
   * UPSERT entity: creates new or updates existing (confidence+0.1, mention_count++, sources merged).
   */
  async upsertEntity(
    userId: string, name: string, entityType: KGEntityType,
    attributes?: Record<string, unknown>, source?: string,
  ): Promise<KGEntity> {
    const normalized = name.trim().toLowerCase();
    const now = new Date().toISOString();
    const id = randomUUID();
    const sourcesJson = source ? JSON.stringify([source]) : '[]';
    const attrsJson = attributes ? JSON.stringify(attributes) : '{}';

    // First try: check if entity exists and merge sources + attributes
    const existing = await this.adapter.queryOne(
      'SELECT id, sources, attributes FROM kg_entities WHERE user_id = ? AND entity_type = ? AND normalized_name = ?',
      [userId, entityType, normalized],
    ) as { id: string; sources: string; attributes: string } | undefined;

    if (existing) {
      // Merge sources
      let existingSources: string[] = [];
      try { existingSources = JSON.parse(existing.sources); } catch { /* empty */ }
      if (source && !existingSources.includes(source)) {
        existingSources.push(source);
      }

      // Merge attributes (existing + new, new wins on conflict)
      let existingAttrs: Record<string, unknown> = {};
      try { existingAttrs = JSON.parse(existing.attributes); } catch { /* empty */ }
      const mergedAttrs = { ...existingAttrs, ...(attributes ?? {}) };

      await this.adapter.execute(`
        UPDATE kg_entities SET
          attributes = ?,
          sources = ?,
          confidence = CASE WHEN confidence + 0.1 > 1.0 THEN 1.0 ELSE confidence + 0.1 END,
          last_seen_at = ?,
          mention_count = mention_count + 1
        WHERE id = ?
      `, [JSON.stringify(mergedAttrs), JSON.stringify(existingSources), now, existing.id]);

      const row = await this.adapter.queryOne('SELECT * FROM kg_entities WHERE id = ?', [existing.id]) as Record<string, unknown>;
      return this.mapEntity(row);
    }

    // Fuzzy match for persons: "Müller" should match "Franz Müller"
    if (entityType === 'person' && normalized.length >= 3) {
      const fuzzyMatch = await this.findFuzzyPersonMatch(userId, normalized);
      if (fuzzyMatch) {
        let fuzzySources: string[] = [];
        try { fuzzySources = JSON.parse(fuzzyMatch.sources as string); } catch { /* empty */ }
        if (source && !fuzzySources.includes(source)) fuzzySources.push(source);

        // Merge attributes (existing + new)
        let existingAttrs: Record<string, unknown> = {};
        try { existingAttrs = JSON.parse(fuzzyMatch.attributes as string); } catch { /* empty */ }
        const mergedAttrs = { ...existingAttrs, ...(attributes ?? {}) };

        // Keep the longer (more specific) name
        const existingName = fuzzyMatch.name as string;
        const betterName = name.length > existingName.length ? name : existingName;
        const betterNormalized = betterName.trim().toLowerCase();

        await this.adapter.execute(`
          UPDATE kg_entities SET
            name = ?, normalized_name = ?, attributes = ?, sources = ?,
            confidence = CASE WHEN confidence + 0.1 > 1.0 THEN 1.0 ELSE confidence + 0.1 END, last_seen_at = ?, mention_count = mention_count + 1
          WHERE id = ?
        `, [betterName, betterNormalized, JSON.stringify(mergedAttrs), JSON.stringify(fuzzySources), now, fuzzyMatch.id as string]);

        const row = await this.adapter.queryOne('SELECT * FROM kg_entities WHERE id = ?', [fuzzyMatch.id]) as Record<string, unknown>;
        return this.mapEntity(row);
      }
    }

    // New entity — atomic INSERT with ON CONFLICT fallback for HA safety.
    // If another node inserts the same entity simultaneously, ON CONFLICT updates instead of throwing.
    const result = await this.adapter.execute(`
      INSERT INTO kg_entities (id, user_id, name, normalized_name, entity_type, attributes, sources, confidence, first_seen_at, last_seen_at, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.5, ?, ?, 1)
      ON CONFLICT (user_id, entity_type, normalized_name) DO UPDATE SET
        confidence = CASE WHEN kg_entities.confidence + 0.1 > 1.0 THEN 1.0 ELSE kg_entities.confidence + 0.1 END,
        last_seen_at = excluded.last_seen_at,
        mention_count = kg_entities.mention_count + 1
    `, [id, userId, name, normalized, entityType, attrsJson, sourcesJson, now, now]);

    // Always fetch from DB to get the REAL id (ON CONFLICT DO UPDATE returns changes=1 but the id in the INSERT is wrong)
    const row = await this.adapter.queryOne(
      'SELECT * FROM kg_entities WHERE user_id = ? AND entity_type = ? AND normalized_name = ?',
      [userId, entityType, normalized],
    ) as Record<string, unknown>;
    return row ? this.mapEntity(row) : {
      id, userId, name, normalizedName: normalized, entityType,
      attributes: attributes ?? {}, sources: source ? [source] : [],
      confidence: 0.5, firstSeenAt: now, lastSeenAt: now, mentionCount: 1,
    };
  }

  /**
   * Find a fuzzy match for a person name: "müller" matches "franz müller" and vice versa.
   * Returns the best match (highest mention_count) or null.
   */
  private async findFuzzyPersonMatch(userId: string, normalized: string): Promise<Record<string, unknown> | null> {
    const like = this.adapter.type === 'postgres' ? 'ILIKE' : 'LIKE';
    const rows = await this.adapter.query(
      `SELECT * FROM kg_entities WHERE user_id = ? AND entity_type = 'person' AND normalized_name != ? AND (normalized_name ${like} ? OR ? ${like} '%' || normalized_name || '%') ORDER BY mention_count DESC LIMIT 1`,
      [userId, normalized, `%${normalized}%`, normalized],
    ) as Record<string, unknown>[];
    return rows.length > 0 ? rows[0] : null;
  }

  async getEntitiesByType(userId: string, type: KGEntityType): Promise<KGEntity[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM kg_entities WHERE user_id = ? AND entity_type = ? ORDER BY confidence DESC, mention_count DESC',
      [userId, type],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapEntity(r));
  }

  async getEntityByName(userId: string, name: string, type?: KGEntityType): Promise<KGEntity | undefined> {
    const normalized = name.trim().toLowerCase();
    const sql = type
      ? 'SELECT * FROM kg_entities WHERE user_id = ? AND normalized_name = ? AND entity_type = ?'
      : 'SELECT * FROM kg_entities WHERE user_id = ? AND normalized_name = ?';
    const params = type ? [userId, normalized, type] : [userId, normalized];
    const row = await this.adapter.queryOne(sql, params) as Record<string, unknown> | undefined;
    return row ? this.mapEntity(row) : undefined;
  }

  async searchEntities(userId: string, query: string, limit = 20): Promise<KGEntity[]> {
    const like = this.adapter.type === 'postgres' ? 'ILIKE' : 'LIKE';
    const rows = await this.adapter.query(
      `SELECT * FROM kg_entities WHERE user_id = ? AND (name ${like} ? OR normalized_name ${like} ?) ORDER BY confidence DESC LIMIT ?`,
      [userId, `%${query}%`, `%${query.toLowerCase()}%`, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapEntity(r));
  }

  // ── Relation CRUD ───────────────────────────────────────────

  /**
   * UPSERT relation: creates new or updates existing (strength+0.1, mention_count++).
   */
  async upsertRelation(
    userId: string, sourceId: string, targetId: string,
    relationType: string, context?: string, sourceSection?: string,
  ): Promise<KGRelation> {
    const now = new Date().toISOString();
    const id = randomUUID();

    const existing = await this.adapter.queryOne(
      'SELECT id FROM kg_relations WHERE user_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ?',
      [userId, sourceId, targetId, relationType],
    ) as { id: string } | undefined;

    if (existing) {
      await this.adapter.execute(`
        UPDATE kg_relations SET
          strength = CASE WHEN strength + 0.1 > 1.0 THEN 1.0 ELSE strength + 0.1 END,
          context = COALESCE(?, context),
          last_seen_at = ?,
          mention_count = mention_count + 1
        WHERE id = ?
      `, [context ?? null, now, existing.id]);

      const row = await this.adapter.queryOne('SELECT * FROM kg_relations WHERE id = ?', [existing.id]) as Record<string, unknown>;
      return this.mapRelation(row);
    }

    // Atomic INSERT with ON CONFLICT for HA safety
    await this.adapter.execute(`
      INSERT INTO kg_relations (id, user_id, source_entity_id, target_entity_id, relation_type, strength, context, source_section, first_seen_at, last_seen_at, mention_count)
      VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, ?, ?, 1)
      ON CONFLICT (user_id, source_entity_id, target_entity_id, relation_type) DO UPDATE SET
        strength = CASE WHEN kg_relations.strength + 0.1 > 1.0 THEN 1.0 ELSE kg_relations.strength + 0.1 END,
        context = COALESCE(excluded.context, kg_relations.context),
        last_seen_at = excluded.last_seen_at,
        mention_count = kg_relations.mention_count + 1
    `, [id, userId, sourceId, targetId, relationType, context ?? null, sourceSection ?? null, now, now]);

    return {
      id, userId, sourceEntityId: sourceId, targetEntityId: targetId,
      relationType, strength: 0.5, context: context ?? null,
      sourceSection: sourceSection ?? null, firstSeenAt: now, lastSeenAt: now, mentionCount: 1,
    };
  }

  // ── Graph Traversal ─────────────────────────────────────────

  async getRelationsFrom(entityId: string): Promise<KGRelation[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM kg_relations WHERE source_entity_id = ? ORDER BY strength DESC',
      [entityId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRelation(r));
  }

  async getRelationsTo(entityId: string): Promise<KGRelation[]> {
    const rows = await this.adapter.query(
      'SELECT * FROM kg_relations WHERE target_entity_id = ? ORDER BY strength DESC',
      [entityId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRelation(r));
  }

  async getConnectedEntities(entityId: string, userId: string): Promise<KGEntity[]> {
    const rows = await this.adapter.query(`
      SELECT DISTINCT e.* FROM kg_entities e
      JOIN kg_relations r ON (r.source_entity_id = e.id OR r.target_entity_id = e.id)
      WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND e.id != ? AND e.user_id = ?
      ORDER BY e.confidence DESC
    `, [entityId, entityId, entityId, userId]) as Record<string, unknown>[];
    return rows.map(r => this.mapEntity(r));
  }

  /** Get full graph for a user (entities + relations). Capped for performance. */
  async getFullGraph(userId: string): Promise<{ entities: KGEntity[]; relations: KGRelation[] }> {
    const entities = await this.adapter.query(
      'SELECT * FROM kg_entities WHERE user_id = ? ORDER BY confidence DESC, mention_count DESC LIMIT 200',
      [userId],
    ) as Record<string, unknown>[];

    const relations = await this.adapter.query(
      'SELECT * FROM kg_relations WHERE user_id = ? ORDER BY strength DESC, mention_count DESC LIMIT 500',
      [userId],
    ) as Record<string, unknown>[];

    return {
      entities: entities.map(r => this.mapEntity(r)),
      relations: relations.map(r => this.mapRelation(r)),
    };
  }

  // ── Maintenance ─────────────────────────────────────────────

  /** Decay confidence of entities not seen for a while. */
  async decayOldEntities(userId: string, olderThanDays: number, decayAmount: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
    const result = await this.adapter.execute(
      'UPDATE kg_entities SET confidence = MAX(0, confidence - ?) WHERE user_id = ? AND last_seen_at < ?',
      [decayAmount, userId, cutoff],
    );
    return result.changes;
  }

  /** Delete entities with confidence below threshold (CASCADE deletes relations). */
  async pruneWeakEntities(userId: string, minConfidence: number): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM kg_entities WHERE user_id = ? AND confidence < ?',
      [userId, minConfidence],
    );
    return result.changes;
  }

  /** Delete weak relations. */
  async pruneWeakRelations(userId: string, minStrength: number): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM kg_relations WHERE user_id = ? AND strength < ?',
      [userId, minStrength],
    );
    return result.changes;
  }

  // ── Row Mappers ─────────────────────────────────────────────

  private mapEntity(row: Record<string, unknown>): KGEntity {
    let attributes: Record<string, unknown> = {};
    let sources: string[] = [];
    try { attributes = JSON.parse(row.attributes as string); } catch { /* empty */ }
    try { sources = JSON.parse(row.sources as string); } catch { /* empty */ }
    return {
      id: row.id as string,
      userId: row.user_id as string,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      entityType: row.entity_type as KGEntityType,
      attributes,
      sources,
      confidence: row.confidence as number,
      firstSeenAt: row.first_seen_at as string,
      lastSeenAt: row.last_seen_at as string,
      mentionCount: row.mention_count as number,
    };
  }

  private mapRelation(row: Record<string, unknown>): KGRelation {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      sourceEntityId: row.source_entity_id as string,
      targetEntityId: row.target_entity_id as string,
      relationType: row.relation_type as string,
      strength: row.strength as number,
      context: (row.context as string) ?? null,
      sourceSection: (row.source_section as string) ?? null,
      firstSeenAt: row.first_seen_at as string,
      lastSeenAt: row.last_seen_at as string,
      mentionCount: row.mention_count as number,
    };
  }
}
