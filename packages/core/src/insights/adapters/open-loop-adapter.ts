import type { ConversationRepository } from '@alfred/storage';
import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';

/**
 * v638 — Findet "Open-Loops" in Conversations:
 *  - Letzte Nachricht ist eine Frage des Users (endet mit "?" oder typische Frage-Muster)
 *  - Conversation hat seit ≥7 Tagen keine neue Antwort
 *  - User-Conversation, nicht scheduled-* / system-Konversation
 *
 * Erzeugt einen Insight "diese offene Frage wartet noch auf dich" — leicht zu dismissen
 * aber sehr wertvoll für Themen die im Alltag untergegangen sind.
 */
export class OpenLoopAdapter implements DomainAdapter {
  readonly name = 'open-loop';

  constructor(private readonly conversations: ConversationRepository) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    const out: InsightCandidate[] = [];

    const list = await this.conversations.listConversations({
      userIds: ctx.linkedUserIds,
      limit: 50,
    });

    for (const conv of list) {
      // Skip scheduled-* chat IDs (auto-generated)
      if (conv.chatId.startsWith('scheduled-')) continue;
      // Need a last-message preview that looks like an unanswered question
      const lastPreview = conv.lastMessagePreview ?? '';
      if (!lastPreview) continue;
      // Did the conversation go quiet?
      const lastAt = conv.lastMessageAt ?? conv.updatedAt;
      if (lastAt >= cutoff) continue; // not stale enough

      // Get the actual last message(s) to verify it's a user-question that got no response
      const recent = await this.conversations.getMessagesPaged(conv.id, { limit: 5 });
      if (recent.length === 0) continue;
      const lastMsg = recent[recent.length - 1];
      if (lastMsg.role !== 'user') continue; // alfred answered last → no loop
      const text = (lastMsg.content ?? '').trim();
      const isQuestion = text.endsWith('?')
        || /\b(wie|wann|was|wo|warum|sollen wir|sollte ich|hast du|kannst du|hattest du|gibt es)\b/i.test(text);
      if (!isQuestion) continue;

      const daysQuiet = Math.round((Date.now() - new Date(lastAt).getTime()) / 86400_000);
      out.push({
        category: 'open-loop',
        title: `Offene Frage in ${conv.platform}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`,
        body: `Letzte Nachricht in dieser Conversation ist deine Frage:\n\n> ${text.slice(0, 280)}${text.length > 280 ? '…' : ''}\n\nSeit ${daysQuiet} Tagen keine Antwort. Soll Alfred dich darauf hinweisen?`,
        confidence: Math.min(0.85, 0.4 + daysQuiet * 0.02),
        sourceData: { conversationId: conv.id, platform: conv.platform, chatId: conv.chatId, daysQuiet },
        dedupeKey: `open-loop:${conv.id}:${lastMsg.id}`,
      });
    }
    return out;
  }
}
