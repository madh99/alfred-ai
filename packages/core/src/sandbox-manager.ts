import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { SandboxConfig, SandboxSessionMode } from '@alfred/types';
import type { SandboxRepository, Sandbox, SandboxInsert } from '@alfred/storage';

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
} from './sandbox/docker.js';

const execFileAsync = promisify(execFile);

export interface SandboxManagerDeps {
  config: SandboxConfig;
  repo: SandboxRepository;
  logger: Logger;
  nodeId: string;
  /** Pfad zu den Sandbox-Dockerfiles. Wenn null/undefined wird relativ zum Bundle gesucht. */
  dockerfilesDir?: string;
}

export interface CreateForSessionInput {
  sessionId: string;
  projectId: string;
  userId: string;
  /** Pfad zum Main-Repo des Projekts (= projects.cwd). */
  projectCwd: string;
  /** sandbox | sandbox-preview | interactive-chat — classic kommt hier nicht durch. */
  mode: SandboxSessionMode;
  /** Slug für branch-name (z.B. aus session-goal). */
  slug?: string;
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
    };
  }

  async checkUserQuota(userId: string): Promise<string | null> {
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
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v697 — Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Erstellt eine neue Sandbox für eine Session.
   *
   * Schritte:
   *  1. Pre-Checks (available, quota, project-cwd ist git-repo)
   *  2. Worktree erstellen
   *  3. Project-Type detecten
   *  4. DB-Eintrag (status='creating')
   *  5. Falls Mode preview/interactive: Image sicherstellen → Port → Container starten → wait_for_health
   *  6. DB-Update status='running' + container_id + host_port
   *
   * Bei jedem Fehler: Rollback (Container weg, Worktree weg, DB-Status='failed').
   */
  async createForSession(input: CreateForSessionInput): Promise<CreateForSessionResult> {
    if (!this.isAvailable()) {
      throw new Error('SandboxManager not available (disabled, no docker, or worktree-base not writable)');
    }
    if (input.mode === 'classic') {
      throw new Error('createForSession called with classic mode — should not happen');
    }
    const quotaIssue = await this.checkUserQuota(input.userId);
    if (quotaIssue) throw new Error(quotaIssue);

    const gitCheck = await validateGitRepo(input.projectCwd);
    if (!gitCheck.ok) throw new Error(`Project not a git repo: ${gitCheck.reason}`);

    const wantsContainer = input.mode === 'sandbox-preview' || input.mode === 'interactive-chat';

    // Pfad + Branch ableiten
    const sid8 = input.sessionId.slice(0, 8);
    const slug = (input.slug ?? 'session').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24).toLowerCase();
    const branchName = `agent-${sid8}-${slug}`;
    const baseDir = this.deps.config.worktreeBasePath ?? '/var/alfred/worktrees';
    const worktreePath = path.join(baseDir, input.projectId, sid8);

    // 2. Worktree
    const wt = await createWorktree({
      projectCwd: input.projectCwd,
      branchName,
      worktreePath,
      logger: this.deps.logger,
    });

    // 3. Project-Type
    const detection = detectProjectType(wt.worktreePath);
    this.deps.logger.info({ detection, sessionId: input.sessionId }, 'Project-Type detected');

    // 4. DB-Insert
    const image = this.deps.config.containerImage ?? 'alfred-sandbox:node-22';
    const sandbox = await this.deps.repo.create({
      projectId: input.projectId,
      sessionId: input.sessionId,
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

    // Wenn kein Container gewünscht (sandbox-only): direkt running setzen
    if (!wantsContainer || !detection.hasDevServer) {
      if (wantsContainer && !detection.hasDevServer) {
        this.deps.logger.warn({ sessionId: input.sessionId, projectType: detection.type }, 'Mode requested preview but project has no dev-server → fallback to sandbox-only');
      }
      await this.deps.repo.updateStatus(sandbox.id, 'running', wantsContainer ? 'no-dev-server-script' : undefined);
      return { sandbox, detection, containerStarted: false };
    }

    // 5. Container starten
    try {
      await ensureImage({ image, dockerfilesDir: this.dockerfilesDir, logger: this.deps.logger });

      const portStart = this.deps.config.hostPortRangeStart ?? 9100;
      const portEnd = this.deps.config.hostPortRangeEnd ?? 9199;
      const hostPort = await findFreePort(portStart, portEnd, this.deps.repo);

      const memMb = this.deps.config.diskQuotaPerSandboxMb ?? 2048;
      const containerName = `alfred-sandbox-${sandbox.id.slice(0, 8)}`;
      const binds: Array<{ host: string; container: string; readOnly?: boolean }> = [
        { host: wt.worktreePath, container: '/workspace' },
      ];
      const pnpmStore = this.deps.config.pnpmStorePath;
      if (pnpmStore) binds.push({ host: pnpmStore, container: '/pnpm-store' });

      // Install + Dev-Server-Befehl
      const installCmd = `${detection.diagnostics.packageManager} install`;
      const devCmd = detection.devCommand.join(' ');
      const fullCmd = `${installCmd} && exec ${devCmd}`;

      const containerId = await runSandboxContainer({
        image,
        name: containerName,
        workdir: '/workspace',
        binds,
        envVars: { CI: '', NODE_ENV: 'development' },
        ports: [[hostPort, detection.internalPort]],
        memoryMb: 2048, // RAM, nicht Disk — fixer Wert für Container
        cpus: 2,
        command: ['sh', '-c', `"${fullCmd}"`],
        restartPolicy: 'no',
        logger: this.deps.logger,
      });

      await this.deps.repo.setContainerInfo(sandbox.id, containerId, hostPort);

      // 6. Health-Check (kann lange dauern wegen npm install)
      const healthy = await waitForDevServer(hostPort, {
        intervalMs: 2000,
        timeoutMs: 5 * 60 * 1000,
        logger: this.deps.logger,
      });
      if (!healthy) {
        throw new Error('dev-server did not become healthy within 5 minutes (npm install or dev start failed)');
      }

      await this.deps.repo.updateStatus(sandbox.id, 'running');
      const updated = await this.deps.repo.getById(sandbox.id);
      return { sandbox: updated ?? sandbox, detection, containerStarted: true };
    } catch (err) {
      // Rollback
      this.deps.logger.error({ err, sandboxId: sandbox.id }, 'Sandbox creation failed, rolling back');
      await this.deps.repo.updateStatus(sandbox.id, 'failed', (err as Error).message.slice(0, 500));
      // Container best-effort entfernen
      const updated = await this.deps.repo.getById(sandbox.id);
      if (updated?.containerId) {
        try { await removeContainer(updated.containerId, true); } catch { /* ignore */ }
      }
      // Worktree entfernen
      try {
        await destroyWorktree({
          projectCwd: input.projectCwd,
          worktreePath: wt.worktreePath,
          branchName: wt.branchName,
          deleteBranch: true,
          force: true,
          logger: this.deps.logger,
        });
      } catch { /* ignore */ }
      throw err;
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
    await this.deps.repo.updateStatus(sandboxId, 'paused', 'user-requested');
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
    await this.deps.repo.updateStatus(sandboxId, 'running');
  }

  /**
   * Discard: Container + Worktree + Branch komplett entfernen, DB markiert als 'discarded'.
   */
  async discard(sandboxId: string, projectCwd: string): Promise<void> {
    const sb = await this.deps.repo.getById(sandboxId);
    if (!sb) throw new Error(`Sandbox not found: ${sandboxId}`);

    if (sb.containerId) {
      try { await stopContainer(sb.containerId, 5); } catch { /* */ }
      try { await removeContainer(sb.containerId, true); } catch { /* */ }
    }
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
      try { await removeContainer(sb.containerId, true); } catch { /* */ }
    }
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
    await this.deps.repo.updateStatus(sandboxId, 'cleaned');
  }

  /** Merge wird in v700 implementiert (PR-API + secret-scan). */
  async merge(_sandboxId: string, _opts: { strategy: 'direct' | 'pr'; commitMessage?: string; prTitle?: string; prBody?: string }): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
    throw new Error('SandboxManager.merge not implemented yet (v700)');
  }

  async touchActivity(sandboxId: string): Promise<void> {
    await this.deps.repo.touchActivity(sandboxId);
  }
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
