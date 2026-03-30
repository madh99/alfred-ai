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
import type { ActivityLogger } from './activity-logger.js';
import type { ConfirmationQueue } from './confirmation-queue.js';
import { InsightTracker } from './insight-tracker.js';
import { ReasoningContextCollector, type CollectedContext } from './reasoning-context-collector.js';
import { buildSkillContext } from './context-factory.js';

/** Schedule run-hours for the 'morning_noon_evening' preset. */
const MNE_HOURS = [7, 12, 18];

/** Maximum tokens for reasoning detail response. */
const MAX_OUTPUT_TOKENS = 1536;

/** Marker separating text insights from structured actions in LLM response. */
const ACTION_MARKER = '---ACTIONS---';

/** Cooldown between event-triggered reasoning passes (ms). */
const EVENT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Check if the LLM response indicates no insights.
 * ONLY checks for the explicit KEINE_INSIGHTS marker — no natural language parsing.
 */
function isNoInsights(text: string): boolean {
  if (!text || text.length < 10) return true;
  const trimmed = text.trim();
  if (trimmed === 'KEINE_INSIGHTS') return true;
  if (trimmed.toLowerCase() === 'keine_insights') return true;
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

export class ReasoningEngine {
  private tickTimer?: ReturnType<typeof setInterval>;
  private lastRunHour = -1;
  private lastEventTriggerAt = 0;
  private readonly enabled: boolean;
  private readonly schedule: ReasoningConfig['schedule'];
  private readonly tier: 'fast' | 'default';
  private readonly deduplicationHours: number;
  private readonly collector: ReasoningContextCollector;

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
    collector?: ReasoningContextCollector,
  ) {
    this.enabled = config?.enabled !== false;
    this.schedule = config?.schedule ?? 'hourly';
    this.tier = config?.tier ?? 'default';
    this.deduplicationHours = config?.deduplicationHours ?? 12;

    this.collector = collector ?? new ReasoningContextCollector(
      this.skillRegistry, this.skillSandbox, this.userRepo,
      this.calendarProvider, this.todoRepo, this.watchRepo,
      this.memoryRepo, this.activityRepo, this.skillHealthRepo,
      this.feedbackRepo, this.defaultChatId, this.defaultPlatform,
      this.defaultLocation, this.logger,
    );
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
   * Trigger a focused reasoning pass in response to an event (watch alert, calendar, todo, post-skill).
   * Debounced: max one event-triggered reasoning per 5 minutes.
   */
  async triggerOnEvent(eventType: string, eventDescription: string, eventData: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled) return;

    // Debounce: prevent trigger storms
    const now = Date.now();
    if (now - this.lastEventTriggerAt < EVENT_COOLDOWN_MS) {
      this.logger.debug({ eventType }, 'Event-triggered reasoning debounced');
      return;
    }
    this.lastEventTriggerAt = now;

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
      // Use collector for full context (holistic reasoning)
      const context = await this.collector.collect();

      const prompt = `Du bist Alfreds proaktives Denk-Modul. Ein Event ist eingetreten:

EVENT: ${eventType}
DETAILS: ${eventDescription}
DATEN: ${JSON.stringify(eventData).slice(0, 500)}

KONTEXT (alle verfügbaren Datenquellen):
${this.formatSections(context)}

Aufgabe: Analysiere ob dieses Event im Kontext ALLER User-Daten eine Handlungsempfehlung oder einen Hinweis ergibt.
- Suche nach Verbindungen zwischen VERSCHIEDENEN Bereichen: Termin + Ort + Shopping? Zeitkonflikt? Preisalert + Fahrt? E-Mail + Meeting?
- Max 1-2 Sätze, konkret und actionable
- Wenn WIRKLICH nichts Relevantes: antworte EXAKT "KEINE_INSIGHTS" — nichts anderes, keine Erklärung
${this.confirmationQueue ? `\nWenn eine sinnvolle Aktion möglich ist, hänge sie als JSON an (${ACTION_MARKER} Format).` : ''}`;

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

  // ── Scheduling ──────────────────────────────────────────────

  private shouldRun(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    switch (this.schedule) {
      case 'morning_noon_evening':
        if (MNE_HOURS.includes(hour) && minute === 0 && this.lastRunHour !== hour) {
          return true;
        }
        return false;

      case 'hourly':
        if (minute === 0 && this.lastRunHour !== hour) return true;
        return false;

      case 'half_hourly':
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

  // ── Main Tick: Two-Pass Reasoning ───────────────────────────

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

      // PHASE 1: Collect context from all available data sources
      const context = await this.collector.collect();

      // PHASE 2: Scan-Pass — quick check for concerns/opportunities
      const scanPrompt = this.buildScanPrompt(context);
      const scanResponse = await this.llm.complete({
        messages: [{ role: 'user', content: scanPrompt }],
        maxTokens: 512,
        tier: this.tier,
      });

      const scanText = scanResponse.content.trim();
      const scanDurationMs = Date.now() - startMs;
      this.logger.debug({ response: scanText.slice(0, 500), durationMs: scanDurationMs }, 'Reasoning scan response');

      if (isNoInsights(scanText)) {
        this.logger.info({ durationMs: scanDurationMs, response: scanText.slice(0, 200) }, 'Reasoning pass: no insights (scan)');
        this.activityLogger?.logScheduledExec({
          actionId: 'reasoning-engine', actionName: 'Reasoning Engine',
          platform: this.defaultPlatform, chatId: this.defaultChatId,
          userId: this.defaultChatId, outcome: 'success', durationMs: scanDurationMs,
        });
        return;
      }

      // PHASE 3: Detail-Pass — elaborate on findings from scan
      const detailPrompt = this.buildDetailPrompt(context, scanText);
      const detailResponse = await this.llm.complete({
        messages: [{ role: 'user', content: detailPrompt }],
        maxTokens: MAX_OUTPUT_TOKENS,
        tier: this.tier,
      });

      const text = detailResponse.content.trim();
      const durationMs = Date.now() - startMs;
      this.logger.debug({ response: text.slice(0, 500), durationMs }, 'Reasoning detail response');

      if (isNoInsights(text)) {
        this.logger.info({ durationMs }, 'Reasoning pass: no insights (detail)');
        return;
      }

      // PHASE 4: Parse, dedup, send
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

  // ── Prompt Building ─────────────────────────────────────────

  private formatSections(ctx: CollectedContext): string {
    return ctx.sections.map(s => `=== ${s.label} ===\n${s.content}`).join('\n\n');
  }

  private buildScanPrompt(ctx: CollectedContext): string {
    const changedInfo = ctx.changedSections.length > 0
      ? ctx.changedSections.map(k => ctx.sections.find(s => s.key === k)?.label).filter(Boolean).join(', ')
      : 'Keine Änderungen';

    return `Du bist Alfreds Denk-Modul. Scanne ALLE folgenden Daten nach:
1. Konflikten (Terminüberschneidungen, überfällige Todos bei vollem Kalender, Zeitdruck)
2. Gelegenheiten (Preis-Alerts + Termine am selben Ort, günstiger Strom + Auto laden, Shopping + Reise)
3. Querverbindungen zwischen VERSCHIEDENEN Bereichen (E-Mail-Thema = Kalender-Meeting, Todo + Wetter, BMW-Akku + Termin morgen)
4. Ungewöhnlichem (plötzliche Änderungen, Anomalien, Muster)

GEÄNDERT SEIT LETZTEM LAUF:
${changedInfo}

${this.formatSections(ctx)}

Antworte mit max 3 kurzen Stichpunkten was du an Verbindungen, Konflikten oder Gelegenheiten gefunden hast.
Wenn WIRKLICH NICHTS Relevantes: antworte EXAKT "KEINE_INSIGHTS"`;
  }

  private buildDetailPrompt(ctx: CollectedContext, scanFindings: string): string {
    return `Du bist Alfreds Denk-Modul. In der Vorab-Analyse wurden folgende Auffälligkeiten erkannt:

${scanFindings}

Formuliere daraus max 5 konkrete, actionable Insights für den User.

REGELN:
- Priorisiere Verbindungen zwischen VERSCHIEDENEN Datenbereichen über reine Fakten-Wiederholung
- KEINE generischen Tipps ("Vergiss nicht zu trinken", "Plane genug Pausen ein")
- Jeder Insight: 1-2 Sätze, konkret und actionable, auf Deutsch
- Priorisiert nach Dringlichkeit

BEISPIELE guter Insights:
- "Du hast um 14:00 einen Termin in Linz, aber die RTX 5090 Watch zeigt ein Angebot in Wien — Abholung wäre auf dem Rückweg möglich."
- "3 deiner 5 Todos sind morgen fällig, aber dein Kalender ist voll — eventuell heute Abend erledigen."
- "Strompreis ist bis 15:00 unter 5 ct/kWh — BMW laden wäre jetzt günstig (Akku war beim letzten Check bei 45%)."
- "Morgen früh -3°C, du hast einen 8:00 Termin — Auto vorheizen einplanen."
- "Du hast 2 überfällige Todos und 3 neue E-Mails zum selben Thema — eventuell zusammenhängend?"

AKTUELLE DATEN:
${this.formatSections(ctx)}
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
    const lines = text.split(/\n{2,}|\n(?=\d+\.\s)/).map(l => l.trim()).filter(l => l.length > 10);
    if (lines.length <= 1) return [text.trim()];
    return lines;
  }

  private insightHash(text: string): string {
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
    'homeassistant', 'sonos', 'spotify', 'watch',
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

        let executeDirectly = false;
        let informUser = false;

        switch (autonomyLevel) {
          case 'autonomous':
            executeDirectly = true;
            informUser = !isAuto;
            break;
          case 'proactive':
            executeDirectly = isAuto || isProactive;
            informUser = isProactive;
            break;
          case 'confirm_all':
          default:
            executeDirectly = isAuto;
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
                `\u26A1 **Proaktiv ausgeführt:** ${action.description}`);
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
