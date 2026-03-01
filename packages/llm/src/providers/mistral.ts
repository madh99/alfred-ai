import type { LLMProviderConfig } from '@alfred/types';
import { OpenAIProvider } from './openai.js';

/**
 * Mistral AI provider — uses the OpenAI-compatible API endpoint.
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
    return false;
  }
}
