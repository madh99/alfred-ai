import type { LLMProviderConfig } from '@alfred/types';
import { OpenAIProvider } from './openai.js';

/**
 * Google/Gemini provider — uses the OpenAI-compatible API endpoint.
 */
export class GoogleProvider extends OpenAIProvider {
  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  supportsEmbeddings(): boolean {
    return false;
  }
}
