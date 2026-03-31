import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────

export type KGEntityType = 'person' | 'location' | 'item' | 'vehicle' | 'event' | 'organization';

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

    // First try: check if entity exists and merge sources
    const existing = await this.adapter.queryOne(
      'SELECT id, sources FROM kg_entities WHERE user_id = ? AND entity_type = ? AND normalized_name = ?',
      [userId, entityType, normalized],
    ) as { id: string; sources: string } | undefined;

    if (existing) {
      // Merge sources
      let existingSources: string[] = [];
      try { existingSources = JSON.parse(existing.sources); } catch { /* empty */ }
      if (source && !existingSources.includes(source)) {
        existingSources.push(source);
      }

      await this.adapter.execute(`
        UPDATE kg_entities SET
          attributes = ?,
          sources = ?,
          confidence = MIN(1.0, confidence + 0.1),
          last_seen_at = ?,
          mention_count = mention_count + 1
        WHERE id = ?
      `, [attrsJson, JSON.stringify(existingSources), now, existing.id]);

      const row = await this.adapter.queryOne('SELECT * FROM kg_entities WHERE id = ?', [existing.id]) as Record<string, unknown>;
      return this.mapEntity(row);
    }

    // New entity
    await this.adapter.execute(`
      INSERT INTO kg_entities (id, user_id, name, normalized_name, entity_type, attributes, sources, confidence, first_seen_at, last_seen_at, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.5, ?, ?, 1)
    `, [id, userId, name, normalized, entityType, attrsJson, sourcesJson, now, now]);

    return {
      id, userId, name, normalizedName: normalized, entityType,
      attributes: attributes ?? {}, sources: source ? [source] : [],
      confidence: 0.5, firstSeenAt: now, lastSeenAt: now, mentionCount: 1,
    };
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
          strength = MIN(1.0, strength + 0.1),
          context = COALESCE(?, context),
          last_seen_at = ?,
          mention_count = mention_count + 1
        WHERE id = ?
      `, [context ?? null, now, existing.id]);

      const row = await this.adapter.queryOne('SELECT * FROM kg_relations WHERE id = ?', [existing.id]) as Record<string, unknown>;
      return this.mapRelation(row);
    }

    await this.adapter.execute(`
      INSERT INTO kg_relations (id, user_id, source_entity_id, target_entity_id, relation_type, strength, context, source_section, first_seen_at, last_seen_at, mention_count)
      VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, ?, ?, 1)
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
