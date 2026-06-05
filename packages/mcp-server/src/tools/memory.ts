import type { McpTool } from './index.js';

/**
 * v850 — `alfred.memory.recall`
 *
 * Semantische + Keyword-Suche über Alfreds persistierte memories.
 * Liefert top-N matches mit key, value, type, lastUsedAt.
 *
 * Read-only. Schreibt nichts. Cross-agent (claude/codex/vibe identisch).
 */
export const memoryRecallTool: McpTool = {
  name: 'alfred.memory.recall',
  description: 'Search Alfred\'s persisted memories (user preferences, project context, learned facts). Returns top-matching memories by keyword or semantic similarity. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (natural language or keywords). Example: "alpbyte-games stack" or "deploy server preferences".',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default 10, max 50).',
        default: 10,
      },
      type: {
        type: 'string',
        description: 'Optional: filter by memory type (e.g. "user", "feedback", "project", "reference"). Omit to search all.',
      },
    },
    required: ['query'],
  },
  async handler(args, deps) {
    const query = String(args.query ?? '').trim();
    if (!query) return { matches: [], note: 'empty query — provide search terms' };
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
    const type = typeof args.type === 'string' ? args.type : undefined;

    // Keyword-Suche (semantic via embeddings ist optional v850.1)
    // Sucht auf key + value + JSON-extrahierte fields
    const masterUserId = deps.masterUserId;
    const params: unknown[] = [`%${query}%`, `%${query}%`];
    let sql = `SELECT key, value, type, last_used_at FROM memories
               WHERE (key LIKE ? OR value LIKE ?)`;
    if (masterUserId) {
      sql += ` AND user_id = ?`;
      params.push(masterUserId);
    }
    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY last_used_at DESC NULLS LAST LIMIT ?`;
    params.push(limit);

    const rows = await deps.adapter.query(sql, params);
    return {
      matches: rows.map(r => ({
        key: r.key as string,
        value: String(r.value ?? '').slice(0, 2000),
        type: r.type as string,
        lastUsedAt: (r.last_used_at as string | null) ?? null,
      })),
      total: rows.length,
    };
  },
};
