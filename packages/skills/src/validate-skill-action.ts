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

/**
 * v861 — Synonym-Kandidaten für LLM-halluzinierte Action-Namen (verschoben aus
 * reasoning-engine v859, damit ALLE Validation-Callsites — watch, scheduled_task,
 * background_task, workflow UND reasoning — dieselbe Heilung nutzen).
 * Kandidaten-Liste: heilt NUR wenn GENAU EIN Kandidat im Ziel-Enum existiert.
 * Ambiguität (z.B. file: 'save' → write vs write_binary vs write_store wäre
 * mehrdeutig wenn mehrere matchen) → kein Heal, reject bleibt sicherer.
 */
export const ACTION_SYNONYMS: Record<string, string[]> = {
  create: ['add', 'save', 'set', 'start'],
  update: ['edit', 'set'],
  get: ['recall', 'list', 'status'],
  fetch: ['recall', 'list'],
  store: ['save', 'add'],
  // 'save' listet write UND write_binary: bei file matchen beide → ambiguous →
  // bewusst KEIN Heal (save→write hätte beim aWATTar-PDF-Workflow das Binary
  // als Text korrumpiert). Bei Skills mit nur 'write' im Enum → eindeutig → Heal.
  save: ['write', 'write_binary'],
  remove: ['delete', 'cancel'],
  mark_done: ['complete'],
  done: ['complete'],
  finish: ['complete'],
  check: ['status', 'list'],
};

/**
 * v861 — versucht eine halluzinierte Action auf eine valide zu mappen.
 * Returns die geheilte Action oder null wenn kein eindeutiges Mapping existiert.
 */
export function healActionSynonym(hallucinated: string, validActions: string[]): string | null {
  const candidates = ACTION_SYNONYMS[hallucinated.toLowerCase()];
  if (!candidates) return null;
  const matches = candidates.filter(c => validActions.includes(c));
  return matches.length === 1 ? matches[0] : null;
}

export function validateSkillAction(
  registry: SkillRegistry | undefined,
  skillName: string,
  params: Record<string, unknown> | undefined,
  opts?: { heal?: boolean },
): (ValidateSkillActionResult & { healed?: { from: string; to: string } }) | ValidateSkillActionFailure {
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
    // v861 — Selfheal: bei eindeutigem Synonym die Action IN-PLACE korrigieren
    // statt abzulehnen. Der aWATTar-Workflow vom 10.06. scheiterte an
    // 'file.save' — mit save→write wäre er gelaufen.
    if (opts?.heal && params) {
      const healed = healActionSynonym(action, validActions);
      if (healed) {
        params.action = healed;
        return { ok: true, validActions, healed: { from: action, to: healed } };
      }
    }
    return {
      ok: false,
      validActions,
      error: `Skill "${skillName}" has no action "${action}". Valid actions: ${validActions.join(', ')}`,
    };
  }
  return { ok: true, validActions };
}
