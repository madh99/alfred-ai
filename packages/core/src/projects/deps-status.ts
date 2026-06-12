import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30_000;

/**
 * v873 — Strukturierte Outdated-Dependency-Erfassung.
 *
 * Gemeinsamer Collector für deps-probe (Health-Status) und das
 * Dependency-Panel (GET /api/projects/:id/deps-status). Die Probe warf die
 * strukturierten npm-outdated-Daten bisher weg (nur gekürzter String) —
 * jetzt eine Implementierung, zwei Konsumenten.
 */
export interface OutdatedDep {
  name: string;
  current?: string;
  wanted?: string;
  latest?: string;
  /** dependencies | devDependencies | optionalDependencies (sofern npm es liefert) */
  type?: string;
}

export interface DepsStatus {
  /** 'npm' | null — null wenn kein erkanntes Manifest vorhanden. */
  manifest: 'npm' | null;
  deps: OutdatedDep[];
}

export async function collectOutdatedDeps(cwd: string, timeoutMs = DEFAULT_TIMEOUT): Promise<DepsStatus> {
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!existsSync(path.join(cwd, 'package.json'))) {
    return { manifest: null, deps: [] };
  }

  // `npm outdated --json` endet mit Exit 1 wenn es Outdated-Einträge GIBT — kein Fehler.
  const { stdout } = await execFileAsync('npm', ['outdated', '--json', '--depth=0'], {
    cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
  }).catch((err: { code?: number; stdout?: string }) => {
    if (err.code === 1 && err.stdout) return { stdout: err.stdout };
    throw err;
  });

  let parsed: Record<string, Record<string, unknown>> = {};
  try { parsed = JSON.parse(stdout || '{}'); } catch { parsed = {}; }

  const deps: OutdatedDep[] = Object.entries(parsed).map(([name, info]) => ({
    name,
    current: typeof info.current === 'string' ? info.current : undefined,
    wanted: typeof info.wanted === 'string' ? info.wanted : undefined,
    latest: typeof info.latest === 'string' ? info.latest : undefined,
    type: typeof info.type === 'string' ? info.type : undefined,
  }));
  deps.sort((a, b) => a.name.localeCompare(b.name));
  return { manifest: 'npm', deps };
}
