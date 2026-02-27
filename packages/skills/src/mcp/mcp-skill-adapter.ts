import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { MCPClient } from './mcp-client.js';

export class MCPSkillAdapter extends Skill {
  readonly metadata: SkillMetadata;

  constructor(
    private readonly client: MCPClient,
    private readonly serverName: string,
    private readonly toolName: string,
    description: string,
    inputSchema: Record<string, unknown>,
  ) {
    super();
    this.metadata = {
      name: `mcp__${serverName}__${toolName}`,
      description: `[MCP/${serverName}] ${description || toolName}`,
      riskLevel: 'write',
      version: '1.0.0',
      inputSchema,
    };
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const result = await this.client.callTool(this.toolName, input);
    return {
      success: !result.isError,
      data: result.content,
      display: result.content,
      error: result.isError ? result.content : undefined,
    };
  }
}
