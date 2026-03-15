import type { Logger } from 'pino';
import type { FeedbackRepository } from '@alfred/storage';
import type { MemoryRepository } from '@alfred/storage';

export interface FeedbackServiceOptions {
  rejectionThreshold?: number;  // rejections before promoting to feedback memory (default 3)
  staleDays?: number;           // days before stale feedback decays (default 90)
}

export class FeedbackService {
  private readonly threshold: number;
  private readonly staleDays: number;

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
      const pruned = this.feedbackRepo.pruneOldEvents(this.staleDays * 2);
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

    this.feedbackRepo.recordEvent(
      opts.userId,
      'watch_rejection',
      opts.watchId,
      contextKey,
      opts.description,
      { skillName: opts.skillName, skillParams: opts.skillParams },
    );

    const count = this.feedbackRepo.countEvents(opts.userId, contextKey);
    this.logger.debug({ contextKey, count, threshold: this.threshold }, 'Feedback: watch rejection recorded');

    if (count >= this.threshold) {
      const memoryKey = `feedback:${contextKey}`;
      const memoryValue = `Watch "${opts.watchName}" wurde ${count}× abgelehnt. Schwellenwert oder Parameter überprüfen bevor diese Aktion vorgeschlagen wird.`;

      this.memoryRepo.saveWithMetadata(
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

    // Extract a concise rule from the correction
    const rule = this.extractCorrectionRule(opts.userMessage);
    if (!rule) return;

    this.feedbackRepo.recordEvent(
      opts.userId,
      'conversation_correction',
      undefined,
      contextKey,
      rule,
      { userMessage: opts.userMessage.slice(0, 500) },
    );

    // Directly save as feedback memory (corrections are explicit — no threshold needed)
    const memoryKey = `feedback:correction:${Date.now()}`;
    this.memoryRepo.saveWithMetadata(
      opts.userId,
      memoryKey,
      rule,
      'general',
      'feedback',
      0.8,
      'auto',
    );

    this.logger.info({ rule }, 'Feedback: conversation correction saved as feedback memory');
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
