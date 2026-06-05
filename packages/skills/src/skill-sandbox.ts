import type { SkillContext, SkillResult } from '@alfred/types';
import type { Logger } from 'pino';
import { Skill } from './skill.js';
import type { ActivityTracker } from './activity-tracker.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * v848 — Default-Inactivity-Threshold. Skills können diesen mit
 * `skill.metadata.inactivityThresholdMs` für long-running CLI-Agents
 * hochsetzen (z.B. 600_000 = 10 min für code_agent).
 *
 * Vorher war dieser Wert hart-codiert. Bei code_agent.run mit claude-code
 * führte das zu unfairen Aborts: claude-code war 2:10 idle (npm install
 * lief, kein stdout) → SkillSandbox killed, aber claude-code completed
 * 2 Min später erfolgreich (zu spät — Promise war schon mit failure
 * resolved).
 */
const DEFAULT_INACTIVITY_THRESHOLD_MS = 120_000; // 2 minutes without a ping → dead
const POLL_INTERVAL_MS = 10_000;         // check every 10s
/**
 * v853 — Periodischer "still active" log/progress damit User bei langen
 * Sessions Sichtbarkeit hat. Feuert alle 30 Min ein Status-Update via
 * onProgress wenn das vorhanden ist.
 */
const LONG_RUN_PROGRESS_INTERVAL_MS = 30 * 60_000; // 30 minutes
/**
 * v853 — kein globales hartes Cap mehr für tracker-mode (war 20min).
 * Activity-Tracking ist die echte Schutzlinie. Skills die einen Hard-Cap
 * wollen setzen `metadata.maxTotalTimeMs` explizit.
 */

export class SkillSandbox {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Execute a skill with timeout protection.
   *
   * If an ActivityTracker is provided, uses an inactivity-based timeout:
   * the skill keeps running as long as the tracker receives pings.
   * Only kills the skill when it goes silent for inactivityThresholdMs.
   *
   * Without a tracker, falls back to a simple hard timeout.
   */
  async execute(
    skill: Skill,
    input: Record<string, unknown>,
    context: SkillContext,
    timeoutMs?: number,
    tracker?: ActivityTracker,
  ): Promise<SkillResult> {
    timeoutMs = timeoutMs ?? skill.metadata.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { name } = skill.metadata;

    const safeInput = { ...input };
    for (const key of ['password', 'secret', 'token', 'apiKey', 'api_key', 'accessToken', 'refreshToken', 'clientSecret']) {
      if (key in safeInput) safeInput[key] = '[REDACTED]';
    }
    this.logger.info({ skill: name, input: safeInput }, 'Skill execution started');

    if (tracker) {
      return this.executeWithTracker(skill, input, context, name, timeoutMs, tracker);
    }

    return this.executeWithHardTimeout(skill, input, context, name, timeoutMs);
  }

  /**
   * Activity-aware timeout: polls the tracker and only kills
   * the skill when it has been inactive for too long.
   */
  private async executeWithTracker(
    skill: Skill,
    input: Record<string, unknown>,
    context: SkillContext,
    name: string,
    initialTimeoutMs: number,
    tracker: ActivityTracker,
  ): Promise<SkillResult> {
    // v848 — per-skill inactivity-Threshold. Default ist 2 min, kann via
    // skill.metadata.inactivityThresholdMs hochgesetzt werden (code_agent
    // setzt 10 min weil claude-code intern lange Pausen haben darf).
    const inactivityThresholdMs = skill.metadata.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;

    // v853 — Hard-Cap nur wenn Skill explizit `maxTotalTimeMs` setzt.
    // Default: undefined → kein Hard-Cap, nur Activity-Tracking entscheidet.
    const maxTotalTimeMs = skill.metadata.maxTotalTimeMs;

    return new Promise<SkillResult>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let safetyTimer: ReturnType<typeof setTimeout> | undefined;
      let initialTimer: ReturnType<typeof setTimeout> | undefined;
      let longRunTimer: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
        if (initialTimer) clearTimeout(initialTimer);
        if (longRunTimer) clearInterval(longRunTimer);
      };

      const finish = (result: SkillResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      // v608 F4 — expose the tracker on context so child sub-processes
      // (e.g. claude-code spawned by code_agent) can keep the watchdog alive
      // by pinging on every stdout/stderr chunk.
      const contextWithTracker: SkillContext = { ...context, tracker } as SkillContext;

      // Run the skill
      skill.execute(input, contextWithTracker).then(
        (result) => {
          this.logger.info({ skill: name, success: result.success, ...(result.success ? {} : { error: result.error }) }, 'Skill execution completed');
          finish(result);
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error({ skill: name, error: message }, 'Skill execution failed');
          finish({ success: false, error: message });
        },
      );

      // After initial timeout, start polling for activity
      initialTimer = setTimeout(() => {
        if (settled) return;

        const idleMs = tracker.getIdleMs();
        if (idleMs >= inactivityThresholdMs) {
          const snapshot = tracker.getSnapshot();
          this.logger.warn(
            { skill: name, idleMs, state: snapshot.state, iteration: snapshot.iteration },
            'Agent inactive after initial timeout — aborting',
          );
          finish({
            success: false,
            error: `Skill "${name}" timed out — inactive for ${Math.round(idleMs / 1000)}s (last state: ${snapshot.state})`,
          });
          return;
        }

        // Agent is still active — start polling
        const snapshot = tracker.getSnapshot();
        this.logger.info(
          { skill: name, idleMs, state: snapshot.state, iteration: snapshot.iteration, totalMs: snapshot.totalElapsedMs },
          'Initial timeout reached but agent is active — extending',
        );

        pollTimer = setInterval(() => {
          if (settled) { cleanup(); return; }

          const currentIdleMs = tracker.getIdleMs();
          const snap = tracker.getSnapshot();

          if (currentIdleMs >= inactivityThresholdMs) {
            this.logger.warn(
              { skill: name, idleMs: currentIdleMs, state: snap.state, iteration: snap.iteration, totalMs: snap.totalElapsedMs },
              'Agent went inactive — aborting',
            );
            finish({
              success: false,
              error: `Skill "${name}" killed — inactive for ${Math.round(currentIdleMs / 1000)}s (last state: ${snap.state})`,
            });
          } else {
            this.logger.debug(
              { skill: name, idleMs: currentIdleMs, state: snap.state, iteration: snap.iteration },
              'Agent still active, continuing...',
            );
          }
        }, POLL_INTERVAL_MS);
      }, initialTimeoutMs);

      // v853 — Absolute Hard-Cap NUR wenn Skill `maxTotalTimeMs` explizit setzt.
      // Default ist undefined → kein safetyTimer. Activity-Tracker via Polling
      // ist die einzige Schutzlinie (idleMs > inactivityThresholdMs → kill).
      if (typeof maxTotalTimeMs === 'number' && maxTotalTimeMs > 0) {
        safetyTimer = setTimeout(() => {
          if (settled) return;
          const snap = tracker.getSnapshot();
          this.logger.error(
            { skill: name, totalMs: snap.totalElapsedMs, state: snap.state, iteration: snap.iteration, maxTotalTimeMs },
            'Skill-configured hard cap reached — force killing agent',
          );
          finish({
            success: false,
            error: `Skill "${name}" force-killed after ${Math.round(maxTotalTimeMs / 60_000)} minutes (skill-configured cap)`,
          });
        }, maxTotalTimeMs);
      }

      // v853 — Periodischer "still active" log für lange Sessions.
      // Gibt dem User Sichtbarkeit dass der Skill noch arbeitet ohne den
      // inactivity-threshold aufzubrechen. Feuert nur wenn Skill noch läuft.
      longRunTimer = setInterval(() => {
        if (settled) return;
        const snap = tracker.getSnapshot();
        const totalMin = Math.round(snap.totalElapsedMs / 60_000);
        this.logger.info(
          { skill: name, totalMin, state: snap.state, iteration: snap.iteration, idleMs: snap.idleMs },
          'Long-running skill: still active',
        );
        // Optional Progress an UI wenn Tracker einen onProgress hat (über die
        // ping()-Schiene; hier loggen wir nur). Konsumenten können totalMs aus
        // tracker.getSnapshot() ableiten.
      }, LONG_RUN_PROGRESS_INTERVAL_MS);
    });
  }

  /**
   * Simple hard timeout for skills that don't use a tracker.
   * This is the legacy behavior.
   */
  private async executeWithHardTimeout(
    skill: Skill,
    input: Record<string, unknown>,
    context: SkillContext,
    name: string,
    timeoutMs: number,
  ): Promise<SkillResult> {
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race<SkillResult>([
        skill.execute(input, context),
        new Promise<SkillResult>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Skill "${name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]).finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle); });

      this.logger.info({ skill: name, success: result.success, ...(result.success ? {} : { error: result.error }) }, 'Skill execution completed');

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error({ skill: name, error: message }, 'Skill execution failed');

      return {
        success: false,
        error: message,
      };
    }
  }
}
