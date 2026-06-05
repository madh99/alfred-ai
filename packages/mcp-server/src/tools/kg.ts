import type { McpTool } from './index.js';

/**
 * v850 — `alfred.kg.query`
 *
 * Knowledge-Graph lookup: findet Entities (Personen, Organisationen, Projekte,
 * Konzepte) und deren Relationen. Gibt direkte Nachbarn + Attribute zurück.
 *
 * Read-only.
 */
export const kgQueryTool: McpTool = {
  name: 'alfred.kg.query',
  description: 'Query Alfred\'s knowledge graph for entities (people, orgs, projects, concepts) and their relations. Returns matching entities + their direct neighbors. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        description: 'Entity name to look up (case-insensitive partial match). Example: "alpbyte", "madh".',
      },
      relation: {
        type: 'string',
        description: 'Optional: filter neighbors by relation type (e.g. "works_at", "uses_tech", "depends_on").',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of neighbor relations per entity (default 20, max 100).',
        default: 20,
      },
    },
    required: ['entity'],
  },
  async handler(args, deps) {
    const entityQuery = String(args.entity ?? '').trim();
    if (!entityQuery) return { entities: [] };
    const relation = typeof args.relation === 'string' ? args.relation : undefined;
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
    const masterUserId = deps.masterUserId;

    // Step 1: matching entities
    const entityParams: unknown[] = [`%${entityQuery.toLowerCase()}%`];
    let entitySql = `SELECT id, name, type, attributes_json FROM kg_entities WHERE LOWER(name) LIKE ?`;
    if (masterUserId) { entitySql += ` AND user_id = ?`; entityParams.push(masterUserId); }
    entitySql += ` LIMIT 5`;
    const entityRows = await deps.adapter.query(entitySql, entityParams);

    if (entityRows.length === 0) return { entities: [], note: 'no matching entity' };

    // Step 2: relations für jede entity
    const result: Array<{
      id: string;
      name: string;
      type: string;
      attributes: Record<string, unknown>;
      relations: Array<{ relation: string; target: string; targetType: string }>;
    }> = [];

    for (const e of entityRows) {
      const relParams: unknown[] = [e.id, e.id];
      let relSql = `SELECT r.relation, e2.name AS target_name, e2.type AS target_type
                    FROM kg_relations r
                    JOIN kg_entities e2 ON e2.id = (CASE WHEN r.from_entity_id = ? THEN r.to_entity_id ELSE r.from_entity_id END)
                    WHERE (r.from_entity_id = ? OR r.to_entity_id = ?)`;
      relParams.push(e.id);
      if (relation) {
        relSql += ` AND r.relation = ?`;
        relParams.push(relation);
      }
      relSql += ` LIMIT ?`;
      relParams.push(limit);

      let relations: Array<{ relation: string; target: string; targetType: string }> = [];
      try {
        const relRows = await deps.adapter.query(relSql, relParams);
        relations = relRows.map(r => ({
          relation: r.relation as string,
          target: r.target_name as string,
          targetType: r.target_type as string,
        }));
      } catch { /* kg tables might not exist on fresh installs */ }

      let attributes: Record<string, unknown> = {};
      try { attributes = JSON.parse((e.attributes_json as string) ?? '{}'); } catch { /* skip */ }

      result.push({
        id: e.id as string,
        name: e.name as string,
        type: e.type as string,
        attributes,
        relations,
      });
    }

    return { entities: result, total: result.length };
  },
};
