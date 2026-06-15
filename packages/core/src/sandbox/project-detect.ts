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
  /** v901 — Sandbox-Image für diesen Stack (z.B. 'alfred-sandbox:python-312').
   *  Undefined → Node-Default ('alfred-sandbox:node-22'). */
  image?: string;
  /** v901 — Setup/Install-Schritte VOR dem dev-Command (z.B. ['pip install -r requirements.txt']).
   *  Undefined → Node-Default ('<pm> install && <pm> rebuild'). */
  setupCommand?: string[];
  /** v901 — Migrations-/Schema-Command, der bei vorhandener DB (Hybrid-Compose) VOR dem
   *  dev-Server läuft (z.B. 'python manage.py migrate'). Node+Prisma wird separat erkannt. */
  dbMigrateCommand?: string;
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

/**
 * v901 — Nicht-Node-Stacks (Python/PHP/Ruby/Go) per Marker-Datei erkennen. Liefert
 * Image + Setup/Dev/Migrate-Commands + Port. Node-Frameworks haben Vorrang (werden
 * in detectProjectType zuerst geprüft); dies greift, wenn kein package.json / kein
 * Node-dev-Script vorhanden ist.
 */
type NonNodeDetection = Omit<ProjectDetection, 'hasComposeFile' | 'composeFile'>;
function readIfExists(worktreePath: string, file: string): string {
  try { return existsSync(path.join(worktreePath, file)) ? readFileSync(path.join(worktreePath, file), 'utf-8') : ''; }
  catch { return ''; }
}
function detectNonNode(worktreePath: string): NonNodeDetection | null {
  const has = (p: string) => existsSync(path.join(worktreePath, p));
  // Django (manage.py)
  if (has('manage.py')) {
    return {
      type: 'python-django', image: 'alfred-sandbox:python-312',
      setupCommand: ['pip install -r requirements.txt'],
      dbMigrateCommand: 'python manage.py migrate --noinput',
      devCommand: ['python', 'manage.py', 'runserver', '0.0.0.0:8000'],
      internalPort: 8000, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'django' },
    };
  }
  // Rails (Gemfile + config.ru/bin/rails)
  if (has('Gemfile') && (has('config.ru') || has('bin/rails'))) {
    return {
      type: 'ruby-rails', image: 'alfred-sandbox:ruby-33',
      setupCommand: ['bundle install'],
      dbMigrateCommand: 'bundle exec rails db:prepare',
      devCommand: ['bundle', 'exec', 'rails', 'server', '-b', '0.0.0.0', '-p', '3000'],
      internalPort: 3000, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'rails' },
    };
  }
  // Laravel (artisan)
  if (has('artisan')) {
    return {
      type: 'php-laravel', image: 'alfred-sandbox:php-83',
      setupCommand: ['composer install --no-interaction'],
      dbMigrateCommand: 'php artisan migrate --force',
      devCommand: ['php', 'artisan', 'serve', '--host', '0.0.0.0', '--port', '8000'],
      internalPort: 8000, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'laravel' },
    };
  }
  // FastAPI (requirements/pyproject mit fastapi/uvicorn)
  const pyDeps = readIfExists(worktreePath, 'requirements.txt') + '\n' + readIfExists(worktreePath, 'pyproject.toml');
  if ((has('requirements.txt') || has('pyproject.toml')) && /fastapi|uvicorn/i.test(pyDeps)) {
    return {
      type: 'python-fastapi', image: 'alfred-sandbox:python-312',
      setupCommand: ['pip install -r requirements.txt'],
      devCommand: ['uvicorn', 'main:app', '--reload', '--host', '0.0.0.0', '--port', '8000'],
      internalPort: 8000, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'fastapi' },
    };
  }
  // Generic Python
  if (has('requirements.txt') || has('pyproject.toml')) {
    return {
      type: 'python-generic', image: 'alfred-sandbox:python-312',
      setupCommand: ['pip install -r requirements.txt || pip install -e .'],
      devCommand: ['python', 'main.py'],
      internalPort: 8000, hasDevServer: has('main.py'),
      diagnostics: { packageManager: 'npm', framework: 'python' },
    };
  }
  // Generic PHP (composer.json / index.php ohne artisan)
  if (has('composer.json') || has('public/index.php') || has('index.php')) {
    const docroot = has('public/index.php') ? 'public' : '.';
    return {
      type: 'php-generic', image: 'alfred-sandbox:php-83',
      setupCommand: has('composer.json') ? ['composer install --no-interaction'] : [],
      devCommand: ['php', '-S', '0.0.0.0:8000', '-t', docroot],
      internalPort: 8000, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'php' },
    };
  }
  // Go
  if (has('go.mod')) {
    return {
      type: 'go', image: 'alfred-sandbox:go-122',
      setupCommand: ['go mod download'],
      devCommand: ['go', 'run', '.'],
      internalPort: 8080, hasDevServer: true,
      diagnostics: { packageManager: 'npm', framework: 'go' },
    };
  }
  return null;
}

export function detectProjectType(worktreePath: string): ProjectDetection {
  // v849 — Compose-Detection läuft unabhängig vom package.json-Check damit
  // auch reine Service-Stacks (z.B. Postgres + Adminer ohne Node) erkannt werden.
  const composeFile = detectComposeFile(worktreePath);
  const hasComposeFile = composeFile !== undefined;

  const pkgPath = path.join(worktreePath, 'package.json');
  if (!existsSync(pkgPath)) {
    // v901 — kein package.json → Nicht-Node-Stack prüfen (Django/PHP/Rails/Go)
    const nn = detectNonNode(worktreePath);
    if (nn) return { ...nn, hasComposeFile, composeFile };
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

  // v901 — package.json ohne dev/start-Script → könnte Tooling für einen Nicht-Node-
  // Stack sein (z.B. Vite-Frontend-Build neben Django-Backend). Nicht-Node prüfen.
  const nn = detectNonNode(worktreePath);
  if (nn) return { ...nn, hasComposeFile, composeFile };

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
