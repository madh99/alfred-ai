import type { Logger } from 'pino';
import type { ConfirmationRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, SkillContext } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';
import type { FeedbackService } from './feedback/feedback-service.js';

export class ConfirmationQueue {
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private feedbackService?: FeedbackService;

  constructor(
    private readonly confirmRepo: ConfirmationRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {}

  setFeedbackService(service: FeedbackService): void {
    this.feedbackService = service;
  }

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
    source: 'watch' | 'scheduled' | 'reasoning';
    sourceId: string;
    description: string;
    skillName: string;
    skillParams: Record<string, unknown>;
    timeoutMinutes?: number;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + (opts.timeoutMinutes ?? 30) * 60_000).toISOString();

    const confirmation = await this.confirmRepo.create({
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
      const confirmId = confirmation.id;
      const msg = `\u2753 Best\u00E4tigung erforderlich:\n${opts.description}\n\nAntworte "ja" oder "nein".`;
      try {
        // Use inline buttons for Telegram
        if (opts.platform === 'telegram' && confirmId) {
          await adapter.sendMessage(opts.chatId, msg, {
            replyMarkup: {
              inlineKeyboard: [[
                { text: '\u2705 Approve', callbackData: `confirm:${confirmId}:approve` },
                { text: '\u274C Reject', callbackData: `confirm:${confirmId}:reject` },
              ]],
            },
          });
        } else {
          await adapter.sendMessage(opts.chatId, msg);
        }
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

    // Handle inline keyboard callback data: confirm:<id>:approve / confirm:<id>:reject
    const callbackMatch = /^confirm:([^:]+):(approve|reject)$/.exec(normalized);
    const isYes = callbackMatch ? callbackMatch[2] === 'approve' : ['ja', 'ok', 'yes', 'best\u00E4tigen', 'j'].includes(normalized);
    const isNo = callbackMatch ? callbackMatch[2] === 'reject' : ['nein', 'no', 'abbrechen', 'n', 'n\u00F6'].includes(normalized);

    if (!isYes && !isNo) return false;

    // Use specific confirmation ID from callback button, or fall back to most recent pending
    const pending = callbackMatch
      ? await this.confirmRepo.getById(callbackMatch[1])
      : await this.confirmRepo.findPending(chatId, platform);
    if (!pending) return false;

    const adapter = this.adapters.get(platform as Platform);

    if (isYes) {
      await this.confirmRepo.resolve(pending.id, 'approved');

      // Auto-resolve other pending confirmations for the same skill+topic (prevent "expired" noise)
      // Only resolve if descriptions share keywords (not ALL same-skill confirmations)
      try {
        const allPending = await this.confirmRepo.findAllPending(chatId, platform);
        const approvedWords = new Set(pending.description.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
        for (const other of allPending) {
          if (other.id === pending.id) continue;
          if (other.skillName !== pending.skillName) continue;
          // Check if descriptions share ≥2 significant words (same topic)
          const otherWords = other.description.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
          const shared = otherWords.filter(w => approvedWords.has(w)).length;
          if (shared >= 2) {
            await this.confirmRepo.resolve(other.id, 'expired');
          }
        }
      } catch { /* best effort */ }

      // Execute the action
      const skill = this.skillRegistry.get(pending.skillName);
      if (skill) {
        try {
          const result = await this.skillSandbox.execute(skill, pending.skillParams, context);
          if (result && !result.success) {
            throw new Error(result.error ?? 'Skill returned success=false');
          }
          if (adapter) {
            // Show full skill result (like a normal chat interaction), not just "Ausgeführt"
            const display = result?.display ?? result?.data ? String(result.display ?? JSON.stringify(result.data)) : '';
            const msg = display
              ? `\u2705 **${pending.description}**\n\n${display}`
              : `\u2705 Aktion ausgef\u00FChrt: ${pending.description}`;
            await adapter.sendMessage(chatId, msg);
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
      await this.confirmRepo.resolve(pending.id, 'rejected');
      if (adapter) {
        await adapter.sendMessage(chatId, `\u274C Aktion abgelehnt: ${pending.description}`);
      }
      this.activityLogger?.logConfirmation({
        confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
        source: pending.source, sourceId: pending.sourceId, outcome: 'rejected',
        userId: context.userId, platform, chatId,
      });
      // Fire-and-forget feedback capture
      this.feedbackService?.onWatchRejected({
        userId: context.userId,
        watchId: pending.sourceId,
        watchName: pending.description,
        skillName: pending.skillName,
        skillParams: (pending as unknown as Record<string, unknown>).skillParams as Record<string, unknown> ?? {},
        description: pending.description,
      });
    }

    return true;
  }

  private async expireTick(): Promise<void> {
    try {
      const expired = await this.confirmRepo.expireOld();
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
