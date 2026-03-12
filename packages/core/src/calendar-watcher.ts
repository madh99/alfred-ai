import type { Logger } from 'pino';
import type { CalendarNotificationRepository } from '@alfred/storage';
import type { CalendarProvider, CalendarEvent } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, CalendarConfig } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';

export class CalendarWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs = 60_000;
  private readonly minutesBefore: number;
  private lastCleanup = 0;

  constructor(
    private readonly calendarProvider: CalendarProvider,
    private readonly notifRepo: CalendarNotificationRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    private readonly config: NonNullable<CalendarConfig['vorlauf']>,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {
    this.minutesBefore = config.minutesBefore ?? 15;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info({ minutesBefore: this.minutesBefore }, 'Calendar watcher started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Calendar watcher stopped');
  }

  private async tick(): Promise<void> {
    try {
      // Cleanup old notifications once per hour
      const now = Date.now();
      if (now - this.lastCleanup > 3_600_000) {
        const cutoff = new Date(now - 24 * 3_600_000).toISOString();
        this.notifRepo.cleanup(cutoff);
        this.lastCleanup = now;
      }

      const windowStart = new Date();
      const windowEnd = new Date(windowStart.getTime() + this.minutesBefore * 60_000);

      const events = await this.calendarProvider.listEvents(windowStart, windowEnd);

      for (const event of events) {
        await this.processEvent(event);
      }
    } catch (err) {
      this.logger.error({ err }, 'Calendar watcher tick failed');
    }
  }

  private async processEvent(event: CalendarEvent): Promise<void> {
    // Skip all-day events
    if (event.allDay) return;

    // Check if already notified
    if (this.notifRepo.wasNotified(event.id, this.defaultChatId)) return;

    // Check if event starts within the vorlauf window
    const now = Date.now();
    const eventStartMs = event.start.getTime();
    const minutesUntil = (eventStartMs - now) / 60_000;

    if (minutesUntil > this.minutesBefore || minutesUntil < 0) return;

    // Build notification
    const lines: string[] = [];
    const minutesDisplay = Math.round(minutesUntil);
    const timeStr = event.start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

    lines.push(`\uD83D\uDCC5 In ${minutesDisplay} Min: ${event.title}`);
    lines.push(`Zeit: ${timeStr} \u2013 ${event.end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);

    if (event.location) {
      lines.push(`Ort: ${event.location}`);
    }
    if (event.description) {
      const plain = event.description
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (plain.length > 0) {
        lines.push(`\n${plain.slice(0, 200)}`);
      }
    }

    const adapter = this.adapters.get(this.defaultPlatform);
    if (adapter) {
      try {
        await adapter.sendMessage(this.defaultChatId, lines.join('\n'));
        this.notifRepo.markNotified(event.id, this.defaultChatId, this.defaultPlatform, event.start.toISOString());
        this.logger.info({ eventId: event.id, title: event.title }, 'Calendar vorlauf notification sent');
        this.activityLogger?.logCalendarNotify({
          eventId: event.id, eventTitle: event.title,
          platform: this.defaultPlatform, chatId: this.defaultChatId, outcome: 'success',
        });
      } catch (err) {
        this.logger.error({ err, eventId: event.id }, 'Failed to send calendar notification');
        this.activityLogger?.logCalendarNotify({
          eventId: event.id, eventTitle: event.title,
          platform: this.defaultPlatform, chatId: this.defaultChatId, outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
