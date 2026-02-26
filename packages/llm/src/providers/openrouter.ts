import type { LLMProviderConfig } from '@alfred/types';
import { OpenAIProvider } from './openai.js';

/**
 * OpenRouter provider — uses the OpenAI-compatible API with a custom base URL.
 * Models are specified as e.g. "anthropic/claude-3.5-sonnet", "google/gemini-pro", etc.
 */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
    });
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }
}
