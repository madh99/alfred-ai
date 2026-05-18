import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProbeContext, ProbeResult } from './probe-types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_BUILD_TIMEOUT = 90_000;

/**
 * Detect the project's build command based on lockfile/config files in cwd.
 * Returns null if no recognised stack is found.
 *
 * Important: build-probe is a non-destructive *check*, not a full build.
 * Where possible we prefer dry-run / type-check commands over full builds
 * to keep duration bounded.
 */
function detectBuildCommand(cwd: string): { cmd: string; args: string[] } | null {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
    return { cmd: 'pnpm', args: ['-s', 'exec', 'tsc', '--noEmit'] };
  }
  if (existsSync(path.join(cwd, 'package-lock.json'))) {
    return { cmd: 'npx', args: ['-y', 'tsc', '--noEmit'] };
  }
  if (existsSync(path.join(cwd, 'yarn.lock'))) {
    return { cmd: 'yarn', args: ['-s', 'tsc', '--noEmit'] };
  }
  if (existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { cmd: 'cargo', args: ['check', '--quiet'] };
  }
  if (existsSync(path.join(cwd, 'pyproject.toml')) || existsSync(path.join(cwd, 'setup.py'))) {
    return { cmd: 'python3', args: ['-m', 'compileall', '-q', '.'] };
  }
  return null;
}

/**
 * build-probe — runs a non-destructive build/typecheck.
 *
 * Returns:
 *  - 'ok'      : command succeeded (exit 0)
 *  - 'error'   : command failed (exit ≠ 0)
 *  - 'warning' : command timed out — inconclusive
 *  - 'skipped' : no cwd OR no recognised stack
 */
export async function buildProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_BUILD_TIMEOUT;

  if (!ctx.cwd) {
    return { probe: 'build', status: 'skipped', details: 'no cwd configured', durationMs: Date.now() - startedAt };
  }
  if (!existsSync(ctx.cwd)) {
    return { probe: 'build', status: 'skipped', details: `cwd missing: ${ctx.cwd}`, durationMs: Date.now() - startedAt };
  }

  const detected = detectBuildCommand(ctx.cwd);
  if (!detected) {
    return {
      probe: 'build', status: 'skipped',
      details: 'no recognised stack (looked for pnpm/npm/yarn/cargo/python)',
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(detected.cmd, detected.args, {
      cwd: ctx.cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
    const tail = (stdout || stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    return {
      probe: 'build', status: 'ok',
      details: `${detected.cmd} ${detected.args.join(' ')} → ok${tail ? ' | ' + tail : ''}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; code?: number | string; stderr?: string; stdout?: string; message?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      return {
        probe: 'build', status: 'warning',
        details: `${detected.cmd}: timeout after ${timeoutMs}ms (inconclusive)`,
        durationMs: Date.now() - startedAt,
      };
    }
    const errOutput = (e.stderr || e.stdout || e.message || '').toString();
    const tail = errOutput.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    return {
      probe: 'build', status: 'error',
      details: `${detected.cmd} ${detected.args.join(' ')} → exit ${e.code ?? '?'} | ${tail}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
