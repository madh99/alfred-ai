import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import type { Logger } from 'pino';
import type { SandboxConfig } from '@alfred/types';
import type { SandboxRepository, Sandbox, SandboxInsert } from '@alfred/storage';

const execFileAsync = promisify(execFile);

export interface SandboxManagerDeps {
  config: SandboxConfig;
  repo: SandboxRepository;
  logger: Logger;
  nodeId: string;
}

/**
 * v696 — Project-Agent Sandbox-Manager (Foundation-Skelett).
 *
 * Verantwortlich für den vollen Lebenszyklus einer Sandbox:
 *  - createForSession()  → Worktree + Container + Proxy-Eintrag
 *  - pause() / resume()
 *  - merge() / discard()
 *  - destroy() (manueller Cleanup)
 *
 * In v696 nur Skelett — die Methoden werfen `not-implemented` und werden in v697-v700
 * mit echter Logik gefüllt. Wichtig: solange `isAvailable() === false` darf der Runner
 * den Manager NIE aufrufen — Default-Verhalten muss classic bleiben.
 */
export class SandboxManager {
  private docker_available = false;
  private worktreeBaseWritable = false;
  private healthCheckedAt?: string;

  constructor(private readonly deps: SandboxManagerDeps) {}

  /**
   * Startup-Health-Check: prüft Docker-Daemon + Worktree-Base-Pfad.
   * Setzt interne Flags. Wird einmalig in alfred.ts beim Init aufgerufen.
   * Idempotent — kann mehrfach gerufen werden.
   */
  async runHealthCheck(): Promise<{ dockerAvailable: boolean; worktreeBaseWritable: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    // Docker via `docker version` probieren (schnell, kein root nötig wenn docker-gruppe)
    try {
      await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
      this.docker_available = true;
    } catch (err) {
      this.docker_available = false;
      reasons.push(`docker not available: ${(err as Error).message.slice(0, 120)}`);
    }

    // Worktree-Base prüfen / erstellen
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
      { dockerAvailable: this.docker_available, worktreeBaseWritable: this.worktreeBaseWritable, reasons },
      'SandboxManager health-check completed',
    );
    return { dockerAvailable: this.docker_available, worktreeBaseWritable: this.worktreeBaseWritable, reasons };
  }

  /** True wenn Sandbox-Feature aktiv NUTZBAR ist. False = Code-Pfad bleibt classic. */
  isAvailable(): boolean {
    return Boolean(this.deps.config.enabled) && this.docker_available && this.worktreeBaseWritable;
  }

  /** Status für Diagnose (Settings-Page, Healthcheck-Endpoint). */
  getStatus(): {
    enabled: boolean;
    available: boolean;
    dockerAvailable: boolean;
    worktreeBaseWritable: boolean;
    healthCheckedAt?: string;
    defaultMode: string;
    defaultMergeStrategy: string;
  } {
    return {
      enabled: Boolean(this.deps.config.enabled),
      available: this.isAvailable(),
      dockerAvailable: this.docker_available,
      worktreeBaseWritable: this.worktreeBaseWritable,
      healthCheckedAt: this.healthCheckedAt,
      defaultMode: this.deps.config.defaultMode ?? 'classic',
      defaultMergeStrategy: this.deps.config.defaultMergeStrategy ?? 'pr',
    };
  }

  /**
   * Quota-Check VOR Create. Gibt `null` bei Erfolg, sonst Begründung.
   * Mit dem Repo-Aufruf bleibt das hier korrekt auch ohne Live-Disk-Stats.
   */
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

  // ── Lifecycle-Methoden (v697+ implementieren, hier nur Skelett) ──

  async createForSession(_input: Omit<SandboxInsert, 'worktreePath' | 'branchName' | 'baseCommitSha' | 'containerImage' | 'internalPort' | 'nodeId'>): Promise<Sandbox> {
    throw new Error('SandboxManager.createForSession not implemented yet (v697)');
  }

  async pause(_sandboxId: string): Promise<void> {
    throw new Error('SandboxManager.pause not implemented yet (v697)');
  }

  async resume(_sandboxId: string): Promise<void> {
    throw new Error('SandboxManager.resume not implemented yet (v697)');
  }

  async merge(_sandboxId: string, _opts: { strategy: 'direct' | 'pr'; commitMessage?: string; prTitle?: string; prBody?: string }): Promise<{ ok: boolean; prUrl?: string; reason?: string }> {
    throw new Error('SandboxManager.merge not implemented yet (v700)');
  }

  async discard(_sandboxId: string): Promise<void> {
    throw new Error('SandboxManager.discard not implemented yet (v697)');
  }

  async destroy(_sandboxId: string): Promise<void> {
    throw new Error('SandboxManager.destroy not implemented yet (v697)');
  }

  async touchActivity(sandboxId: string): Promise<void> {
    await this.deps.repo.touchActivity(sandboxId);
  }
}
