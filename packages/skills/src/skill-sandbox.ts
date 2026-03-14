import type { SkillContext, SkillResult } from '@alfred/types';
import type { Logger } from 'pino';
import { Skill } from './skill.js';
import type { ActivityTracker } from './activity-tracker.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const INACTIVITY_THRESHOLD_MS = 120_000; // 2 minutes without a ping → dead
const POLL_INTERVAL_MS = 10_000;         // check every 10s
const MAX_TOTAL_TIME_MS = 20 * 60_000;   // absolute safety net: 20 minutes

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
   * Only kills the skill when it goes silent for INACTIVITY_THRESHOLD_MS.
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

    this.logger.info({ skill: name, input }, 'Skill execution started');

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
    return new Promise<SkillResult>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let safetyTimer: ReturnType<typeof setTimeout> | undefined;
      let initialTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
        if (initialTimer) clearTimeout(initialTimer);
      };

      const finish = (result: SkillResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      // Run the skill
      skill.execute(input, context).then(
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
        if (idleMs >= INACTIVITY_THRESHOLD_MS) {
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

          if (currentIdleMs >= INACTIVITY_THRESHOLD_MS) {
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

      // Absolute safety net — never let anything run forever
      safetyTimer = setTimeout(() => {
        if (settled) return;
        const snap = tracker.getSnapshot();
        this.logger.error(
          { skill: name, totalMs: snap.totalElapsedMs, state: snap.state, iteration: snap.iteration },
          'Absolute time limit reached — force killing agent',
        );
        finish({
          success: false,
          error: `Skill "${name}" force-killed after ${Math.round(MAX_TOTAL_TIME_MS / 60_000)} minutes (safety limit)`,
        });
      }, MAX_TOTAL_TIME_MS);
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
