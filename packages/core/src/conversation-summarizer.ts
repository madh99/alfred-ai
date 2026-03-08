import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { SummaryRepository, ConversationSummary } from '@alfred/storage';

const SUMMARY_THRESHOLD = 6;
const SUMMARY_UPDATE_INTERVAL = 3;
const SUMMARY_MAX_TOKENS = 512;
const MAX_STORED_MSG_LENGTH = 500;

export class ConversationSummarizer {
  constructor(
    private readonly llm: LLMProvider,
    private readonly summaryRepo: SummaryRepository,
    private readonly logger: Logger,
  ) {}

  getSummary(conversationId: string): ConversationSummary | undefined {
    return this.summaryRepo.get(conversationId);
  }

  onMessageProcessed(
    conversationId: string,
    totalMessages: number,
    userMessage: string,
    assistantResponse: string,
    recentHistory: { role: string; content: string }[],
  ): void {
    const existing = this.summaryRepo.get(conversationId);

    // Too early — not enough messages yet
    if (!existing && totalMessages < SUMMARY_THRESHOLD) {
      return;
    }

    // Too fresh — not enough new messages since last update
    if (existing && totalMessages - existing.messageCount < SUMMARY_UPDATE_INTERVAL) {
      return;
    }

    // Fire-and-forget
    this.updateSummary(conversationId, totalMessages, userMessage, assistantResponse, recentHistory, existing)
      .catch(err => this.logger.warn({ err, conversationId }, 'Failed to update conversation summary'));
  }

  private async updateSummary(
    conversationId: string,
    totalMessages: number,
    userMessage: string,
    assistantResponse: string,
    recentHistory: { role: string; content: string }[],
    existing?: ConversationSummary,
  ): Promise<void> {
    const prompt = this.buildSummaryPrompt(existing?.summary, recentHistory, userMessage, assistantResponse);

    const response = await this.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      tier: 'fast',
      maxTokens: SUMMARY_MAX_TOKENS,
    });

    const summary = response.content?.trim();
    if (!summary || summary.length < 10) {
      this.logger.debug({ conversationId }, 'Summary response too short, skipping upsert');
      return;
    }

    this.summaryRepo.upsert({
      conversationId,
      summary,
      messageCount: totalMessages,
      lastUserMessage: userMessage.slice(0, MAX_STORED_MSG_LENGTH),
      lastAssistantMessage: assistantResponse.slice(0, MAX_STORED_MSG_LENGTH),
      updatedAt: new Date().toISOString(),
    });

    this.logger.debug(
      { conversationId, messageCount: totalMessages, summaryLength: summary.length },
      'Conversation summary updated',
    );
  }

  private buildSummaryPrompt(
    existingSummary: string | undefined,
    recentHistory: { role: string; content: string }[],
    userMessage: string,
    assistantResponse: string,
  ): string {
    let prompt = 'Du bist ein Zusammenfassungs-Assistent. Erstelle eine strukturierte Zusammenfassung des Gesprächsverlaufs.\n';

    if (existingSummary) {
      prompt += `\n## Bisherige Zusammenfassung\n${existingSummary}\n`;
    }

    if (recentHistory.length > 0) {
      prompt += '\n## Letzte Nachrichten\n';
      for (const msg of recentHistory) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        prompt += `${role}: ${msg.content.slice(0, 300)}\n`;
      }
    }

    prompt += `\nUser: ${userMessage.slice(0, MAX_STORED_MSG_LENGTH)}\n`;
    prompt += `Assistant: ${assistantResponse.slice(0, MAX_STORED_MSG_LENGTH)}\n`;

    prompt += `\n## Aufgabe\n${existingSummary ? 'Aktualisiere die Zusammenfassung mit den neuen Nachrichten.' : 'Erstelle eine neue Zusammenfassung des Gesprächs.'}\n`;

    prompt += `
Antworte NUR mit der Zusammenfassung in diesem Format:

**Ziel:** [Was der User erreichen möchte]
**Thema:** [Aktives Thema / Arbeitsbereich]
**Fakten:** [Wichtige technische Fakten — Stichpunkte]
**Entscheidungen:** [Getroffene Entscheidungen — Stichpunkte]
**Offen:** [Offene Fragen oder nächste Schritte — Stichpunkte]

Regeln:
- Maximal 120 Wörter
- Nur relevante Fakten, kein Smalltalk
- Leere Punkte: "—"
- Sprache: Deutsch (oder Sprache des Gesprächs)`;

    return prompt;
  }
}
