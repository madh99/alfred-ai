import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { ConversationRepository, MemoryRepository, RunbookRepository, AsyncDbAdapter } from '@alfred/storage';
import type { ConfirmationQueue } from '../confirmation-queue.js';

/**
 * ChatSessionRunbookReflector — Trigger C.
 *
 * Periodically (every 5 min) scans conversations that became "quiet" (no messages
 * for ≥30 min) AND meet the triage criteria (≥10 messages AND at least one tool-role
 * message indicating skill-calls were involved).
 *
 * For each qualifying session: asks the LLM whether a useful runbook can be extracted
 * (returning structured JSON with confidence). Routing:
 *   - confidence ≥ 0.8 → ConfirmationQueue (user reviews + approves)
 *   - confidence ≥ 0.5 → auto-save as draft
 *   - confidence <  0.5 → skip silently
 *
 * Dedup: per-(conversation, last_message_id) memory marker prevents reprocessing on restart.
 */
export class ChatSessionRunbookReflector {
  private timer?: ReturnType<typeof setInterval>;
  private static readonly QUIET_MINUTES = 30;
  private static readonly MIN_MESSAGES = 10;
  private static readonly POLL_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly MARKER_PREFIX = '_internal_runbook_processed:';

  constructor(
    private readonly adapter: AsyncDbAdapter,
    private readonly conversationRepo: ConversationRepository,
    private readonly runbookRepo: RunbookRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly confirmationQueue: ConfirmationQueue,
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
    private readonly ownerPlatform: string,
    private readonly ownerChatId: string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.warn({ err }, 'Runbook-reflector tick failed'));
    }, ChatSessionRunbookReflector.POLL_INTERVAL_MS);
    this.logger.info('Chat-session runbook reflector started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Main loop — find quiet conversations, triage, extract runbook candidates. */
  async tick(): Promise<void> {
    const cutoffIso = new Date(Date.now() - ChatSessionRunbookReflector.QUIET_MINUTES * 60_000).toISOString();
    // Find conversations where the latest message is older than the cutoff and the message
    // count exceeds the threshold. We also require at least one 'tool' role message.
    const candidates = await this.adapter.query(
      `SELECT c.id AS conversation_id, c.user_id, c.platform, c.chat_id,
              MAX(m.created_at) AS last_message_at,
              COUNT(m.id) AS message_count,
              SUM(CASE WHEN m.role = 'tool' THEN 1 ELSE 0 END) AS tool_messages
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.id, c.user_id, c.platform, c.chat_id
       HAVING MAX(m.created_at) < ?
         AND COUNT(m.id) >= ?
         AND SUM(CASE WHEN m.role = 'tool' THEN 1 ELSE 0 END) >= 1`,
      [cutoffIso, ChatSessionRunbookReflector.MIN_MESSAGES],
    ) as Array<{ conversation_id: string; user_id: string; last_message_at: string; message_count: number; tool_messages: number }>;

    for (const c of candidates) {
      try {
        await this.processCandidate(c.conversation_id, c.user_id, c.last_message_at);
      } catch (err) {
        this.logger.debug({ err, conversation: c.conversation_id }, 'Runbook reflector: candidate processing failed');
      }
    }
  }

  private async processCandidate(conversationId: string, userId: string, lastMessageAt: string): Promise<void> {
    // Lookup last_message_id for dedup marker (so editing a message doesn't trigger re-extraction)
    const lastMsg = await this.adapter.queryOne(
      `SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    ) as { id: string } | undefined;
    if (!lastMsg) return;

    const markerKey = `${ChatSessionRunbookReflector.MARKER_PREFIX}${conversationId}:${lastMsg.id}`;
    const existing = await this.memoryRepo.recall(userId, markerKey);
    if (existing) return; // already processed

    // Fetch the session transcript (last 50 messages — enough context, bounded cost)
    const msgs = await this.conversationRepo.getMessages(conversationId, 50);
    if (msgs.length < ChatSessionRunbookReflector.MIN_MESSAGES) {
      await this.markProcessed(userId, markerKey);
      return;
    }

    // Build LLM extraction prompt
    const transcript = msgs.map(m => {
      const role = m.role.padEnd(10);
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `[${role}] ${content}`;
    }).join('\n');

    const prompt = `Du analysierst einen Chat-Verlauf zwischen User und Assistant. Prüfe ob hier ein Problem gelöst wurde dessen Lösung als Runbook (Schritt-für-Schritt-Anleitung) festgehalten werden sollte.

CHAT:
${transcript}

Antworte ausschließlich mit gültigem JSON (keine Markdown-Codeblöcke, kein Freitext drumherum):
{
  "is_runbook_candidate": true|false,
  "confidence": 0.0-1.0,
  "title": "kurzer Titel (max 80 Zeichen)",
  "symptom": "ein Satz: wann tritt das auf",
  "cause": "ein Satz: die Wurzel-Ursache (falls bekannt, sonst leer)",
  "steps": ["Schritt 1", "Schritt 2", ...],
  "verification": "wie prüft man dass es funktioniert hat",
  "rollback": "wie macht man's rückgängig (falls anwendbar, sonst leer)",
  "tags": ["tag1", "tag2"]
}

Confidence-Skala:
- 0.9-1.0: glasklare Problem→Lösung-Kette, allgemein anwendbar
- 0.7-0.9: Lösung erkennbar, aber session-spezifische Details
- 0.5-0.7: möglicherweise hilfreich, aber unklar
- < 0.5: keine echte Lösung erkennbar → is_runbook_candidate: false

Wenn is_runbook_candidate false ist, alle anderen Felder dürfen leer sein.`;

    let parsed: { is_runbook_candidate?: boolean; confidence?: number; title?: string; symptom?: string; cause?: string; steps?: string[]; verification?: string; rollback?: string; tags?: string[] } = {};
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1500, temperature: 0.2, tier: 'default',
      });
      const text = response.content.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      this.logger.debug({ err, conversationId }, 'Runbook-reflector LLM call failed');
      await this.markProcessed(userId, markerKey);
      return;
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const isCandidate = parsed.is_runbook_candidate === true;
    const hasMinimumStructure = Boolean(parsed.title) && Array.isArray(parsed.steps) && parsed.steps.length >= 2;

    if (!isCandidate || !hasMinimumStructure || confidence < 0.5) {
      await this.markProcessed(userId, markerKey);
      return;
    }

    // Dedup: check if a runbook already exists for this conversation (e.g., user already created one)
    const existingRunbook = await this.runbookRepo.findBySource(userId, 'chat_session', conversationId);
    if (existingRunbook) {
      await this.markProcessed(userId, markerKey);
      return;
    }

    if (confidence >= 0.8) {
      // High-confidence: send to user for approval
      await this.confirmationQueue.enqueue({
        chatId: this.ownerChatId,
        platform: this.ownerPlatform,
        source: 'reasoning',
        sourceId: `runbook-from-chat-${conversationId.slice(0, 8)}`,
        description: `Runbook aus Chat-Session erstellen (Confidence ${(confidence * 100).toFixed(0)}%): "${parsed.title?.slice(0, 80)}"?`,
        skillName: 'runbook',
        skillParams: {
          action: 'create',
          title: parsed.title,
          symptom: parsed.symptom ?? '',
          cause: parsed.cause ?? '',
          steps: parsed.steps,
          verification: parsed.verification ?? '',
          rollback: parsed.rollback ?? '',
          source_type: 'chat_session',
          source_id: conversationId,
          status: 'draft',
          tags: [...(parsed.tags ?? []), 'auto-extracted', 'high-confidence'],
        },
        timeoutMinutes: 24 * 60,
      });
      this.logger.info({ conversationId, title: parsed.title, confidence }, 'Chat-session runbook enqueued for confirmation');
    } else {
      // 0.5 ≤ confidence < 0.8: auto-save silent draft (user reviews via /alfred/runbooks/)
      try {
        await this.runbookRepo.create(userId, {
          title: parsed.title!,
          symptom: parsed.symptom,
          cause: parsed.cause,
          steps: parsed.steps!,
          verification: parsed.verification,
          rollback: parsed.rollback,
          sourceType: 'chat_session',
          sourceId: conversationId,
          confidence,
          status: 'draft',
          tags: [...(parsed.tags ?? []), 'auto-extracted', 'low-confidence'],
        });
        this.logger.info({ conversationId, title: parsed.title, confidence }, 'Chat-session runbook auto-saved as draft');
      } catch (err) {
        this.logger.debug({ err }, 'Auto-draft runbook creation failed');
      }
    }

    await this.markProcessed(userId, markerKey);
  }

  private async markProcessed(userId: string, key: string): Promise<void> {
    try {
      await this.memoryRepo.saveWithMetadata(userId, key, new Date().toISOString(), 'system', 'general', 1.0, 'auto');
      // Auto-expire the marker after 30 days — keeps memory table from growing forever
      const expiry = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
      await this.memoryRepo.setExpiry(userId, key, expiry);
    } catch { /* non-critical */ }
  }
}
