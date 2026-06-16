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
 * v902 — Override-File, das die publizierten Host-Ports der Backing-Services
 * entfernt (`ports: !reset []`). Compose merged `ports` sonst additiv, d.h. ein
 * leeres `ports: []` würde die Originale NICHT überschreiben — nur der `!reset`-Tag
 * (Compose Spec ≥ 2.24) setzt die Liste tatsächlich zurück. Wird als YAML (nicht
 * JSON) geschrieben, da JSON den `!reset`-Tag nicht ausdrücken kann.
 */
function generateBackingPortStripOverride(stateDir: string, backingServices: string[]): string {
  const lines: string[] = ['services:'];
  for (const svc of backingServices) {
    lines.push(`  ${svc}:`);
    lines.push('    ports: !reset []');
  }
  const filePath = path.join(stateDir, 'sandbox-backing-override.yml');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
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

/**
 * v899 (Hybrid-Compose, Interactive-Dev) — Nur die BACKING-Services (db/redis …)
 * via Compose hochfahren; der Primary-Service (App) wird NICHT über Compose
 * gestartet, sondern separat als Dev-Container (Bind-Mount + next dev) auf dasselbe
 * Compose-Netz gehängt. Liefert Netz-Namen + die aufgelöste App-Env (v.a.
 * DATABASE_URL = …@db:5432, damit der Dev-Container die DB per Service-Namen
 * erreicht).
 */
export async function startComposeBackingServices(input: {
  sandboxId: string;
  worktreePath: string;
  composeFile: string;
  primaryService: string;
  /** Pfad zum Sandbox-State-Dir (außerhalb des Repos) — für den Port-Strip-Override. */
  sandboxStateDir: string;
  perServiceMb?: number;
  logger: Logger;
}): Promise<{ networkName: string | null; appEnv: Record<string, string>; backingServices: string[] }> {
  const services = await listComposeServices(input.worktreePath, input.composeFile);
  const backing = services.filter(s => s !== input.primaryService);
  const composePath = path.join(input.worktreePath, input.composeFile);

  // App-Env aus aufgelöster Compose-Config lesen (DATABASE_URL etc.)
  const appEnv: Record<string, string> = {};
  try {
    const { stdout } = await execFileAsync(
      'docker', ['compose', '--project-name', input.sandboxId, '-f', composePath, 'config', '--format', 'json'],
      { cwd: input.worktreePath, timeout: 20_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const cfg = JSON.parse(stdout) as { services?: Record<string, { environment?: unknown }> };
    const envRaw = cfg.services?.[input.primaryService]?.environment;
    if (envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)) {
      for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) if (v != null) appEnv[k] = String(v);
    } else if (Array.isArray(envRaw)) {
      for (const item of envRaw) { const s = String(item); const i = s.indexOf('='); if (i > 0) appEnv[s.slice(0, i)] = s.slice(i + 1); }
    }
  } catch (err) {
    input.logger.warn({ err, sandboxId: input.sandboxId }, 'v899 compose config env-extract failed');
  }

  if (backing.length > 0) {
    const rc = await checkResourcesForCompose({ serviceCount: backing.length, perServiceMb: input.perServiceMb, logger: input.logger });
    if (!rc.ok) throw new Error(`Compose-Backing blockiert vom Resource-Guard: ${rc.reason}`);
    // v902 — Host-Port-Strip-Override: Die User-compose published für Backing-Services
    // (z.B. db: 5432:5432) oft feste Host-Ports. In der Sandbox kollidiert das mit der
    // Infra / einer zweiten Sandbox / einem Deploy-Verify ("port is already allocated").
    // Der App-Dev-Container erreicht die DB ohnehin per Service-Namen (db:5432) über das
    // Compose-Netz — der Host-Publish ist hier unnötig. `ports: !reset []` entfernt ihn,
    // ohne die User-compose.yml anzufassen (Deploy nutzt sie ohne diesen Override).
    const portStripOverride = generateBackingPortStripOverride(input.sandboxStateDir, backing);
    const args = ['compose', '--project-name', input.sandboxId, '-f', composePath, '-f', portStripOverride, 'up', '-d', '--remove-orphans', ...backing];
    try {
      await execFileAsync('docker', args, { cwd: input.worktreePath, timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`docker compose up (backing) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Netz-Namen vom ersten Backing-Container ermitteln
  let networkName: string | null = null;
  if (backing.length > 0) {
    try {
      const { stdout: cid } = await execFileAsync('docker', ['compose', '--project-name', input.sandboxId, 'ps', '-q', backing[0]], { cwd: input.worktreePath, timeout: 10_000 });
      const containerId = cid.trim().split('\n').map(s => s.trim()).filter(Boolean)[0];
      if (containerId) {
        const { stdout: net } = await execFileAsync('docker', ['inspect', '--format', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}', containerId], { timeout: 10_000 });
        networkName = net.trim().split(/\s+/).filter(Boolean)[0] ?? null;
      }
    } catch (err) {
      input.logger.warn({ err, sandboxId: input.sandboxId }, 'v899 compose network-discovery failed');
    }
  }
  return { networkName, appEnv, backingServices: backing };
}

/**
 * v899 — Compose-Projekt (Backing-Services + Netz/Volumes) abräumen. Für den
 * Hybrid-Teardown: der App-Dev-Container wird separat per `docker rm` entfernt.
 */
export async function downComposeProject(
  sandboxId: string, worktreePath: string, composeFile: string, persistVolumes: boolean, logger: Logger,
): Promise<void> {
  const composePath = path.join(worktreePath, composeFile);
  const args = ['compose', '--project-name', sandboxId, '-f', composePath, 'down', ...(persistVolumes ? [] : ['-v']), '--remove-orphans'];
  try {
    await execFileAsync('docker', args, { cwd: worktreePath, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
    logger.info({ sandboxId, persistVolumes }, 'v899 compose backing-services gestoppt');
  } catch (err) {
    logger.warn({ err, sandboxId }, 'v899 compose down (backing) fehlgeschlagen — evtl. schon down');
  }
}
