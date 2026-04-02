import type { Logger } from './security-manager.js';

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
}

/**
 * Optional moderation service that checks user input and LLM output
 * against content policy using OpenAI or Mistral moderation APIs.
 *
 * Completely optional — when not configured, Alfred works as before.
 * NEVER throws — all errors are caught and result in `null`.
 */
export class ModerationService {
  private usageCallback?: (model: string, units: number) => void;

  /** Set callback for tracking service usage (called with model + estimated token count). */
  setUsageCallback(cb: (model: string, units: number) => void): void { this.usageCallback = cb; }

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Moderate a single text string.
   * Returns null on any error (graceful degradation).
   */
  async moderate(text: string): Promise<ModerationResult | null> {
    try {
      const url = `${this.baseUrl.replace(/\/+$/, '')}/moderations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: text, model: this.model }),
      });

      if (!res.ok) {
        this.logger.warn({ status: res.status, url }, 'Moderation API returned non-OK status');
        return null;
      }

      const data = await res.json() as {
        results?: Array<{
          flagged?: boolean;
          categories?: Record<string, boolean>;
          category_scores?: Record<string, number>;
        }>;
      };

      const result = data.results?.[0];
      if (!result) return null;

      // Estimate tokens (~4 chars per token)
      if (this.usageCallback) this.usageCallback(this.model, Math.ceil(text.length / 4));
      return {
        flagged: result.flagged ?? false,
        categories: result.categories ?? {},
        scores: result.category_scores ?? {},
      };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Moderation API call failed');
      return null;
    }
  }

  /**
   * Moderate a chat message array (Mistral chat/moderations or OpenAI moderations).
   * Returns null on any error (graceful degradation).
   */
  async moderateChat(messages: Array<{ role: string; content: string }>): Promise<ModerationResult | null> {
    try {
      // Mistral uses /chat/moderations, OpenAI uses /moderations with concatenated input
      const isMistral = this.baseUrl.includes('mistral.ai');

      if (isMistral) {
        const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/moderations`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ input: messages, model: this.model }),
        });

        if (!res.ok) {
          this.logger.warn({ status: res.status, url }, 'Chat moderation API returned non-OK status');
          return null;
        }

        const data = await res.json() as {
          results?: Array<{
            flagged?: boolean;
            categories?: Record<string, boolean>;
            category_scores?: Record<string, number>;
          }>;
        };

        const result = data.results?.[0];
        if (!result) return null;

        return {
          flagged: result.flagged ?? false,
          categories: result.categories ?? {},
          scores: result.category_scores ?? {},
        };
      }

      // OpenAI: concatenate messages and use standard /moderations endpoint
      const concatenated = messages.map(m => m.content).join('\n');
      return this.moderate(concatenated);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Chat moderation API call failed');
      return null;
    }
  }
}
