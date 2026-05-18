import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProbeContext, ProbeResult } from './probe-types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT = 15_000;

/**
 * git-probe — minimal repo health check.
 *
 * Returns:
 *  - 'ok'      : .git exists, HEAD readable, commit within 30 days
 *  - 'warning' : .git exists, last commit > 30 days ago (stale repo)
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
    const [head, log] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, timeout: timeoutMs }),
      execFileAsync('git', ['log', '-1', '--format=%H %ct'], { cwd: ctx.cwd, timeout: timeoutMs }),
    ]);
    const branch = head.stdout.trim();
    const logLine = log.stdout.trim();
    const [sha, ctRaw] = logLine.split(/\s+/, 2);
    const commitTime = Number(ctRaw) * 1000;
    const ageDays = Math.floor((Date.now() - commitTime) / (24 * 60 * 60 * 1000));

    const status: 'ok' | 'warning' = ageDays > 30 ? 'warning' : 'ok';
    const details = `branch=${branch} sha=${sha.slice(0, 8)} age_days=${ageDays}`;
    return { probe: 'git', status, details, durationMs: Date.now() - startedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { probe: 'git', status: 'error', details: `git read failed: ${msg.slice(0, 200)}`, durationMs: Date.now() - startedAt };
  }
}
