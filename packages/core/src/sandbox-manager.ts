import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { SandboxConfig, SandboxSessionMode } from '@alfred/types';
import type { SandboxRepository, Sandbox, SandboxInsert, EnvironmentRepository, DbSeedRepository } from '@alfred/storage';
import type { EnvCryptoService } from '@alfred/security';

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
  /** v726 — Optional: für ENV-Injection beim Container-Start. */
  envRepo?: EnvironmentRepository;
  envCrypto?: EnvCryptoService;
  /** v726 — Optional: für DB-Seed beim Container-Start. */
  dbSeedRepo?: DbSeedRepository;
  /** v726 — Pfad in dem Upload-Seeds liegen (z.B. /var/alfred/seeds/). */
  uploadSeedsPath?: string;
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
    const quotaIssue = await this.checkUserQuota(input.userId);
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
      await this.deps.repo.updateStatus(sandbox.id, 'running', wantsContainer ? 'no-dev-server-script' : undefined);
      return { sandbox, detection, containerStarted: false };
    }

    // Phase 2 — Container-Start ASYNC starten (nicht awaited!) damit createForSession sofort returnt
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

    // Phase 1 returnt sofort — Frontend pollt /api/sandbox/:id für Progress
    return { sandbox, detection, containerStarted: false };
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

      const installCmd = `${detection.diagnostics.packageManager} install`;
      const devCmd = detection.devCommand.join(' ');
      const fullCmd = `${installCmd} && exec ${devCmd}`;

      // v726 — Project-ENVs + Default-ENVs zusammenführen. Defaults dürfen NICHT von Project überschrieben werden? Doch — Project hat Vorrang (user-controlled).
      const containerEnvs: Record<string, string> = {
        CI: '',
        NODE_ENV: 'development',
        ALFRED_DATA_DIR: '/workspace/.alfred-data',
        ...projectEnvs,
      };

      const containerId = await runSandboxContainer({
        image,
        name: containerName,
        workdir: '/workspace',
        binds,
        envVars: containerEnvs,
        ports: [[hostPort, detection.internalPort]],
        memoryMb: 2048,
        cpus: 2,
        command: ['sh', '-c', `"${fullCmd}"`],
        restartPolicy: 'no',
        logger: this.deps.logger,
      });

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

      await this.deps.repo.updateStatus(sandboxId, 'running');
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

    await this.deps.repo.updateStatus(sandboxId, 'merging', `strategy=${opts.strategy}`);

    try {
      // (1) Container stoppen vor git operations (Lock-Konflikte vermeiden)
      if (sb.containerId) {
        try { await stopContainer(sb.containerId, 5); } catch { /* ignore */ }
      }

      // (2) Uncommitted changes committen — v726: .alfred-data/ + .env* explizit ausschließen
      // damit Sandbox-Test-Daten (DB-Files, Logs, Uploads) und Secrets NICHT ins Repo wandern.
      // Defensiv zusätzlich zu .gitignore (User könnte die Einträge entfernt haben).
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

      // (4) Strategy
      if (opts.strategy === 'pr') {
        const result = await this.mergeViaPr(sb, opts);
        if (!result.ok) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', result.reason ?? 'pr-failed');
          return result;
        }
        await this.cleanupAfterMerge(sb, opts.projectCwd);
        await this.deps.repo.markDestroyed(sandboxId, 'merged_via_pr', result.prUrl);
        return result;
      } else {
        const result = await this.mergeDirect(sb, opts);
        if (!result.ok) {
          await this.deps.repo.updateStatus(sandboxId, 'paused', result.reason ?? 'direct-failed');
          return result;
        }
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
