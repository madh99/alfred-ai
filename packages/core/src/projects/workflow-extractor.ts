import type { LLMProvider } from '@alfred/llm';
import type { WorkflowStep, WorkflowActionStep } from '@alfred/types';

export interface ExtractorToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Boolean — did this call succeed? */
  success: boolean;
  /** Output snippet for context (truncated). */
  output?: string;
}

export interface ExtractorInput {
  /** What the user originally asked for. */
  goal: string;
  /** Ordered list of tool-calls in the session. */
  toolCalls: ExtractorToolCall[];
  /** Available skill names to validate against (extractor never invents new skills). */
  availableSkills: Set<string>;
}

export interface ExtractedWorkflow {
  reusable: boolean;
  suggestedName?: string;        // kebab-case
  suggestedDescription?: string;
  /** Workflow steps in the standard WorkflowStep format (compatible with existing WorkflowRunner). */
  steps?: WorkflowStep[];
  /** Reason if not reusable. */
  rationale?: string;
}

/**
 * WorkflowExtractor — analyzes a finished session's tool-call sequence and proposes
 * a reusable Workflow if the sequence is sufficiently structured + parametrizable.
 *
 * Conservative: returns reusable=false on any uncertainty. The user has the final say
 * via a Confirmation-Queue prompt that the alfred.ts wiring enqueues.
 */
export class WorkflowExtractor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly tier: 'default' | 'strong' = 'strong',
  ) {}

  async analyze(input: ExtractorInput): Promise<ExtractedWorkflow> {
    // Early skip: not enough material for a workflow
    const successful = input.toolCalls.filter(tc => tc.success);
    if (successful.length < 2) {
      return { reusable: false, rationale: 'too few successful tool-calls (<2)' };
    }
    // Early skip: all calls were the same skill (unlikely to be reusable as a multi-step workflow)
    const uniqueSkills = new Set(successful.map(tc => tc.name));
    if (uniqueSkills.size < 2 && successful.length < 4) {
      return { reusable: false, rationale: 'only one skill used, sequence likely trivial' };
    }

    const prompt = this.buildPrompt(input);
    let raw: string;
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        tier: this.tier,
        maxTokens: 1500,
      });
      raw = response.content;
    } catch {
      return { reusable: false, rationale: 'LLM call failed' };
    }
    return this.parse(raw, input.availableSkills);
  }

  private buildPrompt(input: ExtractorInput): string {
    const callsRendering = input.toolCalls.map((tc, i) =>
      `${i + 1}. ${tc.success ? '✓' : '✗'} skill=${tc.name} input=${JSON.stringify(tc.input).slice(0, 400)}${tc.output ? ` → ${tc.output.slice(0, 200)}` : ''}`,
    ).join('\n');

    return `Du analysierst eine abgeschlossene Sub-Agent-Session und entscheidest ob die Tool-Aufruf-Sequenz als wiederverwendbarer Workflow gespeichert werden soll.

URSPRÜNGLICHES ZIEL:
${input.goal}

TOOL-CALLS (chronologisch):
${callsRendering}

VERFÜGBARE SKILLS (nur diese darfst du in steps referenzieren):
${[...input.availableSkills].sort().join(', ')}

Erzeuge AUSSCHLIESSLICH valides JSON nach diesem Schema (KEINE Markdown-Fences, KEIN Prosa-Text):
{
  "reusable": true|false,
  "suggested_name": "kebab-case-name (kurz, prägnant, ≤40 Zeichen)",
  "suggested_description": "1-2 Sätze: was tut der Workflow",
  "steps": [
    {
      "type": "action",
      "skillName": "<existing skill from list above>",
      "inputMapping": { "param1": "{{param.value}} oder static value" },
      "onError": "stop|skip|retry"
    }
  ],
  "rationale": "Falls reusable=false: kurze Begründung"
}

Regeln:
- reusable=true NUR wenn die Sequenz konzeptionell wiederholbar ist (z.B. "Deploy-Pipeline", "Bestandsprüfung", "Sync-Aktion")
- reusable=false wenn die Aktion ad-hoc/explorativ war (z.B. "schau mal nach X")
- Parameter-Templating: variable Werte als {{name}} markieren (z.B. Versionsstring, Pfad, Filter)
- Statische Werte direkt einsetzen
- KEINE Skills erfinden — nur aus VERFÜGBARE SKILLS Liste
- inputMapping muss zu den ursprünglichen Tool-Inputs passen (gleiche Keys)
- onError default "stop" für Deploy/Admin, "skip" für Read-Only-Aufrufe
- Max 12 Steps. Bei längeren Sequenzen: zusammenfassen oder reusable=false setzen
- suggested_name: ohne Leerzeichen, lowercase, mit Bindestrich (z.B. "deploy-uboot", "sync-microsoft-todos")

Beispiel reusable=true: User-Ziel war "Deploy uboot release", 5 Schritte (build, bundle, publish, ssh deploy node-a, ssh deploy node-b). Versionsstring ist parametrisierbar.
Beispiel reusable=false: User-Ziel war "analysiere alle critical incidents im ITSM". Wert "5 Stück" ist eine momentane Situation, nicht parametrisierbar.

Sprache: Deutsch in description, technisch in steps.`;
  }

  private parse(raw: string, availableSkills: Set<string>): ExtractedWorkflow {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return { reusable: false, rationale: 'unparseable LLM output' }; }
    if (!parsed || typeof parsed !== 'object') return { reusable: false, rationale: 'invalid JSON structure' };
    const obj = parsed as Record<string, unknown>;

    if (obj.reusable !== true) {
      return {
        reusable: false,
        rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 300) : 'LLM marked as non-reusable',
      };
    }

    const name = typeof obj.suggested_name === 'string' ? obj.suggested_name.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) {
      return { reusable: false, rationale: 'invalid suggested_name (not kebab-case)' };
    }

    const description = typeof obj.suggested_description === 'string' ? obj.suggested_description.trim().slice(0, 300) : '';
    if (description.length < 5) {
      return { reusable: false, rationale: 'description too short' };
    }

    if (!Array.isArray(obj.steps) || obj.steps.length === 0 || obj.steps.length > 12) {
      return { reusable: false, rationale: 'invalid steps count' };
    }

    const steps: WorkflowStep[] = [];
    for (const raw of obj.steps) {
      if (!raw || typeof raw !== 'object') continue;
      const step = raw as Record<string, unknown>;
      const type = step.type ?? 'action';
      if (type !== 'action') continue; // We only auto-extract action steps for v602
      const skillName = typeof step.skillName === 'string' ? step.skillName.trim() : '';
      if (!skillName || !availableSkills.has(skillName)) {
        return { reusable: false, rationale: `step references unknown skill: ${skillName || '(empty)'}` };
      }
      const inputMapping = (step.inputMapping && typeof step.inputMapping === 'object')
        ? step.inputMapping as Record<string, unknown>
        : {};
      const onError = (typeof step.onError === 'string' && ['stop', 'skip', 'retry'].includes(step.onError))
        ? step.onError as 'stop' | 'skip' | 'retry'
        : 'stop';
      const action: WorkflowActionStep = { type: 'action', skillName, inputMapping, onError };
      steps.push(action);
    }

    if (steps.length === 0) {
      return { reusable: false, rationale: 'no valid action steps after validation' };
    }

    return {
      reusable: true,
      suggestedName: name,
      suggestedDescription: description,
      steps,
    };
  }
}
