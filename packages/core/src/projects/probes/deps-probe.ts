import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProbeContext, ProbeResult } from './probe-types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DEPS_TIMEOUT = 30_000;

/**
 * deps-probe — checks for outdated direct dependencies.
 *
 * Returns:
 *  - 'ok'      : no outdated direct deps
 *  - 'warning' : 1+ outdated direct deps detected
 *  - 'error'   : check failed (network, lockfile mismatch, etc.)
 *  - 'skipped' : no recognised stack
 *
 * Conservative: counts only direct dependencies — transitive churn is noise.
 */
export async function depsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_DEPS_TIMEOUT;

  if (!ctx.cwd || !existsSync(ctx.cwd)) {
    return { probe: 'deps', status: 'skipped', details: 'no cwd or cwd missing', durationMs: Date.now() - startedAt };
  }

  // Node ecosystem
  if (existsSync(path.join(ctx.cwd, 'package.json'))) {
    return runNpmOutdated(ctx.cwd, timeoutMs, startedAt);
  }
  return { probe: 'deps', status: 'skipped', details: 'no recognised dep manifest', durationMs: Date.now() - startedAt };
}

async function runNpmOutdated(cwd: string, timeoutMs: number, startedAt: number): Promise<ProbeResult> {
  try {
    // `npm outdated --json` exits with code 1 when there ARE outdated deps — not an error.
    const { stdout } = await execFileAsync('npm', ['outdated', '--json', '--depth=0'], {
      cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    }).catch((err: { code?: number; stdout?: string }) => {
      // npm-outdated returns exit 1 when outdated entries exist — capture stdout anyway
      if (err.code === 1 && err.stdout) return { stdout: err.stdout };
      throw err;
    });

    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(stdout || '{}'); } catch { parsed = {}; }
    const entries = Object.keys(parsed);
    if (entries.length === 0) {
      return { probe: 'deps', status: 'ok', details: 'no outdated direct deps', durationMs: Date.now() - startedAt };
    }
    const sample = entries.slice(0, 5).join(', ');
    return {
      probe: 'deps', status: 'warning',
      details: `${entries.length} outdated direct dep(s): ${sample}${entries.length > 5 ? '...' : ''}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; message?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      return { probe: 'deps', status: 'warning', details: `npm outdated: timeout`, durationMs: Date.now() - startedAt };
    }
    return {
      probe: 'deps', status: 'error',
      details: `npm outdated failed: ${(e.message ?? String(err)).slice(0, 200)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
