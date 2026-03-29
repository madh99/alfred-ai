import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { FeedbackRepository } from '@alfred/storage';
import type { MemoryRepository } from '@alfred/storage';

export interface FeedbackServiceOptions {
  rejectionThreshold?: number;  // rejections before promoting to feedback memory (default 3)
  staleDays?: number;           // days before stale feedback decays (default 90)
}

export class FeedbackService {
  private readonly threshold: number;
  private readonly staleDays: number;
  private llm?: LLMProvider;
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

    await this.feedbackRepo.recordEvent(
      opts.userId,
      'conversation_correction',
      undefined,
      contextKey,
      rawRule,
      { userMessage: opts.userMessage.slice(0, 500) },
    );

    // Directly save as feedback memory (corrections are explicit — no threshold needed)
    const memoryKey = `feedback:correction:${Date.now()}`;
    await this.memoryRepo.saveWithMetadata(
      opts.userId,
      memoryKey,
      rawRule,
      'general',
      'feedback',
      0.8,
      'auto',
    );

    this.logger.info({ rawRule }, 'Feedback: conversation correction saved as feedback memory');

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
Antworte auf Deutsch.
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
Formuliere die Regel präziser (max 1 Satz, Imperativ), damit sie künftig besser greift. Antworte auf Deutsch.
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
