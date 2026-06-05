import type { LLMProvider } from '@alfred/llm';
import type { PlanMutation } from './project-planner.js';

/**
 * v846 — Mid-Run Plan-Assessor.
 *
 * Nach jeder erfolgreich gebauten Phase fragt der Runner einen Senior-Engineer-
 * LLM (strong tier) ob der Plan noch passt. Der LLM darf entscheiden:
 *   done     — Goal erfüllt, Session beenden
 *   proceed  — wie geplant weiter
 *   skip     — Phase(n) überspringen weil bereits erledigt
 *   merge    — Phasen zusammenfassen
 *   extend   — neue Phase einfügen (mehr Arbeit als gedacht)
 *   replace  — Phase(n) durch neue ersetzen
 *
 * Empirisch (Postgres 14 Tage): Ø 8 Phasen, Ø 51 Files. Mit dem Assessor sollen
 * Sessions früher enden wenn das Goal bereits in Phase 3 oder 4 erfüllt ist —
 * statt blind alle 12 Phasen abzuarbeiten und File-Thrash zu erzeugen.
 */

const ASSESSOR_PROMPT = `Du bist ein Senior-Engineer der nach jeder Phase prüft ob der Plan noch passt.

Du bekommst:
- GOAL: das ursprüngliche Ziel der Session
- COMPLETED PHASES: Was bereits erledigt wurde (Phasen-Beschreibungen + welche Dateien geändert wurden)
- REMAINING PHASES: Was noch geplant ist
- BUILD STATUS: Aktueller Build-Status (passed / failed mit Output)

Entscheide:
1. Ist das GOAL bereits erfüllt? → "done"
2. Sind alle remaining Phasen noch sinnvoll und nötig?
   - Eine Phase die nur Tests für bereits gemachte Arbeit hinzufügt: NÖTIG (proceed)
   - Eine Phase die etwas wiederholt was bereits in einer früheren Phase erledigt wurde: SKIP
   - Zwei aufeinanderfolgende Phasen die dieselbe Datei anfassen: MERGE zu einer
   - Eine Phase ist obsolete weil bereits anders gelöst: SKIP oder REPLACE
3. Hat sich in den completed Phasen mehr Komplexität gezeigt als ursprünglich gedacht?
   - Falls ja: EXTEND mit zusätzlicher konkreter Phase

WICHTIG:
- Bei Unsicherheit: "proceed" (kein Risiko)
- Bei klarer Erkennung: aggressiv kürzen — der Plan war eine Schätzung, jetzt weißt du mehr
- File-Thrash vermeiden: wenn dieselbe Datei mehrfach geändert wurde, ist das ein Warnzeichen
- Du SIEHST das Goal — wenn es bereits durch die committeten Diffs erfüllt scheint: DONE statt proceed

Antworte NUR mit validem JSON:
{
  "kind": "done" | "proceed" | "skip" | "merge" | "extend" | "replace",
  "reasoning": "1-2 Sätze warum",
  "phaseIndices": [/* nur bei skip/merge/replace, 0-basiert in der REMAINING-Liste */],
  "newPhase": "neue Phase (nur bei merge/extend, max 15 Wörter)",
  "newPhases": ["...", "..."] /* nur bei replace */,
  "afterIndex": 0 /* nur bei extend, 0-basiert in COMPLETED-Liste */
}`;

export interface AssessInput {
  goal: string;
  completedPhases: Array<{ index: number; description: string; modifiedFiles: string[] }>;
  remainingPhases: string[];
  buildPassed: boolean;
  buildOutput?: string;
}

/**
 * Frage den LLM ob der Plan angepasst werden soll.
 *
 * Bei Fehler (LLM-Down, parse error, schema mismatch): fallback auf
 * `{ kind: 'proceed' }` damit die Session deterministisch weiterläuft
 * wie pre-v846.
 */
export async function assessPlanProgress(
  llm: LLMProvider,
  input: AssessInput,
): Promise<PlanMutation> {
  const userBlock = formatAssessorInput(input);
  let text = '';
  try {
    const response = await llm.complete({
      system: ASSESSOR_PROMPT,
      messages: [{ role: 'user', content: userBlock }],
      maxTokens: 1024,
      temperature: 0.2,
      tier: 'strong',
    });
    text = response.content;
  } catch (err) {
    // LLM-Call schlägt fehl → konservativ proceed
    return { kind: 'proceed', reasoning: `Assessor-LLM-Fehler: ${(err as Error).message.slice(0, 100)}` };
  }

  const mut = parseMutation(text, input);
  return mut ?? { kind: 'proceed', reasoning: 'Assessor lieferte unparsbaren Output, sicherer Default proceed.' };
}

function formatAssessorInput(input: AssessInput): string {
  const completedBlock = input.completedPhases.length === 0
    ? '(keine)'
    : input.completedPhases
        .map((p) => {
          const files = p.modifiedFiles.length === 0
            ? '(keine)'
            : p.modifiedFiles.slice(0, 10).join(', ') +
              (p.modifiedFiles.length > 10 ? ` und ${p.modifiedFiles.length - 10} weitere` : '');
          return `  ${p.index + 1}. ${p.description.slice(0, 200)}\n     Files: ${files}`;
        })
        .join('\n');

  const remainingBlock = input.remainingPhases.length === 0
    ? '(keine)'
    : input.remainingPhases
        .map((p, i) => `  ${i + 1}. ${p.slice(0, 200)}`)
        .join('\n');

  const buildBlock = input.buildPassed
    ? 'BUILD STATUS: passed (Tests grün)'
    : `BUILD STATUS: FAILED\n${(input.buildOutput ?? '').slice(-1500)}`;

  return [
    `GOAL:\n${input.goal.slice(0, 1500)}`,
    '',
    `COMPLETED PHASES (${input.completedPhases.length}):`,
    completedBlock,
    '',
    `REMAINING PHASES (${input.remainingPhases.length}):`,
    remainingBlock,
    '',
    buildBlock,
  ].join('\n');
}

function parseMutation(text: string, input: AssessInput): PlanMutation | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>; }
  catch { return null; }

  const kind = parsed.kind as string;
  const reasoning = (typeof parsed.reasoning === 'string' ? parsed.reasoning : '').slice(0, 500);

  switch (kind) {
    case 'done':
      return { kind: 'done', reasoning: reasoning || 'Goal erfüllt' };
    case 'proceed':
      return { kind: 'proceed', reasoning: reasoning || undefined };
    case 'skip': {
      const idx = sanitizePhaseIndices(parsed.phaseIndices, input.remainingPhases.length);
      if (idx.length === 0) return { kind: 'proceed', reasoning: 'skip-mutation hatte keine validen Indices' };
      return { kind: 'skip', phaseIndices: idx, reasoning: reasoning || 'Phase(n) bereits durch frühere Arbeit erledigt' };
    }
    case 'merge': {
      const idx = sanitizePhaseIndices(parsed.phaseIndices, input.remainingPhases.length);
      const newPhase = sanitizePhaseText(parsed.newPhase);
      if (idx.length < 2 || !newPhase) return { kind: 'proceed', reasoning: 'merge-mutation invalid (zu wenige indices oder fehlende newPhase)' };
      return { kind: 'merge', phaseIndices: idx, newPhase, reasoning: reasoning || 'Phasen zusammengefasst' };
    }
    case 'extend': {
      const newPhase = sanitizePhaseText(parsed.newPhase);
      const afterIndex = typeof parsed.afterIndex === 'number' && parsed.afterIndex >= 0
        ? Math.min(Math.floor(parsed.afterIndex), input.completedPhases.length - 1)
        : input.completedPhases.length - 1;
      if (!newPhase) return { kind: 'proceed', reasoning: 'extend-mutation invalid (fehlende newPhase)' };
      return { kind: 'extend', afterIndex, newPhase, reasoning: reasoning || 'Zusätzliche Phase benötigt' };
    }
    case 'replace': {
      const idx = sanitizePhaseIndices(parsed.phaseIndices, input.remainingPhases.length);
      const newPhases = Array.isArray(parsed.newPhases)
        ? (parsed.newPhases as unknown[])
            .map((p) => sanitizePhaseText(p))
            .filter((p): p is string => p !== null)
        : [];
      if (idx.length === 0 || newPhases.length === 0) return { kind: 'proceed', reasoning: 'replace-mutation invalid' };
      return { kind: 'replace', phaseIndices: idx, newPhases, reasoning: reasoning || 'Phase(n) ersetzt' };
    }
    default:
      return null;
  }
}

function sanitizePhaseIndices(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
    if (Number.isFinite(n) && n >= 0 && n < max && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function sanitizePhaseText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^\s*Phase\s+\d+\s*[:\-—]\s*/i, '').trim();
  if (t.length === 0) return null;
  return t.slice(0, 500);
}

/**
 * Wende eine PlanMutation auf den aktuellen Plan an. Liefert die NEUE
 * remaining-Liste zurück (immutable; alte Liste bleibt unverändert).
 */
export function applyMutation(
  remaining: string[],
  completedCount: number,
  mutation: PlanMutation,
): { newRemaining: string[]; reorderedCompletedDelta: number } {
  switch (mutation.kind) {
    case 'done':
      return { newRemaining: [], reorderedCompletedDelta: 0 };
    case 'proceed':
      return { newRemaining: [...remaining], reorderedCompletedDelta: 0 };
    case 'skip': {
      const keep = remaining.filter((_, i) => !mutation.phaseIndices.includes(i));
      return { newRemaining: keep, reorderedCompletedDelta: 0 };
    }
    case 'merge': {
      const keep = remaining.filter((_, i) => !mutation.phaseIndices.includes(i));
      const insertAt = Math.min(...mutation.phaseIndices);
      keep.splice(insertAt, 0, mutation.newPhase);
      return { newRemaining: keep, reorderedCompletedDelta: 0 };
    }
    case 'extend': {
      // afterIndex ist 0-basiert in COMPLETED. Wir fügen vor dem ersten remaining ein.
      // Wenn afterIndex == completed.length-1: neue Phase wird die NÄCHSTE Phase.
      // Wir interpretieren extend pragmatisch als "neue Phase ZUERST in remaining".
      const next = [mutation.newPhase, ...remaining];
      return { newRemaining: next, reorderedCompletedDelta: 0 };
    }
    case 'replace': {
      // remove phaseIndices, insert newPhases at first removed position
      const keep = remaining.filter((_, i) => !mutation.phaseIndices.includes(i));
      const insertAt = Math.min(...mutation.phaseIndices);
      keep.splice(insertAt, 0, ...mutation.newPhases);
      return { newRemaining: keep, reorderedCompletedDelta: 0 };
    }
    default: {
      const _exhaustive: never = mutation;
      void _exhaustive;
      return { newRemaining: [...remaining], reorderedCompletedDelta: 0 };
    }
  }
}
