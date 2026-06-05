import type { McpTool } from './index.js';

/**
 * v850 — `alfred.project.conventions`
 *
 * Liefert die persistierten Projekt-Conventions (CLAUDE.md / AGENTS.md
 * Content). Wenn der agent in einem Project-cwd arbeitet, sollte er sich
 * an die Conventions halten — dieser tool macht sie direkt verfügbar
 * ohne dass der agent CLAUDE.md selbst finden + lesen muss.
 *
 * Read-only.
 */
export const projectConventionsTool: McpTool = {
  name: 'alfred.project.conventions',
  description: 'Get Alfred\'s persisted conventions for a project (CLAUDE.md / AGENTS.md content + structured patterns). Returns the canonical conventions text. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      projectIdOrCwd: {
        type: 'string',
        description: 'Project ID (UUID) or working directory path. If cwd path: matches project where cwd is exact or parent.',
      },
    },
    required: ['projectIdOrCwd'],
  },
  async handler(args, deps) {
    const query = String(args.projectIdOrCwd ?? '').trim();
    if (!query) return { found: false };

    // Project finden via id or cwd
    const projParams: unknown[] = [query];
    let projSql = `SELECT id, name, cwd, conventions FROM projects WHERE id = ?`;
    if (deps.masterUserId) {
      projSql += ` AND user_id = ?`;
      projParams.push(deps.masterUserId);
    }
    let projRows = await deps.adapter.query(projSql, projParams);

    if (projRows.length === 0 && query.startsWith('/')) {
      // Fallback: cwd-match (exact oder parent dir)
      const cwdParams: unknown[] = [query, query + '%'];
      let cwdSql = `SELECT id, name, cwd, conventions FROM projects WHERE cwd = ? OR ? LIKE cwd || '/%'`;
      if (deps.masterUserId) {
        cwdSql += ` AND user_id = ?`;
        cwdParams.push(deps.masterUserId);
      }
      cwdSql += ` ORDER BY LENGTH(cwd) DESC LIMIT 1`;
      projRows = await deps.adapter.query(cwdSql, cwdParams);
    }

    if (projRows.length === 0) return { found: false };
    const p = projRows[0];

    // Conventions-text aus agent_conventions Tabelle
    let conventionsText = '';
    try {
      const convRows = await deps.adapter.query(
        `SELECT content FROM agent_conventions WHERE project_id = ? ORDER BY package_path LIMIT 1`,
        [p.id],
      );
      if (convRows[0]) conventionsText = (convRows[0].content as string) ?? '';
    } catch { /* agent_conventions table might not exist on fresh installs */ }

    let inlineConventions: Record<string, unknown> | undefined;
    if (p.conventions) {
      try { inlineConventions = JSON.parse(p.conventions as string); } catch { /* skip */ }
    }

    return {
      found: true,
      project: {
        id: p.id as string,
        name: p.name as string,
        cwd: (p.cwd as string | null) ?? null,
      },
      conventionsText: conventionsText.slice(0, 50000), // limit response size
      inlineConventions,
    };
  },
};
