import type { Logger } from 'pino';
import type { ConfirmationRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, SkillContext } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';

export class ConfirmationQueue {
  private expireTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly confirmRepo: ConfirmationRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {}

  start(): void {
    // Check for expired confirmations every 60s
    this.expireTimer = setInterval(() => this.expireTick(), 60_000);
  }

  stop(): void {
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
  }

  async enqueue(opts: {
    chatId: string;
    platform: string;
    source: 'watch' | 'scheduled';
    sourceId: string;
    description: string;
    skillName: string;
    skillParams: Record<string, unknown>;
    timeoutMinutes?: number;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + (opts.timeoutMinutes ?? 30) * 60_000).toISOString();

    this.confirmRepo.create({
      chatId: opts.chatId,
      platform: opts.platform,
      source: opts.source,
      sourceId: opts.sourceId,
      description: opts.description,
      skillName: opts.skillName,
      skillParams: opts.skillParams,
      expiresAt,
    });

    const adapter = this.adapters.get(opts.platform as Platform);
    if (adapter) {
      const msg = `\u2753 Best\u00E4tigung erforderlich:\n${opts.description}\n\nAntworte "ja" oder "nein".`;
      try {
        await adapter.sendMessage(opts.chatId, msg);
      } catch (err) {
        this.logger.error({ err }, 'Failed to send confirmation request');
      }
    }
  }

  /**
   * Check if an incoming message is a confirmation response.
   * Returns true if the message was handled (consumed), false if it should proceed normally.
   */
  async checkForConfirmation(chatId: string, platform: string, text: string, context: SkillContext): Promise<boolean> {
    const normalized = text.trim().toLowerCase();
    const isYes = ['ja', 'ok', 'yes', 'best\u00E4tigen', 'j'].includes(normalized);
    const isNo = ['nein', 'no', 'abbrechen', 'n', 'n\u00F6'].includes(normalized);

    if (!isYes && !isNo) return false;

    const pending = this.confirmRepo.findPending(chatId, platform);
    if (!pending) return false;

    const adapter = this.adapters.get(platform as Platform);

    if (isYes) {
      this.confirmRepo.resolve(pending.id, 'approved');

      // Execute the action
      const skill = this.skillRegistry.get(pending.skillName);
      if (skill) {
        try {
          await this.skillSandbox.execute(skill, pending.skillParams, context);
          if (adapter) {
            await adapter.sendMessage(chatId, `\u2705 Aktion ausgef\u00FChrt: ${pending.description}`);
          }
          this.activityLogger?.logConfirmation({
            confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
            source: pending.source, sourceId: pending.sourceId, outcome: 'approved',
            userId: context.userId, platform, chatId,
          });
        } catch (err) {
          this.logger.error({ err, confirmationId: pending.id }, 'Confirmed action failed');
          if (adapter) {
            await adapter.sendMessage(chatId, `\u274C Aktion fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.activityLogger?.logConfirmation({
            confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
            source: pending.source, sourceId: pending.sourceId, outcome: 'error',
            userId: context.userId, platform, chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        if (adapter) {
          await adapter.sendMessage(chatId, `\u274C Skill "${pending.skillName}" nicht gefunden.`);
        }
      }
    } else {
      this.confirmRepo.resolve(pending.id, 'rejected');
      if (adapter) {
        await adapter.sendMessage(chatId, `\u274C Aktion abgelehnt: ${pending.description}`);
      }
      this.activityLogger?.logConfirmation({
        confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
        source: pending.source, sourceId: pending.sourceId, outcome: 'rejected',
        userId: context.userId, platform, chatId,
      });
    }

    return true;
  }

  private async expireTick(): Promise<void> {
    try {
      const expired = this.confirmRepo.expireOld();
      for (const conf of expired) {
        this.activityLogger?.logConfirmation({
          confirmationId: conf.id, skillName: conf.skillName, description: conf.description,
          source: conf.source, sourceId: conf.sourceId, outcome: 'expired',
          platform: conf.platform, chatId: conf.chatId,
        });
        const adapter = this.adapters.get(conf.platform as Platform);
        if (adapter) {
          try {
            await adapter.sendMessage(conf.chatId, `\u23F0 Best\u00E4tigung abgelaufen: ${conf.description}`);
          } catch { /* best effort */ }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Confirmation expire tick failed');
    }
  }
}
