import type { Logger } from 'pino';
import type { MemoryRepository, SkillStateRepository } from '@alfred/storage';

interface PendingBatch {
  categories: string[];
  sentAt: number;
}

interface CategoryStats {
  positive: number;
  negative: number;
  ignored: number;
}

export class InsightTracker {
  private static readonly STATS_MEMORY_KEY = 'insight_tracker_stats';

  /** Batches of actionable insights awaiting user reaction (2h window). */
  private pendingBatches: PendingBatch[] = [];
  /** Accumulated stats per category. */
  private stats = new Map<string, CategoryStats>();
  /** Whether stats have been loaded from DB. */
  private loaded = false;
  /** Minimum interactions before saving preference. */
  private readonly MIN_SAMPLES = 10;
  /** Reaction window: 2 hours (was 30 min — too short for async messaging). */
  private static readonly REACTION_WINDOW_MS = 2 * 60 * 60_000;

  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
    private readonly skillState?: SkillStateRepository,
  ) {}

  private async ensureLoaded(userId: string): Promise<void> {
    if (this.loaded) return;
    try {
      let raw: string | undefined;
      if (this.skillState) {
        raw = await this.skillState.get(userId, 'insight_tracker', 'stats');
      } else {
        const entry = await this.memoryRepo.recall(userId, InsightTracker.STATS_MEMORY_KEY);
        raw = entry?.value;
      }
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, CategoryStats>;
        for (const [cat, stat] of Object.entries(obj)) {
          this.stats.set(cat, stat);
        }
      }
    } catch {
      // No persisted state yet
    }
    this.loaded = true;
  }

  private async persistStats(userId: string): Promise<void> {
    const obj = Object.fromEntries(this.stats);
    if (this.skillState) {
      await this.skillState.set(userId, 'insight_tracker', 'stats', JSON.stringify(obj));
    } else {
      await this.memoryRepo.save(userId, InsightTracker.STATS_MEMORY_KEY, JSON.stringify(obj), 'system');
    }
  }

  /**
   * Track a batch of insights sent together.
   * Only ACTIONABLE insights are tracked — informational ones don't need a response.
   */
  trackInsightBatch(categories: string[], insightTexts: string[]): void {
    const actionableCategories = categories.filter((_, i) =>
      InsightTracker.classifyInsightType(insightTexts[i] ?? '') === 'actionable',
    );
    if (actionableCategories.length === 0) return;

    this.pendingBatches.push({ categories: actionableCategories, sentAt: Date.now() });

    // Expire old batches
    const cutoff = Date.now() - InsightTracker.REACTION_WINDOW_MS;
    this.pendingBatches = this.pendingBatches.filter(b => b.sentAt > cutoff);
  }

  /**
   * Legacy single-insight tracking — delegates to batch tracking.
   */
  trackInsightSent(category: string, insightText?: string): void {
    this.trackInsightBatch([category], [insightText ?? '']);
  }

  /**
   * Called by MessagePipeline when user sends a message.
   * Checks if it's a reaction to a recent insight batch.
   */
  async onUserMessage(userId: string, text: string): Promise<void> {
    await this.ensureLoaded(userId);
    if (this.pendingBatches.length === 0) return;

    const cutoff = Date.now() - InsightTracker.REACTION_WINDOW_MS;
    const recent = this.pendingBatches.filter(b => b.sentAt > cutoff);
    if (recent.length === 0) return;

    const sentiment = this.detectSentiment(text);
    if (sentiment === 'neutral') return;

    // Apply sentiment to ALL categories in the most recent batch
    const batch = recent[recent.length - 1];
    for (const cat of batch.categories) {
      const stat = this.stats.get(cat) ?? { positive: 0, negative: 0, ignored: 0 };
      if (sentiment === 'positive') stat.positive++;
      else if (sentiment === 'negative') stat.negative++;
      this.stats.set(cat, stat);
    }

    await this.persistStats(userId).catch(() => {});
    this.pendingBatches = this.pendingBatches.filter(b => b !== batch);
    await this.savePreferences(userId);
  }

  /**
   * Called when System B (message-pipeline insight-response detection) resolves an insight.
   * This is more accurate than keyword detection — feeds into preference learning.
   */
  async onInsightResolved(userId: string, category: string): Promise<void> {
    await this.ensureLoaded(userId);
    const stat = this.stats.get(category) ?? { positive: 0, negative: 0, ignored: 0 };
    stat.positive++;
    this.stats.set(category, stat);
    await this.persistStats(userId).catch(() => {});
    await this.savePreferences(userId);
  }

  /**
   * Called periodically to mark unreacted ACTIONABLE insights as "ignored".
   * Informational insights are never tracked, so they never become "ignored".
   */
  async processExpired(userId: string): Promise<void> {
    await this.ensureLoaded(userId);
    const cutoff = Date.now() - InsightTracker.REACTION_WINDOW_MS;
    const expired = this.pendingBatches.filter(b => b.sentAt <= cutoff);

    for (const batch of expired) {
      for (const cat of batch.categories) {
        const stat = this.stats.get(cat) ?? { positive: 0, negative: 0, ignored: 0 };
        stat.ignored++;
        this.stats.set(cat, stat);
      }
    }

    this.pendingBatches = this.pendingBatches.filter(b => b.sentAt > cutoff);

    if (expired.length > 0) {
      await this.persistStats(userId).catch(() => {});
      this.savePreferences(userId).catch(() => {});
    }
  }

  private detectSentiment(text: string): 'positive' | 'negative' | 'neutral' {
    const lower = text.toLowerCase().trim();

    // Negative signals (explicit rejection — these are reliable)
    if (/\b(stopp|stop|nervig|nervt|aufhören|nicht mehr|zu viel|spam|egal|unwichtig|brauche? ich nicht|interessiert mich nicht|halt die fresse|sei still|ruhe)\b/.test(lower)) {
      return 'negative';
    }

    // Positive signals (explicit acknowledgment)
    if (/\b(danke|super|perfekt|genau|gut|toll|klasse|top|prima|stimmt|richtig|mach|erledige|kümmere|passt|alles klar|check|verstanden|noted|thx|thanks)\b/.test(lower)) {
      return 'positive';
    }

    return 'neutral';
  }

  private async savePreferences(userId: string): Promise<void> {
    for (const [category, stat] of this.stats) {
      const total = stat.positive + stat.negative + stat.ignored;
      if (total < this.MIN_SAMPLES) continue;

      const positiveRate = stat.positive / total;
      const negativeRate = stat.negative / total;

      let preference: string;
      let confidence: number;

      if (positiveRate >= 0.5) {
        preference = `User findet ${category}-Insights nützlich (${stat.positive}/${total} positiv)`;
        confidence = Math.min(0.95, 0.6 + positiveRate * 0.3);
      } else if (negativeRate >= 0.5) {
        // Only explicit rejections trigger "reduce" — not silence
        preference = `User hat ${category}-Insights EXPLIZIT abgelehnt (${stat.negative}/${total} negativ) — Häufigkeit reduzieren aber nicht eliminieren`;
        confidence = Math.min(0.95, 0.6 + negativeRate * 0.3);
      } else {
        // No clear preference — don't save anything
        // This is the key change: silence ≠ rejection
        continue;
      }

      try {
        await this.memoryRepo.saveWithMetadata(
          userId, `insight_pref_${category}`, preference,
          'preferences', 'pattern', confidence, 'auto',
        );
        this.logger.info({ category, preference, total }, 'Insight preference saved');
      } catch { /* skip */ }
    }
  }

  /**
   * Classify whether an insight is informational (no response expected)
   * or actionable (user should respond or take action).
   */
  static classifyInsightType(text: string): 'informational' | 'actionable' {
    const lower = text.toLowerCase();
    if (/konflikt|warnung|⚠️|dringend|deadline|handlungsbedarf|reicht nicht|fehlt|überfällig|sofort|laden nötig|prüfen|action|aktion|entscheid|bestätig/.test(lower)) {
      return 'actionable';
    }
    return 'informational';
  }

  /**
   * Derive insight category from the reasoning context/text.
   */
  static categorizeInsight(text: string): string {
    const lower = text.toLowerCase();
    if (/strom|energie|kwh|laden|wallbox|awattar/.test(lower)) return 'energy';
    if (/kalender|termin|meeting|besprechung/.test(lower)) return 'calendar';
    if (/crypto|bitcoin|btc|eth|kurs|coin/.test(lower)) return 'crypto';
    if (/rss|feed|artikel|news|nachricht/.test(lower)) return 'rss';
    if (/todo|aufgabe|erledigen|fällig/.test(lower)) return 'todo';
    if (/wetter|temperatur|regen|wind/.test(lower)) return 'weather';
    if (/reise|flug|hotel|urlaub/.test(lower)) return 'travel';
    if (/preis|angebot|günstig|geizhals|shop/.test(lower)) return 'shopping';
    if (/bmw|auto|reichweite|akku|soc/.test(lower)) return 'vehicle';
    return 'general';
  }
}
