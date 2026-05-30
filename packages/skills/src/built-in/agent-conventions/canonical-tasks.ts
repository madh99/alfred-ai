/**
 * v836 Phase 4.6 — Canonical Tasks für Test-Harness.
 *
 * Vordefinierte Aufgaben + Validation-Logic für A/B-Vergleich mit/ohne
 * Conventions. Minimal-Implementierung: stack-agnostische Tasks die im
 * project.cwd ausgeführt werden (kein Sandbox-Spawn).
 *
 * Erweiterbar: weitere stack-spezifische Tasks (z.B. Next.js add-route,
 * Rust add-trait) können hier hinzugefügt werden.
 */

export interface CanonicalTask {
  id: string;
  stack: string;
  description: string;
  /** Setup-Commands (vor dem eigentlichen Test). E.g. install. */
  setup?: string[];
  /** Validation-Commands. exitCode=0 = passed. */
  validate: string[];
  /** Timeout pro Command in ms. */
  timeoutMs?: number;
}

export const CANONICAL_TASKS: CanonicalTask[] = [
  {
    id: 'baseline-build',
    stack: 'node',
    description: 'Build + typecheck — baseline ob das Projekt überhaupt bauen kann',
    validate: ['npm run build --if-present', 'npx tsc --noEmit'],
    timeoutMs: 5 * 60_000,
  },
  {
    id: 'baseline-tests',
    stack: 'node',
    description: 'npm test — baseline-Test-Suite ausführen',
    validate: ['npm test'],
    timeoutMs: 10 * 60_000,
  },
  {
    id: 'baseline-lint',
    stack: 'node',
    description: 'npm run lint — Lint-Sauberkeit prüfen',
    validate: ['npm run lint --if-present'],
    timeoutMs: 2 * 60_000,
  },
  {
    id: 'baseline-typecheck',
    stack: 'node',
    description: 'TypeScript-Strict-Check ohne Build',
    validate: ['npx tsc --noEmit'],
    timeoutMs: 3 * 60_000,
  },
];
