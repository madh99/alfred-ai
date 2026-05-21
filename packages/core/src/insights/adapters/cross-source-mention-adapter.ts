import type { ConversationRepository } from '@alfred/storage';
import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';

/** Optional Facade über Kalender-Sources — nur was wir brauchen. */
export interface CalendarFacade {
  /** Returns events between (now, now+forwardDays) for the given user. */
  listUpcoming(userId: string, forwardDays: number): Promise<Array<{
    id: string; title: string; startAt: string; location?: string;
  }>>;
}

const KEYWORD_PATTERNS: Array<{ re: RegExp; topic: string }> = [
  { re: /\b(klempner|installateur|sanitär|monteur|techniker|elektriker)\s+kommt?\b/i, topic: 'handwerker-termin' },
  { re: /\b(treffe(?:n)?|treffen?\s+mich|sehe)\s+\w+\s+(am|um|nächst)/i, topic: 'soziales-treffen' },
  { re: /\b(termin|meeting|besprechung|interview)\s+(am|um|nächst|morgen|heute)/i, topic: 'meeting' },
  { re: /\b(arzt|doktor|zahnarzt|untersuchung)\b/i, topic: 'arzt-termin' },
  { re: /\b(flug|abflug|landung|hotel)\b/i, topic: 'reise' },
];

/**
 * v638 — Erkennt Erwähnungen in Chats (letzte 14 Tage) die nach Terminen klingen
 * ("Klempner kommt Sa", "Treffe Bernhard am Donnerstag") und keinen passenden
 * Calendar-Eintrag in den nächsten 30 Tagen haben.
 *
 * Macht keinen LLM-Call — pure Regex-Heuristik, lässt sich später durch LLM ersetzen.
 */
export class CrossSourceMentionAdapter implements DomainAdapter {
  readonly name = 'cross-source-mention';

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly calendar?: CalendarFacade,
  ) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    const out: InsightCandidate[] = [];
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();

    // Calendar (kann fehlen → Adapter funktioniert trotzdem als reine Detection)
    let upcomingTitles = new Set<string>();
    let upcomingHaystack = '';
    if (this.calendar) {
      try {
        const events = await this.calendar.listUpcoming(ctx.userId, 30);
        for (const e of events) {
          upcomingTitles.add(e.title.toLowerCase());
          upcomingHaystack += ' ' + e.title.toLowerCase() + ' ' + (e.location ?? '').toLowerCase();
        }
      } catch { /* skip calendar enrichment */ }
    }

    // Iteriere alle Conversations + ziehe letzte 30 User-Messages je Conv
    const convs = await this.conversations.listConversations({
      userIds: ctx.linkedUserIds,
      limit: 30,
    });
    for (const conv of convs) {
      if (conv.chatId.startsWith('scheduled-')) continue;
      if ((conv.lastMessageAt ?? conv.updatedAt) < since) continue;

      const msgs = await this.conversations.getMessagesPaged(conv.id, { limit: 30 });
      for (const m of msgs) {
        if (m.role !== 'user') continue;
        if (m.createdAt < since) continue;
        const text = (m.content ?? '').slice(0, 600);
        for (const { re, topic } of KEYWORD_PATTERNS) {
          if (!re.test(text)) continue;
          // Naive de-dupe: ist das Topic schon im Kalender präsent?
          const topicTokens = text.toLowerCase().match(/\b[a-zäöüß]{4,}\b/g) ?? [];
          const matchInCalendar = topicTokens.some(t => upcomingHaystack.includes(t));
          if (matchInCalendar) continue;

          out.push({
            category: 'cross-source-mention',
            title: `Termin-Erwähnung ohne Kalender-Eintrag: ${topic}`,
            body: `Im ${conv.platform}-Chat (vor ${Math.round((Date.now() - new Date(m.createdAt).getTime()) / 86400_000)}d):\n\n> ${text.slice(0, 220)}${text.length > 220 ? '…' : ''}\n\nDas klingt nach einem Termin, aber im Kalender steht nichts dazu. Soll Alfred einen Eintrag vorschlagen?`,
            confidence: this.calendar ? 0.65 : 0.45,
            sourceData: { conversationId: conv.id, messageId: m.id, topic, platform: conv.platform },
            actionSkill: 'calendar',
            actionParams: { action: 'create_event', title: `(aus Chat) ${topic}`, /* user fills date/time */ },
            dedupeKey: `xsrc-mention:${m.id}`,
          });
          break; // ein Insight pro Nachricht
        }
      }
    }
    return out;
  }
}
