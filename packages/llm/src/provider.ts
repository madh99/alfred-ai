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
  // Anthropic
  'claude-opus-4-20250514':       { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4-20250514':     { maxInputTokens: 200_000, maxOutputTokens: 16_000 },
  'claude-haiku-3-5-20241022':    { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
  // OpenAI
  'gpt-4o':                       { maxInputTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini':                  { maxInputTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4-turbo':                  { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'gpt-4':                        { maxInputTokens: 8_192,   maxOutputTokens: 4_096 },
  'gpt-3.5-turbo':                { maxInputTokens: 16_384,  maxOutputTokens: 4_096 },
  'o1':                           { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  'o1-mini':                      { maxInputTokens: 128_000, maxOutputTokens: 65_536 },
  'o3-mini':                      { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
  // Common Ollama models
  'llama3.2':                     { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'llama3.1':                     { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'llama3':                       { maxInputTokens: 8_192,   maxOutputTokens: 4_096 },
  'mistral':                      { maxInputTokens: 32_000,  maxOutputTokens: 4_096 },
  'mistral-small':                { maxInputTokens: 32_000,  maxOutputTokens: 4_096 },
  'mixtral':                      { maxInputTokens: 32_000,  maxOutputTokens: 4_096 },
  'gemma2':                       { maxInputTokens: 8_192,   maxOutputTokens: 4_096 },
  'qwen2.5':                      { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'phi3':                         { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  'deepseek-r1':                  { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
  'command-r':                    { maxInputTokens: 128_000, maxOutputTokens: 4_096 },
  // Google Gemini
  'gemini-2.0-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-2.0-pro':               { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },
  'gemini-1.5-pro':               { maxInputTokens: 2_097_152, maxOutputTokens: 8_192 },
  'gemini-1.5-flash':             { maxInputTokens: 1_048_576, maxOutputTokens: 8_192 },
};

const DEFAULT_CONTEXT_WINDOW: ContextWindow = { maxInputTokens: 8_192, maxOutputTokens: 4_096 };

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
