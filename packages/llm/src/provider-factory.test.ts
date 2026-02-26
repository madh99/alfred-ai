import { describe, it, expect } from 'vitest';
import { createLLMProvider } from './provider-factory.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OllamaProvider } from './providers/ollama.js';

describe('createLLMProvider', () => {
  it('should create AnthropicProvider', () => {
    const provider = createLLMProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test',
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('should create OpenAIProvider', () => {
    const provider = createLLMProvider({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'test',
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('should create OpenRouterProvider', () => {
    const provider = createLLMProvider({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'test',
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('should create OllamaProvider', () => {
    const provider = createLLMProvider({
      provider: 'ollama',
      model: 'llama3',
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('should throw on unknown provider', () => {
    expect(() =>
      createLLMProvider({ provider: 'unknown' as any, model: 'x' }),
    ).toThrow('Unknown LLM provider');
  });
});
