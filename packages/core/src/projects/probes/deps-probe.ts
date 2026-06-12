import { existsSync } from 'node:fs';
import type { ProbeContext, ProbeResult } from './probe-types.js';
import { collectOutdatedDeps } from '../deps-status.js';

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
 * v873 — nutzt den gemeinsamen Collector mit dem Dependency-Panel
 * (collectOutdatedDeps), damit Probe und Panel nie auseinanderlaufen.
 */
export async function depsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_DEPS_TIMEOUT;

  if (!ctx.cwd || !existsSync(ctx.cwd)) {
    return { probe: 'deps', status: 'skipped', details: 'no cwd or cwd missing', durationMs: Date.now() - startedAt };
  }

  try {
    const { manifest, deps } = await collectOutdatedDeps(ctx.cwd, timeoutMs);
    if (manifest === null) {
      return { probe: 'deps', status: 'skipped', details: 'no recognised dep manifest', durationMs: Date.now() - startedAt };
    }
    if (deps.length === 0) {
      return { probe: 'deps', status: 'ok', details: 'no outdated direct deps', durationMs: Date.now() - startedAt };
    }
    const sample = deps.slice(0, 5).map(d => d.name).join(', ');
    return {
      probe: 'deps', status: 'warning',
      details: `${deps.length} outdated direct dep(s): ${sample}${deps.length > 5 ? '...' : ''}`,
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
