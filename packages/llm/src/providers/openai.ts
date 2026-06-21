import OpenAI from 'openai';
import type {
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  ToolCall,
  ToolDefinition,
} from '@alfred/types';
import { LLMProvider, lookupContextWindow, withPrematureCloseRetry } from '../provider.js';

export class OpenAIProvider extends LLMProvider {
  private client!: OpenAI;

  constructor(config: LLMProviderConfig) {
    super(config);
  }

  async initialize(): Promise<void> {
    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      maxRetries: 5,
      // v918 — Wurzel-Fix: Das openai-SDK v4 nutzt intern `node-fetch@2.7.0`, dessen
      // gzip-Handling `ERR_STREAM_PREMATURE_CLOSE` wirft (siehe v916/v917). Nodes
      // natives `fetch` (undici, ab Node 18) umgeht node-fetch komplett → behebt die
      // „Premature close"-Fehler für openai UND mistral (MistralProvider erbt hiervon)
      // an der Wurzel, ohne riskanten Major-SDK-Upgrade.
      fetch: globalThis.fetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'],
    });
    const cw = lookupContextWindow(this.config.model);
    if (cw) this.contextWindow = cw;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.mapMessages(request.messages, request.system);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;
    // gpt-5.5 limitation: chat/completions does NOT accept reasoning_effort + tools
    // simultaneously — would need /v1/responses endpoint. When tools are present we
    // drop the effort parameter and let the API use its default (medium).
    const reasoningEffort = tools ? undefined : this.reasoningEffortParam(request.reasoningEffort);

    // SDK v4.104 only types 'low'|'medium'|'high'; 'none'/'xhigh' (gpt-5.5) are accepted
    // by the API but not yet in the SDK's enum — cast to bypass narrow typing.
    const params = {
      model: this.config.model,
      ...this.tokenLimitParam(request.maxTokens),
      temperature: this.safeTemperature(request.temperature),
      messages,
      ...(tools ? { tools } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...this.extraRequestParams(request),
    } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming;

    // v916 — Retry bei transientem node-fetch „Premature close" (gzip-Stream-Abbruch).
    const response = await withPrematureCloseRetry(() => this.client.chat.completions.create(params));

    return this.mapResponse(response);
  }

  /**
   * Hook for subclasses to inject provider-specific extra params into chat completion
   * requests (e.g. Mistral's `prompt_cache_key`). The OpenAI SDK passes unknown fields
   * through in the request body. Default: no extras.
   */
  protected extraRequestParams(_request: LLMRequest): Record<string, unknown> {
    return {};
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const messages = this.mapMessages(request.messages, request.system);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;
    // Same gpt-5.5 chat/completions tool+effort incompatibility — see complete().
    const reasoningEffort = tools ? undefined : this.reasoningEffortParam(request.reasoningEffort);

    const params = {
      model: this.config.model,
      ...this.tokenLimitParam(request.maxTokens),
      temperature: this.safeTemperature(request.temperature),
      messages,
      ...(tools ? { tools } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...this.extraRequestParams(request),
      stream: true,
    } as unknown as OpenAI.ChatCompletionCreateParamsStreaming;

    const stream = await this.client.chat.completions.create(params);

    let currentToolCallId: string | undefined;
    let currentToolCallName: string | undefined;
    let currentToolCallArgs = '';
    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Handle text content
      if (delta?.content) {
        fullContent += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

      // Handle tool calls
      if (delta?.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          if (toolCallDelta.id) {
            // New tool call starting - flush previous if any
            if (currentToolCallId) {
              let parsedArgs: Record<string, unknown>;
              try { parsedArgs = JSON.parse(currentToolCallArgs || '{}'); }
              catch { parsedArgs = {}; }
              toolCalls.push({
                id: currentToolCallId,
                name: currentToolCallName!,
                input: parsedArgs,
              });
            }
            currentToolCallId = toolCallDelta.id;
            currentToolCallName = toolCallDelta.function?.name;
            currentToolCallArgs = toolCallDelta.function?.arguments ?? '';
            yield {
              type: 'tool_use_start',
              toolCall: {
                id: currentToolCallId,
                name: currentToolCallName,
              },
            };
          } else if (toolCallDelta.function?.arguments) {
            // Arguments are accumulated as a string during streaming and parsed at completion
            currentToolCallArgs += toolCallDelta.function.arguments;
            yield {
              type: 'tool_use_delta',
              toolCall: {
                input: toolCallDelta.function.arguments as unknown as Record<string, unknown>,
              },
            };
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      // Capture usage from the final chunk if available
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
      }
    }

    // Flush last tool call if any
    if (currentToolCallId) {
      let parsedArgs: Record<string, unknown>;
      try { parsedArgs = JSON.parse(currentToolCallArgs || '{}'); }
      catch { parsedArgs = {}; }
      toolCalls.push({
        id: currentToolCallId,
        name: currentToolCallName!,
        input: parsedArgs,
      });
    }

    yield {
      type: 'message_complete',
      response: {
        content: fullContent,
        model: this.config.model,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: cachedTokens,
        },
        stopReason: this.mapStopReason(finishReason),
      },
    };
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async embed(text: string): Promise<import('../provider.js').EmbeddingResult | undefined> {
    try {
      const embeddingModel = this.config.model ?? 'text-embedding-3-small';
      // v916 — Retry bei transientem node-fetch „Premature close" (gzip-Stream-Abbruch).
      const response = await withPrematureCloseRetry(() => this.client.embeddings.create({
        model: embeddingModel,
        input: text,
      }));
      const data = response.data[0];
      return {
        embedding: data.embedding,
        model: embeddingModel,
        dimensions: data.embedding.length,
        totalTokens: response.usage?.total_tokens ?? 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OpenAIProvider] embed() failed: ${msg}`);
      return undefined;
    }
  }

  supportsEmbeddings(): boolean {
    return true;
  }

  /**
   * Detect OpenAI reasoning models that use different API parameters.
   * Matches o1*, o3*, o4*, gpt-5, gpt-5.0, gpt-5.1, gpt-5.5 — but NOT gpt-5.2/5.3/5.4
   * (gpt-5.2 restored support for temperature and is a "chat" model;
   *  gpt-5.5 is a frontier reasoning model with reasoning_effort).
   */
  private isReasoningModel(): boolean {
    return /^(o[1-9]|gpt-5($|[.-][015]))/.test(this.config.model);
  }

  /**
   * Returns the reasoning_effort value to send to the OpenAI API.
   * Only reasoning models (gpt-5.5, o-series) accept this parameter — for chat models
   * we omit it entirely, otherwise the API rejects the call.
   */
  protected reasoningEffortParam(requested?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'): string | undefined {
    if (!requested) return undefined;
    if (!this.isReasoningModel()) return undefined;
    return requested;
  }

  /**
   * Newer OpenAI models (gpt-5*, o1*, o3*, o4*) require `max_completion_tokens`
   * instead of `max_tokens`.  Returns the correct parameter for the current model.
   */
  protected tokenLimitParam(requestMax?: number): { max_tokens?: number; max_completion_tokens?: number } {
    const value = requestMax ?? this.config.maxTokens ?? 4096;
    if (/^(gpt-5|o[1-9])/.test(this.config.model)) {
      return { max_completion_tokens: value };
    }
    return { max_tokens: value };
  }

  /**
   * Reasoning models (o1, o3, o4, gpt-5, gpt-5.1) reject temperature,
   * top_p, frequency_penalty, presence_penalty.  Returns undefined for
   * these models so the SDK omits the parameter.
   */
  protected safeTemperature(requested?: number): number | undefined {
    if (this.isReasoningModel()) return undefined;
    return requested ?? this.config.temperature;
  }

  private mapMessages(
    messages: LLMMessage[],
    system?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const mapped: OpenAI.ChatCompletionMessageParam[] = [];

    if (system) {
      mapped.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        mapped.push({ role: msg.role, content: msg.content });
        continue;
      }

      // Content is LLMContentBlock[] - need to split by block type
      const textParts: OpenAI.ChatCompletionContentPart[] = [];
      const toolUseParts: OpenAI.ChatCompletionMessageToolCall[] = [];
      const toolResultParts: { tool_call_id: string; content: string }[] = [];

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            textParts.push({ type: 'text', text: block.text });
            break;
          case 'image':
            textParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
            break;
          case 'tool_use':
            toolUseParts.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
            break;
          case 'tool_result':
            toolResultParts.push({
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
            break;
        }
      }

      // Assistant messages with tool calls
      if (msg.role === 'assistant' && toolUseParts.length > 0) {
        const textContent = textParts.map((p) => (p as { text: string }).text).join('');
        mapped.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolUseParts,
        });
      } else if (toolResultParts.length > 0) {
        // Tool result messages become separate 'tool' role messages
        for (const result of toolResultParts) {
          mapped.push({
            role: 'tool',
            tool_call_id: result.tool_call_id,
            content: result.content,
          });
        }
      } else if (textParts.length > 0) {
        if (msg.role === 'user') {
          mapped.push({ role: 'user', content: textParts });
        } else {
          mapped.push({ role: msg.role, content: textParts.map((p) => (p as { text: string }).text).join('') });
        }
      }
    }

    return mapped;
  }

  private mapTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private mapResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    const content = message?.content ?? '';
    const toolCalls: ToolCall[] | undefined = message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
    }));

    return {
      content,
      model: response.model ?? this.config.model,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: this.mapStopReason(choice?.finish_reason ?? null),
    };
  }

  private mapStopReason(finishReason: string | null): LLMResponse['stopReason'] {
    switch (finishReason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }
}
