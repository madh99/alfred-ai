import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

/** v697 — Helper zum Bauen + Verwalten von Sandbox-Containern via Docker-CLI. */

export interface RunContainerInput {
  image: string;
  name: string;
  workdir: string;
  binds: Array<{ host: string; container: string; readOnly?: boolean }>;
  envVars?: Record<string, string>;
  /** [hostPort, containerPort] mapping */
  ports: Array<[number, number]>;
  memoryMb: number;
  cpus: number;
  /** Befehl der nach `sh -c "pnpm install && exec"` ausgeführt wird */
  command: string[];
  /** Restart-Policy: 'no' für sandbox (wir managen Lifecycle selbst). */
  restartPolicy?: 'no' | 'unless-stopped';
  /** v899 — Docker-Netz, dem der Container beitritt (Hybrid-Compose: App auf dem
   *  Compose-Netz, damit der DB-Service per Service-Name erreichbar ist). */
  network?: string;
  /** v899 — Netz-Alias des Containers (z.B. der Compose-Service-Name). */
  networkAlias?: string;
  logger: Logger;
}

export async function runSandboxContainer(input: RunContainerInput): Promise<string> {
  const args = [
    'run',
    '-d',                          // detached
    '--name', input.name,
    '--workdir', input.workdir,
    '--memory', `${input.memoryMb}m`,
    '--memory-swap', `${input.memoryMb}m`,
    '--cpus', String(input.cpus),
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--restart', input.restartPolicy ?? 'no',
  ];
  if (input.network) {
    args.push('--network', input.network);
    if (input.networkAlias) args.push('--network-alias', input.networkAlias);
  }
  for (const b of input.binds) {
    args.push('-v', `${b.host}:${b.container}${b.readOnly ? ':ro' : ''}`);
  }
  for (const [h, c] of input.ports) {
    args.push('-p', `${h}:${c}`);
  }
  for (const [k, v] of Object.entries(input.envVars ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(input.image);
  // Wrap command in sh -c so we can chain `pnpm install && <devCommand>`
  args.push('sh', '-c', input.command.join(' '));

  input.logger.info({ name: input.name, image: input.image, command: input.command.join(' ') }, 'docker run starting');
  const { stdout } = await execFileAsync('docker', args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  const containerId = stdout.trim().slice(0, 12);
  if (!containerId) throw new Error('docker run returned no container ID');
  input.logger.info({ containerId, name: input.name }, 'docker run succeeded');
  return containerId;
}

export async function stopContainer(containerId: string, timeoutSec = 10): Promise<void> {
  try {
    await execFileAsync('docker', ['stop', '-t', String(timeoutSec), containerId], { timeout: (timeoutSec + 5) * 1000 });
  } catch {
    // Vielleicht schon weg — kein Fehler
  }
}

export async function startContainer(containerId: string): Promise<void> {
  await execFileAsync('docker', ['start', containerId], { timeout: 30_000 });
}

export async function removeContainer(containerId: string, force = true): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', force ? '-f' : '', containerId].filter(Boolean), { timeout: 30_000 });
  } catch {
    // Idempotent
  }
}

export async function containerExists(containerId: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['inspect', containerId], { timeout: 5_000 });
    return true;
  } catch { return false; }
}

export async function getContainerStatus(containerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.State.Status}}', containerId], { timeout: 5_000 });
    return stdout.trim();
  } catch { return null; }
}

/**
 * v816 — Führt ein Shell-Kommando IM CONTAINER aus via `docker exec`. Wird
 * vom Project-Agent-Runner für Test-Validierung im Sandbox-Kontext genutzt:
 * der Container ist musl, der Host glibc → Host-Tests failen am ABI. Container-
 * Tests laufen genau im Build-Kontext (gleiches node_modules, gleiches /workspace),
 * der dev-server bleibt unbeeinflusst (separate exec-Session).
 *
 * Liefert exitCode, stdout, stderr, durationMs (für validateBuild-Pipeline).
 */
export async function runContainerCommand(
  containerId: string,
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = ['exec'];
    if (opts.cwd) args.push('-w', opts.cwd);
    args.push(containerId, 'sh', '-c', cmd);

    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 3000);
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? 124 : (exitCode ?? -1),
        stdout,
        stderr: killed ? stderr + `\n[runContainerCommand] killed: timeout after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - start,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[runContainerCommand] spawn-error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** v728 — Liefert die letzten N Zeilen aus stdout+stderr eines Containers. */
export async function getContainerLogs(containerId: string, tail = 200): Promise<string> {
  try {
    const safeTail = Math.max(1, Math.min(2000, Math.floor(tail)));
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['logs', '--tail', String(safeTail), '--timestamps', containerId],
      { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    );
    // Docker mischt stdout/stderr — beide concatenaten für vollständige Ansicht
    return [stdout, stderr].filter(s => s && s.length > 0).join('\n');
  } catch (err) {
    return `[docker logs failed: ${(err as Error).message}]`;
  }
}

export async function getContainerStats(containerId: string): Promise<{ ramMb: number | null; cpuPct: number | null }> {
  try {
    const { stdout } = await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', containerId], { timeout: 8_000 });
    const parts = stdout.trim().split('|');
    if (parts.length < 2) return { ramMb: null, cpuPct: null };
    const mem = parts[0]; // z.B. "123.4MiB / 2GiB"
    const cpu = parts[1]; // z.B. "12.34%"
    const memMatch = mem.match(/([\d.]+)\s*(MiB|GiB|KiB)/i);
    let ramMb: number | null = null;
    if (memMatch) {
      const val = parseFloat(memMatch[1]);
      const unit = memMatch[2].toLowerCase();
      ramMb = unit === 'gib' ? val * 1024 : unit === 'kib' ? val / 1024 : val;
    }
    const cpuMatch = cpu.match(/([\d.]+)/);
    return { ramMb, cpuPct: cpuMatch ? parseFloat(cpuMatch[1]) : null };
  } catch {
    return { ramMb: null, cpuPct: null };
  }
}

/**
 * v697 — Pollt den Host-Port via HTTP-GET bis 200/3xx/4xx kommt (= dev-server lebt).
 * Connection-Refused → noch nicht bereit, weiter pollen.
 */
export async function waitForDevServer(hostPort: number, opts: { intervalMs?: number; timeoutMs?: number; logger: Logger }): Promise<boolean> {
  const interval = opts.intervalMs ?? 1_500;
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000; // 5 min default (npm install kann lang dauern)
  const deadline = Date.now() + timeout;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const ok = await probeHttp(hostPort);
    if (ok) {
      opts.logger.info({ hostPort, attempts: attempt }, 'dev-server healthy');
      return true;
    }
    await sleep(interval);
  }
  opts.logger.warn({ hostPort, timeoutMs: timeout }, 'dev-server health-check timed out');
  return false;
}

function probeHttp(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2_000 }, res => {
      // Jede HTTP-Antwort = server lebt (auch 404, 500 — was zählt ist: TCP+HTTP geht durch)
      res.resume();
      res.on('end', () => resolve(true));
      resolve(true);
      req.destroy();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * v697 — Stellt sicher dass das Image vorhanden ist. Wenn nicht: build aus
 * dem Dockerfile unter `dockerfilesDir/<image-name>.Dockerfile`. Beim ersten
 * Sandbox-Create kann das 1-3 min dauern (alpine + pnpm + git).
 */
export async function ensureImage(input: { image: string; dockerfilesDir: string; logger: Logger }): Promise<{ built: boolean }> {
  if (await imageExists(input.image)) {
    return { built: false };
  }
  // Dockerfile suchen: `<image>.Dockerfile` oder `Dockerfile.<tag-part>`
  const tag = input.image.split(':')[1] ?? 'latest';
  const candidates = [
    path.join(input.dockerfilesDir, `${input.image.replace(':', '_')}.Dockerfile`),
    path.join(input.dockerfilesDir, `Dockerfile.${tag}`),
    path.join(input.dockerfilesDir, 'Dockerfile'),
  ];
  const dockerfilePath = candidates.find(p => existsSync(p));
  if (!dockerfilePath) {
    throw new Error(`Sandbox image '${input.image}' not found and no Dockerfile in ${input.dockerfilesDir}. Tried: ${candidates.join(', ')}`);
  }
  input.logger.info({ image: input.image, dockerfile: dockerfilePath }, 'Building sandbox image (first use, can take 1-3 min)…');
  await execFileAsync(
    'docker',
    ['build', '-t', input.image, '-f', dockerfilePath, path.dirname(dockerfilePath)],
    { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
  );
  input.logger.info({ image: input.image }, 'Sandbox image built');
  return { built: true };
}

async function imageExists(image: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['images', '-q', image], { timeout: 5_000 });
    return stdout.trim().length > 0;
  } catch { return false; }
}

/**
 * v697 — Streamt Container-Logs als async-iterable.
 * Caller muss `controller.abort()` oder Stream-Close handhaben.
 */
export function streamContainerLogs(containerId: string, opts: { signal?: AbortSignal; follow?: boolean }): AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }> {
  const args = ['logs', ...(opts.follow ?? true ? ['-f'] : []), '--timestamps', containerId];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  opts.signal?.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* */ } });

  async function* generator(): AsyncIterableIterator<{ stream: 'stdout' | 'stderr'; line: string }> {
    const queue: Array<{ stream: 'stdout' | 'stderr'; line: string }> = [];
    let resolveNext: ((v: IteratorResult<{ stream: 'stdout' | 'stderr'; line: string }>) => void) | null = null;
    let ended = false;
    const emit = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line) continue;
        const evt = { stream, line };
        if (resolveNext) { resolveNext({ value: evt, done: false }); resolveNext = null; }
        else { queue.push(evt); }
      }
    };
    child.stdout?.on('data', emit('stdout'));
    child.stderr?.on('data', emit('stderr'));
    child.on('exit', () => {
      ended = true;
      if (resolveNext) { resolveNext({ value: undefined as never, done: true }); resolveNext = null; }
    });
    while (true) {
      if (queue.length > 0) { yield queue.shift()!; continue; }
      if (ended) return;
      yield await new Promise<{ stream: 'stdout' | 'stderr'; line: string }>(res => {
        resolveNext = (r) => { if (!r.done) res(r.value); };
      });
    }
  }
  return { [Symbol.asyncIterator]: () => generator() };
}
