/**
 * v850 — Alfred MCP-Server
 *
 * Read-only MCP-stdio-Server der claude-code, codex und vibe direkten Zugriff
 * auf Alfreds Wissens-Stores erlaubt. Cross-CLI: alle drei Agents
 * unterstützen das standardisierte MCP-Protocol über stdio.
 *
 * Bereitgestellte Tools (Read-Only v850, Write erst v852):
 *   alfred.memory.recall         — semantic search über persistierte memories
 *   alfred.kg.query              — knowledge-graph entities + relations
 *   alfred.project.conventions   — CLAUDE.md content pro Projekt
 *   alfred.project.features.find — Feature-Library cross-project (v851)
 *   alfred.runbook.find          — Runbooks-Suche
 *
 * Auth: per-spawn One-Time-Token via env-var `ALFRED_MCP_TOKEN`. Alfred
 * generiert pro Subprocess-Spawn ein neues Token und übergibt es als env
 * an den agent — der agent gibt es transparent an seinen MCP-stdio-process
 * weiter (vom MCP-protocol initiated). Token wird vor jedem tool-call
 * gegen alfreds in-memory-token-set validiert.
 *
 * Audit: jeder erfolgreiche tool-call landet in `audit_log` mit
 * `action='mcp_tool_call'` + tool-name + (truncated) input.
 */

export { AlfredMcpServer } from './server.js';
export { runMcpServerStdio } from './run.js';
export { McpTokenStore } from './token-store.js';
export { generateMcpConfigForClaude, generateMcpConfigForCodex, generateMcpConfigForVibe, patchClaudeMcpConfig, patchCodexMcpConfig, patchVibeMcpConfig, defaultClaudeMcpPath, defaultCodexConfigPath, defaultVibeConfigPath } from './cli-config.js';
export type {
  McpServerDeps,
  McpTokenValidator,
  McpToolInvocation,
} from './types.js';
