export interface LLMProviderConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'openwebui';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelTier = 'default' | 'strong' | 'fast' | 'embeddings' | 'local';

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
}

export interface LLMResponse {
  content: string;
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
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'message_complete';
  text?: string;
  toolCall?: Partial<ToolCall>;
  response?: LLMResponse;
}
