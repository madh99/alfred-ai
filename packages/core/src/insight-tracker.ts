import type { Logger } from 'pino';
import type { MemoryRepository, SkillStateRepository } from '@alfred/storage';

interface PendingInsight {
  category: string;
  sentAt: number;
}

interface CategoryStats {
  positive: number;
  negative: number;
  ignored: number;
}

export class InsightTracker {
  private static readonly STATS_MEMORY_KEY = 'insight_tracker_stats';

  /** Insights awaiting user reaction (max 30 min window). */
  private pending: PendingInsight[] = [];
  /** Accumulated stats per category. */
  private stats = new Map<string, CategoryStats>();
  /** Whether stats have been loaded from DB. */
  private loaded = false;
  /** Minimum interactions before saving preference. */
  private readonly MIN_SAMPLES = 5;

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
      // No persisted state yet — fine on fresh start
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
   * Called by ReasoningEngine after sending an insight.
   * Category is derived from the insight context (energy, calendar, crypto, rss, todo, weather, travel, shopping).
   */
  trackInsightSent(category: string): void {
    this.pending.push({ category, sentAt: Date.now() });
    // Expire old pending insights (>30 min)
    const cutoff = Date.now() - 30 * 60_000;
    this.pending = this.pending.filter(p => p.sentAt > cutoff);
  }

  /**
   * Called by MessagePipeline when user sends a message.
   * Checks if it's a reaction to a recent insight.
   */
  async onUserMessage(userId: string, text: string): Promise<void> {
    await this.ensureLoaded(userId);
    if (this.pending.length === 0) return;

    const cutoff = Date.now() - 30 * 60_000;
    const recent = this.pending.filter(p => p.sentAt > cutoff);
    if (recent.length === 0) return;

    // Determine sentiment from user message
    const sentiment = this.detectSentiment(text);

    if (sentiment === 'neutral') {
      // Not clearly a reaction to an insight — ignore
      return;
    }

    // Apply sentiment to the most recent pending insight
    const latest = recent[recent.length - 1];
    const stat = this.stats.get(latest.category) ?? { positive: 0, negative: 0, ignored: 0 };

    if (sentiment === 'positive') {
      stat.positive++;
    } else if (sentiment === 'negative') {
      stat.negative++;
    }

    this.stats.set(latest.category, stat);
    await this.persistStats(userId).catch(() => {});

    // Remove the reacted-to insight from pending
    this.pending = this.pending.filter(p => p !== latest);

    // Save preference if enough samples
    await this.savePreferences(userId);
  }

  /**
   * Called periodically (e.g. hourly) to mark unreacted insights as "ignored".
   */
  async processExpired(userId: string): Promise<void> {
    await this.ensureLoaded(userId);
    const cutoff = Date.now() - 30 * 60_000;
    const expired = this.pending.filter(p => p.sentAt <= cutoff);

    for (const p of expired) {
      const stat = this.stats.get(p.category) ?? { positive: 0, negative: 0, ignored: 0 };
      stat.ignored++;
      this.stats.set(p.category, stat);
    }

    this.pending = this.pending.filter(p => p.sentAt > cutoff);

    // Save if enough data
    if (expired.length > 0) {
      await this.persistStats(userId).catch(() => {});
      this.savePreferences(userId).catch(() => {});
    }
  }

  private detectSentiment(text: string): 'positive' | 'negative' | 'neutral' {
    const lower = text.toLowerCase().trim();

    // Positive signals
    if (/\b(danke|super|perfekt|genau|gut|toll|klasse|top|prima|stimmt|richtig|ja|ok|mach|erledige|kümmere)\b/.test(lower)) {
      return 'positive';
    }

    // Negative signals
    if (/\b(stopp|stop|nervig|nervt|aufhören|nicht mehr|zu viel|spam|egal|unwichtig|brauche? ich nicht|interessiert mich nicht)\b/.test(lower)) {
      return 'negative';
    }

    return 'neutral';
  }

  private async savePreferences(userId: string): Promise<void> {
    for (const [category, stat] of this.stats) {
      const total = stat.positive + stat.negative + stat.ignored;
      if (total < this.MIN_SAMPLES) continue;

      const positiveRate = stat.positive / total;
      const negativeRate = stat.negative / total;
      const ignoredRate = stat.ignored / total;

      let preference: string;
      let confidence: number;

      if (positiveRate >= 0.6) {
        preference = `User reagiert positiv auf ${category}-Insights (${stat.positive}/${total} Reaktionen)`;
        confidence = Math.min(0.95, 0.6 + positiveRate * 0.3);
      } else if (negativeRate >= 0.3) {
        preference = `User lehnt ${category}-Insights ab (${stat.negative}/${total} negativ) — reduzieren`;
        confidence = Math.min(0.95, 0.6 + negativeRate * 0.3);
      } else if (ignoredRate >= 0.7) {
        preference = `User ignoriert ${category}-Insights meist (${stat.ignored}/${total} ohne Reaktion) — weniger senden`;
        confidence = Math.min(0.9, 0.5 + ignoredRate * 0.3);
      } else {
        continue; // No clear preference yet
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
