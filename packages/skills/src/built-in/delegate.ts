import type { SkillMetadata, SkillContext, SkillResult, LLMMessage } from '@alfred/types';
import { Skill } from '../skill.js';
import type { LLMProvider } from '@alfred/llm';

export class DelegateSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'delegate',
    description:
      'Delegate a complex sub-task to a separate AI agent. The sub-agent will process the task independently and return a result. Use this for tasks that require focused attention or multiple steps.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task to delegate to a sub-agent',
        },
        context: {
          type: 'string',
          description: 'Additional context for the sub-agent (optional)',
        },
      },
      required: ['task'],
    },
  };

  constructor(private readonly llm: LLMProvider) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const task = input.task as string | undefined;
    const additionalContext = input.context as string | undefined;

    if (!task || typeof task !== 'string') {
      return {
        success: false,
        error: 'Missing required field "task"',
      };
    }

    const systemPrompt =
      'You are a sub-agent of Alfred. Complete the following task concisely and return the result. Do not use tools.';

    let userContent = task;
    if (additionalContext && typeof additionalContext === 'string') {
      userContent = `${task}\n\nAdditional context: ${additionalContext}`;
    }

    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: userContent,
      },
    ];

    try {
      const response = await this.llm.complete({
        messages,
        system: systemPrompt,
        maxTokens: 2048,
      });

      return {
        success: true,
        data: { response: response.content, usage: response.usage },
        display: response.content,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Sub-agent failed: ${errorMessage}`,
      };
    }
  }
}
