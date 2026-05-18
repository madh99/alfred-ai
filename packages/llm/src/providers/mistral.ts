import { createHash } from 'node:crypto';
import type { LLMProviderConfig, LLMRequest } from '@alfred/types';
import { OpenAIProvider } from './openai.js';

/**
 * Mistral AI provider — uses the OpenAI-compatible API endpoint.
 *
 * v596: Injects `prompt_cache_key` via the OpenAIProvider's extraRequestParams hook
 * for Mistral Medium 3.5+ models. Mistral charges cached tokens at 10% of standard
 * input rate, but caching is opt-in via this parameter (different from OpenAI/Anthropic
 * which auto-cache).
 *
 * Cache-Key Strategy: stable SHA-256 hash over (system prompt + tool definitions).
 * Same system+tools → same cache key → cache-hit on subsequent calls. System-prompt
 * changes (e.g. memory updates that alter the rendered prompt) invalidate the cache,
 * which is the correct behavior.
 *
 * Conservative scope: only enabled for `mistral-medium-3-5*` models. Other Mistral
 * models (small, large, magistral, ministral, codestral, embed) get the standard call
 * without `prompt_cache_key` since Mistral docs don't explicitly confirm support across
 * all models.
 */
export class MistralProvider extends OpenAIProvider {
  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? 'https://api.mistral.ai/v1/',
    });
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  supportsEmbeddings(): boolean {
    return true;
  }

  /** True iff the active model has documented prompt-caching support. */
  protected supportsPromptCaching(): boolean {
    return /^mistral-medium-3-5/i.test(this.config.model);
  }

  /**
   * Stable cache key per (system+tools). Returns undefined when neither a non-empty
   * system prompt nor any tools are present — sending a cache key for an "empty"
   * setup buys nothing. 32 hex chars = 128 bits, ample uniqueness for cache slots.
   */
  protected computeCacheKey(request: LLMRequest): string | undefined {
    const hasSystem = typeof request.system === 'string' && request.system.length > 0;
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    if (!hasSystem && !hasTools) return undefined;
    const seed = `${request.system ?? ''}\n${JSON.stringify(request.tools ?? [])}`;
    return createHash('sha256').update(seed).digest('hex').slice(0, 32);
  }

  /** Inject prompt_cache_key into the chat completion request body via the parent hook. */
  protected extraRequestParams(request: LLMRequest): Record<string, unknown> {
    if (!this.supportsPromptCaching()) return {};
    const key = this.computeCacheKey(request);
    return key ? { prompt_cache_key: key } : {};
  }
}
