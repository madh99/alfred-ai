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
      // Send alert — append context even when using a custom template
      let alertText = watch.messageTemplate
        ?? this.formatAlert(watch, displayValue, result.data);

      if (watch.messageTemplate && result.data && typeof result.data === 'object') {
        const context = this.formatResultContext(result.data as Record<string, unknown>, watch.condition.field);
        if (context) alertText += '\n\n' + context;
      }

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

  private formatAlert(watch: Watch, displayValue: string, resultData?: unknown): string {
    const op = OPERATOR_LABELS[watch.condition.operator] ?? watch.condition.operator;
    const thresholdStr = watch.condition.value != null ? ` ${op} ${watch.condition.value}` : ` ${op}`;
    const lines = [
      `\u26A1 Watch Alert: ${watch.name}`,
      `Bedingung erf\u00FCllt: ${watch.condition.field}${thresholdStr}`,
      `Aktueller Wert: ${displayValue}`,
    ];

    // Enrich alert with context from result data
    if (resultData && typeof resultData === 'object') {
      const data = resultData as Record<string, unknown>;
      const detail = this.formatResultContext(data, watch.condition.field);
      if (detail) lines.push('', detail);
    }

    return lines.join('\n');
  }

  /**
   * Build human-readable context from structured result data.
   * Recognizes common patterns (marketplace listings, arrays with items, etc.)
   */
  private formatResultContext(data: Record<string, unknown>, conditionField: string): string | null {
    // Marketplace-style: has listings array
    if (Array.isArray(data.listings) && data.listings.length > 0) {
      const listings = data.listings as Array<Record<string, unknown>>;
      // Sort by price ascending, show cheapest 3
      const withPrice = listings
        .filter(l => typeof l.price === 'number')
        .sort((a, b) => (a.price as number) - (b.price as number));
      const top = withPrice.slice(0, 3);
      if (top.length === 0) return null;

      const lines = [`G\u00FCnstigste ${top.length}:`];
      for (const l of top) {
        const title = String(l.title ?? '').slice(0, 60);
        const price = typeof l.price === 'number' ? `${l.price}\u00A0\u20AC` : 'k.A.';
        const loc = l.location ? ` \u2014 ${l.location}` : '';
        const url = l.url ? `\n  ${l.url}` : '';
        lines.push(`\u2022 ${title} \u2014 ${price}${loc}${url}`);
      }
      if (typeof data.count === 'number') {
        lines.push(`\nInsgesamt: ${data.count} Inserate`);
      }
      return lines.join('\n');
    }

    // Marketplace compare-style: has cheapest array
    if (Array.isArray(data.cheapest) && data.cheapest.length > 0) {
      const cheapest = data.cheapest as Array<Record<string, unknown>>;
      const lines = [`G\u00FCnstigste ${Math.min(cheapest.length, 3)}:`];
      for (const l of cheapest.slice(0, 3)) {
        const title = String(l.title ?? '').slice(0, 60);
        const price = typeof l.price === 'number' ? `${l.price}\u00A0\u20AC` : 'k.A.';
        const url = l.url ? `\n  ${l.url}` : '';
        lines.push(`\u2022 ${title} \u2014 ${price}${url}`);
      }
      return lines.join('\n');
    }

    return null;
  }
}
