import type { InterestTopic } from '@alfred/storage';

export interface ScanItemLike {
  summary: string;
  urgency: 'urgent' | 'high' | 'normal' | 'low';
  warum?: string;
}

const BUMP: Record<string, 'urgent' | 'high' | 'normal' | 'low'> = {
  low: 'normal',
  normal: 'high',
  high: 'high',   // nie über high boosten — urgent bleibt echten Notfällen vorbehalten
  urgent: 'urgent',
};

/**
 * v930 — Score-Kriterium 4 (Themen-Relevanz): Scan-Items, die zu einem aktiven
 * Interessen-Thema passen (≥2 Keyword-Treffer, oder 1 Treffer wenn der
 * Themenname selbst vorkommt), werden eine Stufe angehoben (max high) und die
 * Begründung wird ergänzt — sichtbar in der Ablage („warum wichtig").
 */
export function boostByTopicRelevance<T extends ScanItemLike>(items: T[], topics: InterestTopic[]): T[] {
  if (topics.length === 0) return items;
  return items.map(item => {
    const haystack = item.summary.toLowerCase();
    for (const topic of topics) {
      const nameHit = haystack.includes(topic.name.toLowerCase());
      const keywordHits = topic.keywords.filter(k => k.trim().length > 0 && haystack.includes(k.toLowerCase())).length;
      if (keywordHits >= 2 || (nameHit && keywordHits >= 1) || (nameHit && topic.keywords.length === 0)) {
        const boosted = BUMP[item.urgency];
        const note = `passt zu Interessen-Thema „${topic.name}"`;
        return {
          ...item,
          urgency: boosted,
          warum: item.warum ? `${item.warum} · ${note}` : note,
        };
      }
    }
    return item;
  });
}
