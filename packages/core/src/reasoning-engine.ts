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
  FeedbackRepository,
  AsyncDbAdapter,
} from '@alfred/storage';
import type { SkillRegistry, SkillSandbox, CalendarProvider } from '@alfred/skills';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';
import type { ConfirmationQueue } from './confirmation-queue.js';
import { InsightTracker } from './insight-tracker.js';

/** Schedule run-hours for the 'morning_noon_evening' preset. */
const MNE_HOURS = [7, 12, 18];

/** Maximum tokens for reasoning response. */
const MAX_OUTPUT_TOKENS = 1536;

/** Marker separating text insights from structured actions in LLM response. */
const ACTION_MARKER = '---ACTIONS---';

/** Check if LLM response means "no insights" — catches variants beyond exact "KEINE_INSIGHTS". */
function isNoInsights(text: string): boolean {
  if (!text || text.length < 10) return true;
  if (text === 'KEINE_INSIGHTS') return true;
  const lower = text.toLowerCase();
  // LLM sometimes explains WHY there are no insights instead of just saying KEINE_INSIGHTS
  if (lower.includes('keine_insights')) return true;
  if (lower.includes('keine insights')) return true;
  if (lower.includes('nichts relevantes') || lower.includes('keine relevanten')) return true;
  if (lower.includes('kein zusammenhang') || lower.includes('keinen zusammenhang')) return true;
  if (lower.includes('kein bezug') || lower.includes('keinen bezug')) return true;
  if (lower.includes('keine handlungsempfehlung')) return true;
  if (lower.includes('keine verbindung') || lower.includes('keine querverbindung')) return true;
  // If it says "no insights" in a longer explanation, still treat as no insights
  if ((lower.includes('keine') || lower.includes('kein')) &&
      (lower.includes('insight') || lower.includes('erkenntnis') || lower.includes('hinweis')) &&
      !lower.includes('---actions---')) return true;
  return false;
}

type ReasoningActionType = 'execute_skill' | 'create_reminder';

interface ProposedAction {
  type: ReasoningActionType;
  description: string;
  skillName: string;
  skillParams: Record<string, unknown>;
}

interface ParsedReasoningResponse {
  insights: string[];
  actions: ProposedAction[];
}

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
  feedback: string;
  charger: string;
  mealPlan: string;
  travel: string;
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
    private readonly feedbackRepo?: FeedbackRepository,
    private readonly confirmationQueue?: ConfirmationQueue,
    private readonly nodeId: string = 'single',
    private readonly adapter?: AsyncDbAdapter,
    private readonly insightTracker?: InsightTracker,
  ) {
    this.enabled = config?.enabled !== false;
    this.schedule = config?.schedule ?? 'hourly';
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

  /**
   * Trigger a focused reasoning pass in response to an event (watch alert, etc.).
   * Uses minimal context — only the event data + most relevant memories.
   */
  async triggerOnEvent(eventType: string, eventDescription: string, eventData: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled) return;

    // Distributed dedup: use event-specific slot (prevent both nodes from processing)
    if (this.adapter && this.adapter.type === 'postgres') {
      const slotKey = `reasoning-event:${Date.now().toString(36)}:${eventType}`;
      const result = await this.adapter.execute(
        'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [slotKey, this.nodeId, new Date().toISOString()],
      );
      if (result.changes === 0) return;
    }

    try {
      // Focused context: only event + memories + calendar + todos (not full context)
      const memories = await this.fetchMemories();
      const events = await this.fetchCalendar(new Date());
      const todos = await this.fetchTodos();

      const prompt = `Du bist Alfreds proaktives Denk-Modul. Ein Event ist eingetreten:

EVENT: ${eventType}
DETAILS: ${eventDescription}
DATEN: ${JSON.stringify(eventData).slice(0, 500)}

KONTEXT:
=== Kalender (n\u00E4chste 24h) ===
${events}

=== Offene Todos ===
${todos}

=== Erinnerungen \u00FCber den User ===
${memories}

Aufgabe: Analysiere ob dieses Event im Kontext der User-Daten eine SOFORTIGE Handlungsempfehlung oder einen wichtigen Hinweis ergibt.
- Nur antworten wenn der Hinweis NICHT offensichtlich ist (der User hat das Event schon als Alert bekommen)
- Suche nach Verbindungen: Hat der User einen Termin in der N\u00E4he des Angebots? Zeitkonflikt? Gelegenheit?
- Max 1-2 S\u00E4tze, konkret und actionable
- Wenn nichts Relevantes: antworte exakt "KEINE_INSIGHTS"
${this.confirmationQueue ? `\nWenn eine sinnvolle Aktion m\u00F6glich ist, h\u00E4nge sie als JSON an (gleicher ${ACTION_MARKER} Format wie beim regul\u00E4ren Reasoning).` : ''}`;

      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        tier: this.tier,
      });

      const text = response.content.trim();
      if (isNoInsights(text)) return;

      const parsed = this.parseReasoningResponse(text);

      // Send insights
      if (parsed.insights.length > 0) {
        const newInsights: string[] = [];
        for (const insight of parsed.insights) {
          if (!await this.wasRecentlySent(insight)) newInsights.push(insight);
        }
        if (newInsights.length > 0) {
          const message = `\u{1F4A1} **Alfred Insight**\n\n${newInsights.join('\n\n')}`;
          const adapter = this.adapters.get(this.defaultPlatform);
          if (adapter) {
            await adapter.sendMessage(this.defaultChatId, message);
            for (const insight of newInsights) await this.markSent(insight);
          }
          if (this.insightTracker) {
            for (const insight of newInsights) {
              const category = InsightTracker.categorizeInsight(insight);
              this.insightTracker.trackInsightSent(category);
            }
          }
        }
      }

      // Process actions with autonomy level
      if (parsed.actions.length > 0) {
        await this.processActions(parsed.actions);
      }
    } catch (err) {
      this.logger.warn({ err, eventType }, 'Event-triggered reasoning failed');
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

    // Distributed dedup: only one node runs reasoning per hour-slot
    if (this.adapter && this.adapter.type === 'postgres') {
      const slotKey = `reasoning:${new Date().toISOString().slice(0, 13)}`;
      const result = await this.adapter.execute(
        'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [slotKey, this.nodeId, new Date().toISOString()],
      );
      if (result.changes === 0) {
        this.logger.debug('Reasoning slot already claimed by another node, skipping');
        return;
      }
    }

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
      if (isNoInsights(text)) {
        this.logger.info({ durationMs }, 'Reasoning pass: no insights');
        this.activityLogger?.logScheduledExec({
          actionId: 'reasoning-engine', actionName: 'Reasoning Engine',
          platform: this.defaultPlatform, chatId: this.defaultChatId,
          userId: this.defaultChatId, outcome: 'success', durationMs,
        });
        return;
      }

      // Parse insights and optional actions
      const parsed = this.parseReasoningResponse(text);
      const newInsights: string[] = [];
      for (const insight of parsed.insights) {
        if (!await this.wasRecentlySent(insight)) newInsights.push(insight);
      }

      if (newInsights.length === 0 && parsed.actions.length === 0) {
        this.logger.info({ durationMs, total: parsed.insights.length }, 'Reasoning pass: all deduplicated');
        return;
      }

      // Send text insights to user
      if (newInsights.length > 0) {
        const message = `\u{1F4A1} **Alfred Insights**\n\n${newInsights.join('\n\n')}`;
        const adapter = this.adapters.get(this.defaultPlatform);
        if (adapter) {
          await adapter.sendMessage(this.defaultChatId, message);
          for (const insight of newInsights) {
            await this.markSent(insight);
          }
          this.logger.info({ durationMs, insights: newInsights.length }, 'Reasoning pass: insights sent');
        }
        if (this.insightTracker) {
          for (const insight of newInsights) {
            const category = InsightTracker.categorizeInsight(insight);
            this.insightTracker.trackInsightSent(category);
          }
        }
      }

      // Process proposed actions (confirmation queue)
      if (parsed.actions.length > 0) {
        await this.processActions(parsed.actions);
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

    // Parallel: calendar + weather + energy + charger (async), rest is sync SQLite
    const [events, weather, energy, charger] = await Promise.all([
      this.fetchCalendar(now),
      this.fetchSkillData('weather', { action: 'current', ...(this.defaultLocation ? { location: this.defaultLocation } : {}) }),
      this.fetchSkillData('energy_price', { action: 'current' }),
      this.fetchChargerStatus(),
    ]);

    // SQLite queries (now async)
    const todos = await this.fetchTodos();
    const watches = await this.fetchWatches();
    const memories = await this.fetchMemories();
    const activity = await this.fetchActivity();
    const skillHealth = await this.fetchSkillHealth();
    const feedback = await this.fetchFeedback();
    const mealPlan = await this.fetchMealPlan();
    const travel = await this.fetchUpcomingTravel();

    return { dateTime, events, todos, watches, memories, activity, weather, energy, charger, skillHealth, feedback, mealPlan, travel };
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
      const { context } = await buildSkillContext(this.userRepo, {
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

  private async fetchTodos(): Promise<string> {
    try {
      const overdue = await this.todoRepo.getOverdue();
      const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const upcoming = await this.todoRepo.getDueInWindow(windowEnd);
      const allOpen = await this.todoRepo.list(this.defaultChatId);

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

  private async fetchWatches(): Promise<string> {
    try {
      const watches = await this.watchRepo.getEnabled();
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

  private async fetchMemories(): Promise<string> {
    try {
      const memories = await this.memoryRepo.getRecentForPrompt(this.defaultChatId, 30);
      // Ensure pattern + connection memories are always included (they describe the user, not a topic)
      const existingKeys = new Set(memories.map(m => m.key));
      for (const type of ['pattern', 'connection'] as const) {
        try {
          const typed = await this.memoryRepo.getByType(this.defaultChatId, type, 5);
          for (const m of typed) {
            if (!existingKeys.has(m.key)) { existingKeys.add(m.key); memories.push(m); }
          }
        } catch { /* skip */ }
      }
      if (memories.length === 0) return 'Keine gespeicherten Erinnerungen.';
      return memories.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: memory fetch failed');
      return '(Memory-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchActivity(): Promise<string> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const stats = await this.activityRepo.stats(since);
      if (stats.length === 0) return 'Keine Aktivität in den letzten 24h.';
      return stats.map(s => `- ${s.eventType} (${s.outcome}): ${s.count}×`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: activity fetch failed');
      return '(Aktivitäts-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchSkillHealth(): Promise<string> {
    try {
      const disabled = await this.skillHealthRepo.getDisabled();
      if (disabled.length === 0) return 'Alle Skills aktiv.';
      return disabled.map(s =>
        `- ${s.skillName}: deaktiviert bis ${s.disabledUntil} (${s.consecutiveFails} Fehler: ${s.lastError ?? '?'})`,
      ).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: skill health fetch failed');
      return '(Skill-Health-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchFeedback(): Promise<string> {
    if (!this.feedbackRepo) return '';
    try {
      const events = await this.feedbackRepo.getRecentEvents(this.defaultChatId, 20);
      if (events.length === 0) return 'Kein Feedback zu Watches oder Korrekturen.';
      return events.map(e =>
        `- [${e.feedbackType}] ${e.description} (${e.occurredAt.slice(0, 10)})`,
      ).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'Reasoning: feedback fetch failed');
      return '';
    }
  }

  private async fetchMealPlan(): Promise<string> {
    const day = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    return this.fetchSkillData('recipe', { action: 'meal_plan', sub_action: 'get', week: 'current', day });
  }

  private async fetchUpcomingTravel(): Promise<string> {
    return this.fetchSkillData('travel', { action: 'plan_list', status: 'booked' });
  }

  private async fetchChargerStatus(): Promise<string> {
    return this.fetchSkillData('goe_charger', { action: 'status' });
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

=== Wallbox ===
${ctx.charger}

=== Meal-Plan heute ===
${ctx.mealPlan}

=== Anstehende Reisen ===
${ctx.travel}

=== Skill-Status ===
${ctx.skillHealth}
${ctx.feedback ? `\n=== Nutzer-Feedback & Korrekturen ===\n${ctx.feedback}` : ''}
${this.confirmationQueue ? `
=== AKTIONEN ===
Wenn du eine sinnvolle, sofort ausführbare Aktion erkennst, kannst du sie vorschlagen.
Regeln: Max 2 Aktionen, nur wenn JETZT sinnvoll (nicht hypothetisch).
Aktionstypen: "execute_skill" (Skill ausführen) oder "create_reminder" (Erinnerung anlegen).
Format: nach deinen Text-Insights, trenne mit "${ACTION_MARKER}", dann ein JSON-Array:
${ACTION_MARKER}
[{"type":"execute_skill","description":"Wallbox ein (Strom <5ct, BMW 45%)","skillName":"homeassistant","skillParams":{"action":"turn_on","entity_id":"switch.wallbox"}}]
Wenn keine Aktionen sinnvoll: lass den ${ACTION_MARKER} Block weg.` : ''}`;
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

  private async wasRecentlySent(insight: string): Promise<boolean> {
    const hash = this.insightHash(insight);
    const key = `reasoning:${hash}`;
    return await this.notifRepo.wasNotified(key, this.defaultChatId);
  }

  private async markSent(insight: string): Promise<void> {
    const hash = this.insightHash(insight);
    const key = `reasoning:${hash}`;
    // Use event_start as expiry marker (dedup window)
    const expiry = new Date(Date.now() + this.deduplicationHours * 60 * 60 * 1000).toISOString();
    await this.notifRepo.markNotified(key, this.defaultChatId, this.defaultPlatform, expiry);
  }

  // ── Action Support ──────────────────────────────────────────

  private parseReasoningResponse(text: string): ParsedReasoningResponse {
    const markerIdx = text.indexOf(ACTION_MARKER);
    if (markerIdx === -1) {
      return { insights: this.parseInsights(text), actions: [] };
    }
    const insightText = text.slice(0, markerIdx).trim();
    const actionText = text.slice(markerIdx + ACTION_MARKER.length).trim();
    const insights = insightText ? this.parseInsights(insightText) : [];
    let actions: ProposedAction[] = [];
    try {
      const parsed = JSON.parse(actionText);
      if (Array.isArray(parsed)) {
        actions = parsed.filter(a =>
          a && typeof a === 'object' &&
          typeof a.type === 'string' &&
          typeof a.description === 'string' &&
          typeof a.skillName === 'string' &&
          typeof a.skillParams === 'object' && a.skillParams !== null,
        ) as ProposedAction[];
      }
    } catch {
      this.logger.warn('Reasoning: failed to parse actions JSON, ignoring');
    }
    return { insights, actions };
  }

  private actionHash(action: ProposedAction): string {
    const normalized = `${action.type}:${action.skillName}:${JSON.stringify(action.skillParams)}`
      .slice(0, 150).toLowerCase().replace(/\s+/g, ' ');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private async actionWasRecentlyProposed(action: ProposedAction): Promise<boolean> {
    const hash = this.actionHash(action);
    return await this.notifRepo.wasNotified(`reasoning-action:${hash}`, this.defaultChatId);
  }

  private async markActionProposed(action: ProposedAction): Promise<void> {
    const hash = this.actionHash(action);
    const key = `reasoning-action:${hash}`;
    const expiry = new Date(Date.now() + this.deduplicationHours * 60 * 60 * 1000).toISOString();
    await this.notifRepo.markNotified(key, this.defaultChatId, this.defaultPlatform, expiry);
  }

  /** Read-only skills — safe to execute silently. */
  private static readonly AUTO_SKILLS = new Set([
    'memory', 'calculator', 'weather', 'energy_price',
    'crypto_price', 'routing', 'transit', 'feed_reader', 'shopping',
  ]);

  /** Low-impact write skills — safe to execute and inform user. */
  private static readonly PROACTIVE_SKILLS = new Set([
    'reminder', 'note', 'todo', 'recipe', 'calendar',
    'homeassistant', 'sonos', 'spotify',
  ]);

  // Everything else = HIGH_RISK -> always confirmation

  private async getAutonomyLevel(): Promise<'confirm_all' | 'proactive' | 'autonomous'> {
    try {
      const mem = await this.memoryRepo.recall(this.defaultChatId, 'autonomy_level');
      if (mem) {
        const level = mem.value.toLowerCase().trim();
        if (level.includes('autonomous') || level.includes('autonom')) return 'autonomous';
        if (level.includes('proactive') || level.includes('proaktiv')) return 'proactive';
      }
    } catch { /* use default */ }
    return 'confirm_all';
  }

  private async processActions(actions: ProposedAction[]): Promise<void> {
    if (actions.length === 0) return;

    // Load user autonomy preference
    const autonomyLevel = await this.getAutonomyLevel();

    const limit = actions.slice(0, 2);
    for (const action of limit) {
      if (await this.actionWasRecentlyProposed(action)) {
        this.logger.info({ action: action.description }, 'Reasoning: action deduplicated, skipping');
        continue;
      }

      try {
        const isAuto = ReasoningEngine.AUTO_SKILLS.has(action.skillName);
        const isProactive = ReasoningEngine.PROACTIVE_SKILLS.has(action.skillName);

        // Determine execution mode based on autonomy level
        let executeDirectly = false;
        let informUser = false;

        switch (autonomyLevel) {
          case 'autonomous':
            executeDirectly = true;
            informUser = !isAuto; // Inform for proactive+high, silent for auto
            break;
          case 'proactive':
            executeDirectly = isAuto || isProactive;
            informUser = isProactive; // Inform for proactive, silent for auto
            break;
          case 'confirm_all':
          default:
            executeDirectly = isAuto; // Only auto skills run silently
            informUser = false;
            break;
        }

        if (executeDirectly) {
          await this.executeDirectly(action);
          await this.markActionProposed(action);

          if (informUser) {
            const adapter = this.adapters.get(this.defaultPlatform);
            if (adapter) {
              await adapter.sendMessage(this.defaultChatId,
                `\u26A1 **Proaktiv ausgef\u00FChrt:** ${action.description}`);
            }
          }

          this.logger.info({ action: action.description, autonomyLevel }, 'Reasoning: action executed');
          continue;
        }

        // High-risk or confirm_all mode -> confirmation queue
        if (!this.confirmationQueue) continue;
        await this.confirmationQueue.enqueue({
          chatId: this.defaultChatId,
          platform: this.defaultPlatform,
          source: 'reasoning',
          sourceId: 'reasoning-engine',
          description: action.description,
          skillName: action.skillName,
          skillParams: action.skillParams,
          timeoutMinutes: 60,
        });
        await this.markActionProposed(action);
        this.logger.info({ action: action.description, autonomyLevel }, 'Reasoning: action enqueued for confirmation');
      } catch (err) {
        this.logger.error({ err, action: action.description }, 'Reasoning: failed to process action');
      }
    }
  }

  private async executeDirectly(action: ProposedAction): Promise<void> {
    const skill = this.skillRegistry.get(action.skillName);
    if (!skill) return;
    try {
      const { context } = await buildSkillContext(this.userRepo, {
        userId: this.defaultChatId,
        platform: this.defaultPlatform,
        chatId: this.defaultChatId,
        chatType: 'dm',
      });
      await this.skillSandbox.execute(skill, action.skillParams, context);
    } catch (err) {
      this.logger.warn({ err, action: action.description }, 'Reasoning: direct action execution failed');
    }
  }
}
