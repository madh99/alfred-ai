import type { Logger } from 'pino';
import type { WatchRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, Watch } from '@alfred/types';
import type { UserRepository } from '@alfred/storage';
import { extractField, evaluateCondition } from './condition-evaluator.js';
import { buildSkillContext } from './context-factory.js';

const OPERATOR_LABELS: Record<string, string> = {
  lt: '<', gt: '>', lte: '<=', gte: '>=',
  eq: '=', neq: '!=',
  contains: 'contains', not_contains: 'not contains',
  changed: 'changed', increased: 'increased', decreased: 'decreased',
};

export class WatchEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly watchRepo: WatchRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info('Watch engine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Watch engine stopped');
  }

  private async tick(): Promise<void> {
    try {
      const dueWatches = this.watchRepo.getDue();

      for (const watch of dueWatches) {
        try {
          await this.checkWatch(watch);
        } catch (err) {
          this.logger.error({ err, watchId: watch.id }, 'Failed to check watch');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error during watch engine tick');
    }
  }

  private async checkWatch(watch: Watch): Promise<void> {
    const now = new Date().toISOString();
    this.logger.debug({ watchId: watch.id, name: watch.name, skill: watch.skillName }, 'Checking watch');

    // Execute the skill
    const skill = this.skillRegistry.get(watch.skillName);
    if (!skill) {
      this.logger.warn({ watchId: watch.id, skillName: watch.skillName }, 'Unknown skill for watch');
      this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: watch.lastValue });
      return;
    }

    const { context } = buildSkillContext(this.users, {
      platformUserId: watch.chatId,
      platform: watch.platform as Platform,
      chatId: watch.chatId,
      chatType: 'dm',
    });

    const result = await this.skillSandbox.execute(skill, watch.skillParams, context);

    if (!result.success) {
      this.logger.warn({ watchId: watch.id, error: result.error }, 'Watch skill execution failed');
      this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: watch.lastValue });
      return;
    }

    // Extract field and evaluate condition
    const currentValue = extractField(result.data, watch.condition.field);
    const lastValue = watch.lastValue !== null ? JSON.parse(watch.lastValue) : null;

    const { triggered, displayValue } = evaluateCondition(
      currentValue,
      watch.condition.operator,
      watch.condition.value,
      lastValue,
    );

    const newLastValue = JSON.stringify(currentValue);

    if (triggered && this.isCooldownExpired(watch)) {
      // Send alert
      const alertText = watch.messageTemplate
        ?? this.formatAlert(watch, displayValue);

      const adapter = this.adapters.get(watch.platform as Platform);
      if (adapter) {
        try {
          await adapter.sendMessage(watch.chatId, alertText);
          this.logger.info({ watchId: watch.id, name: watch.name, value: displayValue }, 'Watch alert sent');
        } catch (err) {
          this.logger.error({ err, watchId: watch.id }, 'Failed to send watch alert');
        }
      }

      this.watchRepo.updateAfterCheck(watch.id, {
        lastCheckedAt: now,
        lastValue: newLastValue,
        lastTriggeredAt: now,
      });
    } else {
      this.watchRepo.updateAfterCheck(watch.id, {
        lastCheckedAt: now,
        lastValue: newLastValue,
      });
    }
  }

  private isCooldownExpired(watch: Watch): boolean {
    if (!watch.lastTriggeredAt) return true;
    const cooldownMs = watch.cooldownMinutes * 60_000;
    const elapsed = Date.now() - new Date(watch.lastTriggeredAt).getTime();
    return elapsed >= cooldownMs;
  }

  private formatAlert(watch: Watch, displayValue: string): string {
    const op = OPERATOR_LABELS[watch.condition.operator] ?? watch.condition.operator;
    const thresholdStr = watch.condition.value != null ? ` ${op} ${watch.condition.value}` : ` ${op}`;
    return `\u26A1 Watch Alert: ${watch.name}\nBedingung erf\u00FCllt: ${watch.condition.field}${thresholdStr}\nAktueller Wert: ${displayValue}`;
  }
}
