import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

const MATH_NAMES = /Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)/g;

const SAFE_EXPRESSION_PATTERN =
  /^[\d+\-*/().,\s%]*(Math\.(sin|cos|tan|sqrt|pow|abs|floor|ceil|round|log|log2|log10|PI|E)[\d+\-*/().,\s(%)]*)*$/;

export class CalculatorSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'calculator',
    description: 'Evaluate mathematical expressions. Use for any calculation, unit conversion, or math question the user asks.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate',
        },
      },
      required: ['expression'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const expression = input.expression as string;

    if (!expression || typeof expression !== 'string') {
      return {
        success: false,
        error: 'Invalid expression: input must be a non-empty string',
      };
    }

    const trimmed = expression.trim();

    // Validate the entire expression only contains safe tokens
    if (!SAFE_EXPRESSION_PATTERN.test(trimmed)) {
      return {
        success: false,
        error: `Invalid expression: "${trimmed}" contains disallowed constructs`,
      };
    }

    // After stripping Math.* names, no alphabetic chars should remain
    const stripped = trimmed.replace(MATH_NAMES, '');
    if (/[a-zA-Z]/.test(stripped)) {
      return {
        success: false,
        error: `Invalid expression: "${trimmed}" contains disallowed identifiers`,
      };
    }

    try {
      // Use Function constructor to evaluate in an isolated scope with Math available
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('Math', `"use strict"; return (${trimmed});`);
      const result: unknown = fn(Math);

      if (typeof result !== 'number' || !isFinite(result)) {
        return {
          success: false,
          error: `Invalid expression: "${trimmed}" did not produce a finite number`,
        };
      }

      return {
        success: true,
        data: result,
        display: `${trimmed} = ${result}`,
      };
    } catch {
      return {
        success: false,
        error: `Invalid expression: "${trimmed}"`,
      };
    }
  }
}
