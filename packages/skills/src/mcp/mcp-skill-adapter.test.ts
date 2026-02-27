import { describe, it, expect, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { MCPSkillAdapter } from './mcp-skill-adapter.js';
import type { MCPClient, MCPToolResult } from './mcp-client.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

function createMockClient(callToolResult: MCPToolResult): MCPClient {
  return {
    connect: vi.fn(),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async (_name: string, _input: Record<string, unknown>) => callToolResult),
    disconnect: vi.fn(),
  } as unknown as MCPClient;
}

describe('MCPSkillAdapter', () => {
  it('should create correct skill name: mcp__server__tool', () => {
    const client = createMockClient({ content: 'ok' });
    const adapter = new MCPSkillAdapter(
      client,
      'my-server',
      'my-tool',
      'A test tool',
      { type: 'object', properties: {} },
    );

    expect(adapter.metadata.name).toBe('mcp__my-server__my-tool');
  });

  it('should include server name in description', () => {
    const client = createMockClient({ content: 'ok' });
    const adapter = new MCPSkillAdapter(
      client,
      'weather-api',
      'get_forecast',
      'Get weather forecast',
      { type: 'object', properties: { city: { type: 'string' } } },
    );

    expect(adapter.metadata.description).toContain('MCP/weather-api');
    expect(adapter.metadata.description).toContain('Get weather forecast');
  });

  it('should use tool name as description fallback when description is empty', () => {
    const client = createMockClient({ content: 'ok' });
    const adapter = new MCPSkillAdapter(
      client,
      'server',
      'do_thing',
      '',
      { type: 'object', properties: {} },
    );

    expect(adapter.metadata.description).toContain('do_thing');
  });

  it('should have write risk level and version 1.0.0', () => {
    const client = createMockClient({ content: 'ok' });
    const adapter = new MCPSkillAdapter(
      client,
      'srv',
      'tool',
      'desc',
      { type: 'object', properties: {} },
    );

    expect(adapter.metadata.riskLevel).toBe('write');
    expect(adapter.metadata.version).toBe('1.0.0');
  });

  it('should store the input schema', () => {
    const client = createMockClient({ content: 'ok' });
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const adapter = new MCPSkillAdapter(client, 'srv', 'tool', 'desc', schema);

    expect(adapter.metadata.inputSchema).toEqual(schema);
  });

  it('should execute and return success on non-error result', async () => {
    const client = createMockClient({ content: 'The weather is sunny, 25C', isError: false });
    const adapter = new MCPSkillAdapter(
      client,
      'weather',
      'get_forecast',
      'Get forecast',
      { type: 'object', properties: {} },
    );

    const result = await adapter.execute({ city: 'London' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toBe('The weather is sunny, 25C');
    expect(result.display).toBe('The weather is sunny, 25C');
    expect(result.error).toBeUndefined();

    // Verify the client was called with the correct tool name and input
    expect(client.callTool).toHaveBeenCalledWith('get_forecast', { city: 'London' });
  });

  it('should handle error results', async () => {
    const client = createMockClient({ content: 'API rate limit exceeded', isError: true });
    const adapter = new MCPSkillAdapter(
      client,
      'weather',
      'get_forecast',
      'Get forecast',
      { type: 'object', properties: {} },
    );

    const result = await adapter.execute({ city: 'London' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('API rate limit exceeded');
    expect(result.data).toBe('API rate limit exceeded');
    expect(result.display).toBe('API rate limit exceeded');
  });

  it('should handle result with undefined isError as success', async () => {
    const client = createMockClient({ content: 'result data' });
    const adapter = new MCPSkillAdapter(
      client,
      'srv',
      'tool',
      'desc',
      { type: 'object', properties: {} },
    );

    const result = await adapter.execute({}, ctx);

    // !undefined === true, so success should be true
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass through input to callTool', async () => {
    const client = createMockClient({ content: 'ok', isError: false });
    const adapter = new MCPSkillAdapter(
      client,
      'db',
      'query',
      'Run a query',
      { type: 'object', properties: {} },
    );

    const input = { sql: 'SELECT * FROM users', limit: 10, format: 'json' };
    await adapter.execute(input, ctx);

    expect(client.callTool).toHaveBeenCalledWith('query', input);
  });
});
