import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export class WeatherSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'weather',
    description: 'Get weather information for a location (placeholder — requires API key)',
    riskLevel: 'read',
    version: '0.1.0',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The location to get weather for (e.g. "London", "New York, NY")',
        },
        units: {
          type: 'string',
          enum: ['metric', 'imperial'],
          description: 'Unit system for temperature (default: metric)',
        },
      },
      required: ['location'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const location = input.location as string;
    const units = (input.units as string | undefined) ?? 'metric';

    if (!location || typeof location !== 'string') {
      return {
        success: false,
        error: 'Invalid input: "location" must be a non-empty string',
      };
    }

    return {
      success: true,
      data: {
        note: 'Weather data is not yet available — API key configuration required',
        location,
        units,
      },
      display: `Weather for "${location}" (${units}) is not yet implemented. This skill requires a weather API key to be configured.`,
    };
  }
}
