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
  WorkflowRepository,
} from '@alfred/storage';
import type { SkillRegistry, SkillSandbox, CalendarProvider } from '@alfred/skills';
import type { ActivityLogger } from './activity-logger.js';
import type { ConfirmationQueue } from './confirmation-queue.js';
import { InsightTracker } from './insight-tracker.js';
import { ReasoningContextCollector, type CollectedContext } from './reasoning-context-collector.js';
import { KnowledgeGraphService } from './knowledge-graph.js';
import { ActionFeedbackTracker } from './action-feedback-tracker.js';
import { buildSkillContext } from './context-factory.js';
import { DeliveryScheduler, type ActivityProfile } from './delivery-scheduler.js';

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
  urgency?: 'urgent' | 'high' | 'normal' | 'low';
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
  private deliveryScheduler?: DeliveryScheduler;
  private resolvedOwnerUserId?: string;
  private activityProfile?: ActivityProfile;
  private tickRunning = false;

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
    private readonly workflowRepo?: WorkflowRepository,
    bmwTelematicRepo?: import('@alfred/storage').BmwTelematicRepository,
    private readonly noteRepo?: import('@alfred/storage').NoteRepository,
    private readonly reminderRepoRef?: import('@alfred/storage').ReminderRepository,
    private readonly documentRepo?: import('@alfred/storage').DocumentRepository,
    private readonly userTimezone?: string,
  ) {
    this.enabled = config?.enabled !== false;
    this.schedule = config?.schedule ?? 'hourly';
    this.tier = config?.tier ?? 'default';
    this.deduplicationHours = config?.deduplicationHours ?? 12;

    const tz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.collector = collector ?? new ReasoningContextCollector(
      this.skillRegistry, this.skillSandbox, this.userRepo,
      this.calendarProvider, this.todoRepo, this.watchRepo,
      this.memoryRepo, this.activityRepo, this.skillHealthRepo,
      this.feedbackRepo, this.defaultChatId, this.defaultPlatform,
      this.defaultLocation, this.logger, this.workflowRepo,
      bmwTelematicRepo, noteRepo, reminderRepoRef, documentRepo,
      tz,
    );

    // Smart delivery timing
    if (this.adapter) {
      this.deliveryScheduler = new DeliveryScheduler(this.adapter, this.logger.child({ component: 'delivery-scheduler' }), tz);
    }
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
- Prüfe Daten in Memories gegen das aktuelle Datum — vergangene Events sind KEIN Handlungsbedarf
- KEINE_INSIGHTS wenn nur Routine-Status ohne Auffälligkeiten
- Melden wenn: Handlungsbedarf ODER relevante Info die zum User-Kontext passt
- Max 3 Stichpunkte, nur FAKTISCH belegte Zusammenhänge
- Bei RSS: Titel + URL + warum relevant

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

      // Send insights (event-triggered are always at least HIGH urgency)
      const newInsights: string[] = [];
      for (const insight of parsed.insights) {
        if (!await this.wasRecentlySent(insight)) newInsights.push(insight);
      }
      if (newInsights.length > 0 || parsed.actions.length > 0) {
        const urgency = this.resolveUrgency(parsed.actions);
        // Event-triggered insights are at least 'high' urgency
        const effectiveUrgency = urgency === 'low' || urgency === 'normal' ? 'high' : urgency;
        await this.deliverOrDefer(newInsights, parsed.actions, effectiveUrgency);
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

      case 'half_hourly': {
        const inWindow = minute <= 1 || (minute >= 30 && minute <= 31);
        const slotId = hour * 100 + (minute < 2 ? 0 : 30);
        const notRun = this.lastRunHour !== slotId;
        if (inWindow) {
          this.logger.debug({ hour, minute, slotId, lastRunHour: this.lastRunHour, notRun }, 'half_hourly shouldRun check');
        }
        if (inWindow && notRun) return true;
        return false;
      }

      default:
        return false;
    }
  }

  private markRun(): void {
    const now = new Date();
    if (this.schedule === 'half_hourly') {
      // Store the SLOT id (rounded to :00 or :30), not the exact minute
      const minute = now.getMinutes();
      this.lastRunHour = now.getHours() * 100 + (minute < 15 ? 0 : 30);
    } else {
      this.lastRunHour = now.getHours();
    }
  }

  // ── Main Tick: Two-Pass Reasoning ───────────────────────────

  private async tick(): Promise<void> {
    if (!this.shouldRun()) return;
    this.markRun();

    // Resolve owner masterUserId once (cached) for memory lookups in this tick
    if (!this.resolvedOwnerUserId) {
      try {
        const user = await this.userRepo.findOrCreate(this.defaultPlatform, this.defaultChatId);
        this.resolvedOwnerUserId = user.masterUserId ?? user.id ?? this.defaultChatId;
      } catch { this.resolvedOwnerUserId = this.defaultChatId; }
    }

    try {
      // Distributed dedup: only one node runs reasoning per slot
      // For half_hourly: include minute bucket (e.g. reasoning:2026-04-01T10:00 vs :30)
      if (this.adapter && this.adapter.type === 'postgres') {
        const now = new Date();
        const minuteBucket = now.getMinutes() < 15 ? '00' : '30';
        const slotKey = `reasoning:${now.toISOString().slice(0, 13)}:${minuteBucket}`;
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

      // Determine urgency from actions (highest wins)
      const urgency = this.resolveUrgency(parsed.actions);

      // Smart delivery: check if user is active, defer if not
      await this.deliverOrDefer(newInsights, parsed.actions, urgency, durationMs);

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
  private resolvedUserId?: string;

  private async resolveUserId(): Promise<string> {
    if (this.resolvedUserId) return this.resolvedUserId;
    try {
      const user = await this.userRepo.findOrCreate(this.defaultPlatform, this.defaultChatId);
      this.resolvedUserId = user.masterUserId ?? user.id;
    } catch {
      this.resolvedUserId = this.defaultChatId;
    }
    return this.resolvedUserId;
  }

  private async enrichWithKnowledgeGraph(ctx: CollectedContext): Promise<void> {
    if (!this.kgService) {
      this.logger.debug('KG: kgService is undefined, skipping');
      return;
    }
    try {
      const userId = await this.resolveUserId();
      this.logger.info({ userId, sections: ctx.sections.length }, 'KG: starting ingest');
      await this.kgService.ingest(userId, ctx.sections);
      const connectionMap = await this.kgService.buildConnectionMap(userId);
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
      this.kgService.markPersonalContextDirty();
      this.logger.info({ connectionMap: connectionMap?.slice(0, 200) ?? 'empty' }, 'KG: ingest + connectionMap done');
    } catch (err) {
      this.logger.error({ err }, 'KG: enrichment FAILED');
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
    const header = `=== Aktuelles Datum & Uhrzeit ===\n${ctx.dateTime}`;
    const sections = ctx.sections.map(s => `=== ${s.label} ===\n${s.content}`).join('\n\n');
    return `${header}\n\n${sections}`;
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
- RSS Feeds: NACHRICHTENARTIKEL aus externen Quellen. Prüfe ob Artikel-Titel/Inhalt für den User RELEVANT sind (Bezug zu Kalender-Themen, KG-Entities, Interessen, Projekten). NUR relevante Artikel als Insight melden. Irrelevante Artikel IGNORIEREN — NICHT "keine Relevanz gefunden" melden.
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

ZEITLICHE EINORDNUNG (WICHTIG):
Das aktuelle Datum steht oben im Kontext. Prüfe bei JEDER Information mit Datum:
- Liegt das Datum in der VERGANGENHEIT? → Das ist WISSEN (der User kann danach fragen), aber KEIN aktueller Handlungsbedarf. NICHT als Insight melden.
- Geburtstage mit vergangenem Datum → nächstes Jahr relevant, NICHT "morgen Geburtstag" melden wenn der Tag schon vorbei ist.
- Vergangene Termine, Events, Deadlines → IGNORIEREN für Insights. Sie sind Erinnerungen, keine offenen Aufgaben.
- Nur ZUKÜNFTIGE Events oder aktuell offene Aufgaben sind Insight-relevant.

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

Antworte mit KEINE_INSIGHTS wenn:
- Nichts Relevantes aus den Daten hervorgeht
- Nur Routine-Status ohne Auffälligkeiten ("alles läuft", "Backup ok", "Batterie stabil")

Antworte mit Stichpunkten wenn:
- Handlungsbedarf besteht (Fehler, Konflikte, überfällige Aufgaben)
- ODER relevante Information die zum User-Kontext passt (RSS-Artikel zu KG-Entities/Portfolio/Interessen, Preisänderungen, Nachrichten die Geräte/Projekte/Personen betreffen)

Bei relevanten RSS-Artikeln: Titel UND URL mitsenden.
Max 3 Stichpunkte. Qualität vor Quantität.

${this.buildTopicInstructions()}`;
  }

  private buildDetailPrompt(ctx: CollectedContext, scanFindings: string, enrichedContext?: Map<string, string>): string {
    const enrichedSection = enrichedContext && enrichedContext.size > 0
      ? this.formatEnrichedContext(enrichedContext)
      : '';

    return `Du bist Alfreds holistisches Denk-Modul. In der Vorab-Analyse wurden folgende Auffälligkeiten erkannt:

${scanFindings}

Formuliere daraus Insights. Es gibt ZWEI Insight-Typen:

1. **Handlungsbedarf** — Fehler, Konflikte, Probleme, überfällige Aufgaben → "Tu X jetzt"
2. **Relevante Information** — RSS-Artikel, Preisänderungen, Nachrichten die zu User-Profil passen (Portfolio, Geräte, Interessen, Projekte, Personen) → "Das solltest du wissen: [Titel + URL]"

KEIN Insight:
- Routine-Status ohne Auffälligkeiten ("alles läuft", "Backup ok", "Batterie stabil")
- Generische Tipps, Bewertungen des Nutzerverhaltens
- VERGANGENE Events/Termine aus Memories — Geburtstage die schon vorbei sind, Termine die vergangen sind, erledigte Aufgaben. Memories sind WISSEN über die Vergangenheit, kein aktueller Handlungsbedarf.

Bei RSS-Artikeln: Titel + URL + warum relevant (1 Satz).
Max 5, aber Qualität vor Quantität. Lieber 2 gute als 5 mittelmäßige.

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
Du kannst Aktionen vorschlagen. Max 5. Nur wenn JETZT sinnvoll.
Alle nutzen type: "execute_skill". Format: nach Text-Insights, trenne mit "${ACTION_MARKER}", dann JSON-Array.

AKTIONSTYPEN:
1. Skill direkt ausführen: {"type":"execute_skill","description":"...","skillName":"homeassistant","skillParams":{"action":"turn_on","entity_id":"switch.wallbox"}}
2. Workflow erstellen: {"type":"execute_skill","description":"...","skillName":"workflow","skillParams":{"action":"create","name":"...","steps":[...]}}
3. Watch erstellen: {"type":"execute_skill","description":"...","skillName":"watch","skillParams":{"action":"create","name":"...","skill_name":"...","skill_params":{...},"condition_field":"...","condition_operator":"lt","condition_value":20,"interval_minutes":30}}
4. Komplexe Aufgabe delegieren: {"type":"execute_skill","description":"...","skillName":"delegate","skillParams":{"task":"...","max_iterations":10}}
5. Erinnerung erstellen: {"type":"execute_skill","description":"...","skillName":"reminder","skillParams":{"action":"set","message":"...","triggerAt":"2026-04-03T09:00"}}
5b. Erinnerung löschen: {"type":"execute_skill","description":"...","skillName":"reminder","skillParams":{"action":"cancel","id":"a3f2c8e1"}}
    WICHTIG: id MUSS die exakte 8-stellige Hex-ID aus der Erinnerungen-Liste sein. NIEMALS erfinden!

${this.skillRegistry.has('cmdb') ? `6. CMDB Discovery: {"type":"execute_skill","description":"...","skillName":"cmdb","skillParams":{"action":"discover"}}` : ''}
${this.skillRegistry.has('itsm') ? `7. ITSM Incident erstellen: {"type":"execute_skill","description":"...","skillName":"itsm","skillParams":{"action":"create_incident","title":"...","severity":"high","symptoms":"..."}}
7b. ITSM Incident aktualisieren: {"type":"execute_skill","description":"...","skillName":"itsm","skillParams":{"action":"update_incident","incident_id":"0815bc66","root_cause":"...","severity":"high"}}
7c. ITSM Investigation Notes: {"type":"execute_skill","description":"...","skillName":"itsm","skillParams":{"action":"update_incident","incident_id":"0815bc66","investigation_notes":"SSH-Verbindung zum Server getestet, Port 22 offen, CPU bei 98%","status":"investigating"}}
    WICHTIG: incident_id MUSS die exakte 8-stellige Hex-ID aus der Aktive-Incidents-Liste sein (z.B. "0815bc66"). NIEMALS eine ID erfinden!
8. ITSM Change Request: {"type":"execute_skill","description":"...","skillName":"itsm","skillParams":{"action":"create_change_request","title":"...","type":"normal","risk_level":"medium"}}` : ''}

WICHTIGE REGELN FÜR AKTIONSWAHL:
- Alfred kann NUR Skills ausführen die er hat. Wenn der User SELBST handeln muss (Browser öffnen, Zahlungsmethode ändern, Login auf Website) → IMMER Erinnerung (reminder) mit klarer Handlungsanweisung + URL
- NIEMALS "delegate" für Aufgaben die Browser, Login oder externe Accounts erfordern
- delegate NUR für echte Multi-Step Alfred-interne Aufgaben (z.B. mehrere Skills kombinieren)
- BMW "Rate Limit" oder "Token abgelaufen" → skillName:"bmw", skillParams:{"action":"authorize"} (startet OAuth-Flow)${this.skillRegistry.has('itsm') ? `
- Infra-Probleme (Node offline, CPU/RAM hoch, Service down) → Incident erstellen ODER bestehenden aktualisieren
- Geplante Infra-Änderungen → Change Request erstellen
- Prüfe "Aktive Incidents" in der CMDB/ITSM Section: Wenn ein aktiver Incident DASSELBE Thema behandelt → KEINEN neuen erstellen! Stattdessen update_incident mit der ID verwenden um root_cause, severity, symptoms oder investigation_notes zu ergänzen
- Incident-Lifecycle: open → acknowledged → investigating (investigation_notes setzen!) → mitigating (workaround setzen!) → resolved (root_cause + resolution setzen!) → closed (lessons_learned + action_items optional)
- "Kürzlich gelöst" Incidents: KEINEN neuen Incident für dasselbe Thema erstellen
- VERSCHIEDENE Probleme am gleichen Gerät SIND verschiedene Incidents (z.B. "Disk voll" ≠ "Updates nötig")
- Erkennst du ein MUSTER (mehrere Geräte gleichzeitig betroffen) → update_incident auf den relevantesten aktiven Incident mit root_cause-Analyse` : ''}
- triggerAt MUSS in der Zukunft liegen! Aktuelle Zeit beachten.

DRINGLICHKEIT (als "urgency" Feld in jeder Aktion):
- "urgent": Sicherheit, Service-Down, Zahlung fehlgeschlagen, <24h Deadline
- "high": <48h Deadline, Rate Limit, wichtige Erneuerungen
- "normal": Informativ, Optimierung, >48h Deadline
- "low": Statusberichte, stabile Werte, keine Eile

SICHERHEIT:
- Prüfe "Aktive Watches" und "Aktive Workflows" Sections — KEINE Duplikate vorschlagen
- Prüfe "Aktive Erinnerungen" Section — wenn dort bereits ein Reminder zum selben Thema existiert, KEINEN neuen vorschlagen!
- Workflows + Delegate erfordern User-Bestätigung
- Wenn keine Aktionen sinnvoll: lass den ${ACTION_MARKER} Block weg` : ''}

FOLLOW-UP:
- Prüfe "insight_delivered:" Memories in der Erinnerungen-Section. Wenn ein Insight >24h alt ist und kein passendes "insight_resolved:" Memory existiert, prüfe ob ein Follow-up Reminder sinnvoll ist (z.B. "Hast du das Geschenk für Bernhard schon besorgt?").
- Erstelle KEINEN Follow-up für rein informative Insights (Wetter, Strompreis, Status-Updates).`;
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
${this.confirmationQueue ? `\nWenn eine sinnvolle Aktion möglich ist (Skill, Watch, Workflow, Delegate), trenne mit "${ACTION_MARKER}" und hänge JSON-Array an. Max 5 Aktionen.` : ''}`;
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
    // Find actions separator — LLM might use exact marker, markdown header, or variations
    let markerIdx = text.indexOf(ACTION_MARKER);
    let markerLen = ACTION_MARKER.length;

    if (markerIdx === -1) {
      // Fallback: match **ACTIONS**, ## ACTIONS, ACTIONS, etc.
      const altMatch = text.match(/\n\s*(?:\*{1,2}ACTIONS?\*{1,2}|#{1,3}\s*ACTIONS?)\s*\n/i);
      if (altMatch && altMatch.index !== undefined) {
        markerIdx = altMatch.index;
        markerLen = altMatch[0].length;
      }
    }

    if (markerIdx === -1) {
      // Last resort: look for JSON array with action objects anywhere in text
      const jsonMatch = text.match(/```(?:json)?\s*\n\s*(\[\s*\{[\s\S]*?"type"\s*:\s*"[\s\S]*?\}\s*\])\s*\n\s*```/);
      if (jsonMatch) {
        const insightText = text.slice(0, jsonMatch.index).trim();
        const actions = this.tryParseActions(jsonMatch[1]);
        // Strip the JSON block from insights
        const cleanedInsightText = insightText.replace(/\n\s*(?:\*{1,2}ACTIONS?\*{1,2}|#{1,3}\s*ACTIONS?)\s*$/i, '').trim();
        return { insights: this.parseInsights(cleanedInsightText), actions };
      }
      return { insights: this.parseInsights(text), actions: [] };
    }

    const insightText = text.slice(0, markerIdx).trim();
    const actionText = text.slice(markerIdx + markerLen).trim();
    const insights = insightText ? this.parseInsights(insightText) : [];
    // Extract JSON from possible code block
    const jsonContent = actionText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
    const actions = this.tryParseActions(jsonContent);
    return { insights, actions };
  }

  private tryParseActions(jsonText: string): ProposedAction[] {
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) {
        return parsed.filter(a =>
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
    return [];
  }

  private actionHash(action: ProposedAction): string {
    // Topic-based hash: extract key words from description + skillName
    // This prevents the same action from being proposed repeatedly with different wording
    const words = `${action.description} ${action.skillName}`
      .toLowerCase()
      .replace(/[^a-zäöüß0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4)
      .sort()
      .join(' ');
    return crypto.createHash('sha256').update(words).digest('hex').slice(0, 16);
  }

  private async actionWasRecentlyProposed(action: ProposedAction): Promise<boolean> {
    const hash = this.actionHash(action);
    return await this.notifRepo.wasNotified(`reasoning-action:${hash}`, this.defaultChatId);
  }

  /** Check if the most recent confirmation for this action description expired or was rejected. */
  private async hasExpiredOrRejectedConfirmation(action: ProposedAction): Promise<boolean> {
    try {
      if (!this.confirmationQueue) return false;
      // Search in recent confirmations by description match
      const row = await this.adapter?.queryOne(
        `SELECT status FROM pending_confirmations WHERE chat_id = ? AND description = ? ORDER BY created_at DESC LIMIT 1`,
        [this.defaultChatId, action.description],
      ) as { status: string } | undefined;
      return row?.status === 'expired' || row?.status === 'rejected';
    } catch { return false; }
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
      const mem = await this.memoryRepo.recall(this.resolvedOwnerUserId || this.defaultChatId, 'autonomy_level');
      if (mem) {
        const level = mem.value.toLowerCase().trim();
        if (level.includes('autonomous') || level.includes('autonom')) return 'autonomous';
        if (level.includes('proactive') || level.includes('proaktiv')) return 'proactive';
      }
    } catch { /* use default */ }
    return 'confirm_all';
  }

  private resolveUrgency(actions: ProposedAction[]): 'urgent' | 'high' | 'normal' | 'low' {
    const levels: Array<'urgent' | 'high' | 'normal' | 'low'> = actions.map(a => a.urgency ?? 'normal');
    if (levels.includes('urgent')) return 'urgent';
    if (levels.includes('high')) return 'high';
    if (levels.includes('normal')) return 'normal';
    return levels.length > 0 ? 'low' : 'normal';
  }

  private async deliverOrDefer(
    insights: string[], actions: ProposedAction[],
    urgency: 'urgent' | 'high' | 'normal' | 'low', durationMs?: number,
  ): Promise<void> {
    // Build message
    let message = '';
    if (insights.length > 0) {
      message = `\u{1F4A1} **Alfred Insights**\n\n${insights.join('\n\n')}`;
      if (actions.length > 0) {
        const actionLines = actions.slice(0, 5).map(a => `\u26A1 ${a.description}`);
        message += `\n\n**Vorgeschlagene Aktionen:**\n${actionLines.join('\n')}`;
      }
    }

    // Check delivery timing
    let deliver = true;
    if (this.deliveryScheduler && urgency !== 'urgent') {
      try {
        if (!this.activityProfile) {
          this.activityProfile = await this.deliveryScheduler.loadOrComputeProfile(this.defaultChatId);
        }
        deliver = this.deliveryScheduler.shouldDeliverNow(urgency, this.activityProfile);
      } catch { deliver = true; /* fallback: deliver */ }
    }

    if (!deliver && this.deliveryScheduler && message) {
      // Defer for later
      await this.deliveryScheduler.defer(
        this.defaultChatId, this.defaultPlatform, urgency,
        message, JSON.stringify(actions),
      );
      this.logger.info({ urgency, insightCount: insights.length }, 'Insights deferred (user likely inactive)');
      // Mark as sent to avoid dedup re-triggering
      for (const insight of insights) await this.markSent(insight);
      return;
    }

    // Deliver now
    if (message) {
      const adapter = this.adapters.get(this.defaultPlatform);
      if (adapter) {
        await adapter.sendMessage(this.defaultChatId, message);
        for (const insight of insights) await this.markSent(insight);
        this.logger.info({ durationMs, insights: insights.length, actions: actions.length, urgency }, 'Reasoning pass: insights sent');
      }
      if (this.insightTracker) {
        for (const insight of insights) {
          const category = InsightTracker.categorizeInsight(insight);
          this.insightTracker.trackInsightSent(category);
        }
      }
      // Track delivered insights as memories for follow-up
      if (this.memoryRepo && this.resolvedOwnerUserId) {
        for (const insight of insights) {
          const topicWords = insight.toLowerCase().replace(/[^a-zäöüß\s]/g, '').split(/\s+/)
            .filter(w => w.length >= 4).slice(0, 3).sort().join('_');
          if (topicWords) {
            try {
              await this.memoryRepo.saveWithMetadata(this.resolvedOwnerUserId, `insight_delivered:${topicWords}`,
                insight.slice(0, 200), 'general', 'connection', 0.6, 'auto');
            } catch { /* non-critical */ }
          }
        }
      }
    }

    // Process actions
    if (actions.length > 0) {
      await this.processActions(actions);
    }

    // Also flush any previously deferred insights now that user is active
    if (this.deliveryScheduler) {
      try {
        const deferred = await this.deliveryScheduler.getPendingDeferred(this.defaultChatId);
        if (deferred.length > 0) {
          const adapter = this.adapters.get(this.defaultPlatform);
          if (adapter) {
            for (const d of deferred) {
              // Add age indicator for deferred insights
              let msg = d.message;
              if (d.created_at) {
                const ageMs = Date.now() - new Date(d.created_at).getTime();
                const ageMin = Math.round(ageMs / 60_000);
                if (ageMin > 30) {
                  const ageStr = ageMin >= 120 ? `${Math.round(ageMin / 60)}h` : `${ageMin} Min`;
                  msg = msg.replace(/^(💡 \*\*Alfred Insights\*\*)/, `$1 _(erstellt vor ${ageStr})_`);
                }
              }
              await adapter.sendMessage(this.defaultChatId, msg);
              // Process deferred actions
              try {
                const deferredActions = JSON.parse(d.actions) as ProposedAction[];
                if (deferredActions.length > 0) await this.processActions(deferredActions);
              } catch { /* no actions */ }
            }
            await this.deliveryScheduler.markDelivered(deferred.map(d => d.id));
            this.logger.info({ count: deferred.length }, 'Deferred insights flushed');
          }
        }
      } catch { /* non-critical */ }
    }
  }

  private async processActions(actions: ProposedAction[]): Promise<void> {
    if (actions.length === 0) return;

    const autonomyLevel = await this.getAutonomyLevel();

    const limit = actions.slice(0, 5);
    for (const action of limit) {
      // Normalize reminder params: LLM sometimes uses wrong field names
      if (action.skillName === 'reminder' && action.skillParams) {
        const p = action.skillParams;
        if (p.action === 'create') p.action = 'set';
        if (p.title && !p.message) { p.message = p.title; delete p.title; }
        if (p.due && !p.triggerAt) { p.triggerAt = p.due; delete p.due; }
        // Fix triggerAt in past → set to tomorrow same time
        if (p.triggerAt && typeof p.triggerAt === 'string') {
          const parsed = new Date(p.triggerAt.replace('T', ' ').replace(/:\d{2}$/, '')); // strip seconds
          if (!isNaN(parsed.getTime()) && parsed.getTime() < Date.now()) {
            const tomorrow = new Date(parsed.getTime() + 24 * 60 * 60_000);
            p.triggerAt = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T${String(tomorrow.getHours()).padStart(2, '0')}:${String(tomorrow.getMinutes()).padStart(2, '0')}`;
          }
          // Strip seconds if present (HH:MM:SS → HH:MM)
          p.triggerAt = String(p.triggerAt).replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}$/, '$1');
        }
      }

      // Skip reminder if an active (unfired OR recently fired) reminder with similar topic exists
      if (action.skillName === 'reminder' && action.skillParams?.message) {
        try {
          if (!this.resolvedOwnerUserId) {
            try {
              const user = await this.userRepo.findOrCreate(this.defaultPlatform, this.defaultChatId);
              this.resolvedOwnerUserId = user.masterUserId ?? user.id ?? this.defaultChatId;
            } catch { this.resolvedOwnerUserId = this.defaultChatId; }
          }
          const uid = this.resolvedOwnerUserId;
          const recentCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
          const existingReminders = await this.adapter?.query(
            "SELECT message FROM reminders WHERE (fired = 0 OR (fired = 1 AND trigger_at > ?)) AND (user_id = ? OR chat_id = ?)",
            [recentCutoff, uid, this.defaultChatId],
          ) as Array<{ message: string }> | undefined;
          if (existingReminders) {
            const actionWords = new Set(String(action.skillParams.message).toLowerCase().split(/\s+/).filter(w => w.length >= 4));
            const alreadyExists = existingReminders.some(r => {
              const rWords = r.message.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
              const shared = rWords.filter(w => actionWords.has(w)).length;
              return shared >= 3; // ≥3 shared keywords = same topic
            });
            if (alreadyExists) {
              this.logger.info({ action: action.description }, 'Reasoning: reminder already exists, skipping');
              continue;
            }
          }
        } catch { /* proceed */ }
      }

      if (await this.actionWasRecentlyProposed(action)) {
        // Allow re-proposal if the previous confirmation expired or was rejected
        const hash = this.actionHash(action);
        const shouldRetry = this.confirmationQueue
          ? await this.hasExpiredOrRejectedConfirmation(action)
          : false;
        if (!shouldRetry) {
          this.logger.info({ action: action.description }, 'Reasoning: action deduplicated, skipping');
          continue;
        }
      }

      // Action-Gating: skip skills with very low historical acceptance rate
      try {
        const feedback = await this.memoryRepo.recall(this.resolvedOwnerUserId || this.defaultChatId, `action_feedback_${action.skillName}`);
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
        // Validate action before enqueuing (prevent hallucinated actions in queue)
        const queueSkill = this.skillRegistry.get(action.skillName);
        if (queueSkill && action.skillParams?.action) {
          const qs = queueSkill.metadata.inputSchema as { properties?: { action?: { enum?: string[] } } } | undefined;
          const qValid = qs?.properties?.action?.enum;
          if (qValid && !qValid.includes(action.skillParams.action as string)) {
            this.logger.warn({ skillName: action.skillName, action: action.skillParams.action }, 'Reasoning: hallucinated action rejected before enqueue');
            continue;
          }
        }
        if (!this.confirmationQueue) continue;
        await this.confirmationQueue.enqueue({
          chatId: this.defaultChatId,
          platform: this.defaultPlatform,
          source: 'reasoning',
          sourceId: 'reasoning-engine',
          description: action.description,
          skillName: action.skillName,
          skillParams: action.skillParams,
          timeoutMinutes: 180,
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

    // Validate action against skill schema (prevent hallucinated actions)
    const actionParam = action.skillParams?.action as string | undefined;
    if (actionParam && skill.metadata.inputSchema) {
      const schema = skill.metadata.inputSchema as { properties?: { action?: { enum?: string[] } } };
      const validActions = schema.properties?.action?.enum;
      if (validActions && !validActions.includes(actionParam)) {
        this.logger.warn({ skillName: action.skillName, action: actionParam, validActions: validActions.join(',') },
          'Reasoning: hallucinated action rejected — not in skill schema');
        return;
      }
    }

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
