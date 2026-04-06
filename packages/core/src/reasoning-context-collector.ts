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
  WorkflowRepository,
  BmwTelematicRepository,
  NoteRepository,
  ReminderRepository,
  DocumentRepository,
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
  /** In-memory error tracking: was this section successful on the previous run? */
  private previousSuccess = new Map<string, boolean>();
  /** Resolved master user ID (cached after first resolve). */
  private resolvedUserId?: string;

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
    private readonly workflowRepo?: WorkflowRepository,
    private readonly bmwTelematicRepo?: BmwTelematicRepository,
    private readonly noteRepo?: NoteRepository,
    private readonly reminderRepo?: ReminderRepository,
    private readonly documentRepo?: DocumentRepository,
  ) {}

  /** Get the effective user ID for memory lookups (resolves master_user_id once, cached). */
  private async getEffectiveUserId(): Promise<string> {
    if (this.resolvedUserId) return this.resolvedUserId;
    try {
      const user = await this.userRepo.findOrCreate(this.defaultPlatform, this.defaultChatId);
      this.resolvedUserId = user.masterUserId ?? user.id;
    } catch {
      this.resolvedUserId = this.defaultChatId;
    }
    return this.resolvedUserId;
  }

  async collect(): Promise<CollectedContext> {
    // Resolve master user ID once per collect() for all memory lookups
    this.resolvedUserId = await this.getEffectiveUserId();

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

    // Change detection + error status annotation
    const changedSections: string[] = [];
    for (const section of sections) {
      const prev = this.previousContent.get(section.key);
      if (prev !== undefined && prev !== section.content) {
        section.changed = true;
        changedSections.push(section.key);
      }
      this.previousContent.set(section.key, section.content);

      // Annotate transient vs persistent errors so the LLM doesn't overreact
      const isError = section.content.startsWith('(') && (
        section.content.includes('fehlgeschlagen') || section.content.includes('error') ||
        section.content.includes('timeout') || section.content.includes('nicht verfügbar')
      );
      const wasSuccessful = this.previousSuccess.get(section.key);
      if (isError && wasSuccessful === true) {
        section.content += '\n⚠️ TRANSIENTER FEHLER — beim letzten Lauf funktionierte diese Quelle. Wahrscheinlich vorübergehend, KEIN Handlungsbedarf empfehlen.';
      } else if (isError && wasSuccessful === false) {
        section.content += '\n🔴 PERSISTENTER FEHLER — bereits beim letzten Lauf fehlgeschlagen. Handlungsbedarf möglich.';
      }
      this.previousSuccess.set(section.key, !isError);
    }

    // Memory-enrichment: annotate sections whose topics the user marked as resolved
    this.annotateResolvedTopics(sections);

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

    // Aktive Workflows (für Dedup — LLM sieht welche Workflows existieren)
    if (this.workflowRepo) {
      defs.push({
        key: 'workflows', label: 'Aktive Workflows', priority: 2, maxTokens: 200,
        fetch: () => this.fetchWorkflows(),
      });
    }

    // ── Priority 2: Notes, Reminders, Documents ──────────────
    if (this.reminderRepo) {
      defs.push({
        key: 'reminders', label: 'Aktive Erinnerungen', priority: 2, maxTokens: 100,
        fetch: () => this.fetchReminders(),
      });
    }
    if (this.noteRepo) {
      defs.push({
        key: 'notes', label: 'Notizen', priority: 2, maxTokens: 200,
        fetch: () => this.fetchNotes(),
      });
    }
    if (this.documentRepo) {
      defs.push({
        key: 'documents', label: 'Dokumente', priority: 3, maxTokens: 150,
        fetch: () => this.fetchDocuments(),
      });
    }

    // ── Priority 2: Skill-based (only if registered) ──────────
    // Weather with dynamic location resolution (from config → memories → skip)
    if (this.skillRegistry.has('weather')) {
      defs.push({
        key: 'weather', label: 'Wetter', priority: 2, maxTokens: 150,
        fetch: () => this.fetchWeather(),
      });
    }

    // Smart Home with domain filtering (from memories → default whitelist)
    if (this.skillRegistry.has('homeassistant')) {
      defs.push({
        key: 'smarthome', label: 'Smart Home', priority: 2, maxTokens: 400,
        fetch: () => this.fetchSmartHome(),
      });
    }

    // BMW with extended timeout (token refresh can take up to 15s + API call)
    if (this.skillRegistry.has('bmw')) {
      defs.push({
        key: 'bmw', label: 'BMW Status', priority: 2, maxTokens: 200,
        fetch: () => this.fetchBmwFromDb(),
      });
    }

    const p2: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'email', label: 'E-Mail Inbox', skill: 'email', input: { action: 'inbox', limit: 5 }, maxTokens: 250 },
      { key: 'energy', label: 'Energiepreise', skill: 'energy_price', input: { action: 'current' }, maxTokens: 150 },
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

    // RSS Feeds with extended timeout (check_all fetches multiple external servers)
    if (this.skillRegistry.has('feed_reader')) {
      defs.push({
        key: 'feeds', label: 'RSS Feeds (neue Artikel)', priority: 2, maxTokens: 400,
        fetch: () => this.fetchFeeds(),
      });
    }

    // Monitor/Infra with extended timeout (checks multiple services, can be slow)
    if (this.skillRegistry.has('monitor')) {
      defs.push({
        key: 'infra', label: 'Infrastruktur', priority: 3, maxTokens: 150,
        fetch: () => this.fetchWithTimeout('monitor', { action: 'status' }, 30_000),
      });
    }

    // CMDB summary (asset counts + open incidents with titles)
    if (this.skillRegistry.has('cmdb') || this.skillRegistry.has('itsm')) {
      defs.push({
        key: 'cmdb', label: 'CMDB / ITSM', priority: 2, maxTokens: 200,
        fetch: async () => {
          const parts: string[] = [];
          try {
            if (this.skillRegistry.has('cmdb')) {
              const statsResult = await this.fetchWithTimeout('cmdb', { action: 'stats' }, 10_000);
              if (statsResult) parts.push(statsResult);
            }
          } catch { /* skip */ }
          try {
            if (this.skillRegistry.has('itsm')) {
              const dashResult = await this.fetchWithTimeout('itsm', { action: 'dashboard' }, 10_000);
              if (dashResult) parts.push(dashResult);
              // Include open incident titles so LLM can avoid duplicates
              const incResult = await this.fetchWithTimeout('itsm', { action: 'list_incidents', status: 'open' }, 10_000);
              if (incResult) {
                // fetchWithTimeout returns the display string; extract just the titles
                // Alternatively, parse the skill result data
                const skill = this.skillRegistry.get('itsm');
                if (skill) {
                  const raw = await this.skillSandbox.execute(skill, { action: 'list_incidents', status: 'open' }, {} as any);
                  if (raw.success && Array.isArray(raw.data)) {
                    const titles = (raw.data as Array<{ title: string; severity: string; status: string }>)
                      .slice(0, 10)
                      .map(i => `- [${i.severity}] ${i.title} (${i.status})`)
                      .join('\n');
                    if (titles) parts.push(`Offene Incidents:\n${titles}`);
                  }
                }
              }
            }
          } catch { /* skip */ }
          return parts.join('\n') || '';
        },
      });
    }

    const p3Skills: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'mealPlan', label: 'Meal-Plan heute', skill: 'recipe', input: { action: 'meal_plan', sub_action: 'get', week: 'current', day: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() }, maxTokens: 100 },
      { key: 'travel', label: 'Anstehende Reisen', skill: 'travel', input: { action: 'plan_list', status: 'booked' }, maxTokens: 100 },
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

  /**
   * Cross-reference "resolved" memories against section content.
   * If a section mentions a topic the user has explicitly marked as resolved/erledigt,
   * annotate that section so the LLM doesn't re-surface it as an open issue.
   */
  private annotateResolvedTopics(sections: ReasoningSection[]): void {
    const memorySection = sections.find(s => s.key === 'memories');
    if (!memorySection) return;

    // Extract resolved memories: lines containing resolution keywords
    const resolvedPattern = /erledigt|resolved|überholt|kein.{0,20}handlungsbedarf|nicht mehr.{0,20}problem|abgeschlossen/i;
    const resolvedMemories: Array<{ key: string; line: string }> = [];
    for (const line of memorySection.content.split('\n')) {
      if (resolvedPattern.test(line)) {
        // Extract the memory key: "- [type] key_name: value..."
        const keyMatch = line.match(/\]\s*([^:]+):/);
        if (keyMatch) resolvedMemories.push({ key: keyMatch[1].trim(), line });
      }
    }
    if (resolvedMemories.length === 0) return;

    // For each resolved memory, extract topic words from the key (split on _ and filter short words)
    for (const resolved of resolvedMemories) {
      const topicWords = resolved.key.split('_')
        .filter(w => w.length >= 4)
        .map(w => w.toLowerCase());
      if (topicWords.length === 0) continue;

      // Annotate matching sections (not memories itself)
      for (const section of sections) {
        if (section.key === 'memories') continue;
        const contentLower = section.content.toLowerCase();
        const matches = topicWords.filter(w => contentLower.includes(w));
        if (matches.length >= 2 || (matches.length === 1 && topicWords.length === 1)) {
          section.content += `\n\n✅ ERLEDIGT laut User-Memory: "${resolved.line.replace(/^-\s*\[.*?\]\s*/, '').slice(0, 150)}" — NICHT als offenes Problem oder Handlungsbedarf darstellen.`;
        }
      }
    }
  }

  private async fetchMemories(): Promise<string> {
    try {
      const memories = await this.memoryRepo.getRecentForPrompt(this.resolvedUserId!, 20);
      const existingKeys = new Set(memories.map(m => m.key));
      for (const type of ['pattern', 'connection'] as const) {
        try {
          const typed = await this.memoryRepo.getByType(this.resolvedUserId!, type, 5);
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

  /** Read BMW telematic data directly from DB — zero REST API calls. */
  private async fetchBmwFromDb(): Promise<string> {
    if (!this.bmwTelematicRepo) {
      return this.fetchWithTimeout('bmw', { action: 'status' }, 20_000); // fallback to skill call
    }
    try {
      const uid = await this.getEffectiveUserId();
      // Get latest MQTT and REST snapshots
      const mqtt = await this.bmwTelematicRepo.getLatestAnyVinBySource(uid, 'mqtt');
      const rest = await this.bmwTelematicRepo.getLatestAnyVinBySource(uid, 'rest');

      if (!mqtt && !rest) return '(Keine BMW-Daten in DB)';

      // Merge: MQTT wins for shared fields
      const merged: Record<string, { value: string; unit?: string }> = {};
      if (rest) for (const [k, v] of Object.entries(rest.telematicData)) merged[k] = v as any;
      if (mqtt) for (const [k, v] of Object.entries(mqtt.telematicData)) merged[k] = v as any;

      const tv = (key: string, ...alts: string[]): string => {
        for (const k of [key, ...alts]) if (merged[k]?.value) return merged[k].value;
        return '?';
      };

      const soc = tv('vehicle.drivetrain.batteryManagement.header', 'vehicle.powertrain.electric.battery.stateOfCharge.displayed');
      const range = tv('vehicle.drivetrain.electricEngine.remainingElectricRange', 'vehicle.drivetrain.lastRemainingRange');
      const km = tv('vehicle.vehicle.travelledDistance');
      const lockedRaw = tv('vehicle.access.centralLocking.isLocked', 'vehicle.cabin.door.status');
      const locked = lockedRaw === 'true' || lockedRaw === 'LOCKED' || lockedRaw === 'SECURED' ? 'Ja' : lockedRaw === 'UNLOCKED' || lockedRaw === 'false' ? 'Nein' : '?';

      const newestAt = mqtt?.createdAt ?? rest?.createdAt;
      const dataAge = newestAt ? Math.round((Date.now() - new Date(newestAt).getTime()) / 60_000) : 999;

      // If data is very old (>6h) and no MQTT/REST update, do ONE REST refresh via skill
      if (dataAge > 360 && Object.keys(merged).length > 0) {
        try {
          const fresh = await this.fetchWithTimeout('bmw', { action: 'status' }, 20_000);
          if (fresh && !fresh.startsWith('(') && !fresh.includes('rate limit')) return fresh;
        } catch { /* rate limited or error — use stale data */ }
      }

      const lines = [
        `**Ladestand (SoC):** ${soc} %`,
        `**Reichweite:** ${range} km`,
        `**Kilometerstand:** ${km} km`,
        `**Verriegelt:** ${locked}`,
      ];
      if (dataAge > 60) lines.push(`⚠️ Daten ${dataAge} Min alt`);

      return lines.filter(l => !l.includes('?')).join('\n') || '(Keine verwertbaren BMW-Daten)';
    } catch (err) {
      this.logger.debug({ err }, 'BMW DB fetch failed');
      return '(BMW DB-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchReminders(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const pending = await this.reminderRepo!.getAllPending();
      // Filter: this user's reminders, due within 24h or overdue
      const cutoff = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const relevant = pending
        .filter(r => r.userId === uid || r.chatId === this.defaultChatId)
        .filter(r => r.triggerAt <= cutoff)
        .slice(0, 10);
      if (relevant.length === 0) return 'Keine aktiven Erinnerungen.';
      return relevant.map(r => {
        const due = new Date(r.triggerAt);
        const overdue = due.getTime() < Date.now();
        return `- ${overdue ? '⚠️ ÜBERFÄLLIG' : due.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${r.message}`;
      }).join('\n');
    } catch { return '(Erinnerungen nicht verfügbar)'; }
  }

  private async fetchNotes(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const notes = await this.noteRepo!.list(uid, 10);
      if (notes.length === 0) return 'Keine Notizen.';
      return notes.map(n => {
        const preview = n.content.slice(0, 100).replace(/\n/g, ' ');
        return `- [${n.updatedAt.slice(0, 10)}] **${n.title}**: ${preview}${n.content.length > 100 ? '...' : ''}`;
      }).join('\n');
    } catch { return '(Notizen nicht verfügbar)'; }
  }

  private async fetchDocuments(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const docs = await this.documentRepo!.listAccessible(uid);
      if (docs.length === 0) return 'Keine Dokumente.';
      return docs.slice(0, 15).map(d => {
        const sizeKb = Math.round(d.sizeBytes / 1024);
        return `- ${d.filename} (${sizeKb} KB, ${d.chunkCount} Seiten, ${d.createdAt.slice(0, 10)})`;
      }).join('\n');
    } catch { return '(Dokumente nicht verfügbar)'; }
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

  private async fetchSmartHome(): Promise<string> {
    // ADDITIVE system: Default-Domains + User-Domains + User-Entities — all combined
    const DEFAULT_DOMAINS = ['light', 'person', 'input_boolean', 'climate'];

    // binary_sensor needs special filtering (only door/window/motion/occupancy/smoke/plug)
    const BINARY_SENSOR_FILTER = /door|window|motion|occupancy|smoke|plug/i;

    const parts: string[] = [];

    // 1. Default domains (always loaded)
    await this.fetchSmartHomeByDomains(DEFAULT_DOMAINS, parts);

    // 2. binary_sensor filtered by device_class (door, motion, smoke, plug — not the 74 "none" and 57 "problem")
    try {
      const result = await this.fetchSkillData('homeassistant', { action: 'states', domain: 'binary_sensor' });
      if (result && !result.startsWith('(')) {
        const lines = result.split('\n').filter(l => {
          if (!l.startsWith('|') || l.startsWith('|---') || l.includes('Entity ID')) return false;
          // Only include lines where name suggests door/window/motion/smoke/plug
          return BINARY_SENSOR_FILTER.test(l);
        });
        if (lines.length > 0) {
          parts.push(`binary_sensor (${lines.length} gefiltert):`);
          for (const line of lines.slice(0, 20)) parts.push(line);
        }
      }
    } catch { /* skip */ }

    // 3. User-configured additional domains (ADDITIVE, from memory "briefing_ha_domains")
    try {
      const mems = await this.memoryRepo.search(this.resolvedUserId!, 'ha_domain');
      const domainMem = mems.find(m => /ha_domain|home.?assistant.*domain|briefing.*domain/i.test(m.key));
      if (domainMem) {
        const userDomains = domainMem.value.split(/[,;]\s*/).map(d => d.trim()).filter(Boolean);
        // Only fetch domains not already in defaults
        const additional = userDomains.filter(d => !DEFAULT_DOMAINS.includes(d) && d !== 'binary_sensor');
        if (additional.length > 0) {
          await this.fetchSmartHomeByDomains(additional, parts);
        }
      }
    } catch { /* skip */ }

    // 4. User-configured specific entities (ADDITIVE, from memory "briefing_ha_entities")
    try {
      const mems = await this.memoryRepo.search(this.resolvedUserId!, 'ha_entit');
      const entityMem = mems.find(m => /ha_entit|home.?assistant.*entit|briefing.*entit/i.test(m.key));
      if (entityMem) {
        const entityIds = entityMem.value.split(/[,;]\s*/).map(e => e.trim()).filter(Boolean);
        if (entityIds.length > 0) {
          await this.fetchSmartHomeByEntities(entityIds, parts);
        }
      }
    } catch { /* skip */ }

    return parts.length > 0 ? parts.join('\n') : '(Smart Home: keine relevanten Entities)';
  }

  private async fetchSmartHomeByEntities(entityIds: string[], parts: string[]): Promise<void> {
    parts.push('Konfigurierte Entities:');
    for (const eid of entityIds.slice(0, 20)) {
      try {
        const result = await this.fetchSkillData('homeassistant', { action: 'state', entityId: eid });
        if (result && !result.startsWith('(')) {
          const stateMatch = result.match(/\*\*State:\*\*\s*(.+)/);
          const nameMatch = result.match(/^##\s*(.+)/m);
          if (stateMatch) {
            parts.push(`  ${nameMatch?.[1] ?? eid}: ${stateMatch[1].trim()}`);
          }
        }
      } catch { /* skip entity */ }
    }
  }

  private async fetchSmartHomeByDomains(domains: string[], parts: string[]): Promise<void> {
    for (const domain of domains.slice(0, 8)) {
      try {
        const result = await this.fetchSkillData('homeassistant', { action: 'states', domain });
        if (result && !result.startsWith('(')) {
          const lines = result.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|---') && !l.includes('Entity ID'));
          if (lines.length > 0) {
            parts.push(`${domain} (${lines.length}):`);
            for (const line of lines.slice(0, 15)) parts.push(line);
          }
        }
      } catch { /* skip domain */ }
    }
  }

  /** Fetch a skill with a custom timeout (for slow skills like monitor, feed_reader). */
  private async fetchWithTimeout(skillName: string, input: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const skill = this.skillRegistry.get(skillName);
    if (!skill) return `(${skillName} nicht verfügbar)`;
    try {
      const { context } = await buildSkillContext(this.userRepo, {
        userId: this.defaultChatId, platform: this.defaultPlatform, chatId: this.defaultChatId, chatType: 'dm',
      });
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, context),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${skillName} timeout`)), timeoutMs)),
      ]);
      if (!result.success) return `(${skillName}: ${result.error})`;
      return result.display ?? JSON.stringify(result.data);
    } catch (err) {
      this.logger.warn({ err, skillName }, 'ReasoningCollector: skill fetch failed');
      return `(${skillName}-Abfrage fehlgeschlagen)`;
    }
  }

  private async fetchFeeds(): Promise<string> {
    return this.fetchWithTimeout('feed_reader', { action: 'check_all' }, 25_000);
  }

  private async fetchWorkflows(): Promise<string> {
    if (!this.workflowRepo) return 'Keine Workflow-Daten.';
    try {
      const workflows = await this.workflowRepo.findByUser(this.resolvedUserId!);
      if (workflows.length === 0) return 'Keine aktiven Workflows.';
      return workflows.map((w: any) => {
        const stepNames = (w.steps ?? []).map((s: any) => s.skillName || s.type || '?').join(' → ');
        const enabled = w.enabled !== false ? '✅' : '❌';
        return `- ${enabled} "${w.name}" (${stepNames})`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: workflow fetch failed');
      return '(Workflow-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchWeather(): Promise<string> {
    // Resolve location: config → memories (home address) → skip
    let location = this.defaultLocation;
    if (!location) {
      try {
        for (const query of ['heim', 'home', 'adress', 'wohn']) {
          const results = await this.memoryRepo.search(this.resolvedUserId!, query);
          if (results.length > 0) {
            // Extract city from address value
            const value = results[0].value;
            for (const city of ['Wien', 'Linz', 'Graz', 'Salzburg', 'Innsbruck', 'Klagenfurt', 'St. Pölten', 'Altlengbach']) {
              if (value.includes(city)) { location = city; break; }
            }
            if (location) break;
            // Fallback: use the whole value as location
            if (value.length > 2 && value.length < 50) { location = value; break; }
          }
        }
      } catch { /* skip location resolution */ }
    }
    if (!location) return '(Wetter: kein Standort konfiguriert — Heimadresse in Memories speichern oder ALFRED_BRIEFING_LOCATION setzen)';
    return this.fetchSkillData('weather', { action: 'current', location });
  }

  private async fetchTemporalInsights(): Promise<string> {
    try {
      const trends = await this.memoryRepo.recall(this.resolvedUserId!, 'temporal_trends_weekly');
      const anomalies = await this.memoryRepo.recall(this.resolvedUserId!, 'temporal_anomalies_weekly');
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
      const summary = await this.memoryRepo.recall(this.resolvedUserId!, 'action_feedback_summary');
      if (summary?.value) {
        parts.push(summary.value);
      }

      // Insight preferences
      const prefs = await this.memoryRepo.search(this.resolvedUserId!, 'insight_pref_');
      if (prefs.length > 0) {
        const positive = prefs.filter(p => p.value.includes('positiv')).map(p => p.key.replace('insight_pref_', ''));
        const negative = prefs.filter(p => p.value.includes('ablehnt') || p.value.includes('ignoriert')).map(p => p.key.replace('insight_pref_', ''));
        if (positive.length > 0) parts.push(`Insight-Präferenz positiv: ${positive.join(', ')}`);
        if (negative.length > 0) parts.push(`Insight-Präferenz negativ: ${negative.join(', ')}`);
      }

      // Autonomy suggestion
      const suggestion = await this.memoryRepo.recall(this.resolvedUserId!, 'autonomy_suggestion');
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
