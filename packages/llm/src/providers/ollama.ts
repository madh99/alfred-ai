import type {
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  LLMContentBlock,
  ToolCall,
  ToolDefinition,
} from '@alfred/types';
import { LLMProvider } from '../provider.js';

export class OllamaProvider extends LLMProvider {
  private baseUrl: string = '';

  constructor(config: LLMProviderConfig) {
    super(config);
  }

  private apiKey: string = '';

  async initialize(): Promise<void> {
    this.baseUrl = this.config.baseUrl ?? 'http://localhost:11434';
    this.apiKey = this.config.apiKey ?? '';
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.buildMessages(request.messages, request.system);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
      options: this.buildOptions(request),
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as OllamaChatResponse;

    return this.mapResponse(data);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const messages = this.buildMessages(request.messages, request.system);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      options: this.buildOptions(request),
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${errorText}`);
    }

    if (!res.body) {
      throw new Error('Ollama streaming response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let promptEvalCount = 0;
    let evalCount = 0;
    const toolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChatResponse;
          try {
            chunk = JSON.parse(trimmed) as OllamaChatResponse;
          } catch {
            continue;
          }

          if (chunk.message?.content) {
            fullContent += chunk.message.content;
            yield { type: 'text_delta', text: chunk.message.content };
          }

          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const toolCall: ToolCall = {
                id: `ollama_tool_${toolCalls.length}`,
                name: tc.function.name,
                input: tc.function.arguments,
              };
              toolCalls.push(toolCall);
              yield {
                type: 'tool_use_start',
                toolCall: { id: toolCall.id, name: toolCall.name },
              };
              yield {
                type: 'tool_use_delta',
                toolCall: { input: toolCall.input },
              };
            }
          }

          if (chunk.done) {
            promptEvalCount = chunk.prompt_eval_count ?? 0;
            evalCount = chunk.eval_count ?? 0;

            yield {
              type: 'message_complete',
              response: {
                content: fullContent,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                usage: {
                  inputTokens: promptEvalCount,
                  outputTokens: evalCount,
                },
                stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
              },
            };
          }
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        let chunk: OllamaChatResponse;
        try {
          chunk = JSON.parse(buffer.trim()) as OllamaChatResponse;
        } catch {
          return;
        }

        if (chunk.message?.content) {
          fullContent += chunk.message.content;
          yield { type: 'text_delta', text: chunk.message.content };
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const toolCall: ToolCall = {
              id: `ollama_tool_${toolCalls.length}`,
              name: tc.function.name,
              input: tc.function.arguments,
            };
            toolCalls.push(toolCall);
            yield {
              type: 'tool_use_start',
              toolCall: { id: toolCall.id, name: toolCall.name },
            };
            yield {
              type: 'tool_use_delta',
              toolCall: { input: toolCall.input },
            };
          }
        }

        if (chunk.done) {
          promptEvalCount = chunk.prompt_eval_count ?? 0;
          evalCount = chunk.eval_count ?? 0;

          yield {
            type: 'message_complete',
            response: {
              content: fullContent,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              usage: {
                inputTokens: promptEvalCount,
                outputTokens: evalCount,
              },
              stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            },
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  isAvailable(): boolean {
    try {
      // isAvailable is synchronous, so we cannot actually make a fetch call.
      // Return true if we have a baseUrl configured (initialize has been called).
      return this.baseUrl.length > 0;
    } catch {
      return false;
    }
  }

  private buildOptions(
    request: LLMRequest,
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      options.temperature = temperature;
    }
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) {
      options.num_predict = maxTokens;
    }
    return options;
  }

  private buildMessages(
    messages: LLMMessage[],
    system?: string,
  ): OllamaMessage[] {
    const mapped: OllamaMessage[] = [];

    if (system) {
      mapped.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        mapped.push({ role: msg.role, content: msg.content });
      } else {
        mapped.push(this.mapContentBlocks(msg.role, msg.content));
      }
    }

    return mapped;
  }

  private mapContentBlocks(
    role: string,
    blocks: LLMContentBlock[],
  ): OllamaMessage {
    // Extract text content from blocks
    const textParts: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          // Tool use blocks in a message indicate the assistant called a tool.
          // Ollama handles this via tool_calls on the message, not inline content.
          // We include a description of the tool call in the text for context.
          textParts.push(
            `[Tool call: ${block.name}(${JSON.stringify(block.input)})]`,
          );
          break;
        case 'tool_result':
          // Tool results are sent as user messages in Ollama.
          // Include them as text content.
          textParts.push(
            `[Tool result for ${block.tool_use_id}]: ${block.content}`,
          );
          break;
      }
    }

    return { role, content: textParts.join('\n') };
  }

  private mapTools(
    tools: ToolDefinition[],
  ): OllamaTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private mapResponse(data: OllamaChatResponse): LLMResponse {
    const toolCalls: ToolCall[] = [];

    if (data.message.tool_calls) {
      for (const tc of data.message.tool_calls) {
        toolCalls.push({
          id: `ollama_tool_${toolCalls.length}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }

    return {
      content: data.message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }
}

// ---------------------------------------------------------------------------
// Ollama-specific types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}
