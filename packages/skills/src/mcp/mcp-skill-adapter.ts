import type { SkillMetadata, SkillContext, SkillResult, RiskLevel } from '@alfred/types';
import { Skill } from '../skill.js';
import type { MCPClient } from './mcp-client.js';

const VALID_RISK_LEVELS: RiskLevel[] = ['read', 'write', 'destructive', 'admin'];

export class MCPSkillAdapter extends Skill {
  readonly metadata: SkillMetadata;

  constructor(
    private readonly client: MCPClient,
    private readonly serverName: string,
    private readonly toolName: string,
    description: string,
    inputSchema: Record<string, unknown>,
    riskLevel?: string,
  ) {
    super();
    const resolvedRisk: RiskLevel = (riskLevel && VALID_RISK_LEVELS.includes(riskLevel as RiskLevel))
      ? (riskLevel as RiskLevel)
      : 'write';
    this.metadata = {
      name: `mcp__${serverName}__${toolName}`,
      category: 'mcp',
      description: `[MCP/${serverName}] ${description || toolName}`,
      riskLevel: resolvedRisk,
      version: '1.0.0',
      inputSchema,
    };
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const result = await this.client.callTool(this.toolName, input);
    return {
      success: result.isError !== true,
      data: result.content,
      display: result.content,
      error: result.isError === true ? result.content : undefined,
    };
  }
}
