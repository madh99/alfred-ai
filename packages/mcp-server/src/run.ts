/**
 * v850 — Stdio-Transport-Wiring für `alfred mcp-server` CLI-command.
 *
 * Wird vom CLI subcommand gestartet. Liest config aus env-vars + DB-Adapter
 * via dependency injection.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AlfredMcpServer } from './server.js';
import type { McpServerDeps } from './types.js';

export interface RunMcpServerStdioOptions {
  deps: McpServerDeps;
  /**
   * Optional: callback wenn stdio-pipe geschlossen wird (parent process gone).
   * Default: process.exit(0).
   */
  onClose?: () => void;
}

/**
 * Startet den MCP-Server auf stdio. Blockt bis stdin/stdout geschlossen wird.
 *
 * WICHTIG: dieser Prozess darf NICHTS auf stdout schreiben außer JSON-RPC
 * messages. stderr ist frei für logging.
 */
export async function runMcpServerStdio(options: RunMcpServerStdioOptions): Promise<void> {
  const server = new AlfredMcpServer(options.deps);
  const transport = new StdioServerTransport();
  await server.getSdkServer().connect(transport);

  // graceful shutdown wenn parent gone
  const onClose = options.onClose ?? (() => process.exit(0));
  process.on('SIGTERM', onClose);
  process.on('SIGINT', onClose);
  process.stdin.on('close', onClose);

  options.deps.logger?.info({}, 'alfred mcp-server: connected to stdio transport');
}
