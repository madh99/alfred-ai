/**
 * v850 — AlfredMcpServer: wrapt das @modelcontextprotocol/sdk Server-Objekt
 * mit Alfred-spezifischer Auth + Tool-Registry + Audit-Log.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerDeps, McpToolInvocation } from './types.js';
import { getAllTools, findTool } from './tools/index.js';

const PROTOCOL_VERSION = '1.0.0';
const SERVER_NAME = 'alfred';
const SERVER_VERSION = '0.19.0-850';

/**
 * Auth-Token-Quelle:
 *  - Bei stdio-transport gibt es kein header-mechanismus.
 *  - Lösung: ALFRED_MCP_TOKEN env-var. Der MCP-Server liest sie EINMAL beim
 *    Start (ist der spawn-env) und vergleicht sie gegen `validateToken`.
 *  - Wenn token mismatch ODER missing: alle tool-calls returnen error.
 *
 * Sicherheits-Modell: jeder CLI-Agent-Spawn bekommt einen frischen
 * One-Time-Token im env. Wenn die MCP-Subprocess-Pipeline kompromittiert
 * ist, ist der token nur für diesen einen spawn gültig.
 */
export class AlfredMcpServer {
  private readonly server: Server;
  private readonly deps: McpServerDeps;
  private envToken: string;

  constructor(deps: McpServerDeps) {
    this.deps = deps;
    this.envToken = process.env.ALFRED_MCP_TOKEN ?? '';
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  /** Expose underlying SDK Server für transport-binding (stdio/http). */
  getSdkServer(): Server {
    return this.server;
  }

  /** Pre-flight token-check. False = unauthorized, true = ok. */
  private isAuthorized(): boolean {
    // Wenn validator null: skip (debug mode)
    if (this.deps.validateToken === null) return true;
    if (!this.envToken) return false;
    return this.deps.validateToken(this.envToken);
  }

  private registerHandlers(): void {
    // tools/list — gibt Tool-Schemas zurück
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.isAuthorized()) {
        return { tools: [], _meta: { error: 'Unauthorized: missing or invalid ALFRED_MCP_TOKEN' } };
      }
      const tools = getAllTools().map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.deps.logger?.info({ count: tools.length }, 'mcp tools/list');
      return { tools };
    });

    // tools/call — führt einen tool aus
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const startedAt = Date.now();
      const toolName = request.params?.name ?? '';
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

      const audit: Partial<McpToolInvocation> = {
        tool: toolName,
        input: args,
        timestamp: new Date().toISOString(),
      };

      if (!this.isAuthorized()) {
        const err = 'Unauthorized: missing or invalid ALFRED_MCP_TOKEN';
        this.deps.logger?.warn({ tool: toolName }, 'mcp tool/call unauthorized');
        const result: McpToolInvocation = {
          ...(audit as McpToolInvocation),
          success: false, error: err, durationMs: Date.now() - startedAt,
        };
        await this.tryAudit(result);
        return { content: [{ type: 'text', text: `Error: ${err}` }], isError: true };
      }

      const tool = findTool(toolName);
      if (!tool) {
        const err = `Tool not found: ${toolName}`;
        const result: McpToolInvocation = {
          ...(audit as McpToolInvocation),
          success: false, error: err, durationMs: Date.now() - startedAt,
        };
        await this.tryAudit(result);
        return { content: [{ type: 'text', text: err }], isError: true };
      }

      try {
        const data = await tool.handler(args, this.deps);
        const json = JSON.stringify(data);
        const resultPreview = json.length > 200 ? json.slice(0, 200) + '…' : json;
        const result: McpToolInvocation = {
          ...(audit as McpToolInvocation),
          success: true, durationMs: Date.now() - startedAt, resultPreview,
        };
        await this.tryAudit(result);
        return { content: [{ type: 'text', text: json }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result: McpToolInvocation = {
          ...(audit as McpToolInvocation),
          success: false, error: msg, durationMs: Date.now() - startedAt,
        };
        await this.tryAudit(result);
        return { content: [{ type: 'text', text: `Tool error: ${msg}` }], isError: true };
      }
    });
  }

  private async tryAudit(entry: McpToolInvocation): Promise<void> {
    if (!this.deps.onAuditLog) return;
    try { await this.deps.onAuditLog(entry); } catch (err) {
      this.deps.logger?.warn({ err, tool: entry.tool }, 'mcp audit-log failed (non-critical)');
    }
  }
}

export const ALFRED_MCP_PROTOCOL_VERSION = PROTOCOL_VERSION;
