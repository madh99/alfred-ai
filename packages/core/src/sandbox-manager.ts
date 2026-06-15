import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { SandboxConfig, SandboxSessionMode } from '@alfred/types';
import type { SandboxRepository, Sandbox, SandboxInsert, EnvironmentRepository, DbSeedRepository } from '@alfred/storage';
import type { EnvCryptoService } from '@alfred/security';

import { killProcessesByCwd, validateBuild } from '@alfred/skills';
import { createWorktree, destroyWorktree, validateGitRepo } from './sandbox/worktree.js';
import { detectProjectType, type ProjectDetection } from './sandbox/project-detect.js';
import { findFreePort } from './sandbox/port-allocator.js';
import {
  runSandboxContainer,
  stopContainer,
  startContainer,
  removeContainer,
  waitForDevServer,
  ensureImage,
  getContainerStatus,
  getContainerStats,
  runContainerCommand,
} from './sandbox/docker.js';
// v849 — Compose-Stack-Support
import { startComposeStack, stopComposeStack, waitForComposeHealthy, listComposeServices } from './sandbox/compose-runner.js';

const execFileAsync = promisify(execFile);

export interface SandboxManagerDeps {
  config: SandboxConfig;
  repo: SandboxRepository;
  logger: Logger;
  nodeId: string;
  /** Pfad zu den Sandbox-Dockerfiles. Wenn null/undefined wird relativ zum Bundle gesucht. */
  dockerfilesDir?: string;
  /** v726 — Optional: für ENV-Injection beim Container-Start. */
  envRepo?: EnvironmentRepository;
  envCrypto?: EnvCryptoService;
  /** v726 — Optional: für DB-Seed beim Container-Start. */
  dbSeedRepo?: DbSeedRepository;
  /** v726 — Pfad in dem Upload-Seeds liegen (z.B. /var/alfred/seeds/). */
  uploadSeedsPath?: string;
  /** v755 — Optional: Lookup-Callback für Per-Project-Quota. Liefert maxConcurrentSandboxes oder null. */
  projectQuotaLookup?: (projectId: string) => Promise<number | null>;
  /**
   * v849 — Optional: Project-Repository für sandbox_mode-Lookup.
   * Wenn gesetzt: Sandboxen werden im compose-Mode gestartet wenn das Projekt
   * `sandboxMode='compose'` hat UND ein docker-compose.yml im Worktree liegt.
   * Wenn null: alle Sandboxen im single-mode (pre-v849 Verhalten).
   */
  projectRepo?: { getById: (userId: string, id: string) => Promise<{ sandboxMode?: 'single' | 'compose'; persistDbVolumes?: boolean; dbSeedStrategy?: string } | null> };
  /**
   * v812 — Wird nach erfolgreichem Merge gerufen: bestätigt die pending Projekt-
   * Sessions dieser Sandbox ('merged'), löst den OpenItemMatcher gegen den
   * gemergten Diff aus und schreibt Workspace-Memory + "applied"-Chat.
   */
  onMergeApplied?: (input: { sandboxId: string; projectId: string; mergedSha?: string }) => Promise<void>;
  /**
   * v812 — Wird beim Discard/Destroy gerufen: markiert die pending Sessions als
   * 'discarded' (bleiben für Arbeitszeit-Statistik) und löscht deren tentativ
   * angelegte Open-Items + Decisions (Arbeit wurde nicht angewendet).
   */
  onSandboxDiscarded?: (input: { sandboxId: string; projectId: string }) => Promise<void>;
  /**
   * v825 — Wird beim Merge-Gate-Failure (Tests fehlgeschlagen) gerufen damit der
   * Conventions-Lessons-Loop daraus eine Erkenntnis ableiten + persistieren kann.
   * Test-Output ist ANSI-stripped + via summarizeTestFailure verkürzt.
   */
  onMergeGateFailed?: (input: { sandboxId: string; projectId: string; testSummary: string; rawOutputTail: string }) => Promise<void>;
}

export interface CreateForSessionInput {
  /** Optional ab v703: Sandbox kann auch ohne Session existieren (z.B. Interactive-Mode-Standalone). */
  sessionId?: string | null;
  projectId: string;
  userId: string;
  /** Pfad zum Main-Repo des Projekts (= projects.cwd). */
  projectCwd: string;
  /** sandbox | sandbox-preview | interactive-chat — classic kommt hier nicht durch. */
  mode: SandboxSessionMode;
  /** Slug für branch-name (z.B. aus session-goal). */
  slug?: string;
  /** v726 — Welche ENV-Stage aus project_environments soll geladen werden? Default: 'sandbox'. */
  envStage?: string;
  /** v726 — DB-Seed-Variante. Default: 'empty' (App muss selbst migrations laufen). */
  dbSeed?: { kind: 'empty' } | { kind: 'repo_path'; path: string } | { kind: 'upload'; seedId: string };
}

export interface CreateForSessionResult {
  sandbox: Sandbox;
  detection: ProjectDetection;
  /** True wenn ein Container hochgefahren wurde (sandbox-preview / interactive-chat). False bei sandbox-only. */
  containerStarted: boolean;
}

/**
 * v696 (Foundation) + v697 (Lifecycle) — Project-Agent Sandbox-Manager.
 *
 * Verantwortlich für den vollen Lebenszyklus einer Sandbox:
 *  - createForSession()  → Worktree + (optional Container) + DB-Eintrag
 *  - pause() / resume()
 *  - merge() / discard()
 *  - destroy() (manueller Cleanup)
 *
 * Wichtig: solange `isAvailable() === false` darf der Runner den Manager NIE
 * aufrufen — Default-Verhalten muss classic bleiben.
 */
export class SandboxManager {
  private docker_available = false;
  private worktreeBaseWritable = false;
  private healthCheckedAt?: string;
  private dockerfilesDir: string;

  constructor(private readonly deps: SandboxManagerDeps) {
    this.dockerfilesDir = deps.dockerfilesDir ?? resolveDockerfilesDir();
  }

  /**
   * Startup-Health-Check: prüft Docker-Daemon + Worktree-Base-Pfad.
   * Setzt interne Flags. Wird einmalig in alfred.ts beim Init aufgerufen.
   */
  async runHealthCheck(): Promise<{ dockerAvailable: boolean; worktreeBaseWritable: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    try {
      await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
      this.docker_available = true;
    } catch (err) {
      this.docker_available = false;
      reasons.push(`docker not available: ${(err as Error).message.slice(0, 120)}`);
    }

    const base = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
    try {
      if (!existsSync(base)) {
        try { mkdirSync(base, { recursive: true }); } catch (err) {
          reasons.push(`cannot create worktree base ${base}: ${(err as Error).message}`);
        }
      }
      if (existsSync(base)) {
        const s = statSync(base);
        if (!s.isDirectory()) { reasons.push(`worktree base ${base} is not a directory`); }
        else { this.worktreeBaseWritable = true; }
      }
    } catch (err) {
      reasons.push(`worktree base check failed: ${(err as Error).message}`);
    }

    this.healthCheckedAt = new Date().toISOString();
    this.deps.logger.info(
      { dockerAvailable: this.docker_available, worktreeBaseWritable: this.worktreeBaseWritable, reasons, dockerfilesDir: this.dockerfilesDir },
      'SandboxManager health-check completed',
    );
    return { dockerAvailable: this.docker_available, worktreeBaseWritable: this.worktreeBaseWritable, reasons };
  }

  isAvailable(): boolean {
    return Boolean(this.deps.config.enabled) && this.docker_available && this.worktreeBaseWritable;
  }

  getStatus(): {
    enabled: boolean;
    available: boolean;
    dockerAvailable: boolean;
    worktreeBaseWritable: boolean;
    healthCheckedAt?: string;
    defaultMode: string;
    defaultMergeStrategy: string;
    dockerfilesDir: string;
    /** v739 — Limits für Frontend-Quota-Display */
    maxParallelPerUser: number;
    diskQuotaPerUserMb: number;
    idleTimeoutMin: number;
  } {
    return {
      enabled: Boolean(this.deps.config.enabled),
      available: this.isAvailable(),
      dockerAvailable: this.docker_available,
      worktreeBaseWritable: this.worktreeBaseWritable,
      healthCheckedAt: this.healthCheckedAt,
      defaultMode: this.deps.config.defaultMode ?? 'classic',
      defaultMergeStrategy: this.deps.config.defaultMergeStrategy ?? 'pr',
      dockerfilesDir: this.dockerfilesDir,
      maxParallelPerUser: this.deps.config.maxParallelPerUser ?? 3,
      diskQuotaPerUserMb: this.deps.config.diskQuotaPerUserMb ?? 5120,
      idleTimeoutMin: this.deps.config.idleTimeoutMin ?? 30,
    };
  }

  async checkUserQuota(userId: string, projectId?: string): Promise<string | null> {
    const max = this.deps.config.maxParallelPerUser ?? 3;
    const active = await this.deps.repo.listActiveByUser(userId);
    if (active.length >= max) {
      return `Max parallele Sandboxes (${max}) erreicht. Bitte erst eine pausieren oder verwerfen.`;
    }
    const quotaMb = this.deps.config.diskQuotaPerUserMb ?? 5120;
    const used = await this.deps.repo.getActiveDiskUsageMb(userId);
    if (used >= quotaMb) {
      return `Disk-Quota (${quotaMb} MB) erreicht — aktuell belegt: ${used} MB.`;
    }
    // v755 — Per-Project-Quota (zusätzlich zur User-Quota)
    if (projectId && this.deps.projectQuotaLookup) {
      try {
        const projectMax = await this.deps.projectQuotaLookup(projectId);
        if (typeof projectMax === 'number' && projectMax > 0) {
          const activeInProject = await this.deps.repo.listByProject(projectId, ['creating', 'running', 'paused']);
          if (activeInProject.length >= projectMax) {
            return `Project-Quota (${projectMax}) erreicht — aktuell aktiv: ${activeInProject.length}. Bitte erst eine Sandbox dieses Projekts pausieren oder verwerfen.`;
          }
        }
      } catch { /* lookup-Fehler ist nicht fatal — falle auf User-Quota zurück */ }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v697 — Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * v708 — Erstellt eine neue Sandbox für eine Session.
   *
   * **Phase 1 (sync)**: Pre-Checks, Worktree-Create, Project-Type-Detect, DB-Insert
   *   → returnt sofort mit `sandbox` (status='creating'). Dauer ~1-3s.
   *
   * **Phase 2 (async, fire-and-forget)**: Image-Build (falls fehlend), Port-Allocation,
   *   Container-Run, waitForDevServer. Updates DB-Status während Lauf:
   *   - phase=building-image → image gerade gebaut (1-3 min, nur 1x)
   *   - phase=starting-container → docker run abgesetzt
   *   - phase=installing-deps → container läuft, npm install ist gang
   *   - status=running am Ende ODER status=failed bei Fehler
   *
   * Frontend pollt /api/sandbox/:id und zeigt status_reason als Progress.
   * Bei jedem Fehler: Rollback (Container weg, Worktree weg, DB-Status='failed').
   */
  async createForSession(input: CreateForSessionInput): Promise<CreateForSessionResult> {
    if (!this.isAvailable()) {
      throw new Error('SandboxManager not available (disabled, no docker, or worktree-base not writable)');
    }
    if (input.mode === 'classic') {
      throw new Error('createForSession called with classic mode — should not happen');
    }
    const quotaIssue = await this.checkUserQuota(input.userId, input.projectId);
    if (quotaIssue) throw new Error(quotaIssue);

    const gitCheck = await validateGitRepo(input.projectCwd);
    if (!gitCheck.ok) throw new Error(`Project not a git repo: ${gitCheck.reason}`);

    const wantsContainer = input.mode === 'sandbox-preview' || input.mode === 'interactive-chat';

    // Pfad + Branch ableiten — sessionId optional: nutze frischen UUID-Prefix bei standalone
    const sid8 = input.sessionId ? input.sessionId.slice(0, 8) : `i${Date.now().toString(36).slice(-7)}`;
    const slug = (input.slug ?? (input.sessionId ? 'session' : 'interactive')).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24).toLowerCase();
    const branchName = `agent-${sid8}-${slug}`;
    const baseDir = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
    const worktreePath = path.join(baseDir, input.projectId, sid8);

    // Phase 1a — Worktree (sync, ~1s)
    const wt = await createWorktree({
      projectCwd: input.projectCwd,
      branchName,
      worktreePath,
      logger: this.deps.logger,
    });

    // Phase 1b — Project-Type-Detect
    const detection = detectProjectType(wt.worktreePath);
    this.deps.logger.info({ detection, sessionId: input.sessionId }, 'Project-Type detected');

    // v849 — sandboxMode aus dem Project. Default 'single' damit Bestand unangetastet bleibt.
    // Compose-Mode wird strict opt-in über project.sandboxMode='compose' aktiviert
    // (UI-Toggle in Project-Settings). Plus: compose-File MUSS vorhanden sein.
    let composeMode = false;
    let composeFile: string | undefined;
    let diagSandboxMode: string | undefined; // v898.7 Diagnose
    let diagLookupErr: string | undefined;
    if (this.deps.projectRepo && input.projectId) {
      try {
        // Project-User auflösen — wir brauchen master-user-id für getById
        const proj = await this.deps.projectRepo.getById(input.userId, input.projectId);
        diagSandboxMode = proj?.sandboxMode;
        if (proj?.sandboxMode === 'compose') {
          if (detection.hasComposeFile && detection.composeFile) {
            composeMode = true;
            composeFile = detection.composeFile;
          } else {
            this.deps.logger.warn(
              { projectId: input.projectId, sessionId: input.sessionId },
              'Project sandboxMode=compose aktiv aber kein docker-compose.yml im Worktree — fallback to single-container',
            );
          }
        }
      } catch (err) {
        diagLookupErr = err instanceof Error ? err.message : String(err);
        this.deps.logger.debug({ err, projectId: input.projectId }, 'v849: Project lookup failed, fallback to single-container');
      }
    }
    // v898.7 — Diagnose ins Journal (pino-Logs erscheinen dort nicht): zeigt exakt,
    // warum compose vs single gewählt wurde. Temporär bis die Ursache geklärt ist.
    try {
      // eslint-disable-next-line no-console
      console.warn(`[sandbox-compose] projectId=${input.projectId ?? 'NONE'} projectRepoWired=${!!this.deps.projectRepo} sandboxMode=${diagSandboxMode ?? 'undef'} hasComposeFile=${detection.hasComposeFile} composeFile=${detection.composeFile ?? '-'} lookupErr=${diagLookupErr ?? '-'} mode=${input.mode} -> composeMode=${composeMode}`);
    } catch { /* */ }

    // Phase 1c — DB-Insert
    const image = this.deps.config.containerImage ?? 'alfred-sandbox:node-22';
    const sandbox = await this.deps.repo.create({
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      userId: input.userId,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      baseCommitSha: wt.baseCommitSha,
      containerImage: image,
      internalPort: detection.internalPort || 3000,
      projectType: detection.type,
      nodeId: this.deps.nodeId,
      status: 'creating',
    });

    // Wenn kein Container gewünscht (sandbox-only): direkt running setzen + return
    if (!wantsContainer || !detection.hasDevServer) {
      if (wantsContainer && !detection.hasDevServer) {
        this.deps.logger.warn({ sessionId: input.sessionId, projectType: detection.type }, 'Mode requested preview but project has no dev-server → fallback to sandbox-only');
      }
      // v817 — markResumed setzt last_resumed_at damit der Live-Counter ab jetzt zählt.
      await this.deps.repo.markResumed(sandbox.id);
      if (wantsContainer && !detection.hasDevServer) {
        await this.deps.repo.updateStatus(sandbox.id, 'running', 'no-dev-server-script');
      }
      return { sandbox, detection, containerStarted: false };
    }

    // Phase 2 — Container-Start ASYNC starten (nicht awaited!) damit createForSession sofort returnt
    // v849 — Routing: compose-Mode → eigener Pfad, sonst Single-Container (Status quo)
    if (composeMode && composeFile) {
      void this.spinUpComposeAsync({
        sandboxId: sandbox.id,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        projectCwd: input.projectCwd,
        detection,
        projectId: input.projectId,
        userId: input.userId,
        composeFile,
      });
    } else {
      void this.spinUpContainerAsync({
        sandboxId: sandbox.id,
        image,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        projectCwd: input.projectCwd,
        detection,
        projectId: input.projectId,
        envStage: input.envStage ?? 'sandbox',
        dbSeed: input.dbSeed ?? { kind: 'empty' },
      });
    }

    // Phase 1 returnt sofort — Frontend pollt /api/sandbox/:id für Progress
    return { sandbox, detection, containerStarted: false };
  }

  /**
   * v849 — Async-Pfad für Compose-Stack-Sandboxen.
   * Parallel zu spinUpContainerAsync, nutzt User's docker-compose.yml + Override.
   */
  private async spinUpComposeAsync(opts: {
    sandboxId: string;
    worktreePath: string;
    branchName: string;
    projectCwd: string;
    detection: ProjectDetection;
    projectId: string;
    userId: string;
    composeFile: string;
  }): Promise<void> {
    try {
      await this.deps.repo.updateStatus(opts.sandboxId, 'creating', 'compose-stack: services starten');

      // 1. Project-Settings für Volume-Strategie holen
      let persistDbVolumes = false;
      try {
        const proj = await this.deps.projectRepo?.getById(opts.userId, opts.projectId);
        persistDbVolumes = Boolean(proj?.persistDbVolumes);
      } catch { /* default false */ }

      // 2. Primary-Service-Port allokieren (gleicher Slot wie single-mode)
      const portStart = this.deps.config.hostPortRangeStart ?? 9100;
      const portEnd = this.deps.config.hostPortRangeEnd ?? 9199;
      const hostPort = await findFreePort(portStart, portEnd, this.deps.repo);

      // 3. Primary-Service ableiten aus detection (web/app) oder erstem Service in compose
      const services = await listComposeServices(opts.worktreePath, opts.composeFile);
      const primaryService = services.find(s => /^(app|web|frontend|client|api)$/i.test(s)) ?? services[0];
      if (!primaryService) {
        throw new Error('Kein primary-service in compose erkennbar (versuche: app, web, frontend, client, api)');
      }

      // 4. Sandbox-State-Dir für Override-File (außerhalb des User-Repos)
      const stateBase = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
      const sandboxStateDir = path.join(stateBase, '.sandbox-state', opts.sandboxId);

      // 5. Compose-Stack starten
      const result = await startComposeStack({
        sandboxId: opts.sandboxId,
        worktreePath: opts.worktreePath,
        composeFile: opts.composeFile,
        sandboxStateDir,
        primaryService,
        primaryHostPort: hostPort,
        envVars: { NODE_ENV: 'development' },
        persistDbVolumes,
        logger: this.deps.logger,
      });

      // 6. Primary-Container-ID + hostPort persistieren
      const primaryContainerId = result.containerIds[0] ?? '';
      await this.deps.repo.setContainerInfo(opts.sandboxId, primaryContainerId, hostPort);
      await this.deps.repo.updateStatus(opts.sandboxId, 'creating', `compose: ${result.services.length} Services gestartet, warte auf health`);

      // 7. Health-Wait auf primary-service
      const healthy = await waitForComposeHealthy(opts.sandboxId, opts.worktreePath, opts.composeFile, primaryService, {
        intervalMs: 2000,
        timeoutMs: 5 * 60_000,
        logger: this.deps.logger,
      });
      if (!healthy) {
        throw new Error(`compose primary-service "${primaryService}" did not become healthy in 5 minutes`);
      }

      await this.deps.repo.markResumed(opts.sandboxId);
      this.deps.logger.info({ sandboxId: opts.sandboxId, hostPort, services: result.services.length }, 'v849 Compose-Sandbox ready');
    } catch (err) {
      this.deps.logger.error({ err, sandboxId: opts.sandboxId }, 'v849 Compose-Sandbox spinUp failed');
      // Cleanup: compose stoppen + state-dir entfernen
      try {
        const stateBase = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
        const sandboxStateDir = path.join(stateBase, '.sandbox-state', opts.sandboxId);
        await stopComposeStack(opts.sandboxId, opts.worktreePath, opts.composeFile, sandboxStateDir, false, this.deps.logger);
      } catch { /* cleanup-effort */ }
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.repo.updateStatus(opts.sandboxId, 'failed', `compose-start failed: ${msg.slice(0, 200)}`);
    }
  }

  /**
   * v708 — Async Phase 2: Image sicherstellen + Container starten + Health-Wait.
   * Aktualisiert DB-Status mit beschreibendem status_reason für UI-Progress.
   * Bei Fehler: vollständiger Rollback wie vorher (Container + Worktree weg).
   */
  private async spinUpContainerAsync(opts: {
    sandboxId: string;
    image: string;
    worktreePath: string;
    branchName: string;
    projectCwd: string;
    detection: ProjectDetection;
    projectId: string;
    envStage: string;
    dbSeed: { kind: 'empty' } | { kind: 'repo_path'; path: string } | { kind: 'upload'; seedId: string };
  }): Promise<void> {
    const { sandboxId, image, worktreePath, branchName, projectCwd, detection, projectId, envStage, dbSeed } = opts;
    try {
      // Status: image preparation
      await this.deps.repo.updateStatus(sandboxId, 'creating', 'building-image: pulled+built docker image (kann 1-3min beim 1. Mal dauern)');
      await ensureImage({ image, dockerfilesDir: this.dockerfilesDir, logger: this.deps.logger });

      // Status: port-allocation + container-run
      await this.deps.repo.updateStatus(sandboxId, 'creating', 'starting-container: Docker-Container startet');
      const portStart = this.deps.config.hostPortRangeStart ?? 9100;
      const portEnd = this.deps.config.hostPortRangeEnd ?? 9199;
      const hostPort = await findFreePort(portStart, portEnd, this.deps.repo);

      // v726 — ENV-Variablen aus project_environments laden (decrypten) + .env.local schreiben
      const projectEnvs = await this.loadProjectEnvironments(projectId, envStage);
      if (Object.keys(projectEnvs).length > 0) {
        try {
          const envLocalPath = path.join(worktreePath, '.env.local');
          const { writeFileSync } = await import('node:fs');
          const lines = Object.entries(projectEnvs).map(([k, v]) => `${k}=${v}`);
          writeFileSync(envLocalPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
          this.deps.logger.info({ sandboxId, stage: envStage, count: lines.length }, 'v726 .env.local written to worktree');
        } catch (err) {
          this.deps.logger.warn({ err, sandboxId }, 'v726 .env.local write failed (continuing with -e flags only)');
        }
      }

      // v726 — DB-Seed bereitstellen (in worktree-relativen Pfad ALFRED_DATA_DIR=/workspace/.alfred-data)
      await this.prepareSandboxDataDir(worktreePath, dbSeed, projectCwd);

      const containerName = `alfred-sandbox-${sandboxId.slice(0, 8)}`;
      const binds: Array<{ host: string; container: string; readOnly?: boolean }> = [
        { host: worktreePath, container: '/workspace' },
      ];
      const pnpmStore = this.deps.config.pnpmStorePath;
      if (pnpmStore) binds.push({ host: pnpmStore, container: '/pnpm-store' });

      // v758 — Native Module für Container-OS rebuilden. Wenn der Host glibc ist und
      // node_modules schon mit Host-Binaries existiert (via bind-mount), würde pnpm install
      // sagen "alles da" und die musl-inkompatiblen Bindings (z.B. better-sqlite3) belassen.
      // `pnpm rebuild` triggert Postinstall-Scripts → prebuild-Downloads für Alpine/musl.
      const pm = detection.diagnostics.packageManager;
      const installCmd = `${pm} install`;
      const rebuildCmd = `${pm} rebuild`;
      const devCmd = detection.devCommand.join(' ');
      const fullCmd = `${installCmd} && ${rebuildCmd} && exec ${devCmd}`;

      // v726 — Project-ENVs + Default-ENVs zusammenführen. Defaults dürfen NICHT von Project überschrieben werden? Doch — Project hat Vorrang (user-controlled).
      // v837 — Resource-Limits + NODE_OPTIONS aus Config. Hardcoded 2GB war zu wenig
      // für tsc/vitest auf größeren Monorepos (V8 SIGABRT bei ~1.4GB Heap-Default).
      const memoryMb = this.deps.config.memoryMb ?? 6144;
      const cpus = this.deps.config.cpus ?? 2;
      const nodeHeapMb = this.deps.config.nodeMaxOldSpaceSizeMb ?? Math.floor(memoryMb * 0.67);
      const containerEnvs: Record<string, string> = {
        CI: '',
        NODE_ENV: 'development',
        ALFRED_DATA_DIR: '/workspace/.alfred-data',
        // v837 — Node V8 Heap explizit setzen. Sonst Default ~1.4GB egal wie groß der Container ist.
        NODE_OPTIONS: `--max-old-space-size=${nodeHeapMb}`,
        ...projectEnvs,
      };

      const containerId = await runSandboxContainer({
        image,
        name: containerName,
        workdir: '/workspace',
        binds,
        envVars: containerEnvs,
        ports: [[hostPort, detection.internalPort]],
        memoryMb,
        cpus,
        command: ['sh', '-c', `"${fullCmd}"`],
        restartPolicy: 'no',
        logger: this.deps.logger,
      });
      this.deps.logger.info({ sandboxId, memoryMb, cpus, nodeHeapMb }, 'v837 sandbox container resource-limits set');

      await this.deps.repo.setContainerInfo(sandboxId, containerId, hostPort);
      await this.deps.repo.updateStatus(sandboxId, 'creating', `installing-deps: ${installCmd} läuft, danach dev-server (port ${detection.internalPort})`);

      // Health-Wait (kann lange dauern wegen npm install)
      const healthy = await waitForDevServer(hostPort, {
        intervalMs: 2000,
        timeoutMs: 5 * 60 * 1000,
        logger: this.deps.logger,
      });
      if (!healthy) {
        throw new Error('dev-server did not become healthy within 5 minutes (npm install or dev start failed — check `sudo docker logs ' + containerName + '` for details)');
      }

      // v817 — markResumed setzt last_resumed_at für Live-Counter
      await this.deps.repo.markResumed(sandboxId);
      this.deps.logger.info({ sandboxId, hostPort, containerId }, 'v708 Sandbox container ready');
    } catch (err) {
      this.deps.logger.error({ err, sandboxId }, 'Sandbox spinUp failed (async), capturing logs + rolling back');
      // v709 — Container-Logs (letzte 50 Zeilen) capturen BEVOR removeContainer ausgeführt wird,
      // sonst sind die Logs für immer weg und Diagnose unmöglich.
      const sb = await this.deps.repo.getById(sandboxId);
      let logTail = '';
      if (sb?.containerId) {
        try {
          const { execFile: ef } = await import('node:child_process');
          const { promisify: pr } = await import('node:util');
          const efa = pr(ef);
          const { stdout: out, stderr: errOut } = await efa('docker', ['logs', '--tail', '50', sb.containerId], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
          logTail = (out + '\n' + errOut).trim();
        } catch (logErr) {
          this.deps.logger.warn({ logErr, sandboxId }, 'docker logs capture failed (continuing rollback)');
        }
      }
      const baseReason = (err as Error).message.slice(0, 250);
      const fullReason = logTail
        ? `${baseReason}\n\n=== Container-Logs (letzte 50 Zeilen) ===\n${logTail.slice(-2000)}`
        : baseReason;
      await this.deps.repo.updateStatus(sandboxId, 'failed', fullReason);
      if (sb?.containerId) {
        try { await removeContainer(sb.containerId, true); } catch { /* ignore */ }
      }
      try {
        await destroyWorktree({
          projectCwd,
          worktreePath,
          branchName,
          deleteBranch: true,
          force: true,
          logger: this.deps.logger,
        });
      } catch { /* ignore */ }
    }
  }

  /** Container stoppen, Worktree bleibt. Status = paused. */
  async pause(sandboxId: string): Promise<void> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
    if (sb.status !== 'running') {
      this.deps.logger.debug({ sandboxId, status: sb.status }, 'pause called on non-running sandbox — no-op');
      return;
    }
    if (sb.containerId) {
      await stopContainer(sb.containerId, 10);
    }
    // v817 — markPaused statt updateStatus: addiert (now - last_resumed_at) zu
    // total_run_seconds + setzt last_paused_at für UI-Anzeige.
    await this.deps.repo.markPaused(sandboxId, 'user-requested');
  }

  /** Pausierten Container neu starten. */
  async resume(sandboxId: string): Promise<void> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);
    if (sb.status !== 'paused') {
      throw new Error(`Cannot resume sandbox in status: ${sb.status}`);
    }
    if (!sb.containerId) {
      throw new Error('Cannot resume sandbox without container_id — was discarded, please re-create');
    }
    const status = await getContainerStatus(sb.containerId);
    if (status === null) {
      throw new Error('Container no longer exists — please discard and re-create the sandbox');
    }
    await startContainer(sb.containerId);
    if (sb.hostPort) {
      const healthy = await waitForDevServer(sb.hostPort, { intervalMs: 1500, timeoutMs: 60_000, logger: this.deps.logger });
      if (!healthy) throw new Error('dev-server did not respond after resume');
    }
    // v817 — markResumed statt updateStatus: setzt last_resumed_at für Live-Counter.
    await this.deps.repo.markResumed(sandboxId);
  }

  /**
   * v728 — Restart: Container stoppen + .next/-Build-Cache im Worktree löschen + Container starten.
   * Heilt den .next/ENOENT-Bug wenn Production-Build versehentlich den dev-server-cache überschrieben hat.
   * NUR `.next/` wird gelöscht — andere Worktree-Files (Code, node_modules) bleiben.
   */
  async restart(sandboxId: string): Promise<{ ok: boolean; reason?: string }> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return { ok: false, reason: 'Sandbox not found' };
    if (!sb.containerId) return { ok: false, reason: 'Sandbox has no container_id' };
    try {
      await this.deps.repo.updateStatus(sandboxId, 'creating', 'restart: stopping container');
      await stopContainer(sb.containerId, 10);
      // .next/ aus dem worktree entfernen (außerhalb des Containers, sonst NFS-Lock-Probleme)
      try {
        const dotNextPath = path.join(sb.worktreePath, '.next');
        if (existsSync(dotNextPath)) {
          const { rmSync } = await import('node:fs');
          rmSync(dotNextPath, { recursive: true, force: true, maxRetries: 3 });
          this.deps.logger.info({ sandboxId, dotNextPath }, 'v728 restart: .next/ removed');
        }
      } catch (err) {
        this.deps.logger.warn({ err, sandboxId }, 'v728 restart: .next/ removal failed (continuing)');
      }
      await this.deps.repo.updateStatus(sandboxId, 'creating', 'restart: starting container');
      await startContainer(sb.containerId);
      if (sb.hostPort) {
        const healthy = await waitForDevServer(sb.hostPort, { intervalMs: 1500, timeoutMs: 120_000, logger: this.deps.logger });
        if (!healthy) {
          await this.deps.repo.markPaused(sandboxId, 'restart: dev-server did not respond');
          return { ok: false, reason: 'dev-server did not respond within 2 minutes' };
        }
      }
      // v817 — markResumed: Restart akkumuliert die vorherige Running-Zeit (war ja
      // im Container am laufen) und setzt last_resumed_at = now für den nächsten
      // Abschnitt. updateStatus mit 'restart: ok' war Status-Hinweis; markResumed
      // setzt status='running' und clear statusReason.
      await this.deps.repo.markResumed(sandboxId);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      this.deps.logger.error({ err, sandboxId }, 'v728 restart failed');
      await this.deps.repo.updateStatus(sandboxId, 'paused', `restart-error: ${msg.slice(0, 200)}`);
      return { ok: false, reason: msg };
    }
  }

  /** v728 — Liefert die letzten N Zeilen aus dem Sandbox-Container-Log. */
  async getLogs(sandboxId: string, tail = 200): Promise<{ ok: boolean; logs?: string; reason?: string }> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return { ok: false, reason: 'Sandbox not found' };
    if (!sb.containerId) return { ok: false, reason: 'Sandbox has no container' };
    const { getContainerLogs } = await import('./sandbox/docker.js');
    const logs = await getContainerLogs(sb.containerId, tail);
    return { ok: true, logs };
  }

  /**
   * v810 — dev-server-stdout für einen Worktree-cwd (für den Project-Agent-Fix-Loop).
   * Findet die Sandbox über den Worktree-Pfad und liefert die Container-Logs.
   * Null wenn keine Sandbox/Container — der Runner behandelt das als "kein Kontext".
   */
  async getDevServerLog(worktreePath: string, tail = 120): Promise<string | null> {
    try {
      const sb = await this.deps.repo.getByWorktreePath(worktreePath);
      if (!sb?.containerId) return null;
      const { getContainerLogs } = await import('./sandbox/docker.js');
      return await getContainerLogs(sb.containerId, tail);
    } catch (err) {
      this.deps.logger.debug({ err, worktreePath }, 'v810 getDevServerLog failed');
      return null;
    }
  }

  /**
   * v810 — Snapshot der dev-server-Logs auf Platte BEVOR der Container entfernt wird.
   * Überlebt den Discard → Post-Mortem-Debugging möglich (vorher: docker logs weg
   * sobald der Container gelöscht ist, Crash-Ursache unwiederbringlich verloren).
   */
  private async snapshotDevServerLog(sb: Sandbox): Promise<void> {
    if (!sb.containerId) return;
    try {
      const { getContainerLogs } = await import('./sandbox/docker.js');
      const logs = await getContainerLogs(sb.containerId, 2000);
      if (!logs?.trim()) return;
      const base = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
      const logDir = path.join(path.dirname(base), 'sandbox-devserver-logs');
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(logDir, `${sb.id}_${ts}.log`);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, logs, { mode: 0o644 });
      this.deps.logger.info({ sandboxId: sb.id, file }, 'v810 dev-server log snapshotted before teardown');
    } catch (err) {
      this.deps.logger.debug({ err, sandboxId: sb.id }, 'v810 snapshotDevServerLog failed (non-fatal)');
    }
  }

  /** v728 — Container-Stats (CPU, RAM, Status, Uptime). */
  async getStats(sandboxId: string): Promise<{
    ok: boolean;
    stats?: { ramMb: number | null; cpuPct: number | null; status: string | null; createdAt: string; hostPort: number | null; image: string };
    reason?: string;
  }> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return { ok: false, reason: 'Sandbox not found' };
    if (!sb.containerId) return { ok: false, reason: 'Sandbox has no container' };
    const liveStats = await getContainerStats(sb.containerId);
    const status = await getContainerStatus(sb.containerId);
    return {
      ok: true,
      stats: {
        ramMb: liveStats.ramMb,
        cpuPct: liveStats.cpuPct,
        status,
        createdAt: sb.createdAt,
        hostPort: sb.hostPort,
        image: sb.containerImage,
      },
    };
  }

  /**
   * Discard: Container + Worktree + Branch komplett entfernen, DB markiert als 'discarded'.
   */
  /**
   * v810 — Host-Prozesse killen die den Worktree als cwd halten, BEVOR er entfernt
   * wird. Sonst scheitert `git worktree remove` mit "Directory not empty" (z.B.
   * verwaiste `npx vitest`-Prozesse die der Coding-Agent gestartet hat und die den
   * Abort überlebt haben). Container ist zu diesem Zeitpunkt bereits gestoppt.
   */
  private killWorktreeHolders(worktreePath: string): void {
    try {
      const n = killProcessesByCwd(worktreePath, 'SIGKILL');
      if (n > 0) this.deps.logger.info({ worktreePath, killed: n }, 'v810 killed leftover processes holding worktree');
    } catch (err) {
      this.deps.logger.debug({ err, worktreePath }, 'v810 killWorktreeHolders failed (non-fatal)');
    }
  }

  /** v812 — Merge bestätigt: Projekt-Sessions dieser Sandbox übernehmen (Callback). */
  private async fireMergeApplied(sb: Sandbox, mergedSha?: string): Promise<void> {
    if (!this.deps.onMergeApplied) return;
    try {
      await this.deps.onMergeApplied({ sandboxId: sb.id, projectId: sb.projectId, mergedSha });
    } catch (err) {
      this.deps.logger.warn({ err, sandboxId: sb.id }, 'v812 onMergeApplied callback failed (non-fatal)');
    }
  }

  /**
   * v813 — Owner-User des Worktrees per stat-uid → /etc/passwd auflösen. Wird für
   * Merge-Gate-Tests gebraucht (sudo -u <owner> npm test im Worktree, damit der
   * Run als der korrekte User läuft den auch der Coding-Agent benutzt hat).
   * Liefert undefined wenn root (kein sudo nötig) oder Lookup fehlschlägt.
   */
  private getWorktreeOwner(worktreePath: string): string | undefined {
    try {
      const uid = statSync(worktreePath).uid;
      if (uid === 0) return undefined;
      const passwd = readFileSync('/etc/passwd', 'utf8');
      const line = passwd.split('\n').find((l) => l.split(':')[2] === String(uid));
      if (line) return line.split(':')[0];
    } catch { /* */ }
    return undefined;
  }

  /**
   * v813b — Merge-Gate: `npm rebuild` (re-glibc der Native-Bindings auf dem Host —
   * der Container hatte sie auf musl umgestempelt) + `npm test` im Worktree als
   * Owner-User. Stop bei erstem non-zero → Merge wird abgelehnt mit Output-Tail.
   *
   * Skippt sauber wenn (a) keine package.json, (b) kein test-Script, (c) test
   * ist nur `echo`-Stub. Container muss vor dem Aufruf gestoppt sein damit kein
   * konkurrierender `npm rebuild` im Container den State wieder auf musl kippt.
   */
  private async runMergeGateTests(sb: Sandbox, sandboxId?: string): Promise<{ ok: boolean; skipped?: boolean; output: string; reason?: string }> {
    let hasTest = false;
    let packageManagerInstall = 'npm rebuild';
    try {
      const pkgPath = path.join(sb.worktreePath, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        hasTest = !!(pkg.scripts?.test && !/^echo\s/.test(pkg.scripts.test));
        if (existsSync(path.join(sb.worktreePath, 'pnpm-lock.yaml'))) packageManagerInstall = 'pnpm rebuild';
        else if (existsSync(path.join(sb.worktreePath, 'yarn.lock'))) packageManagerInstall = 'yarn install --check-files';
      }
    } catch { /* */ }
    if (!hasTest) {
      return { ok: true, skipped: true, output: 'no npm test script — gate skipped' };
    }
    const runAsUser = this.getWorktreeOwner(sb.worktreePath);
    this.deps.logger.info({ sandboxId: sb.id, runAsUser }, 'v813 merge-gate: running npm rebuild + npm test');
    // v819 — Sub-Step für UI-Heartbeat. validateBuild liefert keinen Phase-Callback,
    // daher splitten wir auf "tests-rebuild" (während rebuild läuft) und "tests-run"
    // sobald validateBuild rein heuristisch >60s gelaufen ist (ABI-Build done → tests).
    // Pragmatisch: zwei explizite Markers vor und während des Calls.
    if (sandboxId) await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:tests-rebuild');
    // Async-Heartbeat-Interval: alle 30s last_active_at refreshen damit UI nicht "hängt" zeigt.
    let heartbeat: NodeJS.Timeout | undefined;
    if (sandboxId) {
      let phase: 'tests-rebuild' | 'tests-run' = 'tests-rebuild';
      const start = Date.now();
      heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        // Heuristik: nach 60s gilt rebuild als done, ab dann tests-run
        if (phase === 'tests-rebuild' && elapsed > 60) phase = 'tests-run';
        this.deps.repo.updateStatus(sandboxId, 'merging', `step:${phase} · ${elapsed}s`).catch(() => {/* non-fatal */});
      }, 30_000);
    }
    try {
      // v837 — Merge-Gate via Container-Exec wenn Container existiert und Config erlaubt.
      // Eliminiert die Container-vs-Host-Environment-Asymmetrie (war Ursache des
      // alpbyte-games setup.ts-Bugs). Container ist hier noch laufend (wurde nicht
      // gestoppt vor merge-gate, siehe merge()-Änderung). Vorteil: gleiche env, gleiche
      // native modules (musl), gleiche .env.local wie Per-Phase-Tests.
      const useContainer = (this.deps.config.mergeGateRunInContainer ?? true) && !!sb.containerId;
      if (useContainer && sb.containerId) {
        this.deps.logger.info({ sandboxId: sb.id, containerId: sb.containerId }, 'v837 merge-gate: running npm test in container (eliminates env-asymmetry)');
        // Container könnte gestoppt sein → erst starten falls nötig
        try { await startContainer(sb.containerId); } catch { /* may already be running */ }
        const r = await runContainerCommand(sb.containerId, 'npm test', { cwd: '/workspace', timeoutMs: 10 * 60_000 });
        const combined = `$ npm test (in container, exit ${r.exitCode}, ${r.durationMs}ms)\n${r.stderr}\n${r.stdout}`;
        return {
          ok: r.exitCode === 0,
          output: combined,
          reason: r.exitCode === 0 ? undefined : 'merge-gate-tests-failed',
        };
      }
      // Fallback: Host-Mode (klassische Runs ohne Container, oder Config-Opt-Out)
      this.deps.logger.info({ sandboxId: sb.id, runAsUser }, 'v813b merge-gate: running npm rebuild + npm test on HOST (no container or mergeGateRunInContainer=false)');
      // 10min Test-Timeout — typischer Next.js-Test-Suite-Run liegt drunter; bei
      // Überschreitung gilt: zu langsam = ablehnen, User debuggt manuell.
      const result = await validateBuild(sb.worktreePath, [packageManagerInstall], ['npm test'], 10 * 60_000, runAsUser);
      return {
        ok: result.passed,
        output: result.combinedOutput,
        reason: result.passed ? undefined : 'merge-gate-tests-failed',
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /** v812 — Discard: tentative Projekt-Metadaten der Sandbox aufräumen (Callback). */
  private async fireSandboxDiscarded(sb: Sandbox): Promise<void> {
    if (!this.deps.onSandboxDiscarded) return;
    try {
      await this.deps.onSandboxDiscarded({ sandboxId: sb.id, projectId: sb.projectId });
    } catch (err) {
      this.deps.logger.warn({ err, sandboxId: sb.id }, 'v812 onSandboxDiscarded callback failed (non-fatal)');
    }
  }

  async discard(sandboxId: string, projectCwd: string): Promise<void> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);

    if (sb.containerId) {
      try { await stopContainer(sb.containerId, 5); } catch { /* */ }
      await this.snapshotDevServerLog(sb); // v810 — Logs sichern bevor Container weg
      try { await removeContainer(sb.containerId, true); } catch { /* */ }
    }
    this.killWorktreeHolders(sb.worktreePath);
    await this.fireSandboxDiscarded(sb); // v812 — pending Projekt-Metadaten aufräumen
    try {
      await destroyWorktree({
        projectCwd,
        worktreePath: sb.worktreePath,
        branchName: sb.branchName,
        deleteBranch: true,
        force: true,
        logger: this.deps.logger,
      });
    } catch (err) {
      this.deps.logger.warn({ err, sandboxId }, 'Worktree destroy partially failed during discard');
    }
    await this.deps.repo.markDestroyed(sandboxId, 'discarded');
  }

  /** Cleanup-Worker-target: destroy ohne result-Update. */
  async destroy(sandboxId: string, projectCwd: string): Promise<void> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return;
    if (sb.containerId) {
      try { await stopContainer(sb.containerId, 5); } catch { /* */ }
      await this.snapshotDevServerLog(sb); // v810 — Logs sichern bevor Container weg
      try { await removeContainer(sb.containerId, true); } catch { /* */ }
    }
    this.killWorktreeHolders(sb.worktreePath);
    await this.fireSandboxDiscarded(sb); // v812 — pending Projekt-Metadaten aufräumen
    try {
      await destroyWorktree({
        projectCwd,
        worktreePath: sb.worktreePath,
        branchName: sb.branchName,
        deleteBranch: true,
        force: true,
        logger: this.deps.logger,
      });
    } catch (err) {
      this.deps.logger.warn({ err, sandboxId }, 'Worktree destroy partially failed');
    }
    // v815 SB1 — markDestroyed setzt status + result-Spalte atomar; vorher nur
    // updateStatus('cleaned') → result blieb NULL → mergeState-Inferenz downstream
    // (v812) konnte 'discarded' vs 'cleaned' nicht unterscheiden.
    await this.deps.repo.markDestroyed(sandboxId, 'discarded');
  }

  /**
   * v700 — Merge: bringt die Sandbox-Änderungen in main (direct-push) ODER
   * pusht den Branch und erstellt PR/MR auf der konfigurierten Forge.
   *
   * Schritte:
   *  1. Pre-Checks (status running/paused)
   *  2. Pre-merge-secret-scan auf den diff baseCommit..HEAD
   *  3. Optional: uncommitted changes committen (sicherheitshalber)
   *  4. Container stoppen (Push-Lock-Konflikt vermeiden)
   *  5. Strategy 'direct': checkout main + merge --squash + commit + push
   *     Strategy 'pr': push branch + Forge-API createPullRequest
   *  6. Cleanup (Worktree + Container + DB markDestroyed)
   */
  async merge(
    sandboxId: string,
    opts: { strategy: 'direct' | 'pr'; commitMessage?: string; prTitle?: string; prBody?: string; projectCwd: string; forgeConfig?: import('@alfred/types').ForgeConfig; defaultBranch?: string; repoUrl?: string },
  ): Promise<{ ok: boolean; prUrl?: string; reason?: string; mergedSha?: string }> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return { ok: false, reason: 'Sandbox not found' };
    if (sb.status !== 'running' && sb.status !== 'paused') {
      return { ok: false, reason: `Sandbox in status '${sb.status}' — only running/paused can be merged` };
    }

    // v819 — Fein-granulare Merge-Schritte als status_reason damit der User im
    // Interactive-Header sieht ob noch Fortschritt passiert oder ob's hängt.
    // last_active_at wird bei jedem updateStatus aktualisiert → Frontend nutzt
    // das als Heartbeat (wenn >90s ohne Update → "hängt-Warnung").
    await this.deps.repo.updateStatus(sandboxId, 'merging', `step:init · strategy=${opts.strategy}`);

    // v837 — Wann den Container stoppen: bei Container-Merge-Gate-Mode ERST nach Tests
    // (sonst kein docker exec möglich), bei Host-Mode wie bisher früh (Lock-Konflikte
    // vermeiden bei git push).
    const useContainerForGate = (this.deps.config.mergeGateRunInContainer ?? true) && !!sb.containerId;

    try {
      // (1) Container stoppen vor git operations — nur im HOST-Mode früh.
      // Im Container-Mode wird das nach den Merge-Gate-Tests gemacht.
      await this.deps.repo.updateStatus(sandboxId, 'merging', useContainerForGate ? 'step:keep-container-running' : 'step:container-stop');
      if (sb.containerId && !useContainerForGate) {
        try { await stopContainer(sb.containerId, 5); } catch { /* ignore */ }
      }

      // (2) Uncommitted changes committen — v726: .alfred-data/ + .env* explizit ausschließen
      // damit Sandbox-Test-Daten (DB-Files, Logs, Uploads) und Secrets NICHT ins Repo wandern.
      // Defensiv zusätzlich zu .gitignore (User könnte die Einträge entfernt haben).
      await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:auto-commit');
      try {
        const status = await runGit(['status', '--porcelain'], sb.worktreePath);
        if (status.trim()) {
          await runGit(
            ['add', '-A', '--', ':!.alfred-data', ':!.alfred-data/**', ':!.env', ':!.env.local', ':!.env.*.local'],
            sb.worktreePath,
          );
          const msg = opts.commitMessage ?? `Sandbox session ${sandboxId.slice(0, 8)} — auto-commit`;
          // Identity sicherstellen (Worktree erbt von main, aber für sicher)
          await runGit(['-c', 'user.name=Alfred', '-c', 'user.email=alfred@local', 'commit', '-m', msg], sb.worktreePath);
        }
      } catch (err) {
        this.deps.logger.warn({ err }, 'Auto-commit before merge failed (continuing)');
      }

      // (3) Pre-Merge-Secret-Scan
      await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:secret-scan');
      try {
        const diff = await runGit(['diff', `${sb.baseCommitSha}..HEAD`, '--unified=0'], sb.worktreePath);
        const findings = scanForSecrets(diff);
        if (findings.length > 0) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', `secret-scan: ${findings.length} findings`);
          return { ok: false, reason: `Secrets detected in diff (${findings.length}):\n- ${findings.slice(0, 5).join('\n- ')}` };
        }
      } catch (err) {
        this.deps.logger.warn({ err }, 'Pre-merge secret-scan failed (continuing without block)');
      }

      // (3b) v813b — Merge-Gate: npm rebuild + npm test. Container ist hier gestoppt
      // (Step 1) → das Bind-Mount-ABI ist nicht mehr im Wettlauf. Failed → Merge
      // ablehnen; Sandbox bleibt paused, User kann fixen oder discarden.
      // v819 — runMergeGateTests setzt selbst step:tests-rebuild / step:tests-run.
      try {
        const gate = await this.runMergeGateTests(sb, sandboxId);
        if (!gate.ok) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', gate.reason ?? 'merge-gate-tests-failed');
          // v822 — ANSI-Codes strippen + strukturierte Vitest-Summary extrahieren damit
          // die Error-Message lesbar ist (vorher: wall of \x1b[2m\x1b[22m\x1b... Müll).
          const cleaned = stripAnsi(gate.output || '');
          const summary = summarizeTestFailure(cleaned);
          // v825 — Lessons-Loop: Merge-Gate-Failure ist der zuverlässigste Trigger für
          // generalisierbare Lessons. Wir geben den Callback fire-and-forget — non-fatal.
          if (this.deps.onMergeGateFailed) {
            this.deps.onMergeGateFailed({
              sandboxId,
              projectId: sb.projectId,
              testSummary: summary,
              rawOutputTail: cleaned.slice(-4000),
            }).catch(err => {
              this.deps.logger.debug({ err, sandboxId }, 'v825 onMergeGateFailed callback failed (non-fatal)');
            });
          }
          return {
            ok: false,
            reason: `Merge-Gate: Tests fehlgeschlagen. Sandbox bleibt paused — manuell debuggen oder verwerfen.\n\n${summary}`,
          };
        }
        if (gate.skipped) {
          this.deps.logger.info({ sandboxId }, 'v813b merge-gate skipped (no test script)');
        } else {
          this.deps.logger.info({ sandboxId }, 'v813b merge-gate passed');
        }
      } catch (err) {
        // v815 SB6 — Merge-Gate-Exception MUSS Merge ablehnen. Vorher: "durchwinken
        // bei Infra-Problem". Folge: ein crashender Gate (z.B. validateBuild wirft,
        // OOM beim Test-Spawn, sudo-Fehler) hätte unvalidierte Code-Änderungen in
        // main durchgelassen. Sicher: ablehnen, User muss manuell freigeben.
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err, sandboxId }, 'v815 merge-gate threw — aborting merge');
        await this.deps.repo.updateStatus(sandboxId, 'paused', `merge-gate-exception: ${msg.slice(0, 100)}`);
        return { ok: false, reason: `Merge-Gate-Exception: ${msg.slice(0, 200)}\nSandbox bleibt paused. Manuell debuggen oder Merge erneut versuchen.` };
      }

      // v837 — Container-Stop nach Merge-Gate-Pass (nur im Container-Mode). Lock-Konflikt
      // vermeiden bevor git push läuft. Im Host-Mode wurde der Container schon in (1) gestoppt.
      if (useContainerForGate && sb.containerId) {
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:container-stop-after-gate');
        try { await stopContainer(sb.containerId, 5); } catch { /* */ }
      }

      // (4) Strategy
      if (opts.strategy === 'pr') {
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:pr-push');
        const result = await this.mergeViaPr(sb, opts);
        if (!result.ok) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', result.reason ?? 'pr-failed');
          return result;
        }
        // v812 — PR-Strategie: Code ist noch NICHT in main (Forge-Merge ausstehend).
        // Wir bestätigen die Sessions trotzdem als 'merged' (PR erstellt) — der eigentliche
        // Forge-Merge ist außerhalb von Alfreds Kontrolle. onMergeApplied markiert + matched.
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:finalize');
        await this.fireMergeApplied(sb, undefined);
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:cleanup');
        await this.cleanupAfterMerge(sb, opts.projectCwd);
        await this.deps.repo.markDestroyed(sandboxId, 'merged_via_pr', result.prUrl);
        return result;
      } else {
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:git-merge');
        const result = await this.mergeDirect(sb, opts);
        if (!result.ok) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', result.reason ?? 'direct-failed');
          return result;
        }
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:finalize');
        await this.fireMergeApplied(sb, result.mergedSha); // v812
        await this.deps.repo.updateStatus(sandboxId, 'merging', 'step:cleanup');
        await this.cleanupAfterMerge(sb, opts.projectCwd);
        await this.deps.repo.markDestroyed(sandboxId, 'merged_to_main');
        return result;
      }
    } catch (err) {
      await this.deps.repo.updateStatus(sandboxId, 'paused', `merge-error: ${(err as Error).message.slice(0, 200)}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  private async mergeDirect(sb: Sandbox, opts: { commitMessage?: string; projectCwd: string; defaultBranch?: string }): Promise<{ ok: boolean; reason?: string; mergedSha?: string }> {
    const baseBranch = opts.defaultBranch ?? 'main';
    try {
      // Im MAIN-Repo (projectCwd), nicht im worktree
      await runGit(['fetch', 'origin'], opts.projectCwd);
      const currentBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts.projectCwd)).trim();
      if (currentBranch !== baseBranch) {
        await runGit(['checkout', baseBranch], opts.projectCwd);
      }
      await runGit(['merge', '--squash', sb.branchName], opts.projectCwd);
      const msg = opts.commitMessage ?? `Squash-merge from sandbox ${sb.id.slice(0, 8)} (${sb.branchName})`;
      await runGit(['-c', 'user.name=Alfred', '-c', 'user.email=alfred@local', 'commit', '-m', msg], opts.projectCwd);
      const sha = (await runGit(['rev-parse', 'HEAD'], opts.projectCwd)).trim();
      // Push wenn remote vorhanden
      try {
        await runGit(['push', 'origin', baseBranch], opts.projectCwd);
      } catch (err) {
        this.deps.logger.warn({ err }, 'Direct-merge push failed — commit ist lokal, manueller Push nötig');
        return { ok: true, mergedSha: sha, reason: 'Local commit OK, push failed — push manually' };
      }
      return { ok: true, mergedSha: sha };
    } catch (err) {
      return { ok: false, reason: `Direct merge failed: ${(err as Error).message.slice(0, 300)}` };
    }
  }

  private async mergeViaPr(sb: Sandbox, opts: { prTitle?: string; prBody?: string; projectCwd: string; forgeConfig?: import('@alfred/types').ForgeConfig; defaultBranch?: string; repoUrl?: string }): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
    try {
      // Branch pushen vom WORKTREE aus (dort lebt der Branch)
      const { stderr } = await runGitBoth(['push', '-u', 'origin', sb.branchName], sb.worktreePath);
      // PR-URL aus stderr extrahieren (GitLab/GitHub schreiben das hin)
      const urlMatch = stderr.match(/https?:\/\/[^\s]+(?:merge_requests\/new|pull\/new|compare)[^\s]*/);
      const hintedUrl = urlMatch ? urlMatch[0] : undefined;

      // Forge-API für echten PR-Create wenn konfiguriert
      if (opts.forgeConfig && opts.repoUrl) {
        try {
          const { createForgeClient } = await import('@alfred/skills');
          const client = createForgeClient(opts.forgeConfig);
          const repo = parseRepoFromUrl(opts.repoUrl);
          if (repo) {
            const title = opts.prTitle ?? `Sandbox session ${sb.id.slice(0, 8)}: ${sb.branchName}`;
            const body = opts.prBody ?? `Auto-created from Alfred Sandbox session.\n\nBranch: \`${sb.branchName}\`\nBase commit: \`${sb.baseCommitSha.slice(0, 8)}\``;
            const pr = await client.createPullRequest(repo, { title, body, head: sb.branchName, base: opts.defaultBranch ?? 'main' });
            return { ok: true, prUrl: pr.url };
          }
        } catch (err) {
          this.deps.logger.warn({ err }, 'Forge-API PR-create failed, falling back to push-hint URL');
        }
      }

      // Fallback: keine Forge-API → liefere die Push-Hint-URL
      if (hintedUrl) return { ok: true, prUrl: hintedUrl };
      return { ok: true, reason: 'Branch pushed — please create PR manually on the forge' };
    } catch (err) {
      return { ok: false, reason: `PR push failed: ${(err as Error).message.slice(0, 300)}` };
    }
  }

  private async cleanupAfterMerge(sb: Sandbox, projectCwd: string): Promise<void> {
    // Container weg
    if (sb.containerId) {
      try { await removeContainer(sb.containerId, true); } catch { /* */ }
    }
    // Worktree weg — Branch behalten falls direct-push (history bleibt), bei PR auch behalten (Forge zeigt's)
    try {
      const { destroyWorktree } = await import('./sandbox/worktree.js');
      await destroyWorktree({
        projectCwd,
        worktreePath: sb.worktreePath,
        branchName: sb.branchName,
        deleteBranch: false, // bei merge bleibt der Branch (für history/PR-View)
        force: true,
        logger: this.deps.logger,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, 'Cleanup after merge partially failed');
    }
  }

  /**
   * v700 — Cleanup-Worker: pausiert idle-running Sandboxes und entfernt
   * lange-pausierte. Wird vom Watch-Skill periodisch gerufen.
   */
  async cleanupIdle(projectCwdResolver: (projectId: string) => Promise<string | null>): Promise<{ paused: number; cleaned: number }> {
    const idleMin = this.deps.config.idleTimeoutMin ?? 30;
    const cleanupHours = this.deps.config.cleanupAfterHours ?? 24;
    const now = Date.now();

    let paused = 0;
    let cleaned = 0;

    // Pause idle-running
    const idleCutoff = new Date(now - idleMin * 60_000).toISOString();
    const idleRunning = await this.deps.repo.listIdleSince(idleCutoff, ['running']);
    for (const sb of idleRunning) {
      try { await this.pause(sb.id); paused++; }
      catch (err) { this.deps.logger.debug({ err, sandboxId: sb.id }, 'cleanup pause failed'); }
    }

    // Cleanup stale-paused
    const staleCutoff = new Date(now - cleanupHours * 3600_000).toISOString();
    const stalePaused = await this.deps.repo.listIdleSince(staleCutoff, ['paused', 'failed']);
    for (const sb of stalePaused) {
      try {
        const cwd = await projectCwdResolver(sb.projectId);
        if (!cwd) continue;
        await this.destroy(sb.id, cwd);
        cleaned++;
      } catch (err) {
        this.deps.logger.debug({ err, sandboxId: sb.id }, 'cleanup destroy failed');
      }
    }

    if (paused + cleaned > 0) {
      this.deps.logger.info({ paused, cleaned, idleMin, cleanupHours }, 'Sandbox cleanup-worker pass complete');
    }
    return { paused, cleaned };
  }

  async touchActivity(sandboxId: string): Promise<void> {
    await this.deps.repo.touchActivity(sandboxId);
  }

  /**
   * v749 — Auto-Cleanup stuck Sandboxes (creating-Phase > N min).
   * Aufruf beim Alfred-Startup + periodic alle 5min. Cluster-aware: jeder Node
   * cleant nur seine eigenen Sandboxes (via listByNodeAndStatus).
   * Default-Threshold 10min (consistent mit Frontend isStuck-Logic v748).
   */
  async cleanupStuckSandboxes(thresholdMinutes = 10): Promise<number> {
    try {
      const repo = this.deps.repo as unknown as {
        listByNodeAndStatus?: (nodeId: string, statuses: string[]) => Promise<Array<{ id: string; createdAt: string; branchName?: string }>>;
      };
      if (!repo.listByNodeAndStatus) return 0;
      const stuck = await repo.listByNodeAndStatus(this.deps.nodeId, ['creating']);
      const cutoffMs = Date.now() - thresholdMinutes * 60_000;
      let cleaned = 0;
      for (const sb of stuck) {
        try {
          const createdMs = new Date(sb.createdAt).getTime();
          if (!Number.isFinite(createdMs) || createdMs > cutoffMs) continue;
          await this.forceFail(sb.id, `auto-cleanup: stuck in creating since ${thresholdMinutes}min`);
          cleaned++;
        } catch (err) {
          this.deps.logger.warn({ err, sandboxId: sb.id }, 'v749 stuck-cleanup failed for sandbox');
        }
      }
      if (cleaned > 0) {
        this.deps.logger.info({ cleaned, nodeId: this.deps.nodeId, thresholdMinutes }, 'v749 cleanupStuckSandboxes: marked stuck sandboxes as failed');
      }
      return cleaned;
    } catch (err) {
      this.deps.logger.debug({ err }, 'v749 cleanupStuckSandboxes failed (non-fatal)');
      return 0;
    }
  }

  /**
   * v748 — Force-Fail: für stuck Sandboxes (creating seit > 10min ohne Progress).
   * Setzt status=failed mit reason, versucht best-effort Container zu stoppen falls einer existiert.
   */
  async forceFail(sandboxId: string, reason = 'manually-marked-failed'): Promise<{ ok: boolean; reason?: string }> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) return { ok: false, reason: 'Sandbox not found' };
    if (sb.containerId) {
      try { await stopContainer(sb.containerId, 5); } catch { /* ignore */ }
    }
    await this.deps.repo.updateStatus(sandboxId, 'failed', reason.slice(0, 200));
    this.deps.logger.info({ sandboxId, reason }, 'v748 force-failed sandbox');
    return { ok: true };
  }

  /**
   * v726 — Lädt ENVs für eine Project/Stage aus EnvironmentRepository und decrypted sie.
   * Best-effort: bei Fehler oder fehlenden Deps gibt {} zurück (Container startet wie zuvor).
   */
  private async loadProjectEnvironments(projectId: string, stage: string): Promise<Record<string, string>> {
    if (!this.deps.envRepo || !this.deps.envCrypto) return {};
    try {
      const entry = await this.deps.envRepo.get(projectId, stage);
      if (!entry) return {};
      const decrypted = this.deps.envCrypto.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
      return decrypted;
    } catch (err) {
      this.deps.logger.warn({ err, projectId, stage }, 'v726 env-load failed (returning empty)');
      return {};
    }
  }

  /**
   * v726 — Erstellt /workspace/.alfred-data/ im worktree und kopiert je nach dbSeed
   * eine Seed-DB rein. Diese Pfade liegen IM worktree-mount damit der Container Zugriff hat,
   * werden aber per `.gitignore`-Hint (oder explizitem pre-merge-filter) nicht zurückcommitted.
   */
  private async prepareSandboxDataDir(
    worktreePath: string,
    dbSeed: { kind: 'empty' } | { kind: 'repo_path'; path: string } | { kind: 'upload'; seedId: string },
    projectCwd: string,
  ): Promise<void> {
    const dataDir = path.join(worktreePath, '.alfred-data');
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    } catch (err) {
      this.deps.logger.warn({ err, dataDir }, 'v726 .alfred-data mkdir failed (continuing)');
      return;
    }

    // .gitignore-Einträge sicherstellen damit Daten nicht ins Repo zurückfließen
    try {
      const { readFileSync, writeFileSync, existsSync: exists } = await import('node:fs');
      const gitignorePath = path.join(worktreePath, '.gitignore');
      const existing = exists(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
      const additions: string[] = [];
      if (!existing.includes('.alfred-data')) additions.push('.alfred-data/');
      if (!/^\.env\.local\b/m.test(existing)) additions.push('.env.local');
      if (additions.length > 0) {
        const next = existing + (existing.endsWith('\n') || existing.length === 0 ? '' : '\n') + additions.join('\n') + '\n';
        writeFileSync(gitignorePath, next, 'utf8');
      }
    } catch (err) {
      this.deps.logger.debug({ err }, 'v726 .gitignore update skipped');
    }

    if (dbSeed.kind === 'empty') return;
    try {
      const { copyFileSync, statSync: stat } = await import('node:fs');
      if (dbSeed.kind === 'repo_path') {
        // Pfad relative to projectCwd. Sicherheits-Check: kein .. erlaubt.
        if (dbSeed.path.includes('..')) throw new Error('repo_path darf kein .. enthalten');
        const src = path.resolve(projectCwd, dbSeed.path);
        if (!src.startsWith(path.resolve(projectCwd))) throw new Error('repo_path verlässt projectCwd');
        const target = path.join(dataDir, path.basename(src));
        copyFileSync(src, target);
        this.deps.logger.info({ src, target, size: stat(target).size }, 'v726 db-seed copied from repo_path');
      } else if (dbSeed.kind === 'upload') {
        if (!this.deps.dbSeedRepo || !this.deps.uploadSeedsPath) {
          throw new Error('Upload-Seed angefordert aber dbSeedRepo/uploadSeedsPath nicht konfiguriert');
        }
        const seed = await this.deps.dbSeedRepo.getById(dbSeed.seedId);
        if (!seed) throw new Error(`Seed ${dbSeed.seedId} nicht gefunden`);
        if (seed.kind !== 'upload') throw new Error(`Seed ${dbSeed.seedId} ist kind=${seed.kind}, nicht upload`);
        const src = path.resolve(this.deps.uploadSeedsPath, seed.storageRef);
        if (!src.startsWith(path.resolve(this.deps.uploadSeedsPath))) throw new Error('Upload-Seed verlässt uploadSeedsPath');
        const target = path.join(dataDir, seed.name);
        copyFileSync(src, target);
        this.deps.logger.info({ src, target, size: stat(target).size }, 'v726 db-seed copied from upload');
      }
    } catch (err) {
      this.deps.logger.warn({ err }, 'v726 db-seed copy failed (sandbox startet mit leerem .alfred-data)');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v700 — Merge-Helpers (git/secret-scan/repo-parsing)
// ─────────────────────────────────────────────────────────────────────────

async function runGit(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function runGitBoth(args: string[], cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return { stdout, stderr };
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub Token', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'GitHub PAT', re: /\bghs_[A-Za-z0-9]{36}\b/g },
  { name: 'GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
  { name: 'OpenAI Key', re: /\bsk-[A-Za-z0-9]{48,}\b/g },
  { name: 'Anthropic Key', re: /\bsk-ant-[A-Za-z0-9-_]{24,}\b/g },
  { name: 'Stripe Secret', re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  { name: 'Slack Token', re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Private Key', re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'JWT Token', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
];

/**
 * v822 — Strippt ANSI-Escape-Sequenzen (Color/Cursor/SGR-Codes) aus Test-Output
 * damit das Error-Message-Display lesbar ist statt ein Wall von \x1b[2m\x1b[22m...
 * Pattern deckt SGR (Color/Style), Cursor-Moves und Erase-Codes ab.
 */
function stripAnsi(s: string): string {
  if (!s) return '';
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[=>]/g, '');
}

/**
 * v822 — Extrahiert eine strukturierte Vitest-Summary aus dem (bereits
 * ANSI-stripped) Output: Failing-File-Liste + Test-Counts + Duration.
 * Fallback: Tail des Outputs wenn keine Vitest-Pattern erkannt werden.
 */
function summarizeTestFailure(output: string): string {
  if (!output) return '(kein Output)';
  const lines = output.split(/\r?\n/);
  const failingFiles: string[] = [];
  let testFilesLine = '';
  let testsLine = '';
  let durationLine = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Vitest "FAIL  src/path/file.test.ts" oder "❯ src/path/file.test.ts"
    const failMatch = line.match(/^(?:FAIL|×|❯)\s+(\S+\.(?:test|spec)\.(?:[jt]sx?))/);
    if (failMatch) {
      if (!failingFiles.includes(failMatch[1])) failingFiles.push(failMatch[1]);
      continue;
    }
    if (/^Test Files\s+\d/.test(line)) testFilesLine = line;
    else if (/^Tests\s+\d/.test(line)) testsLine = line;
    else if (/^Duration\s+\d/.test(line) || /^\s*Duration:?\s+\d/.test(line)) durationLine = line;
  }

  const parts: string[] = [];
  if (testFilesLine) parts.push(`📊 ${testFilesLine}`);
  if (testsLine) parts.push(`🧪 ${testsLine}`);
  if (durationLine) parts.push(`⏱  ${durationLine}`);
  if (failingFiles.length > 0) {
    parts.push('');
    parts.push(`❌ Fehlgeschlagene Test-Files (${failingFiles.length}):`);
    for (const f of failingFiles.slice(0, 25)) parts.push(`  - ${f}`);
    if (failingFiles.length > 25) parts.push(`  … +${failingFiles.length - 25} weitere`);
  }

  if (parts.length === 0) {
    // Keine Vitest-Pattern erkannt → letzte 1500 chars rohen Output (ohne ANSI).
    const tail = output.slice(-1500).trim();
    return tail || '(kein Output)';
  }

  // Plus erste fehlerhafte Test-Diagnose-Stelle (Stack-Trace-Anfang) als Hilfe
  const errorStart = output.search(/\b(AssertionError|Error|FAIL)\b/);
  if (errorStart >= 0) {
    const snippet = output.slice(errorStart, errorStart + 600).trim();
    if (snippet) {
      parts.push('');
      parts.push('— Erster Fehler —');
      parts.push(snippet);
    }
  }

  return parts.join('\n');
}

function scanForSecrets(diff: string): string[] {
  if (!diff) return [];
  const findings: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) findings.push(`${name} in: ${line.slice(0, 120).trim()}`);
    }
  }
  return findings.slice(0, 20);
}

/** Parst Owner+Repo aus einem repoUrl (GitHub/GitLab SSH oder HTTPS). */
function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  // git@github.com:owner/repo.git → owner/repo
  let m = url.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo(.git)
  m = url.match(/^https?:\/\/[^/]+\/(?:[^/]+\/)*([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** Findet den sandbox-images-Ordner relativ zum laufenden bundle. */
function resolveDockerfilesDir(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Layout im Bundle: bundle/index.js + bundle/sandbox-images/Dockerfile.*
    const candidates = [
      path.join(here, 'sandbox-images'),
      path.join(here, '..', 'sandbox-images'),
      path.join(here, '..', '..', 'sandbox-images'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  } catch { /* import.meta.url not available in CJS — ignore */ }
  return '/opt/alfred/sandbox-images'; // fallback path
}
