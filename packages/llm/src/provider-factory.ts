import type { LLMProviderConfig } from '@alfred/types';
import { LLMProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenWebUIProvider } from './providers/openwebui.js';
import { GoogleProvider } from './providers/google.js';
import { MistralProvider } from './providers/mistral.js';

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
    case 'openwebui':
      return new OpenWebUIProvider(config);
    case 'google':
      return new GoogleProvider(config);
    case 'mistral':
      return new MistralProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
