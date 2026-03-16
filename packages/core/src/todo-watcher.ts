import type { Logger } from 'pino';
import type { TodoRepository } from '@alfred/storage';
import type { CalendarNotificationRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';

export interface TodoWatcherConfig {
  /** Minutes before due date to send reminder (default: 30) */
  minutesBefore?: number;
  /** Also check for overdue todos once per hour (default: true) */
  overdueCheck?: boolean;
}

export class TodoWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs = 60_000;
  private readonly minutesBefore: number;
  private readonly overdueCheck: boolean;
  private lastOverdueCheck = 0;

  constructor(
    private readonly todoRepo: TodoRepository,
    private readonly notifRepo: CalendarNotificationRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    config: TodoWatcherConfig,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
    private readonly ownerUserId?: string,
  ) {
    this.minutesBefore = config.minutesBefore ?? 30;
    this.overdueCheck = config.overdueCheck ?? true;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info({ minutesBefore: this.minutesBefore }, 'Todo watcher started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Todo watcher stopped');
  }

  private async tick(): Promise<void> {
    try {
      // Upcoming todos within vorlauf window
      const windowEnd = new Date(Date.now() + this.minutesBefore * 60_000);
      const upcoming = await this.todoRepo.getDueInWindow(windowEnd.toISOString(), this.ownerUserId);

      for (const todo of upcoming) {
        await this.notify(todo.id, todo.title, todo.dueDate!, todo.list, todo.priority, 'upcoming');
      }

      // Overdue check once per hour
      const now = Date.now();
      if (this.overdueCheck && now - this.lastOverdueCheck > 3_600_000) {
        this.lastOverdueCheck = now;
        const overdue = await this.todoRepo.getOverdue(this.ownerUserId);
        for (const todo of overdue) {
          await this.notify(todo.id, todo.title, todo.dueDate!, todo.list, todo.priority, 'overdue');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Todo watcher tick failed');
    }
  }

  private async notify(
    todoId: string, title: string, dueDate: string,
    list: string, priority: string, kind: 'upcoming' | 'overdue',
  ): Promise<void> {
    // For overdue todos: use today's date as dedup anchor so cleanup (which
    // deletes entries older than 24h) won't remove the entry before the day
    // is over.  This limits overdue reminders to at most once per day.
    const notifKey = kind === 'overdue'
      ? `todo:${kind}:${todoId}:${new Date().toISOString().slice(0, 10)}`
      : `todo:${kind}:${todoId}`;
    if (await this.notifRepo.wasNotified(notifKey, this.defaultChatId)) return;

    const due = new Date(dueDate);
    const timeStr = due.toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const icon = kind === 'overdue' ? '\u26A0\uFE0F' : '\u2705';
    const label = kind === 'overdue' ? 'Überfällig' : 'Bald fällig';
    const lines = [
      `${icon} **${label}:** ${title}`,
      `Fällig: ${timeStr}`,
    ];
    if (list !== 'default') lines.push(`Liste: ${list}`);
    if (priority !== 'normal') lines.push(`Priorität: ${priority}`);

    const adapter = this.adapters.get(this.defaultPlatform);
    if (!adapter) return;

    // For overdue todos store current timestamp as event_start so that
    // cleanup (>24h) won't delete the entry during the same day.
    const storedEventStart = kind === 'overdue' ? new Date().toISOString() : dueDate;

    try {
      await adapter.sendMessage(this.defaultChatId, lines.join('\n'));
      await this.notifRepo.markNotified(notifKey, this.defaultChatId, this.defaultPlatform, storedEventStart);
      this.logger.info({ todoId, title, kind }, 'Todo reminder sent');
      this.activityLogger?.logCalendarNotify({
        eventId: notifKey, eventTitle: `[Todo] ${title}`,
        platform: this.defaultPlatform, chatId: this.defaultChatId, outcome: 'success',
      });
    } catch (err) {
      this.logger.error({ err, todoId }, 'Failed to send todo reminder');
      this.activityLogger?.logCalendarNotify({
        eventId: notifKey, eventTitle: `[Todo] ${title}`,
        platform: this.defaultPlatform, chatId: this.defaultChatId, outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
