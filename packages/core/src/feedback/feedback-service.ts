import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { FeedbackRepository } from '@alfred/storage';
import type { MemoryRepository } from '@alfred/storage';

/**
 * Minimal interface — keeps feedback-service decoupled from the concrete
 * embedding-service so tests can stub it.
 *
 * The two shapes accepted:
 *  - `embed(text)` returning just a vector — for stubs/tests
 *  - `embed(text)` returning `{ embedding: number[] }` — matches LLMProvider.embed
 */
export interface EmbeddingServiceLike {
  embed(text: string): Promise<number[] | { embedding: number[] } | undefined>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface FeedbackServiceOptions {
  rejectionThreshold?: number;  // rejections before promoting to feedback memory (default 3)
  staleDays?: number;           // days before stale feedback decays (default 90)
}

export class FeedbackService {
  private readonly threshold: number;
  private readonly staleDays: number;
  private llm?: LLMProvider;
  private embeddingService?: EmbeddingServiceLike;
  private lastRuleExtractionAt = 0;

  constructor(
    private readonly feedbackRepo: FeedbackRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
    options?: FeedbackServiceOptions,
  ) {
    this.threshold = options?.rejectionThreshold ?? 3;
    this.staleDays = options?.staleDays ?? 90;
  }

  /**
   * Inject LLM provider for rule extraction from corrections.
   */
  setLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

  /** v606 K4 — inject embedding-service for memory deduplication. Optional. */
  setEmbeddingService(svc: EmbeddingServiceLike): void {
    this.embeddingService = svc;
  }

  /**
   * Called from ConfirmationQueue on watch rejection. Fire-and-forget.
   */
  onWatchRejected(opts: {
    userId: string;
    watchId: string;
    watchName: string;
    skillName: string;
    skillParams: Record<string, unknown>;
    description: string;
  }): void {
    this.handleWatchRejection(opts).catch(err => {
      this.logger.error({ err }, 'Feedback: watch rejection handling failed');
    });
  }

  /**
   * Called from ActiveLearningService on correction signal. Fire-and-forget.
   */
  onConversationCorrection(opts: {
    userId: string;
    userMessage: string;
    assistantResponse: string;
  }): void {
    this.handleCorrection(opts).catch(err => {
      this.logger.error({ err }, 'Feedback: conversation correction handling failed');
    });
  }

  /**
   * Periodic maintenance: prune old events, decay stale feedback.
   */
  async runMaintenance(): Promise<void> {
    try {
      const pruned = await this.feedbackRepo.pruneOldEvents(this.staleDays * 2);
      if (pruned > 0) {
        this.logger.info({ pruned }, 'Feedback: pruned old events');
      }
    } catch (err) {
      this.logger.error({ err }, 'Feedback: maintenance failed');
    }
  }

  /**
   * v606 K5 — one-shot reclassification of existing feedback:correction memories.
   *
   * Reads all memories with key prefix 'feedback:correction:', runs each through
   * classifyMessage(), and updates the type accordingly (or deletes when classified
   * as 'skip'). Gated by a marker memory so it runs at most once per user.
   *
   * Returns the count of memories re-classified / deleted / kept-as-is.
   */
  async migrateCorrectionMemories(userId: string): Promise<{
    reclassified: number; deleted: number; unchanged: number; skipped: number;
  }> {
    const stats = { reclassified: 0, deleted: 0, unchanged: 0, skipped: 0 };
    const markerKey = '_internal_correction_migration_done';
    try {
      const marker = await this.memoryRepo.recall(userId, markerKey);
      if (marker) {
        this.logger.debug({ userId }, 'Feedback: correction-migration already done, skipping');
        return stats;
      }
    } catch { /* no marker, proceed */ }

    try {
      // Pull both type='correction' AND type='feedback' that match the key-prefix
      const corr = await this.memoryRepo.getByType(userId, 'correction', 200);
      const fbk = await this.memoryRepo.getByType(userId, 'feedback', 200);
      const candidates = [...corr, ...fbk].filter(m => m.key.startsWith('feedback:correction:'));
      this.logger.info({ userId, count: candidates.length }, 'Feedback: starting correction-migration');

      for (const m of candidates) {
        try {
          // Strip the "Nutzer-Korrektur: " prefix to get the actual message
          const raw = m.value.replace(/^Nutzer-Korrektur:\s*/, '').trim();
          const classification = await this.classifyMessage(raw, '');
          if (!classification) { stats.skipped++; continue; }

          if (classification.intent === 'skip') {
            await this.memoryRepo.deleteByIds([m.id]);
            stats.deleted++;
            continue;
          }

          const newType = classification.intent === 'preference' ? 'preference'
            : classification.intent === 'rule' ? 'general'
            : 'correction';

          if (newType === m.type) {
            stats.unchanged++;
            continue;
          }

          // Move to correct type by re-saving (key stays the same so it overwrites)
          await this.memoryRepo.saveWithMetadata(
            userId, m.key, m.value, m.category ?? 'general', newType,
            classification.intent === 'correction' ? 0.9 : 0.85, m.source ?? 'manual',
          );
          stats.reclassified++;
          this.logger.info({ key: m.key, oldType: m.type, newType, intent: classification.intent },
            'Feedback: migrated memory to correct type');
        } catch (err) {
          this.logger.debug({ err, key: m.key }, 'Feedback: migration of single memory failed');
          stats.skipped++;
        }
      }

      // Set the marker memory so we don't run again
      try {
        await this.memoryRepo.saveWithMetadata(
          userId, markerKey,
          `Correction-Memory-Migration completed at ${new Date().toISOString()}: ` +
          `reclassified=${stats.reclassified}, deleted=${stats.deleted}, ` +
          `unchanged=${stats.unchanged}, skipped=${stats.skipped}`,
          'system', 'general', 1.0, 'auto',
        );
      } catch { /* non-critical */ }

      this.logger.info({ userId, ...stats }, 'Feedback: correction-migration finished');
    } catch (err) {
      this.logger.warn({ err, userId }, 'Feedback: correction-migration failed');
    }
    return stats;
  }

  private async handleWatchRejection(opts: {
    userId: string;
    watchId: string;
    watchName: string;
    skillName: string;
    skillParams: Record<string, unknown>;
    description: string;
  }): Promise<void> {
    const contextKey = `watch:${opts.watchName.toLowerCase().replace(/\s+/g, '_')}:${opts.skillName}`;

    await this.feedbackRepo.recordEvent(
      opts.userId,
      'watch_rejection',
      opts.watchId,
      contextKey,
      opts.description,
      { skillName: opts.skillName, skillParams: opts.skillParams },
    );

    const count = await this.feedbackRepo.countEvents(opts.userId, contextKey);
    this.logger.debug({ contextKey, count, threshold: this.threshold }, 'Feedback: watch rejection recorded');

    if (count >= this.threshold) {
      const memoryKey = `feedback:${contextKey}`;
      const memoryValue = `Watch "${opts.watchName}" wurde ${count}× abgelehnt. Schwellenwert oder Parameter überprüfen bevor diese Aktion vorgeschlagen wird.`;

      await this.memoryRepo.saveWithMetadata(
        opts.userId,
        memoryKey,
        memoryValue,
        'automation',
        'feedback',
        0.9,
        'auto',
      );

      this.logger.info(
        { contextKey, count, memoryKey },
        'Feedback: watch rejection promoted to feedback memory',
      );
    }
  }

  private async handleCorrection(opts: {
    userId: string;
    userMessage: string;
    assistantResponse: string;
  }): Promise<void> {
    const dateKey = new Date().toISOString().slice(0, 10);
    const contextKey = `correction:${opts.userId}:${dateKey}`;

    // Extract a concise rule from the correction (pattern-based, fast)
    const rawRule = this.extractCorrectionRule(opts.userMessage);
    if (!rawRule) return;

    // v606 K2+K3 — LLM-Validierung + Type-Routing
    // Even if the pattern-scanner triggered, the message might be a question,
    // documentation, or procedural runbook — not a correction. A fast-tier LLM
    // call classifies the message and routes to the right memory-type (or skips).
    const classification = await this.classifyMessage(opts.userMessage, opts.assistantResponse);
    if (!classification || classification.intent === 'skip') {
      this.logger.info({ snippet: opts.userMessage.slice(0, 80), reason: classification?.reason },
        'Feedback: correction-signal triggered but LLM classified as skip — not saving');
      return;
    }

    const memoryType = classification.intent === 'preference' ? 'preference'
      : classification.intent === 'rule' ? 'general'
      : 'correction';
    const confidence = classification.intent === 'correction' ? 0.9 : 0.85;

    await this.feedbackRepo.recordEvent(
      opts.userId,
      'conversation_correction',
      undefined,
      contextKey,
      rawRule,
      { userMessage: opts.userMessage.slice(0, 500), intent: classification.intent },
    );

    // v606 K4 — Embedding-Deduplication: check if a near-identical memory already
    // exists for this user + type; if so, touch it instead of creating a duplicate.
    // Skips embedding lookup when no embedding service is wired.
    const dedup = await this.tryDeduplicate(opts.userId, rawRule, memoryType);
    if (dedup.skipped) {
      this.logger.info({
        existingKey: dedup.existingKey, similarity: dedup.similarity,
      }, 'Feedback: dedup hit — refreshed existing memory instead of creating duplicate');
      return;
    }

    // Save correction as a new memory (safe — does not overwrite existing memories)
    const memoryKey = `feedback:correction:${Date.now()}`;
    await this.memoryRepo.saveWithMetadata(
      opts.userId, memoryKey, rawRule, 'general', memoryType, confidence, 'manual',
    );

    this.logger.info({ rawRule, type: memoryType, intent: classification.intent },
      'Feedback: conversation correction saved');

    // Limit feedback memories to 20 — prune oldest beyond that
    try {
      const allFeedback = await this.memoryRepo.getByType(opts.userId, 'feedback', 100);
      if (allFeedback.length > 20) {
        // getByType returns sorted by confidence DESC, updated_at DESC — remove the tail
        const toDelete = allFeedback.slice(20).map(f => f.id);
        await this.memoryRepo.deleteByIds(toDelete);
        this.logger.debug({ pruned: toDelete.length }, 'Feedback: pruned excess feedback memories');
      }
    } catch (err) {
      this.logger.debug({ err }, 'Feedback: failed to prune old feedback memories');
    }

    // Try to extract a generalized rule via LLM and handle existing rules
    if (this.llm) {
      const now = Date.now();
      if (now - this.lastRuleExtractionAt < 60_000) {
        this.logger.debug('Feedback: skipping LLM rule extraction (cooldown)');
      } else {
        try {
          this.lastRuleExtractionAt = now;
          await this.extractAndSaveRule(opts);
        } catch (err) {
          this.logger.debug({ err }, 'Feedback: LLM rule extraction failed, raw feedback already saved');
        }
      }
    }
  }

  /**
   * Use LLM to extract a generalized rule from a user correction.
   * Also checks for existing rules that should have prevented the error.
   */
  private async extractAndSaveRule(opts: {
    userId: string;
    userMessage: string;
    assistantResponse: string;
  }): Promise<void> {
    if (!this.llm) return;

    const prompt = `Extrahiere eine generalisierbare, kurze Verhaltensregel (max 1 Satz, Imperativ) aus dieser User-Korrektur.
Kontext der Korrektur: ${opts.userMessage.slice(0, 500)}
Letzte Antwort: ${opts.assistantResponse.slice(0, 500)}
Antworte in derselben Sprache wie die User-Korrektur.
Regel:`;

    const response = await this.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      tier: 'fast',
      maxTokens: 128,
    });

    const generatedRule = response.content.trim();
    if (!generatedRule || generatedRule.length < 5 || generatedRule.length > 200) return;

    // Check for existing rule memories that semantically overlap
    const existingRules = await this.memoryRepo.getByType(opts.userId, 'rule', 50);
    const matchingRule = existingRules.find(r =>
      this.isSemanticallySimilar(r.value, generatedRule),
    );

    if (matchingRule) {
      // Existing rule should have prevented this error — lower confidence
      await this.memoryRepo.updateConfidence(matchingRule.id, -0.1);
      this.logger.info(
        { ruleKey: matchingRule.key, newConfidence: Math.max(0, matchingRule.confidence - 0.1) },
        'Feedback: existing rule confidence lowered (failed to prevent correction)',
      );

      // Refine the rule with the new correction context
      try {
        const refinePrompt = `Die folgende Verhaltensregel hat einen Fehler nicht verhindert.
Alte Regel: ${matchingRule.value}
Neue Korrektur: ${opts.userMessage.slice(0, 300)}
Formuliere die Regel präziser (max 1 Satz, Imperativ), damit sie künftig besser greift. Antworte in derselben Sprache wie die Korrektur.
Regel:`;

        const refineResponse = await this.llm.complete({
          messages: [{ role: 'user', content: refinePrompt }],
          temperature: 0.1,
          tier: 'fast',
          maxTokens: 128,
        });

        const refined = refineResponse.content.trim();
        if (refined && refined.length >= 5 && refined.length <= 200) {
          await this.memoryRepo.saveWithMetadata(
            opts.userId,
            matchingRule.key,
            refined,
            matchingRule.category,
            'rule',
            Math.max(0.1, matchingRule.confidence - 0.1),
            'auto',
          );
          this.logger.info({ ruleKey: matchingRule.key, refined }, 'Feedback: existing rule refined');
        }
      } catch { /* refinement is best-effort */ }
    } else {
      // New rule — save with initial confidence
      const ruleKey = `rule_correction_${Date.now()}`;
      await this.memoryRepo.saveWithMetadata(
        opts.userId,
        ruleKey,
        generatedRule,
        'behavior',
        'rule',
        0.7,
        'auto',
      );
      this.logger.info({ ruleKey, generatedRule }, 'Feedback: new rule extracted from correction');
    }
  }

  /**
   * Simple semantic similarity check: Jaccard on lowercased word tokens.
   * Returns true if similarity >= 0.4 (indicating overlapping meaning).
   */
  private isSemanticallySimilar(a: string, b: string): boolean {
    const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(t => t.length >= 3));
    const tokA = tokenize(a);
    const tokB = tokenize(b);
    if (tokA.size === 0 || tokB.size === 0) return false;
    let intersection = 0;
    for (const t of tokA) { if (tokB.has(t)) intersection++; }
    const union = tokA.size + tokB.size - intersection;
    return union > 0 && (intersection / union) >= 0.4;
  }

  /**
   * v606 K2+K3 — classify a triggered message as correction / preference / rule / skip.
   *
   * Fast-tier LLM call. Returns null on LLM failure → caller falls back to default
   * (treat as correction) for safety.
   */
  private async classifyMessage(userMessage: string, assistantResponse: string): Promise<{
    intent: 'correction' | 'preference' | 'rule' | 'skip';
    reason?: string;
  } | null> {
    if (!this.llm) {
      // No LLM available → conservative fallback: treat as correction
      return { intent: 'correction' };
    }
    const prompt = `Analysiere die folgende User-Nachricht im Kontext der letzten Alfred-Antwort.
Entscheide welche der 4 Kategorien zutrifft (gib NUR JSON zurück):

- "correction": User korrigiert eine FALSCHE Aktion/Aussage von Alfred ("nein, das stimmt nicht", "das war falsch", "ich meinte X statt Y"). Etwas konkret Falsches wurde gerade getan.
- "preference": User gibt eine generelle Verhaltensregel für die Zukunft ("Sei zukünftig kürzer", "Beim nächsten Mal direkt fragen", "Sprich mich mit du an").
- "rule": User gibt eine inhaltliche Anweisung / ein Runbook / eine prozedurale Vorschrift ("Mache jeden Tag X, wenn Y dann Z"). Das beschreibt einen Ablauf, KEINE Korrektur.
- "skip": Eine Frage, eine Erklärung, eine Diskussion ohne Korrektur-Charakter. Soll NICHT als Memory gespeichert werden.

Alfred-Antwort: ${assistantResponse.slice(0, 400)}
User-Nachricht: ${userMessage.slice(0, 800)}

Antwort als JSON: {"intent":"correction|preference|rule|skip","reason":"kurze Begründung"}`;
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        tier: 'fast',
        maxTokens: 80,
      });
      const text = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { intent: 'correction' }; // fallback if no JSON
      const parsed = JSON.parse(m[0]) as { intent: string; reason?: string };
      if (!['correction', 'preference', 'rule', 'skip'].includes(parsed.intent)) {
        return { intent: 'correction' };
      }
      return { intent: parsed.intent as 'correction' | 'preference' | 'rule' | 'skip', reason: parsed.reason };
    } catch (err) {
      this.logger.debug({ err }, 'Feedback: LLM classification failed — falling back to correction');
      return { intent: 'correction' };
    }
  }

  /**
   * v606 K4 — embedding-based deduplication. Looks up existing memories of the
   * same type, computes cosine similarity, and refreshes (touches updatedAt) the
   * closest match instead of creating a duplicate when sim > 0.85.
   *
   * Lazy — bypassed entirely when no embeddingService is wired (no breaking change).
   */
  private async tryDeduplicate(userId: string, value: string, type: string): Promise<{
    skipped: boolean;
    existingKey?: string;
    similarity?: number;
  }> {
    if (!this.embeddingService) return { skipped: false };
    try {
      const existing = await this.memoryRepo.getByType(userId, type, 50);
      if (existing.length === 0) return { skipped: false };
      const extractVec = async (text: string): Promise<number[] | undefined> => {
        const raw = await this.embeddingService!.embed(text);
        if (!raw) return undefined;
        return Array.isArray(raw) ? raw : raw.embedding;
      };
      const queryEmb = await extractVec(value);
      if (!queryEmb) return { skipped: false };
      let best: { key: string; sim: number } | undefined;
      for (const m of existing) {
        const emb = await extractVec(m.value);
        if (!emb) continue;
        const sim = cosineSimilarity(queryEmb, emb);
        if (!best || sim > best.sim) best = { key: m.key, sim };
      }
      if (best && best.sim > 0.85) {
        // Touch the existing memory (updatedAt) instead of saving a duplicate
        await this.memoryRepo.touch?.(userId, best.key);
        return { skipped: true, existingKey: best.key, similarity: best.sim };
      }
      return { skipped: false };
    } catch (err) {
      this.logger.debug({ err }, 'Feedback: dedup check failed — proceeding with save');
      return { skipped: false };
    }
  }

  /**
   * Simple rule extraction from correction messages.
   * No LLM call — pattern-based extraction to keep it fast and free.
   */
  private extractCorrectionRule(message: string): string | null {
    const trimmed = message.trim();
    // Keep the user's correction as-is if it's concise enough
    if (trimmed.length > 10 && trimmed.length < 300) {
      return `Nutzer-Korrektur: ${trimmed}`;
    }
    if (trimmed.length >= 300) {
      return `Nutzer-Korrektur: ${trimmed.slice(0, 280)}...`;
    }
    return null;
  }
}
