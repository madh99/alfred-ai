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

Antworte als JSON:
{
  "phases": ["Phase 1: ...", "Phase 2: ...", ...],
  "buildStrategy": "npm install && npm run build && npm test",
  "estimatedIterations": 4
}`;

export async function createProjectPlan(
  goal: string,
  llm: LLMProvider,
  previousSessions?: Array<{ goal: string; milestones: string[] }>,
): Promise<ProjectPlan> {
  try {
    const historyBlock = previousSessions && previousSessions.length > 0
      ? '\n\nVorherige Sessions in diesem Verzeichnis (bereits erledigt — NICHT wiederholen):\n' +
        previousSessions.map((s, i) =>
          `  ${i + 1}. Ziel: ${s.goal}\n     Milestones: ${s.milestones.join(', ') || '—'}`
        ).join('\n')
      : '';

    const response = await llm.complete({
      system: PLANNING_PROMPT,
      messages: [
        { role: 'user', content: goal + historyBlock },
      ],
      maxTokens: 1024,
      temperature: 0.3,
    });

    const text = response.content;

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
  } catch { /* fallback below */ }

  // Fallback: single-phase plan
  return {
    phases: [`Implementiere: ${goal}`],
    buildStrategy: 'npm install && npm run build',
    estimatedIterations: 1,
  };
}
