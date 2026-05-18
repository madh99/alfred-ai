import type { Logger } from 'pino';
import type {
  ProjectRepository, Project, ProjectHealthMode, HealthProbe, HealthStatus, ProjectHealthEntry,
} from '@alfred/storage';
import { gitProbe } from './probes/git-probe.js';
import { buildProbe } from './probes/build-probe.js';
import { depsProbe } from './probes/deps-probe.js';
import { httpProbe } from './probes/http-probe.js';
import type { ProbeResult } from './probes/probe-types.js';

export interface HealthMonitorConfig {
  intervalHours?: number;
  /** Per-probe timeout. Build-probe gets its own larger default. */
  probeTimeoutMs?: number;
}

export interface StatusChangeEvent {
  project: Project;
  probe: HealthProbe;
  from: HealthStatus | 'unknown';
  to: HealthStatus;
  details?: string;
}

export type StatusChangeListener = (event: StatusChangeEvent) => void | Promise<void>;

/**
 * HealthMonitor — periodic background task that runs configured probes
 * against each active project and persists the results in project_health_log.
 *
 * Per-project healthMode:
 *  - 'off'     : skip entirely
 *  - 'minimal' : only gitProbe
 *  - 'full'    : gitProbe + buildProbe + depsProbe + httpProbe
 *
 * On ok→error/warning transition the registered status-change listener is fired,
 * which alfred.ts uses to enqueue a confirmation ("Project X build broken — repair?").
 */
export class HealthMonitor {
  private intervalTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly listeners: StatusChangeListener[] = [];

  constructor(
    private readonly repo: ProjectRepository,
    private readonly userIdResolver: () => string | undefined,
    private readonly logger: Logger,
    private readonly config: HealthMonitorConfig = {},
  ) {}

  onStatusChange(listener: StatusChangeListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    const hours = this.config.intervalHours ?? 6;
    const intervalMs = Math.max(15, hours * 60) * 60_000; // floor 15min
    // Run once shortly after start, then on the configured cadence.
    setTimeout(() => { void this.runCycle(); }, 60_000);
    this.intervalTimer = setInterval(() => { void this.runCycle(); }, intervalMs);
    this.logger.info({ intervalHours: hours }, 'HealthMonitor started');
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  /** Run a full cycle across all active projects. Idempotent — overlapping runs are skipped. */
  async runCycle(): Promise<void> {
    if (this.running) {
      this.logger.debug('HealthMonitor cycle skipped — previous run still active');
      return;
    }
    this.running = true;
    try {
      const userId = this.userIdResolver();
      if (!userId) return;
      const active = [
        ...await this.repo.list(userId, { status: 'active' }),
        ...await this.repo.list(userId, { status: 'maintenance' }),
      ];
      for (const project of active) {
        try {
          await this.checkProject(project);
        } catch (err) {
          this.logger.debug({ err, projectId: project.id }, 'HealthMonitor: per-project check failed');
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Run the appropriate probe set for one project based on its healthMode. */
  async checkProject(project: Project): Promise<ProbeResult[]> {
    const mode: ProjectHealthMode = project.healthMode ?? 'full';
    if (mode === 'off') return [];

    const probes: Array<() => Promise<ProbeResult>> = [];
    const ctx = { cwd: project.cwd, repoUrl: project.repoUrl, timeoutMs: this.config.probeTimeoutMs };

    probes.push(() => gitProbe(ctx));
    if (mode === 'full') {
      probes.push(() => buildProbe(ctx));
      probes.push(() => depsProbe(ctx));
      probes.push(() => httpProbe(ctx));
    }

    const results: ProbeResult[] = [];
    for (const probeFn of probes) {
      const previousByProbe: Map<HealthProbe, ProjectHealthEntry | null> = new Map();
      const result = await probeFn();
      results.push(result);

      const previous = previousByProbe.get(result.probe) ?? await this.repo.getLatestHealth(project.id, result.probe);
      previousByProbe.set(result.probe, previous);

      await this.repo.recordHealth(project.id, {
        probe: result.probe, status: result.status,
        details: result.details, durationMs: result.durationMs,
      });

      // Fire status-change listeners on a degradation transition only:
      // we don't want to spam confirmations when status improves or stays stable.
      const previousStatus: HealthStatus | 'unknown' = previous?.status ?? 'unknown';
      const degraded = isDegradation(previousStatus, result.status);
      if (degraded) {
        for (const l of this.listeners) {
          try { await l({ project, probe: result.probe, from: previousStatus, to: result.status, details: result.details }); }
          catch (err) { this.logger.debug({ err }, 'HealthMonitor listener failed'); }
        }
      }
    }
    return results;
  }
}

/** Did the status get worse since the last check? */
export function isDegradation(from: HealthStatus | 'unknown', to: HealthStatus): boolean {
  const rank: Record<HealthStatus | 'unknown', number> = {
    'ok': 0, 'skipped': 0, 'unknown': 0,
    'warning': 1, 'error': 2,
  };
  return rank[to] > rank[from];
}
