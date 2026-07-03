import type { Logger } from 'pino';
import type { TodoRepository, ReminderRepository } from '@alfred/storage';
import type { Platform } from '@alfred/types';
import type { MessagingAdapter } from '@alfred/messaging';

/**
 * v924 — Quick-Actions für proaktive Nachrichten (Paket-1-Spam-Fix, Teil 1).
 *
 * Problem: Todo-fällig/überfällig- und Reminder-Nachrichten waren reine Texte —
 * der User konnte nicht schnell reagieren, das Todo blieb offen, und der
 * Todo-Watcher (1×/Tag) sowie die Reasoning-Engine (~alle 12h) wiederholten
 * dieselbe Erinnerung endlos (Live-Befund: 45 offene Sensor-Batterie-Todos).
 *
 * Lösung: Die Nachrichten tragen Inline-Buttons (Telegram callback_query kommt
 * als Message-Text zurück, siehe telegram.ts:147). Dieses Handling fängt die
 * Callback-Daten VOR dem LLM ab (analog zum confirm:-Handler):
 *   todo:<id>:done      → Todo erledigen (beendet die tägliche Wiederholung)
 *   todo:<id>:snooze    → Fälligkeit +24h
 *   reminder:<id>:ok    → Bestätigung (keine Aktion nötig)
 *   reminder:<id>:snooze1h → neuen Reminder in 1h anlegen
 */
export class QuickActionHandler {
  /** v934 — Social-Freigabe-Buttons (content:<id>:approve|publish|reject). */
  private socialHandlers?: {
    approve: (itemId: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    publish: (itemId: string) => Promise<{ success: boolean; display?: string; error?: string }>;
    reject: (itemId: string) => Promise<{ success: boolean; display?: string; error?: string }>;
  };

  constructor(
    private readonly todoRepo: TodoRepository,
    private readonly reminderRepo: ReminderRepository,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
  ) {}

  setSocialHandlers(handlers: NonNullable<QuickActionHandler['socialHandlers']>): void {
    this.socialHandlers = handlers;
  }

  /** @returns true wenn die Nachricht eine Quick-Action war (Pipeline stoppt vor dem LLM). */
  async handle(chatId: string, platform: Platform, text: string): Promise<boolean> {
    const m = (text ?? '').trim().match(/^(todo|reminder|content):([0-9a-fA-F-]{8,40}):(done|snooze|ok|snooze1h|approve|publish|reject)$/);
    if (!m) return false;
    const [, kind, id, action] = m;

    const adapter = this.adapters.get(platform);
    const reply = async (t: string) => { try { await adapter?.sendMessage(chatId, t); } catch { /* non-fatal */ } };

    try {
      if (kind === 'todo') {
        const todo = await this.todoRepo.getById(id);
        if (!todo) { await reply('⚠️ Todo nicht (mehr) gefunden — evtl. bereits erledigt.'); return true; }
        if (todo.completed) { await reply(`✅ „${todo.title}" ist bereits erledigt.`); return true; }
        if (action === 'done') {
          await this.todoRepo.complete(todo.id);
          this.logger.info({ todoId: todo.id }, 'v924 quick-action: todo completed');
          await reply(`✅ Erledigt: ${todo.title}`);
          return true;
        }
        if (action === 'snooze') {
          const base = todo.dueDate ? new Date(todo.dueDate).getTime() : Date.now();
          const next = new Date(Math.max(base, Date.now()) + 24 * 3600_000);
          await this.todoRepo.update(todo.id, todo.userId, { dueDate: next.toISOString() });
          this.logger.info({ todoId: todo.id, next: next.toISOString() }, 'v924 quick-action: todo snoozed');
          await reply(`⏰ Auf ${next.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} verschoben: ${todo.title}`);
          return true;
        }
      }

      // v934 — Social-Freigabe: approve = freigeben (Engine published zum Termin),
      // publish = sofort veröffentlichen, reject = ablehnen (Streak-Reset im Skill)
      if (kind === 'content') {
        if (!this.socialHandlers) { await reply('⚠️ Social-Modul nicht verfügbar.'); return true; }
        const fn = action === 'approve' ? this.socialHandlers.approve
          : action === 'publish' ? this.socialHandlers.publish
          : action === 'reject' ? this.socialHandlers.reject
          : undefined;
        if (!fn) return false;
        const r = await fn(id);
        this.logger.info({ itemId: id, action, ok: r.success }, 'v934 quick-action: content');
        await reply(r.success ? (r.display ?? '✅ Erledigt.') : `⚠️ ${r.error ?? 'Aktion fehlgeschlagen'}`);
        return true;
      }

      if (kind === 'reminder') {
        if (action === 'ok') {
          await reply('👍');
          return true;
        }
        if (action === 'snooze1h') {
          const orig = await this.reminderRepo.getById(id);
          if (!orig) { await reply('⚠️ Reminder nicht mehr gefunden.'); return true; }
          const at = new Date(Date.now() + 3600_000);
          await this.reminderRepo.create(orig.userId, orig.platform, orig.chatId, orig.message, at);
          this.logger.info({ reminderId: id }, 'v924 quick-action: reminder snoozed 1h');
          await reply(`⏰ Erinnere in 1 Stunde erneut: ${orig.message.slice(0, 80)}`);
          return true;
        }
      }
      return false;
    } catch (err) {
      this.logger.warn({ err, text }, 'v924 quick-action failed');
      await reply('⚠️ Aktion fehlgeschlagen — bitte manuell erledigen.');
      return true; // trotzdem handled: Callback-Daten gehören nie ins LLM
    }
  }
}
