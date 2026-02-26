import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export class WebSearchSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'web_search',
    description: 'Search the web (placeholder — returns mock results)',
    riskLevel: 'read',
    version: '0.1.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
      },
      required: ['query'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const query = input.query as string;

    return {
      success: true,
      data: {
        note: 'Web search is not yet connected to a search API',
      },
      display: `Web search for "${query}" is not yet implemented. This skill will be connected to a search API in a future update.`,
    };
  }
}
