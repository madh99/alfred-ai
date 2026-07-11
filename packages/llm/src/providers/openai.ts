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
      // v919 — Wurzel-Fix: Das openai-SDK ist auf v6 aktualisiert (nutzt natives
      // `fetch`/undici, KEIN node-fetch v2 mehr → behebt „Premature close" für openai
      // UND mistral an der Wurzel). Der explizite `fetch: globalThis.fetch` bleibt als
      // Gürtel-und-Hosenträger (erzwingt nativen fetch unabhängig vom SDK-Default).
      fetch: globalThis.fetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'],
    });
    const cw = lookupContextWindow(this.config.model);
    if (cw) this.contextWindow = cw;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // v1099 — Reasoning-Modelle sprechen die Responses-API: reasoning_effort
    // funktioniert dort ZUSAMMEN mit Function-Tools (chat/completions verbietet
    // die Kombination — der Haupt-Loop lief bisher ohne Reasoning), Effort
    // „max" (GPT-5.6) wird möglich und Reasoning lebt per previousResponseId
    // über Tool-Runden weiter. Fällt bei Endpoint-Problemen auf chat zurück.
    if (this.useResponsesApi()) {
      try {
        return await withPrematureCloseRetry(() => this.completeViaResponses(request));
      } catch (err) {
        if (!this.shouldFallbackToChat(err)) throw err;
        console.warn(`[OpenAIProvider] Responses-API-Fallback auf chat/completions: ${(err as Error).message?.slice(0, 160)}`);
      }
    }
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
    // v1099 — Reasoning-Modelle streamen über die Responses-API (siehe complete()).
    if (this.useResponsesApi()) {
      let fellBack = false;
      try {
        yield* this.streamViaResponses(request);
      } catch (err) {
        if (!this.shouldFallbackToChat(err)) throw err;
        console.warn(`[OpenAIProvider] Responses-Stream-Fallback auf chat/completions: ${(err as Error).message?.slice(0, 160)}`);
        fellBack = true;
      }
      if (!fellBack) return;
    }
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

  // ── v1099 — Responses-API-Pfad (Reasoning + Tools zusammen) ─────────────

  /** Reasoning-Modelle nehmen die Responses-API; responsesApi:false in der Provider-Config schaltet zurück. */
  private useResponsesApi(): boolean {
    return this.isReasoningModel() && (this.config as { responsesApi?: boolean }).responsesApi !== false;
  }

  /** Nur bei Endpoint-/Parameter-Problemen zurückfallen — echte Fehler (Rate-Limit, Auth) gehören dem Aufrufer. */
  private shouldFallbackToChat(err: unknown): boolean {
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    return status === 404 || (status === 400 && /not supported|unknown parameter|unsupported|invalid model/i.test(msg));
  }

  /** LLMMessages (Anthropic-Blockstil) → Responses-input-Items. */
  private mapResponsesInput(messages: LLMMessage[]): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        items.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (msg.role === 'assistant') {
        const text = msg.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n');
        if (text.trim()) items.push({ role: 'assistant', content: text });
        for (const b of msg.content) {
          if (b.type === 'tool_use') {
            items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
          }
        }
        continue;
      }
      const content: Array<Record<string, unknown>> = [];
      for (const b of msg.content) {
        if (b.type === 'text') content.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image') content.push({ type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` });
        else if (b.type === 'tool_result') {
          // Tool-Ergebnisse sind Top-Level-Items (nicht Message-Content)
          items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `FEHLER: ${b.content}` : b.content });
        }
      }
      if (content.length > 0) items.push({ role: 'user', content });
    }
    return items;
  }

  /** ToolDefinitions → Responses-Tools (FLACHES Format, nicht unter "function" verschachtelt wie bei chat). */
  private mapResponsesTools(tools: NonNullable<LLMRequest['tools']>): Array<Record<string, unknown>> {
    return tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
  }

  private buildResponsesParams(request: LLMRequest): Record<string, unknown> {
    // Etappe 2 — Kontinuität: kennt der Server die Vorrunde (previousResponseId),
    // schicken wir NUR die neuen Tool-Ergebnisse der letzten Message; Reasoning-
    // Items und Historie leben serverseitig weiter (store ist API-Default true).
    let input: Array<Record<string, unknown>>;
    if (request.previousResponseId) {
      const last = request.messages[request.messages.length - 1];
      input = last ? this.mapResponsesInput([last]).filter(i => i.type === 'function_call_output') : [];
      if (input.length === 0) input = this.mapResponsesInput(request.messages); // Kontrakt verletzt → voll senden
    } else {
      input = this.mapResponsesInput(request.messages);
    }
    const effort = request.reasoningEffort; // Responses akzeptiert none…xhigh und (5.6) max
    return {
      model: this.config.model,
      input,
      ...(request.system ? { instructions: request.system } : {}),
      max_output_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      ...(request.tools && request.tools.length > 0 ? { tools: this.mapResponsesTools(request.tools) } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(request.previousResponseId && input.some(i => i.type === 'function_call_output')
        ? { previous_response_id: request.previousResponseId } : {}),
      // temperature bewusst weggelassen — Reasoning-Modelle lehnen sie ab
    };
  }

  private mapResponsesResponse(r: {
    id?: string; status?: string;
    incomplete_details?: { reason?: string } | null;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  }): LLMResponse {
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const item of r.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) content += c.text;
      } else if (item.type === 'function_call' && item.call_id && item.name) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(item.arguments || '{}'); } catch { /* leere Args */ }
        toolCalls.push({ id: item.call_id, name: item.name, input });
      }
    }
    return {
      content,
      model: this.config.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
        cacheReadTokens: r.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: toolCalls.length > 0 ? 'tool_use'
        : (r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'),
      ...(r.id ? { responseId: r.id } : {}),
    };
  }

  private async completeViaResponses(request: LLMRequest): Promise<LLMResponse> {
    const params = this.buildResponsesParams(request);
    const response = await (this.client.responses.create(params as never) as Promise<unknown>);
    return this.mapResponsesResponse(response as Parameters<OpenAIProvider['mapResponsesResponse']>[0]);
  }

  private async *streamViaResponses(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const params = { ...this.buildResponsesParams(request), stream: true };
    const stream = await (this.client.responses.create(params as never) as unknown as Promise<AsyncIterable<Record<string, unknown>>>);
    for await (const ev of stream) {
      const type = ev.type as string;
      if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
        yield { type: 'text_delta', text: ev.delta };
      } else if (type === 'response.output_item.added') {
        const item = ev.item as { type?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === 'function_call' && item.call_id && item.name) {
          yield { type: 'tool_use_start', toolCall: { id: item.call_id, name: item.name } };
        }
      } else if (type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
        yield { type: 'tool_use_delta', toolCall: { input: ev.delta as unknown as Record<string, unknown> } };
      } else if (type === 'response.completed') {
        yield { type: 'message_complete', response: this.mapResponsesResponse(ev.response as Parameters<OpenAIProvider['mapResponsesResponse']>[0]) };
      } else if (type === 'response.failed' || type === 'error') {
        const msg = (ev.response as { error?: { message?: string } } | undefined)?.error?.message
          ?? (ev as { message?: string }).message ?? 'Responses-Stream fehlgeschlagen';
        throw new Error(msg);
      }
    }
  }

  /**
   * Detect OpenAI reasoning models that use different API parameters.
   * Matches o1*, o3*, o4*, gpt-5, gpt-5.0, gpt-5.1, gpt-5.5, gpt-5.6 — but NOT gpt-5.2/5.3/5.4
   * v1097: gpt-5.6 (Luna/Terra/Sol) live verprobt 11.07. — temperature wird abgelehnt,
   * reasoning_effort none…xhigh ok (das neue Effort 'max' gibt es NUR in der Responses-API),
   * Tools+reasoning_effort in chat/completions weiterhin unvereinbar (wie gpt-5.5).
   * (gpt-5.2 restored support for temperature and is a "chat" model;
   *  gpt-5.5 is a frontier reasoning model with reasoning_effort).
   */
  private isReasoningModel(): boolean {
    return /^(o[1-9]|gpt-5($|[.-][0156]))/.test(this.config.model);
  }

  /**
   * Returns the reasoning_effort value to send to the OpenAI API.
   * Only reasoning models (gpt-5.5, o-series) accept this parameter — for chat models
   * we omit it entirely, otherwise the API rejects the call.
   */
  protected reasoningEffortParam(requested?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): string | undefined {
    if (!requested) return undefined;
    if (!this.isReasoningModel()) return undefined;
    // v1099 — 'max' existiert nur in der Responses-API; chat/completions lehnt
    // es ab (live verprobt 11.07.) → beste verfügbare Stufe senden
    return requested === 'max' ? 'xhigh' : requested;
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
    // v919 — openai-SDK v6: `tool_calls` ist eine Union (function|custom);
    // `.function` existiert nur beim function-Typ → per `tc.type` narrowen.
    const toolCalls: ToolCall[] | undefined = message?.tool_calls
      ?.map((tc): ToolCall | undefined => {
        if (tc.type !== 'function') return undefined;
        return {
          id: tc.id,
          name: tc.function.name,
          input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        };
      })
      .filter((x): x is ToolCall => x !== undefined);

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
