import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { checkResourcesForCompose } from './resource-guard.js';

const execFileAsync = promisify(execFile);

/**
 * v849 — Compose-Stack-Runner für Multi-Service-Sandboxen.
 *
 * Pre-v849 unterstützte Sandbox nur Single-Container (App-Image mit Node).
 * Projekte mit PG/Redis/MinIO konnten nicht in der Sandbox laufen.
 *
 * v849 erlaubt User's eigene `docker-compose.yml` zu nutzen:
 *  - Detection erkennt compose-Datei (`docker-compose.yml` etc.)
 *  - User aktiviert `projects.sandbox_mode = 'compose'` im UI (strict opt-in)
 *  - Beim Sandbox-Start:
 *    1. Resource-Guard prüft Host-RAM (verhindert OOM)
 *    2. Erzeugt Sandbox-spezifisches Override-File mit Port-Mappings
 *    3. Startet `docker compose -f user-compose.yml -f override.yml up -d`
 *    4. Wartet bis primary-service (App) gesund ist
 *    5. Optional: project_db_seeds anwenden
 *  - User's `docker-compose.yml` wird NIE modifiziert
 *  - Volumes scoped pro Sandbox (Default) oder pro Projekt (opt-in persistDbVolumes)
 *
 * Service-Ports:
 *   Primary-Service (Web/App): mappt auf hostPort (gleicher Slot wie single-mode)
 *   Andere Services (DB, Redis): mappt auf auto-allocated Host-Ports
 *
 * Cleanup beim Sandbox-Discard:
 *   `docker compose down -v` (entfernt Container + Networks + Volumes)
 *   bzw. `docker compose down` ohne -v wenn persistDbVolumes=true
 */

export interface ComposeStartInput {
  /** Sandbox-ID, dient als Compose-Project-Name (=Container-Prefix). */
  sandboxId: string;
  /** Worktree-Pfad (enthält User's docker-compose.yml). */
  worktreePath: string;
  /** Name der compose-Datei im Worktree (z.B. 'docker-compose.yml'). */
  composeFile: string;
  /** Pfad ZWO Sandbox-Override-File und State (außerhalb des Repos). */
  sandboxStateDir: string;
  /** Primary-Service-Name aus der compose (z.B. 'app', 'web') — wird als Healthcheck-Target genutzt. */
  primaryService: string;
  /** Host-Port-Mapping für den Primary-Service. */
  primaryHostPort: number;
  /** Container-Port, auf dem der Primary-Service lauscht (z.B. 3000 bei Next). v898.9 */
  primaryContainerPort: number;
  /** Optional: weitere Service-Port-Mappings: serviceName -> { containerPort, hostPort }. */
  extraPortMappings?: Record<string, { containerPort: number; hostPort: number }>;
  /** ENV-Vars die in jeden Service-Container injiziert werden. */
  envVars?: Record<string, string>;
  /** Persist DB-Volumes (true) oder ephemer pro Sandbox (false, default). */
  persistDbVolumes: boolean;
  /** RAM-Floor pro Service in MB (für Resource-Guard). */
  perServiceMb?: number;
  logger: Logger;
}

export interface ComposeStartResult {
  /** Compose-project-name (= sandboxId). */
  projectName: string;
  /** Liste aller gestarteten Container-IDs. */
  containerIds: string[];
  /** Service-Status nach Start (für Diagnose). */
  services: Array<{ name: string; state: string; ports: string[] }>;
}

/**
 * Lese alle Services aus einer compose-Datei via `docker compose config --services`.
 */
export async function listComposeServices(worktreePath: string, composeFile: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--services'],
    { cwd: worktreePath, timeout: 10_000 },
  );
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * Generiere Sandbox-Override-File: setzt Port-Mappings + ENV-Vars + Sandbox-Project-Name.
 * Wird in sandboxStateDir geschrieben (außerhalb des User-Repos).
 */
function generateOverrideFile(input: ComposeStartInput): string {
  const services: Record<string, Record<string, unknown>> = {};

  // Primary-Service: Port-Mapping hostPort → Container-Port (z.B. 9100:3000).
  // v898.9 — vorher host:host (9100:9100) → Preview-Proxy traf einen Port, auf dem
  // im Container nichts lauschte (App auf 3000) → 502 socket hang up.
  services[input.primaryService] = {
    ports: [`${input.primaryHostPort}:${input.primaryContainerPort}`],
  };

  // Extra Service-Mappings (DB, Redis, etc.)
  if (input.extraPortMappings) {
    for (const [svc, mapping] of Object.entries(input.extraPortMappings)) {
      services[svc] = {
        ...(services[svc] ?? {}),
        ports: [`${mapping.hostPort}:${mapping.containerPort}`],
      };
    }
  }

  // ENV-Vars in alle Services injizieren wenn vorhanden
  if (input.envVars && Object.keys(input.envVars).length > 0) {
    for (const svc of Object.keys(services)) {
      services[svc] = {
        ...services[svc],
        environment: { ...(services[svc].environment ?? {}), ...input.envVars },
      };
    }
  }

  const override: Record<string, unknown> = { services };
  // YAML-Serialisierung: pragmatisch via JSON (Compose akzeptiert JSON als gültiges YAML)
  const filePath = path.join(input.sandboxStateDir, 'docker-compose.override.yml');
  fs.mkdirSync(input.sandboxStateDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(override, null, 2));
  return filePath;
}

/**
 * Startet den Compose-Stack. Wirft bei Resource-Mangel oder Compose-Fehler.
 */
export async function startComposeStack(input: ComposeStartInput): Promise<ComposeStartResult> {
  // 1. Liste Services für Resource-Check
  const services = await listComposeServices(input.worktreePath, input.composeFile);
  if (services.length === 0) {
    throw new Error(`Keine Services in ${input.composeFile} gefunden`);
  }
  if (!services.includes(input.primaryService)) {
    throw new Error(`Primary-Service "${input.primaryService}" nicht in compose gefunden. Verfügbar: ${services.join(', ')}`);
  }

  // 2. Resource-Guard
  const resourceCheck = await checkResourcesForCompose({
    serviceCount: services.length,
    perServiceMb: input.perServiceMb,
    logger: input.logger,
  });
  if (!resourceCheck.ok) {
    throw new Error(`Compose-Start blockiert vom Resource-Guard: ${resourceCheck.reason}`);
  }

  // 3. Override-File generieren
  const overridePath = generateOverrideFile(input);
  input.logger.info({ overridePath, sandboxId: input.sandboxId }, 'v849 Compose: override-file generiert');

  // 4. docker compose up -d
  const composePath = path.join(input.worktreePath, input.composeFile);
  const composeArgs = [
    'compose',
    '--project-name', input.sandboxId,
    '-f', composePath,
    '-f', overridePath,
    'up', '-d', '--remove-orphans',
  ];
  try {
    await execFileAsync('docker', composeArgs, {
      cwd: input.worktreePath,
      timeout: 5 * 60_000, // 5min für initialen Pull + Start
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docker compose up failed: ${msg}`);
  }

  // 5. Container-IDs sammeln
  const { stdout: psOut } = await execFileAsync(
    'docker', ['compose', '--project-name', input.sandboxId, 'ps', '-q'],
    { cwd: input.worktreePath, timeout: 10_000 },
  );
  const containerIds = psOut.split('\n').map(s => s.trim()).filter(Boolean);

  // 6. Service-Status für Diagnose
  const { stdout: statusOut } = await execFileAsync(
    'docker', ['compose', '--project-name', input.sandboxId, 'ps', '--format', 'json'],
    { cwd: input.worktreePath, timeout: 10_000 },
  ).catch(() => ({ stdout: '' }));
  const statusServices: ComposeStartResult['services'] = [];
  for (const line of statusOut.split('\n').map(s => s.trim()).filter(Boolean)) {
    try {
      const o = JSON.parse(line) as { Service?: string; State?: string; Publishers?: Array<{ PublishedPort?: number }> };
      statusServices.push({
        name: o.Service ?? '',
        state: o.State ?? 'unknown',
        ports: Array.isArray(o.Publishers) ? o.Publishers.map(p => String(p.PublishedPort ?? '')).filter(Boolean) : [],
      });
    } catch { /* skip malformed line */ }
  }

  input.logger.info({
    sandboxId: input.sandboxId,
    services: statusServices.length,
    containerCount: containerIds.length,
  }, 'v849 Compose: Stack gestartet');

  return { projectName: input.sandboxId, containerIds, services: statusServices };
}

/**
 * Stoppt + cleanup eines Compose-Stacks beim Sandbox-Discard.
 * Wenn `persistVolumes=true`: nur Container weg, Volumes bleiben.
 */
export async function stopComposeStack(
  sandboxId: string,
  worktreePath: string,
  composeFile: string,
  sandboxStateDir: string,
  persistVolumes: boolean,
  logger: Logger,
): Promise<void> {
  const overridePath = path.join(sandboxStateDir, 'docker-compose.override.yml');
  const composePath = path.join(worktreePath, composeFile);
  const args = [
    'compose',
    '--project-name', sandboxId,
    '-f', composePath,
    ...(fs.existsSync(overridePath) ? ['-f', overridePath] : []),
    'down',
    ...(persistVolumes ? [] : ['-v']), // -v entfernt Volumes
    '--remove-orphans',
  ];
  try {
    await execFileAsync('docker', args, {
      cwd: worktreePath,
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    logger.info({ sandboxId, persistVolumes }, 'v849 Compose: Stack gestoppt');
  } catch (err) {
    logger.warn({ err, sandboxId }, 'v849 Compose: stop fehlgeschlagen — möglicherweise schon down');
  }
  // Override-File aufräumen
  try { fs.unlinkSync(overridePath); } catch { /* nicht kritisch */ }
}

/**
 * Health-Check für Primary-Service eines laufenden Compose-Stacks.
 * Polled `docker compose ps` bis primary-service state=running ist.
 */
export async function waitForComposeHealthy(
  sandboxId: string,
  worktreePath: string,
  composeFile: string,
  primaryService: string,
  options: { intervalMs?: number; timeoutMs?: number; logger: Logger },
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const composePath = path.join(worktreePath, composeFile);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['compose', '--project-name', sandboxId, '-f', composePath, 'ps', '--format', 'json'],
        { cwd: worktreePath, timeout: 5_000 },
      );
      for (const line of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
        try {
          const o = JSON.parse(line) as { Service?: string; State?: string; Health?: string };
          if (o.Service === primaryService) {
            const state = o.State ?? '';
            const health = o.Health ?? '';
            // 'running' allein reicht; falls Healthcheck definiert ist, muss er 'healthy' sein
            if (state === 'running' && (health === '' || health === 'healthy')) {
              return true;
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      options.logger.debug({ err, sandboxId }, 'v849 Compose health-check failed (transient)');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  options.logger.warn({ sandboxId, primaryService, timeoutMs }, 'v849 Compose: primary-service did not become healthy in time');
  return false;
}
