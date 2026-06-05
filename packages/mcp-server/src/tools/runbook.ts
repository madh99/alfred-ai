import type { McpTool } from './index.js';

/**
 * v850 — `alfred.runbook.find`
 *
 * Sucht in den persistierten Runbooks (Setup-Guides, Deploy-Procedures,
 * Troubleshooting-Steps). Agents können damit etablierte Prozeduren
 * referenzieren statt "from scratch" zu raten.
 *
 * Read-only.
 */
export const runbookFindTool: McpTool = {
  name: 'alfred.runbook.find',
  description: 'Search Alfred\'s runbook library (setup guides, deploy procedures, troubleshooting steps). Returns matching runbooks with their canonical text. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Runbook search query. Example: "deploy nextjs vercel", "postgres restore", "alfred restart".',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of runbooks (default 5, max 20).',
        default: 5,
      },
    },
    required: ['query'],
  },
  async handler(args, deps) {
    const query = String(args.query ?? '').trim();
    if (!query) return { runbooks: [] };
    const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));

    try {
      const params: unknown[] = [`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`];
      let sql = `SELECT id, title, content, source_type, source_id, created_at
                 FROM runbooks
                 WHERE (LOWER(title) LIKE ? OR LOWER(content) LIKE ?)`;
      if (deps.masterUserId) {
        sql += ` AND user_id = ?`;
        params.push(deps.masterUserId);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const rows = await deps.adapter.query(sql, params);

      return {
        runbooks: rows.map(r => ({
          id: r.id as string,
          title: r.title as string,
          content: ((r.content as string) ?? '').slice(0, 20000),
          sourceType: (r.source_type as string) ?? 'unknown',
          sourceId: (r.source_id as string | null) ?? null,
          createdAt: r.created_at as string,
        })),
      };
    } catch {
      return { runbooks: [], note: 'runbooks table not available' };
    }
  },
};
