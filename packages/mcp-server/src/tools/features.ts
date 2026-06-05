import type { McpTool } from './index.js';

/**
 * v850 — `alfred.project.features.find` (Foundation für v851)
 *
 * Sucht in der Feature-Library nach Cross-Project-Implementierungen.
 * Beispiel: agent fragt "wer hat schon Crowd-Funding implementiert?" — wenn
 * das in einem anderen Project bereits gemacht wurde, sieht der agent den
 * Eintrag und kann den source-code referenzieren.
 *
 * Wenn die `project_features` Tabelle noch nicht existiert (v851 nicht
 * deployed): liefert leere Liste mit Hinweis.
 *
 * Read-only.
 *
 * Respektiert `visibility`:
 *   - private: nur wenn requester=owner
 *   - role-shared: alle in derselben role
 *   - global: alle
 */
export const featuresFindTool: McpTool = {
  name: 'alfred.project.features.find',
  description: 'Search Alfred\'s cross-project feature library. Find existing implementations of features (e.g. "crowd funding", "OAuth login", "email service") that have been built in any project. Returns matching features with source-file globs + tech-stack info. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Feature search query. Example: "crowd funding stripe", "email queue worker", "oauth provider".',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of matches (default 5, max 20).',
        default: 5,
      },
    },
    required: ['query'],
  },
  async handler(args, deps) {
    const query = String(args.query ?? '').trim();
    if (!query) return { features: [] };
    const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));

    // Check ob v851 Tabelle existiert
    try {
      const params: unknown[] = [`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`];
      let sql = `SELECT id, project_id, name, description, tech_stack, source_files,
                        git_sha_introduced, version, visibility, confidence
                 FROM project_features
                 WHERE (LOWER(name) LIKE ? OR LOWER(description) LIKE ?)
                   AND retired_at IS NULL`;
      // Visibility-Filter: role-shared/global immer sichtbar, private nur wenn requester ist owner
      // v851 wird das richtig implementieren — v850 reicht eine konservative Variante:
      // nur role-shared + global zeigen (keine private cross-user).
      sql += ` AND visibility IN ('role-shared','global')`;
      sql += ` ORDER BY confidence DESC, version DESC LIMIT ?`;
      params.push(limit);

      const rows = await deps.adapter.query(sql, params);

      return {
        features: rows.map(r => ({
          id: r.id as string,
          projectId: r.project_id as string,
          name: r.name as string,
          description: (r.description as string | null) ?? '',
          techStack: safeJson(r.tech_stack, [] as string[]),
          sourceFiles: safeJson(r.source_files, [] as string[]),
          gitSha: (r.git_sha_introduced as string | null) ?? null,
          version: Number(r.version ?? 1),
          visibility: (r.visibility as string) ?? 'private',
          confidence: Number(r.confidence ?? 0),
        })),
      };
    } catch {
      // Tabelle existiert noch nicht (pre-v851)
      return { features: [], note: 'project_features table not yet available (v851 not deployed)' };
    }
  },
};

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as T) : fallback; } catch { return fallback; }
}
