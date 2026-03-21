import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelTier,
  MultiModelConfig,
} from '@alfred/types';
import { LLMProvider } from './provider.js';
import type { ContextWindow, EmbeddingResult } from './provider.js';
import { createLLMProvider } from './provider-factory.js';
import { TokenCostTracker } from './token-costs.js';
import type { TokenCostSummary, UsagePersistFn } from './token-costs.js';

const TIERS: ModelTier[] = ['default', 'strong', 'fast', 'embeddings', 'local'];

/** Minimal logger interface to avoid hard pino dependency. */
interface RouterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Routes LLM requests to different providers based on the requested tier.
 * Extends LLMProvider so it can be used as a drop-in replacement everywhere.
 */
export class ModelRouter extends LLMProvider {
  private readonly providers = new Map<ModelTier, LLMProvider>();
  private readonly multiConfig: MultiModelConfig;
  private readonly logger?: RouterLogger;
  private readonly costTracker = new TokenCostTracker();

  constructor(config: MultiModelConfig, logger?: RouterLogger) {
    super(config.default);
    this.multiConfig = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    for (const tier of TIERS) {
      const tierConfig = this.multiConfig[tier];
      if (tierConfig) {
        const provider = createLLMProvider(tierConfig);
        await provider.initialize();
        this.providers.set(tier, provider);
        this.logger?.info(
          { tier, provider: tierConfig.provider, model: tierConfig.model },
          'LLM tier initialized',
        );
      }
    }
    if (!this.providers.has('default')) {
      throw new Error(
        'ModelRouter: no "default" tier configured. ' +
        `Available tiers: [${[...this.providers.keys()].join(', ')}]`,
      );
    }
  }

  private resolve(tier?: ModelTier): { provider: LLMProvider; resolvedTier: ModelTier } {
    if (tier && this.providers.has(tier)) {
      return { provider: this.providers.get(tier)!, resolvedTier: tier };
    }
    const defaultProvider = this.providers.get('default');
    if (!defaultProvider) {
      throw new Error(
        'ModelRouter: no "default" tier available. Was initialize() called?',
      );
    }
    return { provider: defaultProvider, resolvedTier: 'default' };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const { provider, resolvedTier } = this.resolve(request.tier);
    const tierConfig = this.multiConfig[resolvedTier];
    this.logger?.debug(
      { requestedTier: request.tier ?? 'default', resolvedTier, model: tierConfig?.model },
      'LLM routing request',
    );
    try {
      return await this.executeComplete(provider, resolvedTier, request);
    } catch (err) {
      if (!this.isRetryableError(err)) throw err;
      this.logger?.warn(
        { err, tier: resolvedTier },
        'Provider failed, attempting fallback',
      );
      return this.completeWithFallback(request, resolvedTier, err);
    }
  }

  private async executeComplete(provider: LLMProvider, resolvedTier: ModelTier, request: LLMRequest): Promise<LLMResponse> {
    const tierConfig = this.multiConfig[resolvedTier];
    const response = await provider.complete(request);
    const model = response.model ?? tierConfig?.model ?? 'unknown';
    if (!response.model) response.model = model;
    const costUsd = this.costTracker.record(model, response.usage);
    this.logger?.info(
      {
        tier: resolvedTier, model, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
        inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens,
        cacheReadTokens: response.usage?.cacheReadTokens, cacheWriteTokens: response.usage?.cacheCreationTokens,
      },
      'LLM call completed',
    );
    return response;
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      // Network errors, 5xx, rate limits → retryable
      if (msg.includes('econnrefused') || msg.includes('enotfound') ||
          msg.includes('etimedout') || msg.includes('econnreset') ||
          msg.includes('socket hang up') || msg.includes('fetch failed')) return true;
      // HTTP status-based
      if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
          msg.includes('504') || msg.includes('529') || msg.includes('rate limit') ||
          msg.includes('overloaded') || msg.includes('too many requests')) return true;
    }
    // Check for status code on error object
    const status = (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode;
    if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
    return false;
  }

  private async completeWithFallback(request: LLMRequest, failedTier: ModelTier, originalErr: unknown): Promise<LLMResponse> {
    const fallbackOrder = (['default', 'strong', 'fast'] as ModelTier[]).filter(t => t !== failedTier);
    for (const tier of fallbackOrder) {
      const provider = this.providers.get(tier);
      if (!provider) continue;
      try {
        this.logger?.info({ tier }, 'Fallback to tier');
        return await this.executeComplete(provider, tier, request);
      } catch {
        continue;
      }
    }
    throw originalErr;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const { provider, resolvedTier } = this.resolve(request.tier);
    let hasYielded = false;
    try {
      for await (const event of provider.stream(request)) {
        hasYielded = true;
        yield event;
      }
    } catch (err) {
      // If we already yielded chunks, fallback would produce a spliced/garbled stream
      if (hasYielded || !this.isRetryableError(err)) throw err;
      this.logger?.warn(
        { err, tier: resolvedTier },
        'Stream provider failed before first chunk, attempting fallback',
      );
      const fallbackOrder = (['default', 'strong', 'fast'] as ModelTier[]).filter(t => t !== resolvedTier);
      for (const tier of fallbackOrder) {
        const fbProvider = this.providers.get(tier);
        if (!fbProvider) continue;
        try {
          this.logger?.info({ tier }, 'Stream fallback to tier');
          yield* fbProvider.stream(request);
          return;
        } catch {
          continue;
        }
      }
      throw err;
    }
  }

  async embed(text: string): Promise<EmbeddingResult | undefined> {
    const result = await (this.providers.get('embeddings') ?? this.resolve().provider).embed(text);
    if (result?.totalTokens) {
      this.costTracker.record(result.model, { inputTokens: result.totalTokens, outputTokens: 0 });
    }
    return result;
  }

  supportsEmbeddings(): boolean {
    return (this.providers.get('embeddings') ?? this.resolve().provider).supportsEmbeddings();
  }

  isAvailable(): boolean {
    return this.resolve().provider.isAvailable();
  }

  getContextWindow(): ContextWindow {
    return this.resolve().provider.getContextWindow();
  }

  getProviderStatuses(): Record<string, { model: string; available: boolean }> {
    const result: Record<string, { model: string; available: boolean }> = {};
    for (const tier of TIERS) {
      const provider = this.providers.get(tier);
      if (provider) {
        const tierConfig = this.multiConfig[tier];
        result[tier] = {
          model: tierConfig?.model ?? 'unknown',
          available: provider.isAvailable(),
        };
      }
    }
    return result;
  }

  getCostSummary(): TokenCostSummary {
    return this.costTracker.getSummary();
  }

  /** Wire SQLite persistence for usage tracking. */
  setPersist(fn: UsagePersistFn): void {
    this.costTracker.setPersist(fn);
  }
}

export function createModelRouter(config: MultiModelConfig, logger?: RouterLogger): ModelRouter {
  return new ModelRouter(config, logger);
}
