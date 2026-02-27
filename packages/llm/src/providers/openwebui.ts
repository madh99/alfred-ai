import type { LLMProviderConfig } from '@alfred/types';
import { OpenAIProvider } from './openai.js';

/**
 * OpenWebUI provider — uses the OpenAI-compatible API exposed by a local OpenWebUI instance.
 * Defaults to http://localhost:3000/api/v1 when no baseUrl is configured.
 */
export class OpenWebUIProvider extends OpenAIProvider {
  constructor(config: LLMProviderConfig) {
    super({
      ...config,
      // OpenAI SDK requires a non-empty apiKey — use a placeholder for local instances
      apiKey: config.apiKey || 'openwebui',
      baseUrl: config.baseUrl ?? 'http://localhost:3000/api/v1',
    });
  }

  isAvailable(): boolean {
    return true; // Local instance, no API key required
  }

  supportsEmbeddings(): boolean {
    return false;
  }
}
