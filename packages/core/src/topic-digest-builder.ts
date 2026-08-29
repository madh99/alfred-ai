import type { Logger } from 'pino';
import type { InterestsRepository, InterestTopic, TopicItem } from '@alfred/storage';
import type { Platform } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import type { NotificationRouter, NotificationUrgency } from './notification-router.js';

const URGENCY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** v930 — Dringlichkeit eines Themen-Digests aus der besten Item-Relevanz. */
export function digestUrgency(items: Array<Pick<TopicItem, 'importance'>>): NotificationUrgency {
  const max = Math.max(0, ...items.map(i => i.importance ?? 0.5));
  if (max >= 0.8) return 'high';
  if (max >= 0.4) return 'normal';
  return 'low';
}

/**
 * v930 — Digest-Builder: fasst täglich (06:30) je Topic die neuen Items zu einem
 * rollenden Dossier zusammen und meldet EINE gebündelte Nachricht über den
 * Notification-Router — gegated durch das per-Topic notify_threshold UND die
 * globale Router-Schwelle. Unter der Schwelle: stille Ablage (Insights-UI).
 */
export class TopicDigestBuilder {
  constructor(
    private readonly repo: InterestsRepository,
    private readonly llm: LLMProvider | undefined,
    private readonly router: NotificationRouter | undefined,
    private readonly logger: Logger,
    private readonly delivery: { chatId: string; platform: Platform },
  ) {}

  /** Verarbeitet alle aktiven Topics. @returns Anzahl Topics mit aktualisiertem Dossier. */
  async run(): Promise<number> {
    const topics = await this.repo.listAllActiveTopics();
    let updated = 0;
    for (const topic of topics) {
      try {
        if (await this.processTopic(topic)) updated++;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, topic: topic.name }, 'v930 digest build failed');
      }
    }
    if (topics.length > 0) this.logger.info({ topics: topics.length, updated }, 'v930 digest pass done');
    return updated;
  }

  /** @returns true wenn das Dossier aktualisiert wurde (neue Items vorhanden). */
  async processTopic(topic: InterestTopic): Promise<boolean> {
    const digest = await this.repo.getDigest(topic.id);
    const since = digest?.updatedAt ?? '1970-01-01T00:00:00Z';
    const newCount = await this.repo.countItemsSince(topic.id, since);
    if (newCount === 0) return false;

    const items = await this.repo.listItems(topic.id, { limit: 20 });
    const newItems = items.filter(i => i.createdAt >= since);

    // Rolling Summary per LLM (ohne LLM: nur Zähler-Digest)
    let summary = digest?.summary ?? '';
    if (this.llm) {
      try {
        const refreshed = await this.buildSummary(topic, digest?.summary, newItems.length > 0 ? newItems : items);
        if (refreshed) summary = refreshed;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, topic: topic.name }, 'v930 digest LLM refresh failed');
      }
    }
    if (summary) await this.repo.upsertDigest(topic.id, summary);

    // Melden — EINE gebündelte Nachricht je Topic, gegated durch notify_threshold + Router
    if (this.router && newItems.length > 0) {
      const urgency = digestUrgency(newItems);
      // v1143 — D: notify_threshold 'mute' = Dossier wird gepflegt, aber NIE
      // aktiv gemeldet (nur stille Ablage). Der explizite Schalter je Thema
      // ersetzt implizite Drosseleien — der User entscheidet, welches Thema
      // ihn anschreiben darf.
      const threshold = topic.notifyThreshold === 'mute' ? 'mute'
        : (topic.notifyThreshold in URGENCY_RANK ? topic.notifyThreshold : 'high');
      const top = newItems.slice(0, 5).map(i => `• ${i.title}${i.url ? `\n  ${i.url}` : ''}`).join('\n');
      const body = `📡 **${topic.name}** — ${newItems.length} neue Beiträge\n\n${summary ? `${summary}\n\n` : ''}${top}`;
      const notification = {
        source: 'interests',
        urgency,
        title: `${topic.name}: ${newItems.length} neue Beiträge`,
        body,
        reasons: [`beste Item-Relevanz ${Math.max(0, ...newItems.map(i => i.importance ?? 0.5)).toFixed(2)}`],
        chatId: this.delivery.chatId,
        platform: this.delivery.platform,
        dedupeKey: `topic-digest:${topic.id}:${new Date().toISOString().slice(0, 10)}`,
      };
      if (threshold !== 'mute' && URGENCY_RANK[urgency] >= URGENCY_RANK[threshold]) {
        await this.router.route(notification);
      } else {
        await this.router.store(notification); // unter Topic-Schwelle / gemutet → nur stille Ablage
      }
    }
    return true;
  }

  private async buildSummary(topic: InterestTopic, previous: string | undefined, items: TopicItem[]): Promise<string | null> {
    if (!this.llm) return null;
    const itemLines = items.slice(0, 15).map(i =>
      `- ${i.title}${i.summary ? `: ${i.summary.slice(0, 200)}` : ''} (${(i.publishedAt ?? i.createdAt).slice(0, 10)})`,
    ).join('\n');
    const prompt = `Du pflegst ein rollendes Themen-Dossier für "${topic.name}".
${previous ? `Bisheriges Dossier:\n${previous}\n\n` : ''}Neue gesammelte Beiträge:
${itemLines}

Aktualisiere das Dossier: 4-8 Sätze, deutsch, sachlich, neueste Entwicklungen zuerst, Überholtes raus. Nur der Dossier-Text, keine Einleitung.`;
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 600, tier: 'fast' });
    const summary = response.content?.trim();
    return summary && summary.length >= 20 ? summary : null;
  }
}
