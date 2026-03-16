import type { Logger } from 'pino';
import type { ReminderRepository } from '@alfred/storage';
import type { Platform } from '@alfred/types';

export type SendMessageFn = (platform: Platform, chatId: string, text: string) => Promise<void>;

/** Minimal interface to resolve linked users for cross-platform reminder delivery. */
export interface LinkedUserResolver {
  getMasterUserId(userId: string): Promise<string>;
  getLinkedUsers(masterUserId: string): Promise<{ id: string; platform: string; platformUserId: string }[]>;
  findConversation(platform: string, userId: string): Promise<{ chatId: string } | undefined>;
}

export class ReminderScheduler {
  private intervalId?: ReturnType<typeof setInterval>;
  private readonly checkIntervalMs: number;
  /** Track consecutive send failures per reminder to avoid infinite retry loops. */
  private readonly failCounts = new Map<string, number>();
  private static readonly MAX_SEND_RETRIES = 5;

  constructor(
    private readonly reminderRepo: ReminderRepository,
    private readonly sendMessage: SendMessageFn,
    private readonly logger: Logger,
    checkIntervalMs = 15_000,
    private readonly linkedUsers?: LinkedUserResolver,
    private readonly nodeId: string = 'single',
  ) {
    this.checkIntervalMs = checkIntervalMs;
  }

  start(): void {
    this.logger.info('Reminder scheduler started');
    this.intervalId = setInterval(() => this.checkDueReminders(), this.checkIntervalMs);
    // Also check immediately on start
    this.checkDueReminders();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.failCounts.clear();
    this.logger.info('Reminder scheduler stopped');
  }

  private async checkDueReminders(): Promise<void> {
    try {
      const due = await this.reminderRepo.claimDue(this.nodeId);
      for (const reminder of due) {
        try {
          const text = `\u23F0 Reminder: ${reminder.message}`;
          let delivered = false;

          // Send to the original platform
          try {
            await this.sendMessage(
              reminder.platform as Platform,
              reminder.chatId,
              text,
            );
            delivered = true;
          } catch (primaryErr) {
            this.logger.warn({ err: primaryErr, reminderId: reminder.id }, 'Primary platform delivery failed, trying cross-platform');
          }

          // Also send to all other linked platforms
          if (this.linkedUsers) {
            try {
              const masterUserId = await this.linkedUsers.getMasterUserId(reminder.userId);
              const linked = await this.linkedUsers.getLinkedUsers(masterUserId);
              for (const user of linked) {
                if (user.platform === reminder.platform) continue;
                const conv = await this.linkedUsers.findConversation(user.platform, user.id);
                if (conv) {
                  try {
                    await this.sendMessage(user.platform as Platform, conv.chatId, text);
                    delivered = true;
                  } catch (xErr) {
                    this.logger.debug({ err: xErr, reminderId: reminder.id, platform: user.platform }, 'Cross-platform delivery failed');
                  }
                }
              }
            } catch (err) {
              this.logger.debug({ err, reminderId: reminder.id }, 'Cross-platform user lookup failed');
            }
          }

          if (!delivered) {
            // No platform could deliver — treat as failure for retry
            throw new Error('No platform could deliver reminder');
          }

          await this.reminderRepo.markFired(reminder.id);
          this.failCounts.delete(reminder.id);
          this.logger.info({ reminderId: reminder.id }, 'Reminder fired');
        } catch (err) {
          const fails = (this.failCounts.get(reminder.id) ?? 0) + 1;
          this.failCounts.set(reminder.id, fails);

          if (fails >= ReminderScheduler.MAX_SEND_RETRIES) {
            await this.reminderRepo.markFired(reminder.id);
            this.failCounts.delete(reminder.id);
            this.logger.error(
              { reminderId: reminder.id, attempts: fails, chatId: reminder.chatId },
              'Reminder abandoned after max retries — marked as fired',
            );
          } else {
            this.logger.warn(
              { err, reminderId: reminder.id, attempt: fails, maxRetries: ReminderScheduler.MAX_SEND_RETRIES },
              'Failed to send reminder, will retry',
            );
          }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error checking due reminders');
    }
  }
}
