import type { Logger } from 'pino';
import type { Platform } from '@alfred/types';
import type {
  TodoRepository,
  WatchRepository,
  MemoryRepository,
  ActivityRepository,
  SkillHealthRepository,
  FeedbackRepository,
  UserRepository,
} from '@alfred/storage';
import type { SkillRegistry, SkillSandbox, CalendarProvider } from '@alfred/skills';
import { buildSkillContext } from './context-factory.js';

// ── Types ────────────────────────────────────────────────────

export interface ReasoningSection {
  key: string;
  label: string;
  content: string;
  priority: 1 | 2 | 3;
  tokenEstimate: number;
  changed: boolean;
}

export interface CollectedContext {
  dateTime: string;
  sections: ReasoningSection[];
  changedSections: string[];
  totalTokens: number;
}

// ── Source Definitions ───────────────────────────────────────

interface SourceDef {
  key: string;
  label: string;
  priority: 1 | 2 | 3;
  maxTokens: number;
  fetch: () => Promise<string>;
}

// ── Constants ────────────────────────────────────────────────

/** Total token budget for all data sections combined. */
const TOTAL_TOKEN_BUDGET = 3500;

/** Timeout for individual skill data fetches (ms). */
const SKILL_FETCH_TIMEOUT_MS = 5_000;

// ── Collector ────────────────────────────────────────────────

export class ReasoningContextCollector {
  /** In-memory change detection: previous content per section key. */
  private previousContent = new Map<string, string>();

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly userRepo: UserRepository,
    private readonly calendarProvider: CalendarProvider | undefined,
    private readonly todoRepo: TodoRepository,
    private readonly watchRepo: WatchRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly skillHealthRepo: SkillHealthRepository,
    private readonly feedbackRepo: FeedbackRepository | undefined,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    private readonly defaultLocation: string | undefined,
    private readonly logger: Logger,
  ) {}

  async collect(): Promise<CollectedContext> {
    const now = new Date();
    const dateTime = now.toLocaleString('de-AT', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const sources = this.buildSourceDefs(now);

    // Fetch all sources in parallel (Promise.allSettled = non-blocking)
    const results = await Promise.allSettled(
      sources.map(async (src): Promise<ReasoningSection> => {
        const content = await src.fetch();
        return {
          key: src.key,
          label: src.label,
          priority: src.priority,
          content,
          tokenEstimate: Math.ceil(content.length / 4),
          changed: false, // set below
        };
      }),
    );

    // Collect fulfilled results, skip failures
    const sections: ReasoningSection[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.content) {
        sections.push(r.value);
      }
    }

    // Change detection
    const changedSections: string[] = [];
    for (const section of sections) {
      const prev = this.previousContent.get(section.key);
      if (prev !== undefined && prev !== section.content) {
        section.changed = true;
        changedSections.push(section.key);
      }
      this.previousContent.set(section.key, section.content);
    }

    // Fit to token budget
    const fitted = this.fitToBudget(sections, TOTAL_TOKEN_BUDGET);
    const totalTokens = fitted.reduce((sum, s) => sum + s.tokenEstimate, 0);

    return { dateTime, sections: fitted, changedSections, totalTokens };
  }

  // ── Source Definitions ──────────────────────────────────────

  private buildSourceDefs(now: Date): SourceDef[] {
    const defs: SourceDef[] = [];

    // ── Priority 1: Always available (DB queries) ─────────────
    defs.push(
      { key: 'calendar', label: 'Kalender (nächste 48h)', priority: 1, maxTokens: 400, fetch: () => this.fetchCalendar(now) },
      { key: 'todos', label: 'Offene Todos', priority: 1, maxTokens: 300, fetch: () => this.fetchTodos() },
      { key: 'watches', label: 'Aktive Watches', priority: 1, maxTokens: 300, fetch: () => this.fetchWatches() },
      { key: 'memories', label: 'User-Erinnerungen', priority: 1, maxTokens: 500, fetch: () => this.fetchMemories() },
    );

    // ── Priority 2: Skill-based (only if registered) ──────────
    const p2: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'email', label: 'E-Mail Inbox', skill: 'email', input: { action: 'inbox', limit: 5 }, maxTokens: 250 },
      { key: 'weather', label: 'Wetter', skill: 'weather', input: { action: 'current', ...(this.defaultLocation ? { location: this.defaultLocation } : {}) }, maxTokens: 150 },
      { key: 'energy', label: 'Energiepreise', skill: 'energy_price', input: { action: 'current' }, maxTokens: 150 },
      { key: 'bmw', label: 'BMW Status', skill: 'bmw', input: { action: 'status' }, maxTokens: 200 },
      { key: 'smarthome', label: 'Smart Home', skill: 'homeassistant', input: { action: 'states' }, maxTokens: 300 },
      { key: 'charger', label: 'Wallbox', skill: 'goe_charger', input: { action: 'status' }, maxTokens: 100 },
      { key: 'mstodo', label: 'Microsoft To Do', skill: 'microsoft_todo', input: { action: 'list_tasks' }, maxTokens: 200 },
      { key: 'crypto', label: 'Crypto/Bitpanda', skill: 'bitpanda', input: { action: 'portfolio' }, maxTokens: 150 },
    ];
    for (const src of p2) {
      if (this.skillRegistry.has(src.skill)) {
        defs.push({
          key: src.key, label: src.label, priority: 2, maxTokens: src.maxTokens,
          fetch: () => this.fetchSkillData(src.skill, src.input),
        });
      }
    }

    // ── Priority 2: Temporal trends (from TemporalAnalyzer memories) ──
    defs.push({
      key: 'trends', label: 'Trends & Anomalien (4 Wochen)', priority: 2, maxTokens: 250,
      fetch: () => this.fetchTemporalInsights(),
    });

    // ── Priority 2: User feedback on actions + insights ───────
    defs.push({
      key: 'action_feedback', label: 'User-Feedback (Aktionen & Insights)', priority: 2, maxTokens: 200,
      fetch: () => this.fetchActionFeedback(),
    });

    // ── Priority 3: Nice-to-have ──────────────────────────────
    defs.push(
      { key: 'activity', label: 'Aktivität 24h', priority: 3, maxTokens: 150, fetch: () => this.fetchActivity() },
      { key: 'skillHealth', label: 'Skill-Status', priority: 3, maxTokens: 100, fetch: () => this.fetchSkillHealth() },
      { key: 'feedback', label: 'Nutzer-Feedback', priority: 3, maxTokens: 100, fetch: () => this.fetchFeedback() },
    );

    const p3Skills: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'mealPlan', label: 'Meal-Plan heute', skill: 'recipe', input: { action: 'meal_plan', sub_action: 'get', week: 'current', day: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() }, maxTokens: 100 },
      { key: 'travel', label: 'Anstehende Reisen', skill: 'travel', input: { action: 'plan_list', status: 'booked' }, maxTokens: 100 },
      { key: 'feeds', label: 'RSS Feeds (letzte)', skill: 'feed_reader', input: { action: 'recent', limit: 5 }, maxTokens: 150 },
      { key: 'infra', label: 'Infrastruktur', skill: 'monitor', input: { action: 'status' }, maxTokens: 100 },
    ];
    for (const src of p3Skills) {
      if (this.skillRegistry.has(src.skill)) {
        defs.push({
          key: src.key, label: src.label, priority: 3, maxTokens: src.maxTokens,
          fetch: () => this.fetchSkillData(src.skill, src.input),
        });
      }
    }

    return defs;
  }

  // ── Token Budget Management ─────────────────────────────────

  private fitToBudget(sections: ReasoningSection[], maxTokens: number): ReasoningSection[] {
    // Sort: priority ASC, then changed first, then by tokenEstimate ASC
    const sorted = [...sections].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      return a.tokenEstimate - b.tokenEstimate;
    });

    const result: ReasoningSection[] = [];
    let remaining = maxTokens;

    for (const section of sorted) {
      if (remaining <= 0) break;

      if (section.tokenEstimate <= remaining) {
        result.push(section);
        remaining -= section.tokenEstimate;
      } else if (section.priority <= 2) {
        // Priority 1+2: truncate rather than drop
        const maxChars = remaining * 4;
        const truncated = section.content.slice(0, maxChars) + '\n...(gekürzt)';
        result.push({
          ...section,
          content: truncated,
          tokenEstimate: Math.ceil(truncated.length / 4),
        });
        remaining = 0;
      }
      // Priority 3: drop if over budget
    }

    return result;
  }

  // ── Data Fetchers ───────────────────────────────────────────

  private async fetchCalendar(now: Date): Promise<string> {
    if (!this.calendarProvider) return '(Kalender nicht konfiguriert)';
    try {
      const start = now;
      const end = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48h window
      const events = await this.calendarProvider.listEvents(start, end);
      if (events.length === 0) return 'Keine Termine in den nächsten 48h.';
      return events.map(e => {
        const time = e.start instanceof Date
          ? e.start.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
          : String(e.start);
        const day = e.start instanceof Date
          ? e.start.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' })
          : '';
        const loc = e.location ? ` (${e.location})` : '';
        return `- ${day} ${time}: ${e.title ?? 'Termin'}${loc}`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: calendar fetch failed');
      return '(Kalender-Abfrage fehlgeschlagen)';
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
      this.logger.warn({ err }, 'ReasoningCollector: todo fetch failed');
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
      this.logger.warn({ err }, 'ReasoningCollector: watch fetch failed');
      return '(Watch-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchMemories(): Promise<string> {
    try {
      const memories = await this.memoryRepo.getRecentForPrompt(this.defaultChatId, 20);
      const existingKeys = new Set(memories.map(m => m.key));
      for (const type of ['pattern', 'connection'] as const) {
        try {
          const typed = await this.memoryRepo.getByType(this.defaultChatId, type, 5);
          for (const m of typed) {
            if (!existingKeys.has(m.key)) { existingKeys.add(m.key); memories.push(m); }
          }
        } catch { /* skip */ }
      }
      // Limit to 25 entries, prioritizing pattern + connection
      const MAX = 25;
      if (memories.length > MAX) {
        const priority = memories.filter(m => m.type === 'pattern' || m.type === 'connection');
        const rest = memories.filter(m => m.type !== 'pattern' && m.type !== 'connection');
        memories.length = 0;
        memories.push(...priority, ...rest.slice(0, MAX - priority.length));
      }
      if (memories.length === 0) return 'Keine gespeicherten Erinnerungen.';
      return memories.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: memory fetch failed');
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
      this.logger.warn({ err }, 'ReasoningCollector: activity fetch failed');
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
      this.logger.warn({ err }, 'ReasoningCollector: skill health fetch failed');
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
      this.logger.warn({ err }, 'ReasoningCollector: feedback fetch failed');
      return '';
    }
  }

  private async fetchTemporalInsights(): Promise<string> {
    try {
      const trends = await this.memoryRepo.recall(this.defaultChatId, 'temporal_trends_weekly');
      const anomalies = await this.memoryRepo.recall(this.defaultChatId, 'temporal_anomalies_weekly');
      const parts: string[] = [];
      if (trends?.value && trends.value !== 'Keine signifikanten Trends.') {
        parts.push(`Trends:\n${trends.value}`);
      }
      if (anomalies?.value && anomalies.value !== 'Keine Anomalien.') {
        parts.push(`Anomalien:\n${anomalies.value}`);
      }
      return parts.length > 0 ? parts.join('\n\n') : 'Keine temporalen Auffälligkeiten.';
    } catch {
      return '(Trend-Daten nicht verfügbar)';
    }
  }

  private async fetchActionFeedback(): Promise<string> {
    try {
      const parts: string[] = [];

      // Action acceptance rates
      const summary = await this.memoryRepo.recall(this.defaultChatId, 'action_feedback_summary');
      if (summary?.value) {
        parts.push(summary.value);
      }

      // Insight preferences
      const prefs = await this.memoryRepo.search(this.defaultChatId, 'insight_pref_');
      if (prefs.length > 0) {
        const positive = prefs.filter(p => p.value.includes('positiv')).map(p => p.key.replace('insight_pref_', ''));
        const negative = prefs.filter(p => p.value.includes('ablehnt') || p.value.includes('ignoriert')).map(p => p.key.replace('insight_pref_', ''));
        if (positive.length > 0) parts.push(`Insight-Präferenz positiv: ${positive.join(', ')}`);
        if (negative.length > 0) parts.push(`Insight-Präferenz negativ: ${negative.join(', ')}`);
      }

      // Autonomy suggestion
      const suggestion = await this.memoryRepo.recall(this.defaultChatId, 'autonomy_suggestion');
      if (suggestion?.value) parts.push(suggestion.value);

      return parts.length > 0 ? parts.join('\n') : 'Noch kein Feedback zu Aktionen gesammelt.';
    } catch {
      return '(Feedback-Daten nicht verfügbar)';
    }
  }

  // ── Enrichment ───────────────────────────────────────────

  /** Topic-to-skill mapping for deep enrichment fetches after Scan identifies concerns. */
  private static readonly ENRICHMENT_MAP: Record<string, { skill: string; input: Record<string, unknown>; maxTokens: number }> = {
    vehicle_battery:  { skill: 'bmw',          input: { action: 'status' },                  maxTokens: 300 },
    routing:          { skill: 'routing',       input: { action: 'route' },                   maxTokens: 300 },
    weather_forecast: { skill: 'weather',       input: { action: 'forecast' },                maxTokens: 250 },
    email_detail:     { skill: 'email',         input: { action: 'inbox', limit: 3 },         maxTokens: 300 },
    calendar_detail:  { skill: 'calendar',      input: { action: 'list_events', days: 3 },    maxTokens: 300 },
    smarthome_detail: { skill: 'homeassistant', input: { action: 'states' },                  maxTokens: 300 },
    crypto_detail:    { skill: 'bitpanda',      input: { action: 'portfolio' },               maxTokens: 250 },
    energy_forecast:  { skill: 'energy_price',  input: { action: 'today' },                   maxTokens: 200 },
  };

  /** Timeout for enrichment skill fetches (longer than base context). */
  private static readonly ENRICHMENT_TIMEOUT_MS = 8_000;

  /** Separate token budget for enrichment data. */
  private static readonly MAX_ENRICHMENT_TOKENS = 1500;

  /**
   * Fetch deeper data for topics identified by the Scan pass.
   * Runs in parallel with per-skill dedup and token budget enforcement.
   */
  async enrichTopics(topics: Array<{ topic: string; params?: Record<string, unknown> }>): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    // Handle memory-based topics (no skill call needed)
    for (const t of topics) {
      if (t.topic === 'trend_analysis') {
        const content = await this.fetchTemporalInsights();
        if (content && !content.startsWith('(') && content !== 'Keine temporalen Auffälligkeiten.') {
          results.set('trend_analysis', content);
        }
      }
    }

    // Deduplicate: don't call same skill twice
    const toFetch = new Map<string, { topic: string; skill: string; input: Record<string, unknown> }>();
    for (const t of topics) {
      const def = ReasoningContextCollector.ENRICHMENT_MAP[t.topic];
      if (!def || !this.skillRegistry.has(def.skill)) continue;
      if (toFetch.has(def.skill)) continue;
      const mergedInput = { ...def.input, ...(t.params ?? {}) };
      toFetch.set(t.topic, { topic: t.topic, skill: def.skill, input: mergedInput });
    }

    if (toFetch.size === 0) return results;

    // Parallel fetch with timeout
    const fetches = [...toFetch.values()].map(async (entry) => {
      try {
        const content = await Promise.race([
          this.fetchSkillData(entry.skill, entry.input),
          new Promise<string>((_, rej) =>
            setTimeout(() => rej(new Error('enrichment timeout')), ReasoningContextCollector.ENRICHMENT_TIMEOUT_MS),
          ),
        ]);
        return { topic: entry.topic, content };
      } catch {
        return { topic: entry.topic, content: '' };
      }
    });

    const settled = await Promise.allSettled(fetches);
    let usedTokens = 0;

    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value.content) continue;
      const est = Math.ceil(r.value.content.length / 4);
      if (usedTokens + est > ReasoningContextCollector.MAX_ENRICHMENT_TOKENS) {
        const remaining = (ReasoningContextCollector.MAX_ENRICHMENT_TOKENS - usedTokens) * 4;
        if (remaining > 100) {
          results.set(r.value.topic, r.value.content.slice(0, remaining) + '\n...(gekürzt)');
        }
        break;
      }
      results.set(r.value.topic, r.value.content);
      usedTokens += est;
    }

    return results;
  }

  // ── Skill Data Fetcher ──────────────────────────────────────

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

      // Timeout wrapper
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${skillName} timeout`)), SKILL_FETCH_TIMEOUT_MS),
        ),
      ]);

      if (!result.success) return `(${skillName}: ${result.error})`;
      return result.display ?? JSON.stringify(result.data);
    } catch (err) {
      this.logger.warn({ err, skillName }, 'ReasoningCollector: skill fetch failed');
      return `(${skillName}-Abfrage fehlgeschlagen)`;
    }
  }
}
