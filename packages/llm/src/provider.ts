import type {
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from '@alfred/types';

export interface ContextWindow {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

// Known context window sizes for popular models
const KNOWN_CONTEXT_WINDOWS: Record<string, ContextWindow> = {
  // Anthropic — Claude 4.6 / 4.5 / 4.x / 3.5 / 3.x
  'claude-opus-4-6':              { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
  'claude-sonnet-4-6':            { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
  'claude-opus-4-5-20251101':     { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
  'claude-opus-4-20250514':       { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4-5-20250929':   { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
  'claude-sonnet-4-20250514':     { maxInputTokens: 200_000, maxOutputTokens: 16_000 },
  'claude-haiku-4-5-20251001':    { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
  'claude-3-5-sonnet-20241022':   { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
  'claude-3-5-sonnet-20240620':   { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
  'claude-3-5-haiku-20241022':    { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
  'claude-haiku-3-5-20241022':    { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
  'claude-3-opus-20240229':       { maxInputTokens: 200_000, maxOutputTokens: 4_096 },
  'claude-3-sonnet-20240229':     { maxInputTokens: 200_000, maxOutputTokens: 4_096 },
  'claude-3-haiku-20240307':      { maxInputTokens: 200_000, maxOutputTokens: 4_096 },
  // Generic Claude prefix fallback (future claude-* models default to 1M context)
  'claude-':                      { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },

  // OpenAI — GPT-5.x / GPT-4.1 / GPT-4o / o-series
  'gpt-5.4':                      { maxInputTokens: 1_050_000, maxOutputTokens: 128_000 },
  'gpt-5.4-mini':                 { maxInputTokens: 400_000,   maxOutputTokens: 128_000 },
  'gpt-5.4-nano':                 { maxInputTokens: 400_000,   maxOutputTokens: 128_000 },
  'gpt-5':                        { maxInputTokens: 400_000,   maxOutputTokens: 128_000 },
  'gpt-4.1':                      { maxInputTokens: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4.1-mini':                 { maxInputTokens: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4.1-nano':                 { maxInputTokens: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4o':                       { maxInputTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini':                  { maxInputTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4-turbo':                  { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'gpt-4':                        { maxInputTokens: 8_192,   maxOutputTokens: 8_192 },
  'gpt-3.5-turbo':                { maxInputTokens: 16_385,  maxOutputTokens: 4_096 },
  'o3':                           { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  'o3-mini':                      { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  'o4-mini':                      { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  'o1':                           { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  'o1-mini':                      { maxInputTokens: 128_000, maxOutputTokens: 65_536 },

  // Google Gemini
  'gemini-3.1-pro':               { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3.1-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3-pro':                 { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-3-flash':               { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-pro':               { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.0-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-2.0-pro':               { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-1.5-pro':               { maxInputTokens: 2_097_152, maxOutputTokens: 8_192 },
  'gemini-1.5-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },

  // Mistral AI
  'mistral-large':                { maxInputTokens: 256_000, maxOutputTokens: 256_000 },
  'mistral-medium':               { maxInputTokens: 131_072, maxOutputTokens: 131_072 },
  'mistral-small':                { maxInputTokens: 256_000, maxOutputTokens: 256_000 },
  'codestral':                    { maxInputTokens: 256_000, maxOutputTokens: 256_000 },
  'magistral-medium':             { maxInputTokens: 40_000,  maxOutputTokens: 40_000 },
  'magistral-small':              { maxInputTokens: 128_000, maxOutputTokens: 128_000 },
  'ministral':                    { maxInputTokens: 128_000, maxOutputTokens: 128_000 },

  // Common Ollama / local models
  'llama4':                       { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'llama3.2':                     { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'llama3.1':                     { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'llama3':                       { maxInputTokens: 8_192,   maxOutputTokens: 4_096 },
  'gemma3':                       { maxInputTokens: 128_000, maxOutputTokens: 128_000 },
  'gemma2':                       { maxInputTokens: 8_192,   maxOutputTokens: 4_096 },
  'qwen3':                        { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
  'qwen2.5':                      { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'mixtral':                      { maxInputTokens: 32_000,  maxOutputTokens: 4_096 },
  'phi3':                         { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'phi4':                         { maxInputTokens: 16_384,  maxOutputTokens: 4_096 },
  'deepseek-r1':                  { maxInputTokens: 128_000, maxOutputTokens: 64_000 },
  'deepseek-v3':                  { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
  'deepseek-chat':                { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
  'command-r':                    { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'command-r-plus':               { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
};

const DEFAULT_CONTEXT_WINDOW: ContextWindow = { maxInputTokens: 128_000, maxOutputTokens: 8_192 };

export function lookupContextWindow(model: string): ContextWindow | undefined {
  // Exact match
  if (KNOWN_CONTEXT_WINDOWS[model]) return KNOWN_CONTEXT_WINDOWS[model];
  // Prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
  // Sort by key length descending so longer/more-specific prefixes match first
  // (e.g. "gpt-4-turbo" matches before "gpt-4")
  const entries = Object.entries(KNOWN_CONTEXT_WINDOWS).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [key, value] of entries) {
    if (model.startsWith(key)) return value;
  }
  return undefined;
}

export abstract class LLMProvider {
  protected config: LLMProviderConfig;
  protected contextWindow: ContextWindow = DEFAULT_CONTEXT_WINDOW;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract complete(request: LLMRequest): Promise<LLMResponse>;
  abstract stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  abstract isAvailable(): boolean;

  getContextWindow(): ContextWindow {
    return this.contextWindow;
  }

  async embed(_text: string): Promise<EmbeddingResult | undefined> {
    return undefined;
  }

  supportsEmbeddings(): boolean {
    return false;
  }
}
