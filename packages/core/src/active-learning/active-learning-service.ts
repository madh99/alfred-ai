import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository } from '@alfred/storage';
import type { EmbeddingService } from '../embedding-service.js';
import { scanSignal } from './signal-scanner.js';
import { MemoryExtractor } from './memory-extractor.js';
import { scanCorrectionSignal } from '../feedback/correction-signal-scanner.js';
import type { FeedbackService } from '../feedback/feedback-service.js';

export interface ActiveLearningOptions {
  llm: LLMProvider;
  memoryRepo: MemoryRepository;
  logger: Logger;
  embeddingService?: EmbeddingService;
  minMessageLength?: number;
  minConfidence?: number;
  maxExtractionsPerMinute?: number;
}

export class ActiveLearningService {
  private readonly extractor: MemoryExtractor;
  private readonly logger: Logger;
  private readonly minMessageLength: number;
  private readonly maxExtractionsPerMinute: number;

  // Rate limiting: track extraction timestamps per user
  private readonly extractionTimestamps = new Map<string, number[]>();
  private feedbackService?: FeedbackService;

  setFeedbackService(service: FeedbackService): void {
    this.feedbackService = service;
  }

  constructor(options: ActiveLearningOptions) {
    this.logger = options.logger;
    this.minMessageLength = options.minMessageLength ?? 15;
    this.maxExtractionsPerMinute = options.maxExtractionsPerMinute ?? 5;

    this.extractor = new MemoryExtractor(
      options.llm,
      options.memoryRepo,
      this.logger,
      options.embeddingService,
      options.minConfidence ?? 0.4,
    );
  }

  /**
   * Fire-and-forget: analyze a user message for memory-worthy content.
   * Does NOT block the message pipeline.
   */
  onMessageProcessed(
    userId: string,
    userMessage: string,
    assistantResponse: string,
  ): void {
    // Skip too-short messages
    if (!userMessage || userMessage.length < this.minMessageLength) {
      return;
    }

    // Correction signal scan (independent of memory extraction)
    if (this.feedbackService) {
      const correctionSignal = scanCorrectionSignal(userMessage);
      if (correctionSignal.level === 'high') {
        this.feedbackService.onConversationCorrection({
          userId,
          userMessage,
          assistantResponse,
        });
      }
    }

    // Signal scan (pure function, ~1ms)
    const signal = scanSignal(userMessage);
    if (signal.level === 'low') {
      this.logger.debug({ signal: 'low' }, 'Skipping fact extraction — low signal');

      // Even on low signal, try connection extraction if user has enough memories
      this.extractor.extractConnectionsOnly(userId, userMessage, assistantResponse)
        .then(count => {
          if (count > 0) {
            this.logger.info({ userId, connectionCount: count }, 'Connection extraction on low-signal message');
          }
        })
        .catch(err => {
          this.logger.debug({ err }, 'Connection extraction skipped or failed');
        });

      return;
    }

    // Rate limiting
    if (!this.checkRateLimit(userId)) {
      this.logger.debug({ userId }, 'Skipping extraction — rate limit reached');
      return;
    }

    this.logger.info(
      { signal: signal.level, patterns: signal.matchedPatterns },
      'High signal detected, triggering extraction',
    );

    // Async extraction — fire and forget
    this.extractor
      .extract(userId, userMessage, assistantResponse)
      .then(count => {
        if (count > 0) {
          this.logger.info({ userId, extractedCount: count }, 'Auto-extraction complete');
        }
      })
      .catch(err => {
        this.logger.error({ err }, 'Auto-extraction failed');
      });
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let timestamps = this.extractionTimestamps.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.extractionTimestamps.set(userId, timestamps);
    }

    // Remove old timestamps
    const recent = timestamps.filter(t => t > oneMinuteAgo);
    if (recent.length === 0) {
      timestamps.length = 0;
      timestamps.push(now);
      return true;
    }
    this.extractionTimestamps.set(userId, recent);

    if (recent.length >= this.maxExtractionsPerMinute) {
      return false;
    }

    recent.push(now);
    return true;
  }
}
