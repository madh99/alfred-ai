import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Logger } from 'pino';
import type { ProjectRepository, Project, ProjectStorageType } from '@alfred/storage';
import type { ShareManager } from './share-manager.js';

const execFileAsync = promisify(execFile);

/**
 * v665b — Project-Move zwischen storage_types (local/shared) und ggf. Shares.
 *
 * Pre-Flight (alles must-pass):
 *   1. Keine aktive Project-Agent-Session (locked_by_node_id IS NULL)
 *   2. Git working tree clean (kein staged/modified/untracked außer .gitignore)
 *   3. Disk-Space auf Ziel (du-Quelle < df-avail-Ziel)
 *   4. Source-Pfad existiert + lesbar
 *   5. Target-Pfad noch nicht vorhanden (oder leer)
 *   6. Bei Ziel=shared: Share verfügbar + nicht readOnly
 *
 * Execution:
 *   1. tryLock (zusätzlich zum Pre-Flight — atomare Sicherung)
 *   2. rsync mit Excludes
 *   3. Verify: git status im Ziel funktioniert
 *   4. DB-Update transaktional
 *   5. Source löschen (wenn keepSource=false)
 *   6. releaseLock
 *
 * Rollback-Safety: vor DB-Update bleibt Source unverändert. Bei rsync-Fehler
 * wird Ziel-Verzeichnis NICHT aufgeräumt (Operator kann manuell prüfen).
 */

export interface MoveTarget {
  storageType: ProjectStorageType;
  shareId?: string;          // required bei storageType='shared'
  nodeId?: string;           // für local: welche Cluster-Node
}

export interface MoveOptions {
  excludes?: string[];       // rsync --exclude Patterns
  keepSource?: boolean;      // default false
  ttlMinutes?: number;       // Lock-TTL (default 30 — Move sollte schnell sein)
}

export interface PreflightResult {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  sourceCwd: string;
  targetCwd: string;
}

export class ProjectMoveService {
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly shareManager: ShareManager,
    private readonly localBase: string,
    private readonly defaultExcludes: string[],
    private readonly myNodeId: string,
    private readonly logger: Logger,
  ) {}

  /** Berechnet den Target-Pfad basierend auf MoveTarget + Projekt-Slug. */
  computeTargetPath(project: Project, target: MoveTarget): string {
    if (target.storageType === 'shared') {
      if (!target.shareId) throw new Error('shareId required for shared storage');
      const share = this.shareManager.getShare(target.shareId);
      if (!share) throw new Error(`Share "${target.shareId}" nicht konfiguriert`);
      return path.join(share.mountPath, project.slug);
    }
    return path.join(this.localBase, project.slug);
  }

  /** Führt alle Pre-Flight-Checks ohne side-effects aus. */
  async preflight(project: Project, target: MoveTarget, opts: MoveOptions): Promise<PreflightResult> {
    const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
    const sourceCwd = project.cwd ?? '';
    let targetCwd = '';
    try { targetCwd = this.computeTargetPath(project, target); }
    catch (err) {
      checks.push({ name: 'target_resolvable', passed: false, detail: (err as Error).message });
      return { ok: false, checks, sourceCwd, targetCwd: '' };
    }
    checks.push({ name: 'target_resolvable', passed: true, detail: targetCwd });

    // 1. Active Session?
    const lockedFree = !project.lockedByNodeId || (project.lockedUntil && new Date(project.lockedUntil).getTime() < Date.now());
    checks.push({
      name: 'no_active_session',
      passed: !!lockedFree,
      detail: lockedFree ? undefined : `gehalten von node "${project.lockedByNodeId}" bis ${project.lockedUntil}`,
    });

    // 2. Git working tree clean
    if (sourceCwd && existsSync(sourceCwd)) {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: sourceCwd, maxBuffer: 2 * 1024 * 1024 });
        const dirty = stdout.trim().length > 0;
        checks.push({
          name: 'git_clean',
          passed: !dirty,
          detail: dirty ? `${stdout.trim().split('\n').length} uncommitted changes — bitte committen oder stashen vor dem Move` : undefined,
        });
      } catch (err) {
        // kein git repo? — pass (kein git → keine Dirtyness möglich)
        checks.push({ name: 'git_clean', passed: true, detail: '(kein git repo)' });
      }
    } else {
      checks.push({ name: 'source_exists', passed: false, detail: `Source-cwd "${sourceCwd}" nicht vorhanden auf dieser Node` });
    }

    // 3. Source-Pfad existiert
    checks.push({
      name: 'source_exists',
      passed: !!sourceCwd && existsSync(sourceCwd),
      detail: existsSync(sourceCwd) ? undefined : `nicht vorhanden: ${sourceCwd}`,
    });

    // 4. Target noch nicht vorhanden
    if (existsSync(targetCwd)) {
      try {
        const stat = statSync(targetCwd);
        if (stat.isDirectory()) {
          checks.push({ name: 'target_free', passed: false, detail: `Target existiert bereits: ${targetCwd}` });
        } else {
          checks.push({ name: 'target_free', passed: false, detail: `Target-Pfad ist eine Datei, nicht Verzeichnis` });
        }
      } catch {
        checks.push({ name: 'target_free', passed: false, detail: `Target nicht lesbar` });
      }
    } else {
      checks.push({ name: 'target_free', passed: true });
    }

    // 5. Bei Ziel=shared: Share verfügbar + nicht readOnly
    if (target.storageType === 'shared') {
      const share = this.shareManager.getShare(target.shareId!);
      const usable = share && this.shareManager.isUsable(target.shareId!);
      checks.push({
        name: 'share_usable',
        passed: !!usable,
        detail: !share ? 'Share nicht konfiguriert' : !usable ? 'Share nicht beschreibbar oder offline' : undefined,
      });
    }

    // 6. Disk-Space (best-effort, ignoriere wenn du/df nicht verfügbar)
    try {
      const { stdout: sizeOut } = await execFileAsync('du', ['-sb', sourceCwd], { maxBuffer: 1024 * 1024 });
      const sourceBytes = parseInt(sizeOut.split(/\s+/)[0], 10);
      const targetParent = path.dirname(targetCwd);
      const { stdout: dfOut } = await execFileAsync('df', ['--output=avail', '-B1', targetParent], { maxBuffer: 1024 * 1024 });
      const lines = dfOut.trim().split('\n');
      const availBytes = parseInt(lines[lines.length - 1].trim(), 10);
      const enough = !isNaN(sourceBytes) && !isNaN(availBytes) && availBytes > sourceBytes * 1.2;
      checks.push({
        name: 'disk_space',
        passed: enough,
        detail: !enough ? `Quelle ~${Math.round(sourceBytes / 1e6)}MB, Ziel hat ${Math.round(availBytes / 1e6)}MB frei — empfohlen +20% Puffer` : undefined,
      });
    } catch {
      // du/df nicht verfügbar (z.B. Windows oder Container) — skip
      checks.push({ name: 'disk_space', passed: true, detail: '(Check übersprungen — du/df nicht verfügbar)' });
    }

    const ok = checks.every(c => c.passed);
    return { ok, checks, sourceCwd, targetCwd };
  }

  /**
   * Move-Execution. Voraussetzung: preflight().ok === true.
   * Liefert {ok, sourceCwd, targetCwd, durationMs}.
   *
   * onProgress wird mit rsync-stderr-Lines aufgerufen (für SSE-Stream in WebUI).
   */
  async execute(
    project: Project,
    target: MoveTarget,
    opts: MoveOptions,
    userId: string,
    onProgress?: (line: string) => void,
  ): Promise<{ ok: boolean; sourceCwd: string; targetCwd: string; durationMs: number; error?: string }> {
    const startedAt = Date.now();
    const targetCwd = this.computeTargetPath(project, target);
    const sourceCwd = project.cwd!;
    const excludes = opts.excludes ?? this.defaultExcludes;

    // 1. Lock acquire (zusätzlich zum Pre-Flight)
    const ttl = opts.ttlMinutes ?? 30;
    const lock = await this.projectRepo.tryLock(project.id, this.myNodeId, ttl);
    if (!lock.acquired) {
      return { ok: false, sourceCwd, targetCwd, durationMs: Date.now() - startedAt, error: `Lock nicht erworben (Holder: ${lock.holderNodeId})` };
    }

    try {
      // 2. rsync
      onProgress?.(`rsync ${sourceCwd}/ → ${targetCwd}/`);
      const rsyncArgs = [
        '-a',                       // archive (preserves perms, symlinks, times)
        '--info=progress2',         // progress to stderr
        ...excludes.flatMap(e => ['--exclude', e]),
        // Trailing slash: Inhalt von source kopieren, nicht source-dir selbst
        sourceCwd.endsWith('/') ? sourceCwd : `${sourceCwd}/`,
        targetCwd,
      ];
      await this.runRsync(rsyncArgs, onProgress);

      // 3. Verify (git status muss funktionieren oder Repo war eh keins)
      if (existsSync(path.join(targetCwd, '.git'))) {
        try {
          await execFileAsync('git', ['status'], { cwd: targetCwd, maxBuffer: 1024 * 1024 });
        } catch (err) {
          throw new Error(`Verify failed: git status im Ziel nicht erfolgreich: ${(err as Error).message}`);
        }
      }

      // 4. DB-Update
      await this.projectRepo.update(userId, project.id, {
        cwd: targetCwd,
        storageType: target.storageType,
        shareId: target.storageType === 'shared' ? target.shareId : undefined,
        nodeId: target.storageType === 'local' ? (target.nodeId ?? this.myNodeId) : undefined,
      });

      // 5. Source cleanup (optional)
      if (!opts.keepSource) {
        onProgress?.(`Aufräumen: ${sourceCwd}`);
        try {
          const fs = await import('node:fs/promises');
          await fs.rm(sourceCwd, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn({ err, sourceCwd }, 'Source cleanup failed (non-fatal — manueller cleanup nötig)');
          onProgress?.(`⚠️ Source-Cleanup fehlgeschlagen — bitte manuell prüfen: ${sourceCwd}`);
        }
      }

      this.logger.info({
        projectId: project.id, sourceCwd, targetCwd,
        storageType: target.storageType, shareId: target.shareId, nodeId: target.nodeId,
        durationMs: Date.now() - startedAt,
      }, 'Project-Move erfolgreich');
      return { ok: true, sourceCwd, targetCwd, durationMs: Date.now() - startedAt };
    } catch (err) {
      this.logger.error({ err, sourceCwd, targetCwd }, 'Project-Move fehlgeschlagen');
      return { ok: false, sourceCwd, targetCwd, durationMs: Date.now() - startedAt, error: (err as Error).message };
    } finally {
      // 6. Lock release
      try { await this.projectRepo.releaseLock(project.id, this.myNodeId); } catch { /* skip */ }
    }
  }

  private async runRsync(args: string[], onProgress?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrBuffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(l => l.trim());
        for (const line of lines) onProgress?.(line);
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = chunk.toString().split('\n').filter(l => l.trim());
        for (const line of lines) onProgress?.(line);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`rsync exit ${code}: ${stderrBuffer.slice(-500)}`));
      });
      proc.on('error', (err) => reject(err));
    });
  }
}
