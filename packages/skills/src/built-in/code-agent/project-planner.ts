import type { LLMProvider } from '@alfred/llm';

/**
 * v846 — Klassifikation des Goals zur Plan-Größen-Biasierung.
 * - bug-fix: i.d.R. 1-3 Phasen
 * - refactor: i.d.R. 2-5 Phasen
 * - audit: i.d.R. 1-2 Phasen
 * - feature: i.d.R. 3-8 Phasen
 * - setup: i.d.R. 2-5 Phasen
 * Keine HARTEN caps — der Planner darf abweichen, muss aber `reasoning`
 * setzen wenn er deutlich mehr Phasen vorschlägt als typisch.
 */
export type GoalKind = 'bug-fix' | 'feature' | 'refactor' | 'audit' | 'setup' | 'unknown';

export interface ProjectPlan {
  phases: string[];
  buildStrategy: string;
  estimatedIterations: number;
  /**
   * v846 — Selbst-Klassifikation des Planners. Wird genutzt für:
   * - dynamic Cap-Berechnung (F-dynamisch)
   * - Bias-Warnung wenn Plan deutlich größer als typisch
   * - Chat-Banner ("Goal als bug-fix klassifiziert → 3 Phasen, ok?")
   */
  goalKind?: GoalKind;
  /**
   * v846 — Vom Planner gelieferte Begründung WENN der Plan größer ist als
   * für die Klassifikation typisch. Wird im Chat angezeigt damit der User
   * den Plan vorab sieht und ggf. interjecten kann.
   */
  reasoning?: string;
}

/**
 * v846 — Mid-Run Plan-Mutation Decision.
 *
 * Nach jeder erfolgreich gebauten Phase ruft der Runner einen LLM-Check
 * (strong tier) auf, der entscheidet wie es weitergeht. Der Plan ist NICHT
 * mehr immutable wie pre-v846.
 *
 * Optionen:
 *  - done      → Goal erfüllt, Session beenden (kein File-Thrash mehr)
 *  - proceed   → unverändert weiter wie geplant
 *  - skip      → Phase(n) überspringen weil bereits erledigt
 *  - merge     → Phasen zusammenfassen zu einer neuen Phase
 *  - extend    → neue Phase einfügen (Coder hat Komplexität entdeckt)
 *  - replace   → bestehende Phase(n) durch neue ersetzen
 */
export type PlanMutation =
  | { kind: 'done';     reasoning: string }
  | { kind: 'proceed';  reasoning?: string }
  | { kind: 'skip';     phaseIndices: number[]; reasoning: string }
  | { kind: 'merge';    phaseIndices: number[]; newPhase: string; reasoning: string }
  | { kind: 'extend';   afterIndex: number; newPhase: string; reasoning: string }
  | { kind: 'replace';  phaseIndices: number[]; newPhases: string[]; reasoning: string };

/**
 * v846 — Umgeschriebener Prompt:
 *  - explizite Goal-Klassifikation (bug-fix/feature/refactor/audit/setup)
 *  - Bias zu MINIMALEN Phasen-Anzahlen, KEIN hartes Cap
 *  - reasoning-Pflicht WENN Plan größer als typisch für die Klassifikation
 *  - Phasen-Beschreibungen kurz (≤ 15 Wörter), nicht Mini-Pläne in Phasen
 *
 * Empirisch (14 Tage Postgres): Ø 8 Phasen, Ø 51 Files. Bug-Fixes wurden
 * routinemäßig in 12 Phasen zerlegt → File-Thrash, Stunden-Laufzeit. Mit
 * dem neuen Prompt sollen einfache Fixes typisch 1-3 Phasen haben.
 */
const PLANNING_PROMPT = `Du bist ein Senior-Engineer der einen Plan für eine konkrete Code-Änderung erstellt.

WICHTIGSTE REGEL: Bevorzuge WENIGER Phasen. Jede zusätzliche Phase erhöht die Wahrscheinlichkeit dass spätere Phasen frühere Arbeit überschreiben oder dieselben Dateien mehrfach anfassen.

SCHRITT 1 — Klassifikation des Goals:
- "bug-fix": eine bestehende Funktion verhält sich falsch → typisch 1-3 Phasen
- "feature": neue Funktionalität → typisch 3-8 Phasen
- "refactor": Umstrukturierung ohne Verhaltensänderung → typisch 2-5 Phasen
- "audit": nur Analyse/Recherche/Doku → typisch 1-2 Phasen
- "setup": neues Projekt/Infrastruktur → typisch 2-5 Phasen
- "unknown": wenn keine Kategorie passt

SCHRITT 2 — Plan-Größe wählen:
- Halte dich an die typische Spanne FÜR DIE KLASSIFIKATION
- Wenn du MEHR Phasen brauchst als typisch (z.B. 7 für einen Bug-Fix), MUSST du ein "reasoning"-Feld liefern das genau erklärt warum weniger Phasen nicht reichen
- Wenn du in der typischen Spanne bleibst, ist "reasoning" optional

SCHRITT 3 — Phasen formulieren:
- JEDE Phase ist EIN konkreter Schritt, max 15 Wörter, kein eigener Sub-Plan
- BEISPIEL GUT: "API-Endpoint /users POST hinzufügen"
- BEISPIEL SCHLECHT: "Server-Datenmodell und Chat-Flows analysieren: ChatSession-, ChannelMembership-Modelle, joinedAt/leftAt/active-Felder sowie Leave/Rejoin-Endpunkte lokalisieren"
- Phasen in Abhängigkeits-Reihenfolge
- KEINE separate "Tests schreiben"-Phase wenn der Code-Agent ohnehin Tests mit-schreibt
- KEINE separate "Lokale Validierung"-Phase — der Runner validiert nach jeder Phase automatisch

Antworte NUR mit validem JSON:
{
  "goalKind": "bug-fix" | "feature" | "refactor" | "audit" | "setup" | "unknown",
  "phases": ["Konkreter Schritt 1", "Konkreter Schritt 2", ...],
  "buildStrategy": "npm install && npm run build",
  "estimatedIterations": 3,
  "reasoning": "Optional. PFLICHT wenn Plan größer als typisch für goalKind."
}`;

async function tryGeneratePlan(
  goal: string,
  llm: LLMProvider,
  historyBlock: string,
): Promise<ProjectPlan | null> {
  const response = await llm.complete({
    system: PLANNING_PROMPT,
    messages: [
      { role: 'user', content: goal + historyBlock },
    ],
    maxTokens: 2048,
    temperature: 0.3,
  });

  const text = response.content;
  console.log(`[project-planner] LLM response (${text.length} chars): ${text.slice(0, 200)}`);

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.phases) && parsed.phases.length > 0) {
      // L7 (v604) — strip redundant "Phase X:" prefixes from phase strings.
      // The runner already prepends "Phase X/N:" itself, so the planner's
      // "Phase X: ..." created the ugly "Phase 1/13: Phase 1: ..." doubling.
      const normalizedPhases = parsed.phases.map((p: string) =>
        typeof p === 'string' ? p.replace(/^\s*Phase\s+\d+\s*[:\-—]\s*/i, '').trim() : p,
      );
      // v846 — goalKind + reasoning übernehmen
      const goalKind = (typeof parsed.goalKind === 'string'
        ? parsed.goalKind as GoalKind
        : 'unknown') as GoalKind;
      const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim().slice(0, 1000)
        : undefined;
      return {
        phases: normalizedPhases,
        buildStrategy: parsed.buildStrategy ?? 'npm install && npm run build',
        estimatedIterations: parsed.estimatedIterations ?? parsed.phases.length,
        goalKind,
        reasoning,
      };
    }
  }
  return null;
}

/**
 * v846 — Typische Phasen-Spanne pro Klassifikation. Wird vom Runner genutzt
 * um zu entscheiden ob ein Plan ungewöhnlich groß ist und ggf. eine Banner-
 * Warnung an den User gepushed werden soll.
 */
export function typicalPhaseRange(kind: GoalKind | undefined): { min: number; max: number } {
  switch (kind) {
    case 'bug-fix':  return { min: 1, max: 3 };
    case 'audit':    return { min: 1, max: 2 };
    case 'refactor': return { min: 2, max: 5 };
    case 'setup':    return { min: 2, max: 5 };
    case 'feature':  return { min: 3, max: 8 };
    default:         return { min: 2, max: 8 };
  }
}

export async function createProjectPlan(
  goal: string,
  llm: LLMProvider,
  previousSessions?: Array<{ goal: string; milestones: string[] }>,
  recentChanges?: Array<{ sha: string; message: string; files: string[] }>,
): Promise<ProjectPlan> {
  const sessionsBlock = previousSessions && previousSessions.length > 0
    ? '\n\nVorherige Sessions in diesem Verzeichnis (bereits erledigt — NICHT wiederholen):\n' +
      previousSessions.map((s, i) =>
        `  ${i + 1}. Ziel: ${s.goal}\n     Milestones: ${s.milestones.join(', ') || '—'}`
      ).join('\n')
    : '';

  // v846 — Recent-Commits-Block: Files die in den letzten Tagen schon
  // bearbeitet wurden. Bei "Continue/Resume"-Sessions sieht der Planner
  // hier was bereits committed wurde und kann diese Arbeit nicht
  // doppelt einplanen.
  const changesBlock = recentChanges && recentChanges.length > 0
    ? '\n\nZuletzt im Repo committet (NICHT wiederholen, ggf. KORRIGIEREN wenn fehlerhaft):\n' +
      recentChanges.slice(0, 20).map((c) => {
        const fileSummary = c.files.length === 0 ? '(keine)' : c.files.slice(0, 8).join(', ') + (c.files.length > 8 ? `, …+${c.files.length - 8}` : '');
        return `  ${c.sha.slice(0, 7)}  ${c.message.slice(0, 100).replace(/\n/g, ' ')}  [${fileSummary}]`;
      }).join('\n')
    : '';

  const historyBlock = sessionsBlock + changesBlock;

  // Try up to 2 times before falling back to single-phase plan
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const plan = await tryGeneratePlan(goal, llm, historyBlock);
      if (plan) return plan;
      console.log(`[project-planner] Attempt ${attempt + 1}: valid response but no phases extracted`);
    } catch (err) {
      console.log(`[project-planner] Attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: single-phase plan
  console.log('[project-planner] FALLBACK: single-phase plan after 2 attempts');
  return {
    phases: [`Implementiere: ${goal}`],
    buildStrategy: 'npm install && npm run build',
    estimatedIterations: 1,
    goalKind: 'unknown',
    reasoning: 'Planner-Fallback: LLM lieferte keinen validen Plan, single-phase als sicherer Default.',
  };
}
