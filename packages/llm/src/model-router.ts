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

/**
 * Routes LLM requests to different providers based on the requested tier.
 * Extends LLMProvider so it can be used as a drop-in replacement everywhere.
 */
export class ModelRouter extends LLMProvider {
  private readonly providers = new Map<ModelTier, LLMProvider>();
  private readonly multiConfig: MultiModelConfig;

  constructor(config: MultiModelConfig) {
    super(config.default);
    this.multiConfig = config;
  }

  async initialize(): Promise<void> {
    for (const tier of TIERS) {
      const tierConfig = this.multiConfig[tier];
      if (tierConfig) {
        const provider = createLLMProvider(tierConfig);
        await provider.initialize();
        this.providers.set(tier, provider);
      }
    }
  }

  private resolve(tier?: ModelTier): LLMProvider {
    if (tier && this.providers.has(tier)) return this.providers.get(tier)!;
    return this.providers.get('default')!;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.resolve(request.tier).complete(request);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    yield* this.resolve(request.tier).stream(request);
  }

  async embed(text: string): Promise<EmbeddingResult | undefined> {
    return (this.providers.get('embeddings') ?? this.resolve()).embed(text);
  }

  supportsEmbeddings(): boolean {
    return (this.providers.get('embeddings') ?? this.resolve()).supportsEmbeddings();
  }

  isAvailable(): boolean {
    return this.resolve().isAvailable();
  }

  getContextWindow(): ContextWindow {
    return this.resolve().getContextWindow();
  }
}

export function createModelRouter(config: MultiModelConfig): ModelRouter {
  return new ModelRouter(config);
}
