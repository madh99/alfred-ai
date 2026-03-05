import { GoogleGenAI } from '@google/genai';
import type {
  Content,
  FunctionDeclaration,
  Part,
  GenerateContentResponse,
} from '@google/genai';
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

/**
 * Native Google Gemini provider using the @google/genai SDK.
 *
 * Previous versions routed through the OpenAI-compatible endpoint, but
 * Gemini 3/3.1 Pro models break tool calling there due to the
 * thought_signature requirement.  The native SDK handles this correctly
 * because we cache and replay the raw model Content (including thought
 * parts and signatures) on subsequent turns.
 */
export class GoogleProvider extends LLMProvider {
  private client!: GoogleGenAI;

  /**
   * Cache of raw model Content for responses that contain function calls.
   * Gemini 3+ requires thought_signature to be preserved in multi-turn
   * function calling; our internal LLMMessage format doesn't carry these.
   * We cache the raw Content keyed by a fingerprint of the tool call IDs
   * and replay it verbatim when building the next request.
   */
  private rawContentCache = new Map<string, Content>();

  constructor(config: LLMProviderConfig) {
    super(config);
  }

  async initialize(): Promise<void> {
    this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
    const cw = lookupContextWindow(this.config.model);
    if (cw) this.contextWindow = cw;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const contents = this.mapContents(request.messages);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const response = await this.client.models.generateContent({
      model: this.config.model,
      contents,
      config: {
        systemInstruction: request.system,
        ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
        temperature: request.temperature ?? this.config.temperature,
        maxOutputTokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      },
    });

    this.cacheRawContent(response);
    return this.mapResponse(response);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const contents = this.mapContents(request.messages);
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const stream = await this.client.models.generateContentStream({
      model: this.config.model,
      contents,
      config: {
        systemInstruction: request.system,
        ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
        temperature: request.temperature ?? this.config.temperature,
        maxOutputTokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      },
    });

    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let lastChunkResponse: GenerateContentResponse | undefined;

    for await (const chunk of stream) {
      lastChunkResponse = chunk;
      const text = chunk.text;
      if (text) {
        fullContent += text;
        yield { type: 'text_delta', text };
      }

      if (chunk.functionCalls) {
        for (const fc of chunk.functionCalls) {
          const tc: ToolCall = {
            id: fc.id ?? `google_tool_${toolCalls.length}`,
            name: fc.name!,
            input: (fc.args ?? {}) as Record<string, unknown>,
          };
          toolCalls.push(tc);
          yield {
            type: 'tool_use_start',
            toolCall: { id: tc.id, name: tc.name },
          };
        }
      }

      if (chunk.usageMetadata) {
        promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        completionTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }

    // Cache the raw Content for thought signature preservation
    if (lastChunkResponse) {
      this.cacheRawContent(lastChunkResponse);
    }

    yield {
      type: 'message_complete',
      response: {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: { inputTokens: promptTokens, outputTokens: completionTokens },
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      },
    };
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  supportsEmbeddings(): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Raw content cache for thought_signature preservation
  // ---------------------------------------------------------------------------

  /**
   * Cache the raw model Content from a response that contains function calls.
   * This preserves thought parts + signatures that Gemini 3+ requires.
   */
  private cacheRawContent(response: GenerateContentResponse): void {
    const content = response.candidates?.[0]?.content;
    if (!content?.parts) return;

    // Only cache if the response contains function calls
    const fcParts = content.parts.filter((p: Part) => p.functionCall);
    if (fcParts.length === 0) return;

    const key = this.buildCacheKey(fcParts);
    this.rawContentCache.set(key, content);

    // Prevent unbounded cache growth — keep only the last 20 entries
    if (this.rawContentCache.size > 20) {
      const firstKey = this.rawContentCache.keys().next().value;
      if (firstKey) this.rawContentCache.delete(firstKey);
    }
  }

  /** Build a cache key from function call parts (sorted IDs/names). */
  private buildCacheKey(fcParts: Part[]): string {
    return fcParts
      .map((p: Part) => `${p.functionCall!.id ?? ''}:${p.functionCall!.name}`)
      .sort()
      .join('|');
  }

  /** Build a cache key from tool_use content blocks. */
  private buildCacheKeyFromBlocks(blocks: Array<{ id: string; name: string }>): string {
    return blocks
      .map((b) => `${b.id}:${b.name}`)
      .sort()
      .join('|');
  }

  // ---------------------------------------------------------------------------
  // Message mapping
  // ---------------------------------------------------------------------------

  private mapContents(messages: LLMMessage[]): Content[] {
    // Build a lookup of tool_call_id → function_name from assistant messages
    // so we can set the correct `name` on FunctionResponse parts.
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolCallIdToName.set(block.id, block.name);
        }
      }
    }

    const contents: Content[] = [];

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      // Content blocks — split into model parts and tool-result (user) parts
      const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      const modelParts: Part[] = [];
      const toolResultParts: Part[] = [];

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            modelParts.push({ text: block.text });
            break;
          case 'image':
            modelParts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            });
            break;
          case 'tool_use':
            toolUseBlocks.push({ id: block.id, name: block.name, input: block.input });
            break;
          case 'tool_result': {
            const name = toolCallIdToName.get(block.tool_use_id) ?? block.tool_use_id;
            let responseObj: Record<string, unknown>;
            try {
              const parsed = JSON.parse(block.content);
              responseObj = typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed };
            } catch {
              responseObj = { result: block.content };
            }
            toolResultParts.push({
              functionResponse: {
                id: block.tool_use_id,
                name,
                response: responseObj,
              },
            });
            break;
          }
        }
      }

      // For assistant messages with tool_use: try to use cached raw Content
      // (preserves thought_signature).  Fall back to reconstructed parts.
      if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
        const cacheKey = this.buildCacheKeyFromBlocks(toolUseBlocks);
        const cached = this.rawContentCache.get(cacheKey);
        if (cached) {
          contents.push(cached);
        } else {
          // No cache hit — reconstruct (with sentinel thoughtSignature for Gemini 3+)
          const parts: Part[] = [...modelParts];
          for (let i = 0; i < toolUseBlocks.length; i++) {
            const tb = toolUseBlocks[i];
            parts.push({
              functionCall: { id: tb.id, name: tb.name, args: tb.input },
              // Sentinel value accepted by Gemini API for externally injected calls
              ...(i === 0 ? { thoughtSignature: 'skip_thought_signature_validator' } : {}),
            });
          }
          contents.push({ role: 'model', parts });
        }
      } else if (modelParts.length > 0) {
        contents.push({ role, parts: modelParts });
      }

      // Tool results go as 'user' role
      if (toolResultParts.length > 0) {
        contents.push({ role: 'user', parts: toolResultParts });
      }
    }

    // Gemini requires strict turn ordering:
    // 1. No orphaned functionResponse without a preceding functionCall
    // 2. No consecutive same-role turns
    // 3. functionCall turns must follow user or functionResponse turns
    return this.sanitizeContents(contents);
  }

  /**
   * Sanitize Content array for Gemini's strict turn-ordering requirements.
   * - Removes orphaned functionResponse parts (no matching prior functionCall)
   * - Merges consecutive same-role turns
   * - Removes empty entries after filtering
   */
  private sanitizeContents(contents: Content[]): Content[] {
    // Pass 1: Track which function call IDs have been emitted by model turns.
    // Remove functionResponse parts that reference unknown/orphaned call IDs.
    const emittedCallIds = new Set<string>();
    const cleaned: Content[] = [];

    for (const entry of contents) {
      if (entry.role === 'model') {
        // Collect all functionCall IDs from this model turn
        for (const part of entry.parts ?? []) {
          if (part.functionCall) {
            const id = part.functionCall.id ?? part.functionCall.name ?? '';
            if (id) emittedCallIds.add(id);
          }
        }
        cleaned.push(entry);
      } else {
        // User turn — filter out orphaned functionResponse parts
        const parts = (entry.parts ?? []).filter((part: Part) => {
          if (part.functionResponse) {
            const id = part.functionResponse.id ?? part.functionResponse.name ?? '';
            return id ? emittedCallIds.has(id) : false;
          }
          return true; // keep text, inlineData, etc.
        });
        if (parts.length > 0) {
          cleaned.push({ role: entry.role, parts });
        }
        // If all parts were orphaned functionResponses, skip the entire entry
      }
    }

    // Pass 2: Merge consecutive same-role turns
    if (cleaned.length <= 1) return cleaned;
    const merged: Content[] = [cleaned[0]];
    for (let i = 1; i < cleaned.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = cleaned[i];
      if (prev.role === cur.role) {
        prev.parts = [...(prev.parts ?? []), ...(cur.parts ?? [])];
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Tool mapping
  // ---------------------------------------------------------------------------

  private mapTools(tools: ToolDefinition[]): FunctionDeclaration[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as FunctionDeclaration['parameters'],
    }));
  }

  // ---------------------------------------------------------------------------
  // Response mapping
  // ---------------------------------------------------------------------------

  private mapResponse(response: GenerateContentResponse): LLMResponse {
    const text = response.text ?? '';
    const fcs = response.functionCalls;
    const toolCalls: ToolCall[] | undefined = fcs?.map((fc, i) => ({
      id: fc.id ?? `google_tool_${i}`,
      name: fc.name!,
      input: (fc.args ?? {}) as Record<string, unknown>,
    }));

    return {
      content: text,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      stopReason: toolCalls && toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }
}
