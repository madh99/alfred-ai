import type { SkillContext, SkillResult } from '@alfred/types';
import type { Logger } from 'pino';
import { Skill } from './skill.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class SkillSandbox {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async execute(
    skill: Skill,
    input: Record<string, unknown>,
    context: SkillContext,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<SkillResult> {
    const { name } = skill.metadata;

    this.logger.info({ skill: name, input }, 'Skill execution started');

    try {
      const result = await Promise.race<SkillResult>([
        skill.execute(input, context),
        new Promise<SkillResult>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Skill "${name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);

      this.logger.info({ skill: name, success: result.success }, 'Skill execution completed');

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error({ skill: name, error: message }, 'Skill execution failed');

      return {
        success: false,
        error: message,
      };
    }
  }
}
