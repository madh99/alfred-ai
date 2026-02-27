// Type shims for @modelcontextprotocol/sdk dynamic imports.
// The SDK is an optional runtime dependency — installed in apps/alfred.

declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class Client {
    constructor(info: { name: string; version: string }, options: { capabilities: Record<string, unknown> });
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }>;
    callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: { text?: string }[]; isError?: boolean }>;
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  export class StdioClientTransport {
    constructor(options: { command: string; args?: string[]; env?: Record<string, string> });
    close?(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/sse.js' {
  export class SSEClientTransport {
    constructor(url: URL);
    close?(): Promise<void>;
  }
}
