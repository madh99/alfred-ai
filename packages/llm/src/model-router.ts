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

const TIERS: ModelTier[] = ['default', 'strong', 'fast', 'embeddings', 'local'];

/** Minimal logger interface to avoid hard pino dependency. */
interface RouterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
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
  }

  private resolve(tier?: ModelTier): { provider: LLMProvider; resolvedTier: ModelTier } {
    if (tier && this.providers.has(tier)) {
      return { provider: this.providers.get(tier)!, resolvedTier: tier };
    }
    return { provider: this.providers.get('default')!, resolvedTier: 'default' };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const { provider, resolvedTier } = this.resolve(request.tier);
    const tierConfig = this.multiConfig[resolvedTier];
    this.logger?.debug(
      { requestedTier: request.tier ?? 'default', resolvedTier, model: tierConfig?.model },
      'LLM routing request',
    );
    const response = await provider.complete(request);
    this.logger?.info(
      { tier: resolvedTier, model: tierConfig?.model, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens },
      'LLM call completed',
    );
    return response;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const { provider } = this.resolve(request.tier);
    yield* provider.stream(request);
  }

  async embed(text: string): Promise<EmbeddingResult | undefined> {
    return (this.providers.get('embeddings') ?? this.resolve().provider).embed(text);
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
}

export function createModelRouter(config: MultiModelConfig, logger?: RouterLogger): ModelRouter {
  return new ModelRouter(config, logger);
}
