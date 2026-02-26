import type { LLMProviderConfig } from '@alfred/types';
import { LLMProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OllamaProvider } from './providers/ollama.js';

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
