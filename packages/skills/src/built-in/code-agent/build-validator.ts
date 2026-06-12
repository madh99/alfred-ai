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

const DEFAULT_TIMEOUT_MS = 600_000; // v877.1 — 10 min pro Command (300s war zu knapp für gewachsene Testsuiten, Vorfall 12.06.: 307s)
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
  // v877.1 — Timeout EXPLIZIT ausweisen: vorher stand nur "exit 124" im Header
  // und der Fix-Agent rätselte über fehlerfreien (grünen) Output. Vorfall 12.06.:
  // Testsuite brauchte 307s bei 300s-Limit → SIGTERM → vitest druckte trotzdem
  // die grüne Summary → Fix-Loop suchte einen Bug, den es nie gab.
  const header = (c: CommandResult) =>
    `$ ${c.command} (exit ${c.exitCode}, ${Math.round(c.durationMs / 1000)}s)` +
    (c.timedOut ? ` ⏱ TIMEOUT — Prozess nach ${Math.round(timeoutMs / 1000)}s abgebrochen; der Output kann fehlerfrei aussehen, das Problem ist die LAUFZEIT, kein Code-Fehler` : '');
  const combinedOutput = commands
    .map(c => `${header(c)}\n${[c.stderr, c.stdout].filter(Boolean).join('\n')}`)
    .join('\n\n');

  // v877.1 — Command-Übersicht überlebt die Tail-Kürzung: vorher schnitt der
  // 8k-Tail die "$ cmd (exit …)"-Header weg → der Fix-Agent sah weder WAS
  // fehlschlug noch den Exit-Code.
  const overview = commands.map(header).join('\n');
  const truncated = combinedOutput.length > MAX_OUTPUT_CHARS
    ? `## Command-Übersicht\n${overview}\n\n[...truncated...]\n${combinedOutput.slice(-MAX_OUTPUT_CHARS)}`
    : combinedOutput;

  return {
    passed,
    commands,
    combinedOutput: truncated,
    durationMs: Date.now() - startTime,
  };
}
