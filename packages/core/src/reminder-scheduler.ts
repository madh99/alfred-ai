import type { Logger } from 'pino';
import type { ReminderRepository } from '@alfred/storage';
import type { Platform } from '@alfred/types';

export type SendMessageFn = (platform: Platform, chatId: string, text: string) => Promise<void>;

export class ReminderScheduler {
  private intervalId?: ReturnType<typeof setInterval>;
  private readonly checkIntervalMs: number;

  constructor(
    private readonly reminderRepo: ReminderRepository,
    private readonly sendMessage: SendMessageFn,
    private readonly logger: Logger,
    checkIntervalMs = 15_000,
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
    this.logger.info('Reminder scheduler stopped');
  }

  private async checkDueReminders(): Promise<void> {
    try {
      const due = this.reminderRepo.getDue();
      for (const reminder of due) {
        try {
          await this.sendMessage(
            reminder.platform as Platform,
            reminder.chatId,
            `\u23F0 Reminder: ${reminder.message}`,
          );
          this.reminderRepo.markFired(reminder.id);
          this.logger.info({ reminderId: reminder.id }, 'Reminder fired');
        } catch (err) {
          this.logger.error({ err, reminderId: reminder.id }, 'Failed to send reminder');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error checking due reminders');
    }
  }
}
