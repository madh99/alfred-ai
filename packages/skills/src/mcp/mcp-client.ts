import type { Logger } from 'pino';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  content: string;
  isError?: boolean;
}

export class MCPClient {
  private client: any;
  private transport: any;
  private connected = false;

  constructor(
    private readonly serverName: string,
    private readonly config: { command?: string; args?: string[]; env?: Record<string, string>; url?: string },
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

      this.client = new Client({ name: `alfred-${this.serverName}`, version: '1.0.0' }, { capabilities: {} });

      if (this.config.command) {
        // stdio transport
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        // Resolve env vars in config.env
        const env = { ...process.env };
        if (this.config.env) {
          for (const [key, value] of Object.entries(this.config.env)) {
            env[key] = value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
          }
        }
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          env: env as Record<string, string>,
        });
      } else if (this.config.url) {
        // SSE transport
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
        this.transport = new SSEClientTransport(new URL(this.config.url));
      } else {
        throw new Error(`MCP server "${this.serverName}": must specify either command or url`);
      }

      await this.client.connect(this.transport);
      this.connected = true;
      this.logger.info({ server: this.serverName }, 'MCP server connected');
    } catch (err) {
      this.logger.error({ server: this.serverName, err }, 'Failed to connect MCP server');
      throw err;
    }
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.connected || !this.client) return [];
    try {
      const result = await this.client.listTools();
      return (result.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
    } catch (err) {
      this.logger.error({ server: this.serverName, err }, 'Failed to list MCP tools');
      return [];
    }
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.connected || !this.client) {
      return { content: 'MCP server not connected', isError: true };
    }
    try {
      const result = await this.client.callTool({ name, arguments: input });
      const content = (result.content ?? [])
        .map((c: any) => c.text ?? JSON.stringify(c))
        .join('\n');
      return { content, isError: result.isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `MCP tool error: ${msg}`, isError: true };
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close?.();
      } catch { /* ignore */ }
    }
    this.connected = false;
    this.logger.info({ server: this.serverName }, 'MCP server disconnected');
  }
}
