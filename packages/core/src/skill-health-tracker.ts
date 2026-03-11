import type { Logger } from 'pino';
import type { SkillHealthRepository } from '@alfred/storage';
import type { SkillHealth } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';

/** Auto-disable thresholds: consecutive fails -> disable duration in minutes. */
const DISABLE_THRESHOLDS: Array<{ fails: number; durationMinutes: number }> = [
  { fails: 20, durationMinutes: 24 * 60 },  // 24 hours
  { fails: 10, durationMinutes: 2 * 60 },   // 2 hours
  { fails: 5, durationMinutes: 30 },         // 30 minutes
];

export class SkillHealthTracker {
  constructor(
    private readonly healthRepo: SkillHealthRepository,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {}

  /** Returns SkillHealth if skill is disabled, undefined if OK. */
  isDisabled(skillName: string): SkillHealth | undefined {
    try {
      if (!this.healthRepo.isDisabled(skillName)) return undefined;
      return this.healthRepo.getByName(skillName);
    } catch {
      return undefined; // DB error -> don't block
    }
  }

  recordSuccess(skillName: string): void {
    try {
      this.healthRepo.recordSuccess(skillName);
    } catch (err) {
      this.logger.debug({ err, skillName }, 'Failed to record skill success');
    }
  }

  recordFailure(skillName: string, error: string): void {
    try {
      const health = this.healthRepo.recordFailure(skillName, error);

      // Check thresholds (ordered from highest to lowest)
      for (const threshold of DISABLE_THRESHOLDS) {
        if (health.consecutiveFails >= threshold.fails && !health.disabledUntil) {
          const until = new Date(Date.now() + threshold.durationMinutes * 60_000).toISOString();
          this.healthRepo.disable(skillName, until);
          this.logger.warn(
            { skillName, consecutiveFails: health.consecutiveFails, disabledUntil: until },
            'Skill auto-disabled due to repeated failures',
          );
          this.activityLogger?.logSkillHealth({
            skillName,
            outcome: 'disabled',
            details: {
              consecutiveFails: health.consecutiveFails,
              disabledUntil: until,
              lastError: error,
            },
          });
          break;
        }
      }
    } catch (err) {
      this.logger.debug({ err, skillName }, 'Failed to record skill failure');
    }
  }

  forceEnable(skillName: string): void {
    try {
      this.healthRepo.enable(skillName);
      this.logger.info({ skillName }, 'Skill force-enabled by user');
      this.activityLogger?.logSkillHealth({
        skillName,
        outcome: 're-enabled',
        details: { reason: 'force-enable' },
      });
    } catch (err) {
      this.logger.warn({ err, skillName }, 'Failed to force-enable skill');
    }
  }

  getDashboard(): SkillHealth[] {
    try {
      return this.healthRepo.getAll();
    } catch {
      return [];
    }
  }

  /** Check for expired disables and re-enable them. */
  checkReEnables(): void {
    try {
      const all = this.healthRepo.getAll();
      const now = new Date();
      for (const health of all) {
        if (health.disabledUntil && new Date(health.disabledUntil) <= now) {
          this.healthRepo.enable(health.skillName);
          this.logger.info({ skillName: health.skillName }, 'Skill auto-re-enabled after cooldown');
          this.activityLogger?.logSkillHealth({
            skillName: health.skillName,
            outcome: 're-enabled',
            details: { reason: 'cooldown-expired' },
          });
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to check re-enables');
    }
  }
}
