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
  async isDisabled(skillName: string): Promise<SkillHealth | undefined> {
    try {
      if (!(await this.healthRepo.isDisabled(skillName))) return undefined;
      return this.healthRepo.getByName(skillName);
    } catch {
      return undefined; // DB error -> don't block
    }
  }

  async recordSuccess(skillName: string): Promise<void> {
    try {
      await this.healthRepo.recordSuccess(skillName);
    } catch (err) {
      this.logger.debug({ err, skillName }, 'Failed to record skill success');
    }
  }

  async recordFailure(skillName: string, error: string): Promise<void> {
    try {
      const health = await this.healthRepo.recordFailure(skillName, error);

      // Check thresholds (ordered from highest to lowest)
      for (const threshold of DISABLE_THRESHOLDS) {
        if (health.consecutiveFails >= threshold.fails && !health.disabledUntil) {
          const until = new Date(Date.now() + threshold.durationMinutes * 60_000).toISOString();
          await this.healthRepo.disable(skillName, until);
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

  async forceEnable(skillName: string): Promise<void> {
    try {
      await this.healthRepo.enable(skillName);
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

  async getDashboard(): Promise<SkillHealth[]> {
    try {
      return await this.healthRepo.getAll();
    } catch {
      return [];
    }
  }

  /** Check for expired disables and re-enable them. */
  async checkReEnables(): Promise<void> {
    try {
      const all = await this.healthRepo.getAll();
      const now = new Date();
      for (const health of all) {
        if (health.disabledUntil && new Date(health.disabledUntil) <= now) {
          await this.healthRepo.enable(health.skillName);
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
