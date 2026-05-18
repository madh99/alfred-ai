import type { SkillRegistry } from './skill-registry.js';

/**
 * Validate that a `skill_params.action` value is in the target skill's enum.
 *
 * Used by createWatch, createScheduledTask, createBackgroundTask and workflow.create
 * to prevent LLM-hallucinated actions from being persisted into long-lived configs.
 *
 * Returns `{ ok: true }` if valid or skip cases (no schema, no enum, no action key in params).
 * Returns `{ ok: false, error }` with a human-readable message listing valid actions.
 */
export interface ValidateSkillActionResult {
  ok: true;
  validActions?: string[];
}
export interface ValidateSkillActionFailure {
  ok: false;
  error: string;
  validActions?: string[];
}

export function validateSkillAction(
  registry: SkillRegistry | undefined,
  skillName: string,
  params: Record<string, unknown> | undefined,
): ValidateSkillActionResult | ValidateSkillActionFailure {
  if (!registry) return { ok: true };
  const skill = registry.get(skillName);
  if (!skill) return { ok: false, error: `Unknown skill "${skillName}". It must be registered before use.` };

  const schema = skill.metadata.inputSchema as
    | { properties?: { action?: { enum?: string[] } } }
    | undefined;
  const validActions = schema?.properties?.action?.enum;
  if (!validActions || !Array.isArray(validActions)) return { ok: true };

  const action = params?.action as string | undefined;
  if (!action) {
    // Caller might not pass `action` for skills that don't require it.
    // Don't fail here — `required` check is the caller's responsibility.
    return { ok: true, validActions };
  }
  if (!validActions.includes(action)) {
    return {
      ok: false,
      validActions,
      error: `Skill "${skillName}" has no action "${action}". Valid actions: ${validActions.join(', ')}`,
    };
  }
  return { ok: true, validActions };
}
