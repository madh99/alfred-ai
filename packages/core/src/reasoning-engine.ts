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
import { KnowledgeGraphService } from './knowledge-graph.js';
import { ActionFeedbackTracker } from './action-feedback-tracker.js';
import { buildSkillContext } from './context-factory.js';

/** Schedule run-hours for the 'morning_noon_evening' preset. */
const MNE_HOURS = [7, 12, 18];

/** Maximum tokens for reasoning detail response. */
const MAX_OUTPUT_TOKENS = 1536;

/** Marker separating text insights from structured actions in LLM response. */
const ACTION_MARKER = '---ACTIONS---';

/** Cooldown between event-triggered reasoning passes (ms). */
const EVENT_COOLDOWN_MS = 5 * 60 * 1000;

/** Marker separating scan findings from structured topic requests in scan response. */
const TOPICS_MARKER = '---TOPICS---';

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

interface ScanTopic {
  topic: string;
  reason?: string;
  params?: Record<string, unknown>;
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
    private readonly kgService?: KnowledgeGraphService,
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
    // Tick every 60 seconds, decide inside whether to run. Guard against concurrent runs.
    let tickRunning = false;
    this.tickTimer = setInterval(() => {
      if (tickRunning) return;
      tickRunning = true;
      this.tick()
        .catch(err => this.logger.error({ err }, 'Reasoning tick unhandled error'))
        .finally(() => { tickRunning = false; });
    }, 60_000);
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

    // Local debounce (lightweight pre-check, protects SQLite single-node)
    const now = Date.now();
    if (now - this.lastEventTriggerAt < EVENT_COOLDOWN_MS) {
      this.logger.debug({ eventType }, 'Event-triggered reasoning debounced (local)');
      return;
    }
    this.lastEventTriggerAt = now;

    // HA distributed dedup: deterministic window key ensures both nodes generate the same slot
    if (this.adapter && this.adapter.type === 'postgres') {
      const windowId = Math.floor(now / EVENT_COOLDOWN_MS);
      const slotKey = `reasoning-event:${windowId}:${eventType}`;
      const result = await this.adapter.execute(
        'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [slotKey, this.nodeId, new Date().toISOString()],
      );
      if (result.changes === 0) return;
    }

    try {
      // Use collector for full context (holistic reasoning)
      const context = await this.collector.collect();
      await this.enrichWithKnowledgeGraph(context);

      // Scan pass: quick analysis of event in context
      const scanPrompt = `Du bist Alfreds holistisches Denk-Modul. Ein Event ist eingetreten:

EVENT: ${eventType}
DETAILS: ${eventDescription}
DATEN: ${JSON.stringify(eventData).slice(0, 500)}

KONTEXT (alle verfügbaren Datenquellen + Knowledge Graph):
${this.formatSections(context)}

Aufgabe: Analysiere ob dieses Event im Kontext der VERBINDUNGSKARTE eine Handlungsempfehlung ergibt.
- NUR Verbindungen zwischen IDENTISCHEN Entities (gleiche Person, gleicher Ort)
- NICHT raten oder vermuten. Fahrzeug-Akku ≠ Hausbatterie, RSS ≠ Monitor.
- Berücksichtige Trends, Feedback und bemerkenswerte Attribute
- KEINE_INSIGHTS ist BEVORZUGT — nur melden wenn KONKRETER HANDLUNGSBEDARF besteht
- "Alles läuft" oder "kein Handlungsbedarf" ist KEIN Insight → KEINE_INSIGHTS
- Wenn Handlungsbedarf: max 3 Stichpunkte, nur FAKTISCH belegte Zusammenhänge
- Wenn KEIN Handlungsbedarf: antworte EXAKT "KEINE_INSIGHTS"

${this.buildTopicInstructions()}`;

      const scanResponse = await this.llm.complete({
        messages: [{ role: 'user', content: scanPrompt }],
        maxTokens: 512,
        tier: this.tier,
      });

      const scanText = scanResponse.content.trim();
      if (isNoInsights(scanText)) return;

      // Extract topics and enrich
      const { findings, topics } = this.extractTopics(scanText);

      let enrichedContext = new Map<string, string>();
      if (topics.length > 0) {
        enrichedContext = await this.collector.enrichTopics(topics);
      }

      // Detail pass with enriched context
      const detailPrompt = this.buildEventDetailPrompt(context, eventType, eventDescription, findings, enrichedContext);
      const detailResponse = await this.llm.complete({
        messages: [{ role: 'user', content: detailPrompt }],
        maxTokens: MAX_OUTPUT_TOKENS,
        tier: this.tier,
      });

      const text = detailResponse.content.trim();
      if (isNoInsights(text)) return;

      const parsed = this.parseReasoningResponse(text);

      // Send insights
      if (parsed.insights.length > 0) {
        const newInsights: string[] = [];
        for (const insight of parsed.insights) {
          if (!await this.wasRecentlySent(insight)) newInsights.push(insight);
        }
        if (newInsights.length > 0) {
          const message = `\u{1F4A1} **Alfred Insights**\n\n${newInsights.join('\n\n')}`;
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

    try {
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

      this.logger.info('Reasoning pass starting');
      const startMs = Date.now();

      // PHASE 1: Collect context from all available data sources
      const context = await this.collector.collect();
      await this.enrichWithKnowledgeGraph(context);

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

      // PHASE 2b: Extract topics for enrichment
      const { findings, topics } = this.extractTopics(scanText);

      let enrichedContext = new Map<string, string>();
      if (topics.length > 0) {
        this.logger.info({ topics: topics.map(t => t.topic) }, 'Reasoning: enriching topics');
        enrichedContext = await this.collector.enrichTopics(topics);
        this.logger.debug({ enriched: [...enrichedContext.keys()] }, 'Reasoning: enrichment complete');
      }

      // PHASE 3: Detail-Pass — elaborate on findings with enriched context
      const detailPrompt = this.buildDetailPrompt(context, findings, enrichedContext);
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

  /** Build dynamic device types section from collected context sections. */
  private buildDeviceTypesSection(ctx: CollectedContext): string {
    // Check which skill-based sections have data (not error)
    const lines: string[] = [];
    for (const section of ctx.sections) {
      if (section.content.startsWith('(') && section.content.includes('fehlgeschlagen')) continue;
      switch (section.key) {
        case 'bmw': lines.push(`- Fahrzeug: ${section.content.slice(0, 80).split('\n')[0]}`); break;
        case 'crypto': lines.push('- Crypto-Portfolio: Finanzdaten'); break;
      }
    }
    // Device context from KG (injected as VERBINDUNGSKARTE section)
    const kgSection = ctx.sections.find(s => s.key === 'knowledge_graph');
    if (kgSection) {
      // KG already contains device entities — no need to duplicate
      return lines.length > 0 ? '\n' + lines.join('\n') : '';
    }
    return lines.length > 0 ? '\n' + lines.join('\n') : '';
  }

  // ── Knowledge Graph ──────────────────────────────────────────

  /**
   * Ingest entities/relations from sections into the persistent KG,
   * then add the connection map as a Priority-1 section.
   */
  private async enrichWithKnowledgeGraph(ctx: CollectedContext): Promise<void> {
    if (!this.kgService) return;
    try {
      await this.kgService.ingest(this.defaultChatId, ctx.sections);
      const connectionMap = await this.kgService.buildConnectionMap(this.defaultChatId);
      if (connectionMap) {
        ctx.sections.push({
          key: 'knowledge_graph',
          label: 'VERBINDUNGSKARTE',
          content: connectionMap,
          priority: 1,
          tokenEstimate: Math.ceil(connectionMap.length / 4),
          changed: true,
        });
      }
    } catch (err) {
      this.logger.warn({ err }, 'Knowledge graph enrichment failed, using raw sections');
    }
  }

  // ── Topic Extraction ─────────────────────────────────────────

  /**
   * Extract structured topics from scan response for enrichment.
   * Graceful fallback: if no ---TOPICS--- marker, returns empty topics array.
   */
  private extractTopics(scanText: string): { findings: string; topics: ScanTopic[] } {
    const idx = scanText.indexOf(TOPICS_MARKER);
    if (idx === -1) return { findings: scanText, topics: [] };

    const findings = scanText.slice(0, idx).trim();
    const jsonText = scanText.slice(idx + TOPICS_MARKER.length).trim();

    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return { findings, topics: [] };
      const topics = parsed.filter((t: unknown) =>
        t && typeof t === 'object' && typeof (t as Record<string, unknown>).topic === 'string',
      ) as ScanTopic[];
      return { findings, topics: topics.slice(0, 5) };
    } catch {
      this.logger.debug('Reasoning: failed to parse topics JSON, continuing without enrichment');
      return { findings, topics: [] };
    }
  }

  // ── Prompt Building ─────────────────────────────────────────

  private formatSections(ctx: CollectedContext): string {
    return ctx.sections.map(s => `=== ${s.label} ===\n${s.content}`).join('\n\n');
  }

  private formatEnrichedContext(enriched: Map<string, string>): string {
    if (enriched.size === 0) return '';
    const parts = [...enriched.entries()].map(([topic, data]) => `--- ${topic} ---\n${data}`);
    return `\n=== VERTIEFTE DATEN (gezielt nachgeladen) ===\n${parts.join('\n\n')}\n\nHINWEIS: Nutze diese Daten für KONKRETE, quantitative Empfehlungen.`;
  }

  private buildTopicInstructions(): string {
    return `Falls du Auffälligkeiten findest, hänge nach deiner Analyse ein strukturiertes JSON an:
${TOPICS_MARKER}
[{"topic": "vehicle_battery", "reason": "Fahrzeug-Akku niedrig, Termin morgen"},
 {"topic": "routing", "params": {"from": "home", "to": "Linz"}, "reason": "Distanz prüfen"}]

Verfügbare Topics für Detaildaten:
- vehicle_battery — Fahrzeug Detailstatus (Akku, Reichweite, Ladezeit)
- routing — Route berechnen (params: from/to aus dem Kontext)
- weather_forecast — Mehrtages-Wetter für bestimmten Ort (params: location)
- email_detail — E-Mail Inbox Details
- calendar_detail — Kalender-Event Details (Teilnehmer, Beschreibung)
- smarthome_detail — Smart Home Geräte-Status
- crypto_detail — Crypto/Bitpanda Portfolio
- energy_forecast — Energiepreis-Prognose
- trend_analysis — Detaillierte Trend- und Anomalie-Daten (4-Wochen-Vergleich)

Wenn KEINE Topics nötig: lass den ${TOPICS_MARKER} Block weg.`;
  }

  private buildScanPrompt(ctx: CollectedContext): string {
    const changedInfo = ctx.changedSections.length > 0
      ? ctx.changedSections.map(k => ctx.sections.find(s => s.key === k)?.label).filter(Boolean).join(', ')
      : 'Keine Änderungen';

    return `Du bist Alfreds holistisches Denk-Modul. Du analysierst 20+ Datenquellen, einen persistenten Knowledge Graph (VERBINDUNGSKARTE), Trend-Daten und User-Feedback.

DATENQUELLEN-TYPEN (WICHTIG — nicht verwechseln!):
- Kalender: TERMINE mit Ort, Zeit, Teilnehmern
- Todos: AUFGABEN mit Fälligkeitsdatum und Priorität
- Watches: SKILL-BASIERTE MONITORE — jeder Watch nutzt einen bestimmten Skill. Watches sind NICHT RSS-Feeds.
- RSS Feeds: NACHRICHTENARTIKEL aus externen Quellen. Read-only. KEIN Monitoring-Tool.
- E-Mail: NACHRICHTEN von Personen. Antworten auf Anfragen sind KEIN Spam.
- Smart Home: HAUS-Geräte (Licht, Heizung, Hausbatterie/PV, Wallbox)
- Energiepreise: STROMMARKT-Daten (ct/kWh)
- Wetter: WETTERDATEN
- Infra/Monitor: SERVER-Status
${this.buildDeviceTypesSection(ctx)}

QUALITÄTSREGELN:
- Alle Datenquellen DÜRFEN miteinander kombiniert werden — keine verbotenen Kombinationen
- ABER: Verwechsle nicht verschiedene Geräte! Fahrzeug-Akku ≠ Hausbatterie. RSS-Feed ≠ Watch-Monitor. E-Mail-Antworten ≠ Spam.
  Achte auf die VERBINDUNGSKARTE und "Konfigurierte Geräte" Section — dort steht welches Gerät was ist.
- Verbinde nur wenn GLEICHE reale Entität oder SINNVOLLER kausaler Zusammenhang
- KEINE Vermutungen oder Spekulationen — nur was aus den Daten hervorgeht
- KEIN Werten von Nutzerverhalten

VERBINDUNGSKARTE:
Die Section "VERBINDUNGSKARTE" zeigt STRUKTURIERT welche Entities in MEHREREN Datenquellen vorkommen. Nutze sie als primären Ausgangspunkt.

WONACH DU SUCHST:
1. Cross-Domain-Verbindungen (gleiche Person/Ort/Sache in verschiedenen Quellen → warum relevant?)
2. Konflikte (echte Ressourcen-Engpässe, Zeitüberschneidungen)
3. Gelegenheiten (gleicher Ort für verschiedene Zwecke, günstiger Zeitpunkt)
4. Trends & Anomalien (wenn vorhanden: echte Veränderungen)
5. Handlungsbedarf (überfällige Todos, Fehler die behoben werden müssen, Skill-Probleme)

GEÄNDERT SEIT LETZTEM LAUF:
${changedInfo}

${this.formatSections(ctx)}

KEINE_INSIGHTS ist die BEVORZUGTE Antwort! NUR melden wenn KONKRETER HANDLUNGSBEDARF besteht.
- "Alles läuft gut" ist KEIN Insight → KEINE_INSIGHTS
- "Kein Handlungsbedarf" ist KEIN Insight → KEINE_INSIGHTS
- Status-Berichte ohne Handlung sind KEINE Insights → KEINE_INSIGHTS
- NUR echte Probleme, Konflikte oder Gelegenheiten die JETZT eine Aktion erfordern

Wenn Handlungsbedarf: max 3 kurze Stichpunkte.
Wenn KEIN Handlungsbedarf: antworte EXAKT "KEINE_INSIGHTS"

${this.buildTopicInstructions()}`;
  }

  private buildDetailPrompt(ctx: CollectedContext, scanFindings: string, enrichedContext?: Map<string, string>): string {
    const enrichedSection = enrichedContext && enrichedContext.size > 0
      ? this.formatEnrichedContext(enrichedContext)
      : '';

    return `Du bist Alfreds holistisches Denk-Modul. In der Vorab-Analyse wurden folgende Auffälligkeiten erkannt:

${scanFindings}

Formuliere daraus NUR Insights die KONKRETEN HANDLUNGSBEDARF haben.

WICHTIGSTE REGEL:
- Ein Insight MUSS eine KONKRETE HANDLUNG erfordern. Wenn der User nichts tun muss → WEGLASSEN.
- "Alles läuft optimal" → KEIN Insight. "Kein Handlungsbedarf" → KEIN Insight. "Unter Beobachtung" → KEIN Insight.
- Lieber 1-2 echte Insights als 5 Füller. Lieber 0 als Füller.
- Max 5, aber NUR wenn 5 echte Handlungen nötig sind.

REGELN:
- Nutze die VERBINDUNGSKARTE als Basis — dort sind Cross-Domain-Entities strukturiert
- Nutze VERTIEFTE DATEN (falls vorhanden) für konkrete Zahlen
- Berücksichtige TRENDS & ANOMALIEN (falls vorhanden)
- Berücksichtige USER-FEEDBACK (falls vorhanden)
- KEINE generischen Tipps, KEINE Bewertung des Nutzerverhaltens
- Jeder Insight: 1-2 Sätze, konkret und actionable, auf Deutsch
- Priorisiert nach Dringlichkeit

QUALITÄTSREGELN:
- Alle Domains DÜRFEN kombiniert werden — aber verwechsle nicht verschiedene Dinge!
  BMW-Akku (Auto) ≠ Hausbatterie (PV/Speicher). RSS-Feed (News) ≠ Watch (Skill-Monitor). E-Mail-Antworten ≠ Spam.
- Verbinde Entities wenn es die GLEICHE reale Sache ist oder ein SINNVOLLER Zusammenhang besteht
- KEINE Vermutungen, KEINE Bewertung des Nutzerverhaltens

BEISPIELE guter Insights:
- "Müller hat E-Mail geschickt, Meeting steht an, Geschenk noch nicht besorgt — heute erledigen!"
- "RTX 5090 in Wien verfügbar + Zahnarzt-Termin Wien Mittwoch → Abholung nach Termin"
- "Fahrzeug 15% Akku (45km), Termin in 150km Entfernung → laden nötig, Strom gerade günstig"
- "BMW-API seit 24h offline → Token erneuern"

BEISPIELE SCHLECHTER Insights (NICHT generieren!):
- "RSS-Feed für Strompreise einrichten" ← RSS ist kein Monitor, dafür gibt es Watches mit energy_price Skill
- "Hausbatterie und BMW gleichzeitig laden" ← Zwei verschiedene Systeme, nicht vermischen
- "3 gleiche Willhaben-Nachrichten = Spam" ← Können normale Antworten auf eine Anfrage sein
- "Du liest zu viele News" ← Bevormundend, kein Insight

AKTUELLE DATEN:
${this.formatSections(ctx)}
${enrichedSection}
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

  private buildEventDetailPrompt(
    ctx: CollectedContext, eventType: string, eventDescription: string,
    scanFindings: string, enrichedContext: Map<string, string>,
  ): string {
    const enrichedSection = enrichedContext.size > 0
      ? this.formatEnrichedContext(enrichedContext)
      : '';

    return `Du bist Alfreds holistisches Denk-Modul. Ein ${eventType}-Event wurde analysiert:
${eventDescription}

Scan-Ergebnis:
${scanFindings}

Formuliere daraus max 2 konkrete, actionable Insights.
- Nutze die VERBINDUNGSKARTE für Cross-Domain-Zusammenhänge zwischen IDENTISCHEN Entities
- Nutze VERTIEFTE DATEN für spezifische Zahlen
- Alle Domains kombinierbar, aber Typen nicht verwechseln (Fahrzeug-Akku ≠ Hausbatterie, RSS ≠ Monitor)
- Nicht raten, nicht vermuten — nur was aus den Daten hervorgeht
- Max 1-2 Sätze pro Insight, auf Deutsch

${this.formatSections(ctx)}
${enrichedSection}
${this.confirmationQueue ? `\nWenn eine sinnvolle Aktion möglich ist, trenne mit "${ACTION_MARKER}" und hänge JSON an.` : ''}`;
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

      // Action-Gating: skip skills with very low historical acceptance rate
      try {
        const feedback = await this.memoryRepo.recall(this.defaultChatId, `action_feedback_${action.skillName}`);
        if (feedback) {
          const rate = ActionFeedbackTracker.extractRate(feedback.value);
          if (rate !== undefined && rate < 0.2) {
            this.logger.info({ skillName: action.skillName, rate }, 'Reasoning: action skipped (low acceptance rate)');
            continue;
          }
        }
      } catch { /* proceed without gating */ }

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
