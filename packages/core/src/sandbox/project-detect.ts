import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SandboxProjectType } from '@alfred/storage';

export interface ProjectDetection {
  type: SandboxProjectType;
  /** Befehl der im Container läuft (nach pnpm install). */
  devCommand: string[];
  /** Port den der dev-server intern lauscht. */
  internalPort: number;
  /** Hat das Projekt überhaupt ein dev-Script? Bei `false` lohnt sich kein preview-Container. */
  hasDevServer: boolean;
  /** Roh-Info für Debug/UI. */
  diagnostics: {
    packageManager: 'pnpm' | 'npm' | 'yarn';
    devScript?: string;
    framework?: string;
  };
  /**
   * v849 — Compose-Stack-Capability: True wenn ein `docker-compose.yml` oder
   * `docker-compose.yaml` ODER `compose.yml`/`compose.yaml` im Repo-Root liegt.
   *
   * WICHTIG: Diese Erkennung sagt NUR "compose ist möglich" — sie schaltet
   * den Sandbox-Mode NICHT automatisch um. Der echte Switch passiert via
   * `project.sandboxMode = 'compose'` (Opt-In im Project-Settings-UI).
   *
   * Default-Verhalten: bestehende Projekte (sandboxMode='single') ignorieren
   * compose-Files komplett — pre-v849 Verhalten 1:1 erhalten.
   */
  hasComposeFile: boolean;
  /** v849 — Pfad zur erkannten Compose-Datei (relativ zum worktreePath), falls vorhanden. */
  composeFile?: string;
}

/**
 * v697 — Erkennt Project-Type aus package.json + Lockfiles. Heuristisch, aber
 * deckt 95% der Web-Projekte ab. Bei Unklarheit: 'node-generic' mit dem
 * vorhandenen dev-Script und Port 3000 (Next.js-Default).
 *
 * Wenn KEIN package.json existiert oder kein dev-Script vorhanden ist:
 * type='unknown', hasDevServer=false → sandbox-preview wird im UI deaktiviert,
 * `sandbox`-Modus (nur Worktree-Isolation, kein Container) bleibt verfügbar.
 */
/** v849 — Suche nach docker-compose-Datei im Repo-Root. */
function detectComposeFile(worktreePath: string): string | undefined {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (existsSync(path.join(worktreePath, name))) return name;
  }
  return undefined;
}

export function detectProjectType(worktreePath: string): ProjectDetection {
  // v849 — Compose-Detection läuft unabhängig vom package.json-Check damit
  // auch reine Service-Stacks (z.B. Postgres + Adminer ohne Node) erkannt werden.
  const composeFile = detectComposeFile(worktreePath);
  const hasComposeFile = composeFile !== undefined;

  const pkgPath = path.join(worktreePath, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      type: 'unknown',
      devCommand: [],
      internalPort: 0,
      hasDevServer: false,
      diagnostics: { packageManager: 'pnpm' },
      hasComposeFile,
      composeFile,
    };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {
      type: 'unknown',
      devCommand: [],
      internalPort: 0,
      hasDevServer: false,
      diagnostics: { packageManager: 'pnpm' },
      hasComposeFile,
      composeFile,
    };
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};

  // Package-Manager via Lockfile
  let packageManager: 'pnpm' | 'npm' | 'yarn' = 'pnpm';
  if (existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (existsSync(path.join(worktreePath, 'yarn.lock'))) packageManager = 'yarn';
  else if (existsSync(path.join(worktreePath, 'package-lock.json'))) packageManager = 'npm';

  // v711 — npm braucht 'run', pnpm/yarn nicht. Wir verwenden überall 'run' weil's
  // für alle drei funktioniert. Args nach `--` werden von npm/pnpm/yarn ans script
  // weitergereicht (Next.js liest dann --hostname/--port etc.).
  const runArgs = (script: string, ...extraArgs: string[]) => {
    if (packageManager === 'npm') {
      return extraArgs.length > 0
        ? ['npm', 'run', script, '--', ...extraArgs]
        : ['npm', 'run', script];
    }
    // pnpm + yarn akzeptieren beides; wir nutzen 'run' für Konsistenz
    return extraArgs.length > 0
      ? [packageManager, 'run', script, '--', ...extraArgs]
      : [packageManager, 'run', script];
  };

  // Framework-Erkennung (Reihenfolge wichtig: spezifischer zuerst)
  // Next.js
  if (deps.next) {
    return {
      type: 'node-next',
      devCommand: runArgs('dev', '--hostname', '0.0.0.0', '--port', '3000'),
      internalPort: 3000,
      hasDevServer: Boolean(scripts.dev || scripts.start),
      diagnostics: { packageManager, devScript: scripts.dev ?? scripts.start, framework: 'next' },
      hasComposeFile,
      composeFile,
    };
  }
  // Astro
  if (deps.astro) {
    return {
      type: 'node-astro',
      devCommand: runArgs('dev', '--host', '0.0.0.0', '--port', '4321'),
      internalPort: 4321,
      hasDevServer: Boolean(scripts.dev),
      diagnostics: { packageManager, devScript: scripts.dev, framework: 'astro' },
      hasComposeFile,
      composeFile,
    };
  }
  // Remix
  if (deps['@remix-run/dev'] || deps['@remix-run/serve']) {
    return {
      type: 'node-remix',
      devCommand: runArgs('dev'),
      internalPort: 3000,
      hasDevServer: Boolean(scripts.dev),
      diagnostics: { packageManager, devScript: scripts.dev, framework: 'remix' },
      hasComposeFile,
      composeFile,
    };
  }
  // Create React App (legacy aber noch häufig)
  if (deps['react-scripts']) {
    return {
      type: 'node-cra',
      devCommand: runArgs('start'),
      internalPort: 3000,
      hasDevServer: Boolean(scripts.start),
      diagnostics: { packageManager, devScript: scripts.start, framework: 'cra' },
      hasComposeFile,
      composeFile,
    };
  }
  // Vite (sehr verbreitet — nach den spezifischeren Frameworks)
  if (deps.vite) {
    return {
      type: 'node-vite',
      devCommand: runArgs('dev', '--host', '0.0.0.0', '--port', '5173'),
      internalPort: 5173,
      hasDevServer: Boolean(scripts.dev),
      diagnostics: { packageManager, devScript: scripts.dev, framework: 'vite' },
      hasComposeFile,
      composeFile,
    };
  }
  // Generic Node-Projekt mit dev-Script
  if (scripts.dev) {
    return {
      type: 'node-generic',
      devCommand: runArgs('dev'),
      internalPort: tryParsePortFromScript(scripts.dev) ?? 3000,
      hasDevServer: true,
      diagnostics: { packageManager, devScript: scripts.dev, framework: 'generic' },
      hasComposeFile,
      composeFile,
    };
  }
  // Generic Node-Projekt mit start-Script
  if (scripts.start) {
    return {
      type: 'node-generic',
      devCommand: runArgs('start'),
      internalPort: tryParsePortFromScript(scripts.start) ?? 3000,
      hasDevServer: true,
      diagnostics: { packageManager, devScript: scripts.start, framework: 'generic-start' },
      hasComposeFile,
      composeFile,
    };
  }

  // Kein dev-Script → kein preview-Container (sandbox-only Mode wäre noch ok)
  return {
    type: 'node-generic',
    devCommand: [],
    internalPort: 0,
    hasDevServer: false,
    diagnostics: { packageManager, framework: 'no-dev-script' },
    hasComposeFile,
    composeFile,
  };
}

/** Versucht einen Port aus einem npm-Script zu parsen ("--port 3000", "PORT=3000", "-p 3000"). */
function tryParsePortFromScript(script: string): number | null {
  const portMatch = script.match(/(?:--port|-p|PORT=)\s*(\d{2,5})/);
  if (portMatch) {
    const p = parseInt(portMatch[1], 10);
    if (p >= 1024 && p <= 65535) return p;
  }
  return null;
}
