import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';

export abstract class Skill {
  abstract readonly metadata: SkillMetadata;

  abstract execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult>;
}
