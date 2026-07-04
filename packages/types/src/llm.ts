export interface LLMProviderConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'openwebui' | 'google' | 'mistral';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/** v868 — 'fallback': reiner Notfall-Provider (z.B. Mistral). Wird nie regulär
 *  geroutet, steht nur am Ende der Fallback-Kette wenn default/strong/fast
 *  ausfallen (Transient- oder Billing-Fehler).
 *  v979 — 'medium': hochwertige Serienproduktion (z.B. Studio-Redaktionstexte,
 *  Übersetzungen) — Qualität über 'fast', Kosten unter 'strong', entkoppelt
 *  vom Chat-Alltag ('default'). Nicht konfiguriert → Router fällt auf
 *  'default' zurück. */
export type ModelTier = 'default' | 'medium' | 'strong' | 'fast' | 'embeddings' | 'local' | 'fallback';

export type MultiModelConfig = {
  [K in ModelTier]?: LLMProviderConfig;
} & {
  default: LLMProviderConfig;
};

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | LLMTextBlock
  | LLMImageBlock
  | LLMToolUseBlock
  | LLMToolResultBlock;

export interface LLMImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface LLMTextBlock {
  type: 'text';
  text: string;
}

export interface LLMToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LLMRequest {
  messages: LLMMessage[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  tier?: ModelTier;
  /**
   * Reasoning depth for reasoning-capable models (gpt-5.5, o-series).
   * Ignored by chat models and non-OpenAI providers.
   * - `none`: no internal reasoning (fastest, cheapest)
   * - `low`: minimal reasoning
   * - `medium`: default
   * - `high`: deep reasoning
   * - `xhigh`: maximum reasoning (slowest, most expensive)
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface LLMResponse {
  content: string;
  model?: string;
  toolCalls?: ToolCall[];
  usage: LLMUsage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'message_complete';
  text?: string;
  toolCall?: Partial<ToolCall>;
  response?: LLMResponse;
}
