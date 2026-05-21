import type { Logger } from 'pino';
import type { GoalsRepository, ConversationRepository, ConfirmationRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

const SYSTEM_PROMPT = `Du analysierst Chat-Nachrichten eines Users und extrahierst Ziele/Vorhaben die er für sich formuliert hat ("ich möchte X", "ich muss Y", "ich werde Z", "mein Ziel ist …", "ab nächster Woche", "ich nehme mir vor"). Ignoriere triviale Wünsche ("hätte gern Kaffee"), Fragen ("soll ich X?"), Vergangenheit ("hab gemacht"), und Aussagen über andere ("der Klempner sollte").

Antworte als JSON-Array. Jedes Element:
{
  "title": "Kurzer Titel (max 60 Zeichen)",
  "description": "Kontext aus der Nachricht",
  "category": "fitness|finance|relationships|work|health|learning|home|other",
  "cadence": "daily|weekly|monthly|one-time",
  "target_metric": "z.B. '2x/Woche Sport', '8h Schlaf', '500€ sparen'",
  "confidence": 0.0-1.0,
  "source_excerpt": "Originalzitat aus der Nachricht (max 200 Zeichen)"
}

Nur Ziele die der User selbst formuliert. Wenn keine Ziele erkennbar: leeres Array \`[]\`.`;

interface ExtractedGoal {
  title: string;
  description?: string;
  category?: string;
  cadence?: string;
  target_metric?: string;
  confidence?: number;
  source_excerpt?: string;
  sourceMessageId?: string;
  sourceConversationId?: string;
}

/**
 * v639 — Goal-Extraction-Pass: scannt die letzten 7 Tage Chat-Messages des Owners,
 * gruppiert sie nach Conversation, schickt sie an den LLM mit dem System-Prompt oben.
 *
 * Erkannte Ziele werden NICHT direkt persistiert — sie landen als Confirmations,
 * der User bestätigt explizit. Dedupe via Title-Normalization (vermeidet Doppel-Ziele
 * wenn der LLM denselben Vorsatz aus mehreren Nachrichten extrahiert).
 */
export class GoalExtractor {
  constructor(
    private readonly goals: GoalsRepository,
    private readonly conversations: ConversationRepository,
    private readonly llm: LLMProvider,
    private readonly confirm: ConfirmationRepository,
    private readonly logger: Logger,
  ) {}

  async run(userId: string, linkedUserIds: string[], opts?: { lookbackDays?: number; maxMessagesPerConv?: number }): Promise<{ extracted: number; enqueued: number }> {
    const lookbackDays = opts?.lookbackDays ?? 7;
    const maxPerConv = opts?.maxMessagesPerConv ?? 30;
    const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();

    let convs: Awaited<ReturnType<typeof this.conversations.listConversations>> = [];
    try { convs = await this.conversations.listConversations({ userIds: linkedUserIds, limit: 30 }); } catch { return { extracted: 0, enqueued: 0 }; }

    // Existing active goals — for de-dupe
    const existing = await this.goals.list(userId, { status: 'active' });
    const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9äöüß\s]/g, '').trim();
    const existingTitles = new Set(existing.map(g => normalizeTitle(g.title)));

    let totalExtracted = 0;
    let enqueued = 0;

    for (const conv of convs) {
      if (conv.chatId.startsWith('scheduled-')) continue;
      const messages = await this.conversations.getMessagesPaged(conv.id, { limit: maxPerConv });
      const userMessages = messages.filter(m => m.role === 'user' && m.createdAt >= since);
      if (userMessages.length === 0) continue;

      const blob = userMessages.map(m => `[${m.createdAt.slice(11, 16)}] ${m.content.slice(0, 500)}`).join('\n');
      if (blob.length < 100) continue; // not enough signal

      let extracted: ExtractedGoal[] = [];
      try {
        const res = await this.llm.complete({
          messages: [
            { role: 'user', content: `${SYSTEM_PROMPT}\n\nChat-Auszug:\n\n${blob.slice(0, 8000)}` },
          ],
          tier: 'default' as any,
          maxTokens: 1500,
        });
        // Strip code fences if any
        const cleaned = res.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
        const start = cleaned.indexOf('[');
        const end = cleaned.lastIndexOf(']');
        if (start >= 0 && end > start) {
          extracted = JSON.parse(cleaned.slice(start, end + 1));
        }
      } catch (err) {
        this.logger.debug({ err, convId: conv.id }, 'Goal-extract LLM call failed');
        continue;
      }

      for (const g of extracted) {
        if (!g.title || (g.confidence ?? 1) < 0.5) continue;
        const norm = normalizeTitle(g.title);
        if (existingTitles.has(norm)) continue;
        existingTitles.add(norm);
        totalExtracted++;

        // Try to find the source message that produced the excerpt
        const srcMsg = g.source_excerpt
          ? userMessages.find(m => m.content.includes(g.source_excerpt!.slice(0, 30)))
          : userMessages[userMessages.length - 1];

        try {
          // Enqueue a confirmation — Skill action `goal.add` with all extracted fields
          await this.confirm.create({
            chatId: conv.chatId,
            platform: conv.platform,
            source: 'reasoning',
            sourceId: `goal-extract:${conv.id}:${srcMsg?.id ?? Date.now()}`,
            description: `Ziel aus Chat erkannt: **${g.title}**${g.target_metric ? ` (${g.target_metric})` : ''}\n\nZitat: "${(g.source_excerpt ?? '').slice(0, 200)}"\n\nSpeichern?`,
            skillName: 'goal',
            skillParams: {
              action: 'add',
              title: g.title,
              description: g.description,
              category: g.category,
              cadence: g.cadence,
              target_metric: g.target_metric,
            },
            expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
          });
          enqueued++;
        } catch (err) {
          this.logger.debug({ err, goal: g.title }, 'Goal-confirmation enqueue failed');
        }
      }
    }
    this.logger.info({ userId, extracted: totalExtracted, enqueued }, 'GoalExtractor completed');
    return { extracted: totalExtracted, enqueued };
  }
}
