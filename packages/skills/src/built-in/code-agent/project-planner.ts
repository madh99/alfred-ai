import type { LLMProvider } from '@alfred/llm';

export interface ProjectPlan {
  phases: string[];
  buildStrategy: string;
  estimatedIterations: number;
}

const PLANNING_PROMPT = `Du bist ein Software-Architekt. Deine Aufgabe: Zerlege das folgende Projektziel in geordnete Build-Phasen.

Regeln:
- Jede Phase ist ein konkreter, ausführbarer Schritt (z.B. "Projekt-Setup mit package.json und tsconfig", nicht "Planung")
- Phasen sind in der Reihenfolge der Abhängigkeiten sortiert
- Jede Phase sollte in 5-15 Minuten von einem Code-Agent umsetzbar sein
- Wähle so viele Phasen wie nötig für die Aufgabe — einfache Projekte 2-4, mittlere 5-8, komplexe 9-15
- Build-Strategie: welche Commands zum Validieren (z.B. "npm install && npm run build")

Antworte NUR mit validem JSON, kein Markdown, keine Erklärung:
{
  "phases": ["Phase 1: ...", "Phase 2: ...", ...],
  "buildStrategy": "npm install && npm run build",
  "estimatedIterations": 4
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
      return {
        phases: parsed.phases,
        buildStrategy: parsed.buildStrategy ?? 'npm install && npm run build',
        estimatedIterations: parsed.estimatedIterations ?? parsed.phases.length,
      };
    }
  }
  return null;
}

export async function createProjectPlan(
  goal: string,
  llm: LLMProvider,
  previousSessions?: Array<{ goal: string; milestones: string[] }>,
): Promise<ProjectPlan> {
  const historyBlock = previousSessions && previousSessions.length > 0
    ? '\n\nVorherige Sessions in diesem Verzeichnis (bereits erledigt — NICHT wiederholen):\n' +
      previousSessions.map((s, i) =>
        `  ${i + 1}. Ziel: ${s.goal}\n     Milestones: ${s.milestones.join(', ') || '—'}`
      ).join('\n')
    : '';

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
  };
}
