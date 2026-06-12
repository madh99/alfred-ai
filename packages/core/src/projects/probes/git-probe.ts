import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProbeContext, ProbeResult } from './probe-types.js';
import { collectRepoStatus } from '../repo-status.js';

const DEFAULT_GIT_TIMEOUT = 15_000;

/**
 * git-probe — minimal repo health check.
 *
 * Returns:
 *  - 'ok'      : .git exists, HEAD readable, commit within 30 days, clean + gepusht
 *  - 'warning' : last commit > 30 days ago (stale) ODER uncommittete Dateien
 *                ODER ungepushte Commits (v872 — genau die Zustände, die diese
 *                Woche teuer waren: dirty cwd, ahead of origin)
 *  - 'error'   : cwd missing OR not a git repo OR HEAD unreadable
 *  - 'skipped' : no cwd configured
 */
export async function gitProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_GIT_TIMEOUT;

  if (!ctx.cwd) {
    return { probe: 'git', status: 'skipped', details: 'no cwd configured', durationMs: Date.now() - startedAt };
  }
  if (!existsSync(ctx.cwd)) {
    return { probe: 'git', status: 'error', details: `cwd does not exist: ${ctx.cwd}`, durationMs: Date.now() - startedAt };
  }
  if (!existsSync(path.join(ctx.cwd, '.git'))) {
    return { probe: 'git', status: 'error', details: 'not a git repository (no .git/)', durationMs: Date.now() - startedAt };
  }

  try {
    // v872 — gemeinsamer Collector mit dem Repo-Status-Endpoint (eine Implementierung)
    const rs = await collectRepoStatus(ctx.cwd, { timeoutMs });

    const reasons: string[] = [];
    if (rs.commitAgeDays > 30) reasons.push('stale');
    if (rs.dirtyCount > 0) reasons.push(`dirty=${rs.dirtyCount}`);
    if ((rs.ahead ?? 0) > 0) reasons.push(`unpushed=${rs.ahead}`);
    const status: 'ok' | 'warning' = reasons.length > 0 ? 'warning' : 'ok';

    const details = `branch=${rs.branch} sha=${rs.sha} age_days=${rs.commitAgeDays}` +
      ` dirty=${rs.dirtyCount}` +
      (rs.upstream ? ` ahead=${rs.ahead} behind=${rs.behind}` : ' upstream=none');
    return { probe: 'git', status, details, durationMs: Date.now() - startedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { probe: 'git', status: 'error', details: `git read failed: ${msg.slice(0, 200)}`, durationMs: Date.now() - startedAt };
  }
}
