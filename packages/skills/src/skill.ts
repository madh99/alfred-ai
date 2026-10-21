import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';

export abstract class Skill {
  abstract readonly metadata: SkillMetadata;

  /** v1537 — optionale Prüfung der Eingabe je Aktion (z. B. vor „Ausführen“ eines Vorgangs); Grund oder undefined. */
  pruefeEingabe?(input: Record<string, unknown>): string | undefined;

  abstract execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult>;
}
