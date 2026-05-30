import { spawn } from 'node:child_process';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface BuildValidationResult {
  passed: boolean;
  commands: CommandResult[];
  combinedOutput: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes per command
const MAX_OUTPUT_CHARS = 8_000;

function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  // Keep tail (where errors appear)
  return '[...truncated...]\n' + text.slice(-max);
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  runAsUser?: string,
): Promise<CommandResult> {
  const startTime = Date.now();
  // If runAsUser is specified, wrap command with sudo -u <user>
  let finalCmd: string;
  let finalArgs: string[];
  if (runAsUser) {
    finalCmd = 'sudo';
    finalArgs = ['-u', runAsUser, 'bash', '-c', command];
  } else {
    const parts = command.split(/\s+/);
    finalCmd = parts[0];
    finalArgs = parts.slice(1);
  }

  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    // v838 — NODE_OPTIONS für tsc/vitest-spawn auf Host. Verhindert V8 SIGABRT bei
    // großen Monorepos. Vererbt existierendes parent-NODE_OPTIONS wenn schon gesetzt.
    const parentNodeOpts = process.env.NODE_OPTIONS ?? '';
    const nodeOpts = /max-old-space-size/.test(parentNodeOpts)
      ? parentNodeOpts
      : `${parentNodeOpts} --max-old-space-size=4096`.trim();
    const child = spawn(finalCmd, finalArgs, {
      cwd,
      shell: !runAsUser, // Don't use shell when wrapping with sudo (already using bash -c)
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NODE_OPTIONS: nodeOpts },
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: killed ? 124 : (code ?? 1),
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut: killed,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: 127,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr + '\n' + err.message),
        timedOut: false,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * Run build and test commands sequentially in a given directory.
 * Returns a combined result indicating whether all commands passed.
 */
/**
 * v816 — Optionaler Container-Exec für Test-Commands. Wird vom Project-Agent-
 * Runner gesetzt wenn der Run in einem Sandbox-Container läuft: Tests laufen
 * dann via `docker exec` IM Container statt auf dem Host. Behebt das musl/glibc
 * ABI-Problem (Host kann musl-rebuilte Bindings nicht laden) das v813 dazu zwang
 * Tests aus der per-Phase-Validierung rauszunehmen. Build-Commands bleiben am Host.
 */
export type ContainerExec = (cmd: string, timeoutMs: number) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}>;

export async function validateBuild(
  cwd: string,
  buildCommands: string[],
  testCommands: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runAsUser?: string,
  containerExec?: ContainerExec,
): Promise<BuildValidationResult> {
  const startTime = Date.now();
  const commands: CommandResult[] = [];

  // Build-Commands laufen weiter auf dem Host (npm install / typecheck etc.
  // sind ABI-unkritisch oder explizit Host-Operationen wie git rebase).
  for (const cmd of buildCommands) {
    const result = await runCommand(cmd, cwd, timeoutMs, runAsUser);
    commands.push(result);
    if (result.exitCode !== 0) break;
  }

  // Wenn Build durchlief: Test-Commands. Mit containerExec im Container,
  // sonst Fallback Host (Backwards-Compat für klassische, nicht-sandbox Runs).
  if (commands.every((c) => c.exitCode === 0)) {
    for (const cmd of testCommands) {
      let result: CommandResult;
      if (containerExec) {
        const r = await containerExec(cmd, timeoutMs);
        result = { command: cmd, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs, timedOut: r.exitCode === 124 };
      } else {
        result = await runCommand(cmd, cwd, timeoutMs, runAsUser);
      }
      commands.push(result);
      if (result.exitCode !== 0) break;
    }
  }

  const passed = commands.every(c => c.exitCode === 0);
  const combinedOutput = commands
    .map(c => `$ ${c.command} (exit ${c.exitCode}, ${c.durationMs}ms)\n${[c.stderr, c.stdout].filter(Boolean).join('\n')}`)
    .join('\n\n');

  return {
    passed,
    commands,
    combinedOutput: truncateOutput(combinedOutput),
    durationMs: Date.now() - startTime,
  };
}
