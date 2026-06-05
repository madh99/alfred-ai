import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * v849 — Resource-Guard für Compose-Stack-Sandboxen.
 *
 * Compose-Stacks können 3-5+ Container starten (App + DB + Redis + MinIO etc.)
 * — auf einem Host mit nur 1.9 GB RAM (wie unsere VM .92 vor dem Upgrade) ist
 * das ein sicherer Weg zum OOM-killer-Suizid.
 *
 * Dieser Guard prüft VOR dem `docker compose up`:
 *   - Wieviel RAM ist auf dem Host frei?
 *   - Reicht das für die geschätzte Last des Stacks?
 *   - Wenn nicht: clean error statt OOM-Tod
 *
 * Die Schätzung basiert auf service-count + per-service-floor (default 384 MB
 * pro Service). User kann den Floor pro Service in der Config überschreiben.
 */

/** Default-Schätzung: 384 MB pro Service-Container. */
const DEFAULT_PER_SERVICE_MB = 384;

/** Minimum-freies-RAM nach Sandbox-Start damit Host noch atmen kann. */
const HOST_HEADROOM_MB = 512;

export interface ResourceCheckInput {
  /** Anzahl der Services im Compose-Stack (`docker compose config --services | wc -l`). */
  serviceCount: number;
  /** Optional: explizite RAM-Anforderung pro Service (z.B. aus deploy.resources.limits.memory). */
  perServiceMb?: number;
  /** Logger für Diagnose-Output. */
  logger?: { warn(o: object, msg: string): void; info(o: object, msg: string): void };
}

export interface ResourceCheckResult {
  ok: boolean;
  reason?: string;
  diagnostics: {
    hostFreeMb: number;
    hostTotalMb: number;
    estimatedNeedMb: number;
    headroomMb: number;
  };
}

/**
 * Liest verfügbaren Host-RAM in MB. Versucht `free -m` (Linux), fällt auf
 * `os.freemem()` zurück (etwas pessimistischer wegen Linux-Buffer/Cache).
 */
export async function getHostFreeMb(): Promise<{ free: number; total: number }> {
  // Linux: `free -m` gibt available-Wert der Buffers/Cache mitrechnet
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('free', ['-m'], { timeout: 3000 });
      const lines = stdout.split('\n');
      const memLine = lines.find(l => l.startsWith('Mem:'));
      if (memLine) {
        // Format: "Mem: total used free shared buff/cache available"
        const parts = memLine.split(/\s+/).filter(Boolean);
        if (parts.length >= 7) {
          const total = Number(parts[1]);
          const available = Number(parts[6]); // "available" column
          if (Number.isFinite(total) && Number.isFinite(available)) {
            return { free: available, total };
          }
        }
      }
    } catch { /* fallback below */ }
  }
  // Plattform-agnostisch via Node
  const total = Math.floor(os.totalmem() / 1024 / 1024);
  const free = Math.floor(os.freemem() / 1024 / 1024);
  return { free, total };
}

/**
 * Pre-flight check: reicht der Host-RAM für den Compose-Stack?
 *
 * Strategie:
 *  - Need = serviceCount × perServiceMb (Default 384 MB/Service)
 *  - OK wenn `hostFreeMb >= need + HOST_HEADROOM_MB`
 *  - Sonst clear-error-string mit konkreten Zahlen
 */
export async function checkResourcesForCompose(input: ResourceCheckInput): Promise<ResourceCheckResult> {
  const { serviceCount, perServiceMb = DEFAULT_PER_SERVICE_MB, logger } = input;
  const { free, total } = await getHostFreeMb();
  const estimatedNeedMb = serviceCount * perServiceMb;
  const headroomMb = free - estimatedNeedMb;
  const ok = headroomMb >= HOST_HEADROOM_MB;

  const diagnostics = {
    hostFreeMb: free,
    hostTotalMb: total,
    estimatedNeedMb,
    headroomMb,
  };

  if (!ok) {
    const reason =
      `Compose-Stack benötigt geschätzt ${estimatedNeedMb} MB (${serviceCount} Services × ${perServiceMb} MB), ` +
      `aber Host hat nur ${free} MB von ${total} MB frei. ` +
      `Es wären nach Start nur ${headroomMb} MB übrig — Mindestens ${HOST_HEADROOM_MB} MB Headroom erforderlich. ` +
      `Lösung: VM aufrüsten (>= ${estimatedNeedMb + HOST_HEADROOM_MB} MB RAM) oder weniger Services im Compose-Stack.`;
    logger?.warn(diagnostics, `Resource-Guard: Compose-Start blockiert — ${reason}`);
    return { ok: false, reason, diagnostics };
  }

  logger?.info(diagnostics, 'Resource-Guard: Compose-Stack passt');
  return { ok: true, diagnostics };
}
