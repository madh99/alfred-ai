/**
 * v854 — Test-Runner Detection + Cross-Runner Flag Sanitization.
 *
 * Hintergrund: Pipeline-LLMs erfanden Jest-Flags (`--runInBand`) in
 * `project_agent.start({ testCommands })` für Vitest-Projekte. Die Flag wurde
 * unverändert an jede Phase weitergereicht, der LLM im Fix-Loop sah die
 * Inkompatibilität, konnte sie aber nicht beheben (testCommands sind in der
 * Session-Config frozen). Resultat: Loop "--runInBand ist Jest, nicht Vitest"
 * nach jeder Phase ohne Fix-Chance.
 *
 * Strategy:
 *   1. Test-Runner aus package.json devDependencies/dependencies detecten
 *   2. Inkompatible Flags pro Runner blacklisten
 *   3. Sanitization: bei Konflikt → silent strip mit Log-Eintrag
 *   4. Wenn Runner nicht erkennbar → durchlassen (no-op)
 */

export type TestRunner = 'vitest' | 'jest' | 'mocha' | 'ava' | 'unknown';

export interface SanitizeResult {
  /** Bereinigte Commands (gleich wenn nichts gestripped wurde). */
  testCommands: string[];
  /** Erkannter Test-Runner aus package.json. */
  detectedRunner: TestRunner;
  /** Pro originalem Command: was wurde gestripped? Leer wenn nichts. */
  strippedFlags: Array<{ original: string; sanitized: string; flags: string[] }>;
}

/**
 * Liest package.json synchron und detected den Test-Runner aus deps.
 * Vorrang: explizit in scripts.test referenziert (`vitest`/`jest`/`mocha`/`ava`)
 * → dann devDependencies → dann dependencies.
 * Return: 'unknown' wenn nicht eindeutig.
 */
export function detectTestRunner(cwd: string): TestRunner {
  try {
    // dynamic require to avoid top-level imports (test-friendlier + ESM-safe)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const pkgPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'unknown';
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const testScript = (pkg.scripts?.test ?? '').toLowerCase();
    // 1) explicit reference in scripts.test wins (most reliable)
    if (/\bvitest\b/.test(testScript)) return 'vitest';
    if (/\bjest\b/.test(testScript)) return 'jest';
    if (/\bmocha\b/.test(testScript)) return 'mocha';
    if (/\bava\b/.test(testScript)) return 'ava';
    // 2) deps lookup
    const allDeps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    if (allDeps.vitest) return 'vitest';
    if (allDeps.jest || allDeps['ts-jest'] || allDeps['@jest/core']) return 'jest';
    if (allDeps.mocha) return 'mocha';
    if (allDeps.ava) return 'ava';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Flags die der Runner NICHT akzeptiert. Wenn sie auf der CLI auftauchen,
 * bricht der Test-Run mit "unknown option" ab oder ignoriert sie still.
 *
 * Bewusst konservativ: nur eindeutig cross-runner-fremde Flags. Generische
 * Flags wie `--watch`, `--reporter` werden NICHT entfernt (beide Runner
 * kennen sie meistens, auch wenn die Semantik leicht abweicht).
 */
const INCOMPATIBLE_FLAGS: Record<Exclude<TestRunner, 'unknown'>, RegExp[]> = {
  // Jest-Flags die Vitest nicht kennt
  vitest: [
    /^--runInBand$/,                  // jest sequential
    /^--testPathPattern(=.*)?$/,      // jest test-path-pattern (vitest nutzt positional)
    /^--testNamePattern(=.*)?$/,      // jest test-name-pattern (vitest: -t)
    /^--detectOpenHandles$/,          // jest only
    /^--listTests$/,                  // jest only (vitest: --reporter=verbose --run)
    /^--forceExit$/,                  // jest only
    /^--useStderr$/,                  // jest only
    /^--ci$/,                         // jest CI-Modus (vitest hat eigene CI-Detection)
  ],
  // Vitest-Flags die Jest nicht kennt
  jest: [
    /^--no-threads$/,                 // vitest only
    /^--pool(=.*)?$/,                 // vitest only
    /^--poolOptions(\..+)?(=.*)?$/,   // vitest only
    /^--browser(=.*)?$/,              // vitest only
    /^--ui$/,                         // vitest UI (jest hat keinen)
    /^--api(=.*)?$/,                  // vitest only
  ],
  mocha: [
    /^--runInBand$/,                  // jest
    /^--no-threads$/,                 // vitest
    /^--testPathPattern(=.*)?$/,      // jest
    /^--testNamePattern(=.*)?$/,      // jest
  ],
  ava: [
    /^--runInBand$/,                  // jest
    /^--no-threads$/,                 // vitest
    /^--testPathPattern(=.*)?$/,      // jest
    /^--testNamePattern(=.*)?$/,      // jest
  ],
};

/**
 * Zerlege ein Command-String in Tokens, respektiere shell-Quoting nur grob
 * (für unsere CLI-Test-Use-Cases reicht das — wir haben keine multi-arg
 * Quoted-Strings mit Spaces in den blacklisted Flags).
 */
function tokenize(command: string): string[] {
  // Split on whitespace, preserving non-empty tokens. Single/double-quoted
  // segments werden zwar nicht zusammengefasst, das ist OK weil unsere
  // Blacklist-Patterns nie Spaces enthalten.
  return command.split(/\s+/).filter(t => t.length > 0);
}

/**
 * Strippt incompatible Flags aus einem einzelnen Test-Command.
 * Liefert sanitized command + Liste der entfernten Flags.
 */
function stripFlagsFromCommand(command: string, patterns: RegExp[]): { sanitized: string; flags: string[] } {
  const tokens = tokenize(command);
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const tok of tokens) {
    if (patterns.some(p => p.test(tok))) {
      stripped.push(tok);
    } else {
      kept.push(tok);
    }
  }
  return { sanitized: kept.join(' '), flags: stripped };
}

/**
 * Bereinigt die übergebenen testCommands gegen den erkannten Runner.
 *
 * Verhalten:
 *   - Wenn `detectedRunner === 'unknown'`: no-op (Flags durchlassen, nur loggen
 *     wäre Aufgabe des Callers — wir geben dieselbe Liste unverändert zurück)
 *   - Sonst: pro Command incompatible Flags strippen, Original separat
 *     für Logging zurückgeben
 *
 * NIE: Command komplett fallen lassen. Wenn nach Strip nur noch `npm test --`
 * übrig ist, lass das stehen — npm akzeptiert leere `--` Trailing.
 */
export function sanitizeTestCommands(
  testCommands: string[],
  detectedRunner: TestRunner,
): SanitizeResult {
  if (detectedRunner === 'unknown') {
    return { testCommands: [...testCommands], detectedRunner, strippedFlags: [] };
  }
  const patterns = INCOMPATIBLE_FLAGS[detectedRunner];
  if (!patterns || patterns.length === 0) {
    return { testCommands: [...testCommands], detectedRunner, strippedFlags: [] };
  }
  const out: string[] = [];
  const stripped: Array<{ original: string; sanitized: string; flags: string[] }> = [];
  for (const cmd of testCommands) {
    const { sanitized, flags } = stripFlagsFromCommand(cmd, patterns);
    out.push(sanitized);
    if (flags.length > 0) {
      stripped.push({ original: cmd, sanitized, flags });
    }
  }
  return { testCommands: out, detectedRunner, strippedFlags: stripped };
}

/**
 * Hilfs-Funktion: erkennt ob ein Build-Output-String typische "unknown flag"-
 * Fehler eines Test-Runners enthält. Wird vom project-agent-runner verwendet
 * um im fix-prompt einen klärenden Hinweis zu setzen.
 */
export function looksLikeTestRunnerFlagMismatch(output: string): boolean {
  if (!output) return false;
  // Vitest typische Fehler-Meldungen
  if (/error:\s+(unknown|invalid)\s+option/i.test(output) && /vitest/i.test(output)) return true;
  // Jest typische Fehler-Meldungen
  if (/●\s+Unrecognized\s+CLI\s+Parameter/i.test(output)) return true;
  // Generisch (yargs-basiert)
  if (/Unknown\s+argument/i.test(output) && /(--runInBand|--no-threads|--testPathPattern|--testNamePattern|--pool)/i.test(output)) return true;
  return false;
}
