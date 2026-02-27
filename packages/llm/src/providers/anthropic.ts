import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  ToolCall,
  ToolDefinition,
} from '@alfred/types';
import { LLMProvider, lookupContextWindow } from '../provider.js';

export class AnthropicProvider extends LLMProvider {
  private client!: Anthropic;

  constructor(config: LLMProviderConfig) {
    super(config);
  }

  async initialize(): Promise<void> {
    this.client = new Anthropic({ apiKey: this.config.apiKey });
    const cw = lookupContextWindow(this.config.model);
    if (cw) this.contextWindow = cw;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.mapMessages(request.messages);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const params: Anthropic.MessageCreateParams = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: request.temperature ?? this.config.temperature,
      system: request.system,
      messages,
      tools,
    };

    const response = await this.client.messages.create(params);

    return this.mapResponse(response);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const messages = this.mapMessages(request.messages);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: request.temperature ?? this.config.temperature,
      system: request.system,
      messages,
      tools,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          yield {
            type: 'tool_use_delta',
            toolCall: { input: event.delta.partial_json as unknown as Record<string, unknown> },
          };
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          yield {
            type: 'tool_use_start',
            toolCall: {
              id: event.content_block.id,
              name: event.content_block.name,
            },
          };
        }
      } else if (event.type === 'message_stop') {
        const finalMessage = await stream.finalMessage();
        yield {
          type: 'message_complete',
          response: this.mapResponse(finalMessage),
        };
      }
    }
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  private mapMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }

      const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
        switch (block.type) {
          case 'text':
            return { type: 'text' as const, text: block.text };
          case 'image':
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: block.source.data,
              },
            };
          case 'tool_use':
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          case 'tool_result':
            return {
              type: 'tool_result' as const,
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            };
        }
      });

      return { role: msg.role, content: blocks };
    });
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  private mapResponse(response: Anthropic.Message): LLMResponse {
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason as LLMResponse['stopReason'],
    };
  }
}
