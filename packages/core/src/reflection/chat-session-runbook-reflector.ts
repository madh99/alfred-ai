import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { ConversationRepository, MemoryRepository, RunbookRepository, AsyncDbAdapter } from '@alfred/storage';
import type { ConfirmationQueue } from '../confirmation-queue.js';

/**
 * v621 R2 — Title-Normalisierung für Duplikat-Erkennung.
 * - lowercase
 * - alles außer Buchstaben/Zahlen/Umlauten → Whitespace
 * - Füllwörter und Modal-Verben entfernen
 * - leere Tokens raus
 * Liefert ein Set tokens für O(1) Schnittmenge.
 */
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'aber', 'auch',
  'in', 'im', 'auf', 'an', 'am', 'mit', 'von', 'vom', 'zu', 'zum', 'zur',
  'fuer', 'für', 'aus', 'bei', 'nach', 'ueber', 'über', 'um', 'unter',
  'ein', 'eine', 'einen', 'einer', 'eines',
  'soll', 'sollen', 'kann', 'koennen', 'können', 'will', 'wird', 'werden',
  'ist', 'sind', 'war', 'waren', 'sein',
  'and', 'or', 'the', 'to', 'of', 'for', 'with', 'on', 'in', 'at', 'by',
  'is', 'are', 'was', 'were', 'be',
]);
function normalizeTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, ' ')
      .split(' ')
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

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
  private tickRunning = false; // R2: concurrency guard
  private static readonly QUIET_MINUTES = 30;
  /**
   * Minimum message count for a session to even be considered.
   * Lowered from 10 → 6 in v592 so shorter problem-solving conversations (e.g.
   * "wie strukturieren wir das Vorgehen für X") aren't ignored.
   */
  private static readonly MIN_MESSAGES = 6;
  private static readonly POLL_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly MARKER_PREFIX = '_internal_runbook_processed:';
  /** R5: marker that initial backfill has been applied (one-shot per user). */
  private static readonly BACKFILL_MARKER = '_internal_runbook_reflector_backfilled';
  /** R3: max LLM-extractions per tick — prevents flood even on cold-start backlog. */
  private static readonly MAX_CANDIDATES_PER_TICK = 3;
  /** R4: only analyze sessions whose last message is within this window. */
  private static readonly SESSION_AGE_DAYS = 7;
  /** R1: TTL of the "processed" marker — one full day before allowing re-analysis. */
  private static readonly MARKER_TTL_MS = 24 * 60 * 60 * 1000;
  /** R6: confidence thresholds for routing. */
  private static readonly CONFIRM_THRESHOLD = 0.9;
  private static readonly DRAFT_THRESHOLD = 0.65;

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
      // R2: skip tick if previous one is still running (LLM calls can be slow)
      if (this.tickRunning) {
        this.logger.debug('Runbook-reflector: previous tick still running, skipping');
        return;
      }
      this.tickRunning = true;
      this.tick()
        .catch(err => this.logger.warn({ err }, 'Runbook-reflector tick failed'))
        .finally(() => { this.tickRunning = false; });
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
    const now = Date.now();
    const cutoffIso = new Date(now - ChatSessionRunbookReflector.QUIET_MINUTES * 60_000).toISOString();
    // R4: only analyze recent sessions — older ones are unlikely to yield useful runbooks
    // and were the main source of the cold-start flood (v592→v593 deploy produced 28 pending
    // confirmations from historical conversations).
    const minLastMessageIso = new Date(now - ChatSessionRunbookReflector.SESSION_AGE_DAYS * 24 * 60 * 60_000).toISOString();

    const candidates = await this.adapter.query(
      `SELECT c.id AS conversation_id, c.user_id, c.platform, c.chat_id,
              MAX(m.created_at) AS last_message_at,
              COUNT(m.id) AS message_count,
              SUM(CASE WHEN m.role = 'tool' THEN 1 ELSE 0 END) AS tool_messages,
              SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.id, c.user_id, c.platform, c.chat_id
       HAVING MAX(m.created_at) < ?
         AND MAX(m.created_at) >= ?
         AND COUNT(m.id) >= ?
         AND (
           SUM(CASE WHEN m.role = 'tool' THEN 1 ELSE 0 END) >= 1
           OR SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) >= 3
         )
       ORDER BY MAX(m.created_at) DESC`,
      [cutoffIso, minLastMessageIso, ChatSessionRunbookReflector.MIN_MESSAGES],
    ) as Array<{ conversation_id: string; user_id: string; last_message_at: string; message_count: number; tool_messages: number; assistant_messages: number }>;

    if (candidates.length === 0) return;
    this.logger.debug({ count: candidates.length }, 'Runbook-reflector: candidates found');

    // R5: per-user one-shot backfill — first encounter of a user marks ALL their existing
    // qualifying conversations as already-processed, WITHOUT running LLM extraction. Only
    // sessions that become quiet AFTER the backfill timestamp will be analyzed normally.
    // This prevents the cold-start flood that produced 28 stacked confirmations.
    const userIds = [...new Set(candidates.map(c => c.user_id))];
    const backfilledUsers = new Set<string>();
    for (const userId of userIds) {
      const marker = await this.memoryRepo.recall(userId, ChatSessionRunbookReflector.BACKFILL_MARKER);
      if (!marker) {
        const userConversations = candidates.filter(c => c.user_id === userId);
        let backfilled = 0;
        for (const c of userConversations) {
          await this.markProcessed(userId, `${ChatSessionRunbookReflector.MARKER_PREFIX}${c.conversation_id}`);
          backfilled++;
        }
        // Set the backfill marker (no TTL — backfill is one-shot per user lifetime)
        try {
          await this.memoryRepo.saveWithMetadata(
            userId, ChatSessionRunbookReflector.BACKFILL_MARKER,
            new Date().toISOString(), 'system', 'general', 1.0, 'auto',
          );
        } catch { /* non-critical */ }
        backfilledUsers.add(userId);
        this.logger.info({ userId, backfilled }, 'Runbook-reflector: first-run backfill — marked existing quiet conversations as processed without LLM analysis');
      }
    }

    // After backfill: anything in `backfilledUsers` is now "marked", skip those candidates
    // this tick — next tick (after 5min) will pick up any that have new messages since.
    const remaining = candidates.filter(c => !backfilledUsers.has(c.user_id));

    // R3: per-tick limit — at most MAX_CANDIDATES_PER_TICK LLM-extractions to prevent flood
    const limited = remaining.slice(0, ChatSessionRunbookReflector.MAX_CANDIDATES_PER_TICK);
    if (remaining.length > limited.length) {
      this.logger.debug({ skipped: remaining.length - limited.length }, 'Runbook-reflector: throttled (remaining candidates will be picked up next tick)');
    }

    for (const c of limited) {
      try {
        await this.processCandidate(c.conversation_id, c.user_id, c.last_message_at);
      } catch (err) {
        this.logger.debug({ err, conversation: c.conversation_id }, 'Runbook reflector: candidate processing failed');
      }
    }
  }

  private async processCandidate(conversationId: string, userId: string, _lastMessageAt: string): Promise<void> {
    // R1: marker is per-conversation (no message-id suffix). This makes the marker stable
    // even when new messages arrive during/after LLM analysis. The marker is auto-expired
    // by `markProcessed()` after MARKER_TTL_MS (24h), allowing a fresh analysis the next
    // day if the conversation grew further.
    const markerKey = `${ChatSessionRunbookReflector.MARKER_PREFIX}${conversationId}`;
    const existing = await this.memoryRepo.recall(userId, markerKey);
    if (existing) return; // already processed within the TTL window

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

    const prompt = `Du analysierst einen Chat-Verlauf zwischen User und Assistant. Prüfe ob hier eine Aufgabe, ein Problem oder eine Entscheidung erfolgreich bearbeitet wurde — egal in welchem Bereich. Ziel: das gewonnene Wissen für künftige ähnliche Situationen festhalten ("so haben wir's letztes Mal gemacht").

WICHTIG: Runbooks sind NICHT nur für Infrastruktur/Technik. Sie sind generelles Erfahrungsgedächtnis. Beispielthemen:
- Technische Probleme ("BMW MQTT reconnect", "Server-RAM-Cleanup")
- Organisatorische Logistik ("Sonntag-Match + BMW-Laden parallel planen")
- Konzeptionelle Aufgaben ("Bewerbung strukturieren", "Geburtstag organisieren")
- Recherche- oder Entscheidungs-Ketten ("welche Option für X — Pro/Contra → Entscheidung")
- Wissen das beim nächsten Mal sofort hilft

CHAT:
${transcript}

Antworte ausschließlich mit gültigem JSON (keine Markdown-Codeblöcke, kein Freitext drumherum):
{
  "is_runbook_candidate": true|false,
  "confidence": 0.0-1.0,
  "title": "kurzer Titel (max 80 Zeichen) — beschreibend, NICHT 'Chat vom 03.05.'",
  "symptom": "ein Satz: wann/in welcher Situation greift das Wissen?",
  "cause": "ein Satz: warum entsteht die Situation / was ist der Kern? (falls anwendbar, sonst leer)",
  "steps": ["Schritt 1", "Schritt 2", ...],
  "verification": "wie erkennt man dass es funktioniert hat (falls anwendbar)",
  "rollback": "wie korrigiert man falls es schiefgeht (NUR bei riskanten/reversiblen Aktionen, sonst leer)",
  "tags": ["thema1", "thema2", "thema3"]
}

TAGS-REGEL (wichtig für Wiederauffinden):
- 2-5 prägnante Themen-Tags in Kleinschreibung, deutsche oder englische Begriffe
- Beispiele: "bewerbung", "logistik", "familie", "bmw", "netzwerk", "kinder", "schule", "finanzen", "geburtstag", "reise"
- Tags sollen das Thema kennzeichnen, NICHT die Aktion ("anrufen" → nein; "werkstatt" → ja)

Confidence-Skala:
- 0.9-1.0: glasklare Aufgabe/Problem → Lösung-Kette, klar wiederverwendbar
- 0.7-0.9: gute Lösung, aber teils session-spezifische Details
- 0.5-0.7: möglicherweise hilfreich, aber Lösung nicht eindeutig
- < 0.5: keine konkrete Erkenntnis/Lösung erkennbar → is_runbook_candidate: false

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

    if (!isCandidate || !hasMinimumStructure || confidence < ChatSessionRunbookReflector.DRAFT_THRESHOLD) {
      await this.markProcessed(userId, markerKey);
      return;
    }

    // Dedup: check if a runbook already exists for this conversation (e.g., user already created one)
    const existingRunbook = await this.runbookRepo.findBySource(userId, 'chat_session', conversationId);
    if (existingRunbook) {
      await this.markProcessed(userId, markerKey);
      return;
    }

    // v621 R2 — Similarity-Dedup gegen ALLE bestehenden Runbooks. Vorher nur
    // pro-Conversation Dedup, was bei Cron-Triggered-Conversations (z.B.
    // aWATTar-Check 4× täglich → 4 separate Conversations) zu nahezu identischen
    // Runbooks führte ("aWATTar-Rechnung in Microsoft-Mail prüfen/suchen/...
    // Duplikate vermeiden/blockieren" 3× am selben Tag). Heuristik:
    //   - ≥3 gemeinsame Tags  → Duplikat
    //   - Title-Token-Overlap ≥ 60% (normalisiert, ohne Füllwörter) → Duplikat
    // Beide Bedingungen separat — eine reicht. Bei Treffer: skip + mark.
    try {
      const candidateTags = new Set((parsed.tags ?? []).map(t => t.toLowerCase()));
      const candidateTitleTokens = normalizeTitle(parsed.title ?? '');
      if (candidateTitleTokens.size >= 2 || candidateTags.size >= 2) {
        // Alle Status berücksichtigen (auch 'verified'/'deprecated') — gegen
        // ein verified-Runbook zu duplizieren wäre besonders unsinnig.
        const allExisting = await this.runbookRepo.list(userId, { limit: 200 });
        const similar = allExisting.find(rb => {
          const sharedTags = [...candidateTags].filter(t => rb.tags.map(x => x.toLowerCase()).includes(t)).length;
          if (sharedTags >= 3) return true;
          const existingTitleTokens = normalizeTitle(rb.title);
          if (candidateTitleTokens.size === 0 || existingTitleTokens.size === 0) return false;
          const sharedTokens = [...candidateTitleTokens].filter(t => existingTitleTokens.has(t)).length;
          const smallerSize = Math.min(candidateTitleTokens.size, existingTitleTokens.size);
          return smallerSize > 0 && (sharedTokens / smallerSize) >= 0.6;
        });
        if (similar) {
          this.logger.info({
            conversationId, newTitle: parsed.title?.slice(0, 60),
            existingId: similar.id.slice(0, 8), existingTitle: similar.title.slice(0, 60),
          }, 'Runbook-reflector R2: similar runbook already exists — skipping');
          await this.markProcessed(userId, markerKey);
          return;
        }
      }
    } catch (err) {
      this.logger.debug({ err }, 'Runbook-reflector R2: similarity-dedup failed (non-critical, falling through)');
    }

    if (confidence >= ChatSessionRunbookReflector.CONFIRM_THRESHOLD) {
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
      // R1: 24h TTL — allow re-analysis the next day if the conversation has substantial
      // new content. Memory cleanup-expired removes the marker after this, then the
      // conversation can be analyzed again on next quiet→active→quiet cycle.
      const expiry = new Date(Date.now() + ChatSessionRunbookReflector.MARKER_TTL_MS).toISOString();
      await this.memoryRepo.setExpiry(userId, key, expiry);
    } catch { /* non-critical */ }
  }
}
