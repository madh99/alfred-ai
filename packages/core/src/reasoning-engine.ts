import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { Platform, ReasoningConfig } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import type { MessagingAdapter } from '@alfred/messaging';
import type {
  TodoRepository,
  WatchRepository,
  MemoryRepository,
  ActivityRepository,
  SkillHealthRepository,
  CalendarNotificationRepository,
  UserRepository,
} from '@alfred/storage';
import type { SkillRegistry, SkillSandbox, CalendarProvider } from '@alfred/skills';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';

/** Schedule run-hours for the 'morning_noon_evening' preset. */
const MNE_HOURS = [7, 12, 18];

/** Maximum tokens for reasoning response. */
const MAX_OUTPUT_TOKENS = 1024;

interface ReasoningContext {
  dateTime: string;
  events: string;
  todos: string;
  watches: string;
  memories: string;
  activity: string;
  weather: string;
  energy: string;
  skillHealth: string;
}

export class ReasoningEngine {
  private tickTimer?: ReturnType<typeof setInterval>;
  private lastRunHour = -1;
  private readonly enabled: boolean;
  private readonly schedule: ReasoningConfig['schedule'];
  private readonly tier: 'fast' | 'default';
  private readonly deduplicationHours: number;

  constructor(
    private readonly calendarProvider: CalendarProvider | undefined,
    private readonly todoRepo: TodoRepository,
    private readonly watchRepo: WatchRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly skillHealthRepo: SkillHealthRepository,
    private readonly notifRepo: CalendarNotificationRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly llm: LLMProvider,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly userRepo: UserRepository,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    config: ReasoningConfig | undefined,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
    private readonly defaultLocation?: string,
  ) {
    this.enabled = config?.enabled !== false;
    this.schedule = config?.schedule ?? 'morning_noon_evening';
    this.tier = config?.tier ?? 'fast';
    this.deduplicationHours = config?.deduplicationHours ?? 12;
  }

  start(): void {
    if (!this.enabled) {
      this.logger.info('Reasoning engine disabled');
      return;
    }
    // Tick every 60 seconds, decide inside whether to run
    this.tickTimer = setInterval(() => this.tick(), 60_000);
    this.logger.info({ schedule: this.schedule, tier: this.tier }, 'Reasoning engine started');
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private shouldRun(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    switch (this.schedule) {
      case 'morning_noon_evening':
        // Run at the first tick of each target hour (within first minute)
        if (MNE_HOURS.includes(hour) && minute === 0 && this.lastRunHour !== hour) {
          return true;
        }
        return false;

      case 'hourly':
        if (minute === 0 && this.lastRunHour !== hour) return true;
        return false;

      case 'half_hourly':
        // Tolerance window: fire at :00/:30 or :01/:31 (event loop delay tolerance)
        if ((minute <= 1 || (minute >= 30 && minute <= 31)) && this.lastRunHour !== hour * 100 + (minute < 2 ? 0 : 30)) return true;
        return false;

      default:
        return false;
    }
  }

  private markRun(): void {
    const now = new Date();
    if (this.schedule === 'half_hourly') {
      this.lastRunHour = now.getHours() * 100 + now.getMinutes();
    } else {
      this.lastRunHour = now.getHours();
    }
  }

  private async tick(): Promise<void> {
    if (!this.shouldRun()) return;
    this.markRun();

    try {
      this.logger.info('Reasoning pass starting');
      const startMs = Date.now();

      const context = await this.collectContext();
      const prompt = this.buildPrompt(context);
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: MAX_OUTPUT_TOKENS,
        tier: this.tier,
      });

      const text = response.content.trim();
      const durationMs = Date.now() - startMs;

      // Filter: no insights
      if (!text || text === 'KEINE_INSIGHTS' || text.length < 10) {
        this.logger.info({ durationMs }, 'Reasoning pass: no insights');
        this.activityLogger?.logScheduledExec({
          actionId: 'reasoning-engine', actionName: 'Reasoning Engine',
          platform: this.defaultPlatform, chatId: this.defaultChatId,
          userId: this.defaultChatId, outcome: 'success', durationMs,
        });
        return;
      }

      // Dedup: hash the insight text
      const insights = this.parseInsights(text);
      const newInsights = insights.filter(insight => !this.wasRecentlySent(insight));

      if (newInsights.length === 0) {
        this.logger.info({ durationMs, total: insights.length }, 'Reasoning pass: all insights deduplicated');
        return;
      }

      // Send to user
      const message = `\u{1F4A1} **Alfred Insights**\n\n${newInsights.join('\n\n')}`;
      const adapter = this.adapters.get(this.defaultPlatform);
      if (adapter) {
        await adapter.sendMessage(this.defaultChatId, message);
        // Mark as sent
        for (const insight of newInsights) {
          this.markSent(insight);
        }
        this.logger.info({ durationMs, insights: newInsights.length }, 'Reasoning pass: insights sent');
      }

      this.activityLogger?.logScheduledExec({
        actionId: 'reasoning-engine', actionName: 'Reasoning Engine',
        platform: this.defaultPlatform, chatId: this.defaultChatId,
        userId: this.defaultChatId, outcome: 'success', durationMs,
      });
    } catch (err) {
      this.logger.error({ err }, 'Reasoning pass failed');
      this.activityLogger?.logScheduledExec({
        actionId: 'reasoning-engine', actionName: 'Reasoning Engine',
        platform: this.defaultPlatform, chatId: this.defaultChatId,
        userId: this.defaultChatId, outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Data Collection ─────────────────────────────────────────

  private async collectContext(): Promise<ReasoningContext> {
    const now = new Date();
    const dateTime = now.toLocaleString('de-AT', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    // Parallel: calendar + weather + energy (async), rest is sync SQLite
    const [events, weather, energy] = await Promise.all([
      this.fetchCalendar(now),
      this.fetchSkillData('weather', { action: 'current', ...(this.defaultLocation ? { location: this.defaultLocation } : {}) }),
      this.fetchSkillData('energy_price', { action: 'current' }),
    ]);

    // Sync SQLite queries
    const todos = this.fetchTodos();
    const watches = this.fetchWatches();
    const memories = this.fetchMemories();
    const activity = this.fetchActivity();
    const skillHealth = this.fetchSkillHealth();

    return { dateTime, events, todos, watches, memories, activity, weather, energy, skillHealth };
  }

  private async fetchCalendar(now: Date): Promise<string> {
    if (!this.calendarProvider) return '(Kalender nicht konfiguriert)';
    try {
      const start = now;
      const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const events = await this.calendarProvider.listEvents(start, end);
      if (events.length === 0) return 'Keine Termine in den nächsten 24h.';
      return events.map(e => {
        const time = e.start instanceof Date
          ? e.start.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
          : String(e.start);
        const loc = e.location ? ` (${e.location})` : '';
        return `- ${time}: ${e.title ?? 'Termin'}${loc}`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: calendar fetch failed');
      return '(Kalender-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchSkillData(skillName: string, input: Record<string, unknown>): Promise<string> {
    const skill = this.skillRegistry.get(skillName);
    if (!skill) return `(${skillName} nicht verfügbar)`;
    try {
      const { context } = buildSkillContext(this.userRepo, {
        userId: this.defaultChatId,
        platform: this.defaultPlatform,
        chatId: this.defaultChatId,
        chatType: 'dm',
      });
      const result = await this.skillSandbox.execute(skill, input, context);
      if (!result.success) return `(${skillName}: ${result.error})`;
      return result.display ?? JSON.stringify(result.data);
    } catch (err) {
      this.logger.warn({ err, skillName }, 'Reasoning: skill fetch failed');
      return `(${skillName}-Abfrage fehlgeschlagen)`;
    }
  }

  private fetchTodos(): string {
    try {
      const overdue = this.todoRepo.getOverdue();
      const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const upcoming = this.todoRepo.getDueInWindow(windowEnd);
      const allOpen = this.todoRepo.list(this.defaultChatId);

      const lines: string[] = [];
      if (overdue.length > 0) {
        lines.push(`Überfällig (${overdue.length}):`);
        for (const t of overdue.slice(0, 10)) {
          lines.push(`  - [${t.priority}] ${t.title} (fällig: ${t.dueDate})`);
        }
      }
      if (upcoming.length > 0) {
        lines.push(`Bald fällig (${upcoming.length}):`);
        for (const t of upcoming.slice(0, 10)) {
          lines.push(`  - [${t.priority}] ${t.title} (fällig: ${t.dueDate})`);
        }
      }
      if (allOpen.length > 0) {
        lines.push(`Gesamt offene Todos: ${allOpen.length}`);
      }
      return lines.length > 0 ? lines.join('\n') : 'Keine offenen Todos.';
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: todo fetch failed');
      return '(Todo-Abfrage fehlgeschlagen)';
    }
  }

  private fetchWatches(): string {
    try {
      const watches = this.watchRepo.getEnabled();
      if (watches.length === 0) return 'Keine aktiven Watches.';
      return watches.map(w => {
        const lastVal = w.lastValue
          ? (() => { try { const p = JSON.parse(w.lastValue!); return typeof p === 'object' ? JSON.stringify(p).slice(0, 200) : String(p); } catch { return w.lastValue!.slice(0, 200); } })()
          : 'noch kein Ergebnis';
        const lastTrigger = w.lastTriggeredAt
          ? `letzter Alert: ${new Date(w.lastTriggeredAt).toLocaleString('de-AT')}`
          : 'noch nie ausgelöst';
        return `- "${w.name}" (${w.skillName}, alle ${w.intervalMinutes} Min) → ${lastTrigger}\n  Letzter Wert: ${lastVal}`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: watch fetch failed');
      return '(Watch-Abfrage fehlgeschlagen)';
    }
  }

  private fetchMemories(): string {
    try {
      const memories = this.memoryRepo.getRecentForPrompt(this.defaultChatId, 30);
      if (memories.length === 0) return 'Keine gespeicherten Erinnerungen.';
      return memories.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: memory fetch failed');
      return '(Memory-Abfrage fehlgeschlagen)';
    }
  }

  private fetchActivity(): string {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const stats = this.activityRepo.stats(since);
      if (stats.length === 0) return 'Keine Aktivität in den letzten 24h.';
      return stats.map(s => `- ${s.eventType} (${s.outcome}): ${s.count}×`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: activity fetch failed');
      return '(Aktivitäts-Abfrage fehlgeschlagen)';
    }
  }

  private fetchSkillHealth(): string {
    try {
      const disabled = this.skillHealthRepo.getDisabled();
      if (disabled.length === 0) return 'Alle Skills aktiv.';
      return disabled.map(s =>
        `- ${s.skillName}: deaktiviert bis ${s.disabledUntil} (${s.consecutiveFails} Fehler: ${s.lastError ?? '?'})`,
      ).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: skill health fetch failed');
      return '(Skill-Health-Abfrage fehlgeschlagen)';
    }
  }

  // ── Prompt Building ─────────────────────────────────────────

  private buildPrompt(ctx: ReasoningContext): string {
    return `Du bist Alfreds Denk-Modul. Deine Aufgabe: Analysiere ALLE folgenden Daten und finde Zusammenhänge, Konflikte, Optimierungen oder Handlungsempfehlungen für den User.

REGELN:
- Nur ECHTE, nicht-offensichtliche Erkenntnisse melden
- KEINE Wiederholung von Fakten die der User schon kennt (z.B. "du hast 3 Termine" ohne Mehrwert)
- KEINE generischen Tipps ("Vergiss nicht zu trinken", "Plane genug Pausen ein")
- Wenn es nichts Relevantes gibt: antworte exakt "KEINE_INSIGHTS"
- Max 5 Insights, priorisiert nach Dringlichkeit
- Jeder Insight: 1-2 Sätze, konkret und actionable
- Schreibe auf Deutsch

BEISPIELE guter Insights:
- "Du hast um 14:00 einen Termin in Linz, aber die RTX 5090 Watch zeigt ein Angebot in Wien — Abholung wäre auf dem Rückweg möglich."
- "3 deiner 5 Todos sind morgen fällig, aber dein Kalender ist voll — eventuell heute Abend erledigen."
- "Strompreis ist bis 15:00 unter 5 ct/kWh — BMW laden wäre jetzt günstig (Akku war beim letzten Check bei 45%)."
- "Der Willhaben-Watch hat seit 3 Tagen keine neuen Treffer — eventuell Suchkriterien erweitern?"
- "Morgen früh -3°C, du hast einen 8:00 Termin — Auto vorheizen einplanen."
- "Du hast 2 überfällige Todos und 3 neue E-Mails zum selben Thema — eventuell zusammenhängend?"

AKTUELLE DATEN:

=== Datum & Uhrzeit ===
${ctx.dateTime}

=== Kalender (nächste 24h) ===
${ctx.events}

=== Offene Todos ===
${ctx.todos}

=== Aktive Watches & letzte Ergebnisse ===
${ctx.watches}

=== Erinnerungen über den User ===
${ctx.memories}

=== Aktivität letzte 24h ===
${ctx.activity}

=== Wetter ===
${ctx.weather}

=== Energiepreise ===
${ctx.energy}

=== Skill-Status ===
${ctx.skillHealth}`;
  }

  // ── Dedup & Parsing ─────────────────────────────────────────

  private parseInsights(text: string): string[] {
    // Split by numbered list (1. ..., 2. ...) or double-newline
    const lines = text.split(/\n{2,}|\n(?=\d+\.\s)/).map(l => l.trim()).filter(l => l.length > 10);
    // If only one block, return as-is
    if (lines.length <= 1) return [text.trim()];
    return lines;
  }

  private insightHash(text: string): string {
    // Hash first 100 chars to catch near-duplicates
    const normalized = text.slice(0, 100).toLowerCase().replace(/\s+/g, ' ');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private wasRecentlySent(insight: string): boolean {
    const hash = this.insightHash(insight);
    const key = `reasoning:${hash}`;
    return this.notifRepo.wasNotified(key, this.defaultChatId);
  }

  private markSent(insight: string): void {
    const hash = this.insightHash(insight);
    const key = `reasoning:${hash}`;
    // Use event_start as expiry marker (dedup window)
    const expiry = new Date(Date.now() + this.deduplicationHours * 60 * 60 * 1000).toISOString();
    this.notifRepo.markNotified(key, this.defaultChatId, this.defaultPlatform, expiry);
  }
}
