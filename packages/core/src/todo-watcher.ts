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
  /** v925 — täglicher Duplikat-Dedup-Pass über offene Todos. */
  private lastDedupCheck = 0;

  /** Optional callback when a todo notification is sent (for reasoning triggers). */
  public onTodoNotified?: (todoId: string, title: string, kind: 'upcoming' | 'overdue') => void;

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

      // v925 — Selbstheilung: 1×/Tag semantische Duplikat-Todos schließen.
      // Realfall: 45 offene „Sensor-Batterien"-Todos, weil die Reasoning-Engine
      // dasselbe Todo immer neu formulierte und nichts den Bestand bereinigte.
      if (now - this.lastDedupCheck > 24 * 3_600_000) {
        this.lastDedupCheck = now;
        await this.dedupOpenTodos();
      }
    } catch (err) {
      this.logger.error({ err }, 'Todo watcher tick failed');
    }
  }

  /**
   * v925 — Cluster offener Todos per Keyword-Ähnlichkeit (gleiche Metrik wie
   * der v924-Erstell-Dedup in todo.ts): neuestes Todo je Cluster bleibt, ältere
   * werden als Duplikat geschlossen. Eine Sammel-Meldung an den Owner.
   */
  private async dedupOpenTodos(): Promise<void> {
    if (!this.ownerUserId) return;
    try {
      const open = await this.todoRepo.list(this.ownerUserId);
      if (open.length < 2) return;
      const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-zä-ü0-9]+/i).filter(w => w.length >= 4));
      const sorted = [...open].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')); // neueste zuerst
      const kept: Array<{ title: string; tok: Set<string> }> = [];
      const closed: string[] = [];

      for (const todo of sorted) {
        const tok = tokens(todo.title);
        let dupOf: string | null = null;
        for (const k of kept) {
          let common = 0;
          for (const t of tok) if (k.tok.has(t)) common++;
          const minSize = Math.min(tok.size, k.tok.size);
          if (common >= 3 || (common >= 2 && minSize > 0 && common / minSize >= 0.6)) { dupOf = k.title; break; }
        }
        if (dupOf) {
          await this.todoRepo.complete(todo.id);
          closed.push(todo.title);
          this.logger.info({ todoId: todo.id, title: todo.title, dupOf }, 'v925 todo-dedup: duplicate closed');
        } else {
          kept.push({ title: todo.title, tok });
        }
      }

      if (closed.length > 0) {
        const adapter = this.adapters.get(this.defaultPlatform);
        const list = closed.slice(0, 6).map(t => `• ${t.slice(0, 70)}`).join('\n');
        const more = closed.length > 6 ? `\n… und ${closed.length - 6} weitere` : '';
        try {
          await adapter?.sendMessage(this.defaultChatId,
            `🧹 **${closed.length} Duplikat-Todo${closed.length === 1 ? '' : 's'} automatisch geschlossen** (jeweils neueste Version bleibt offen):\n${list}${more}`);
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      this.logger.warn({ err }, 'v925 todo-dedup failed (non-fatal)');
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
    // HA-safe: Atomic claim-first — only the winning node sends the notification.
    const storedEventStart = kind === 'overdue' ? new Date().toISOString() : dueDate;
    const claimed = await this.notifRepo.claimNotification(notifKey, this.defaultChatId, this.defaultPlatform, storedEventStart);
    if (!claimed) return; // Already claimed by other node

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

    try {
      // v924 — Quick-Action-Buttons: ohne sie konnte der User nicht reagieren,
      // das Todo blieb offen und der Overdue-Alarm wiederholte sich täglich.
      await adapter.sendMessage(this.defaultChatId, lines.join('\n'), {
        replyMarkup: {
          inlineKeyboard: [[
            { text: '✅ Erledigt', callbackData: `todo:${todoId}:done` },
            { text: '⏰ Morgen', callbackData: `todo:${todoId}:snooze` },
          ]],
        },
      });
      // markNotified already done by claimNotification above
      this.logger.info({ todoId, title, kind }, 'Todo reminder sent');
      this.onTodoNotified?.(todoId, title, kind);
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
