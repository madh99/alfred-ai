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
import { DiagnoseKette, anthropicDiagnose, istDiagnoseAblehnung } from '../cache-diagnose.js';
import { LLMProvider, lookupContextWindow, withPrematureCloseRetry } from '../provider.js';

/**
 * v1355 — Verlauf im Cache (Punkt 8, Owner-Freigabe 11.10.): bisher trugen nur System und Werkzeuge eine Cache-Marke
 * (0.10.52). In Werkzeug-Schleifen ging der wachsende Verlauf jede Runde ungecacht hinaus (Realfall delegate 11.10.
 * 13:26: Cache konstant 89 182 Tokens, ungecacht 908 → 146 038 über 18 Runden). Jetzt bekommt der letzte Block der
 * letzten Nachricht eine Marke — aber nur, wenn sie Werkzeugergebnisse enthält, also eine weitere Runde zu erwarten ist:
 * Cache-Schreiben kostet 25 % Aufschlag und lohnt sich bei Einzelanfragen nicht. Höchstens 3 Marken (System, Werkzeuge,
 * Verlauf) — Anthropic erlaubt 4. Die nächste Runde findet das Präfix über die Rückschau der Marke wieder.
 */
export function markiereVerlaufFuerCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const letzte = messages[messages.length - 1];
  if (!letzte || letzte.role !== 'user' || typeof letzte.content === 'string' || letzte.content.length === 0) return messages;
  if (!letzte.content.some(b => b.type === 'tool_result')) return messages;
  const bloecke = [...letzte.content];
  const i = bloecke.length - 1;
  bloecke[i] = { ...bloecke[i], cache_control: { type: 'ephemeral' as const } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...letzte, content: bloecke }];
}

export class AnthropicProvider extends LLMProvider {
  private client!: Anthropic;

  constructor(config: LLMProviderConfig) {
    super(config);
  }

  async initialize(): Promise<void> {
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      maxRetries: 5,        // Default 2 reicht bei Overload (529) oft nicht
    });
    const cw = lookupContextWindow(this.config.model);
    if (cw) this.contextWindow = cw;
  }

  /**
   * v608 F2 — Some Anthropic models reject `temperature` ("`temperature` is deprecated
   * for this model"). Filter it out for those models instead of bubbling a 400 error
   * up to the caller. Applies to Opus 4.7 + 4.8 (and assumed-forward for newer Opus
   * generations that ship adaptive thinking without sampling parameters).
   * v860 — Fable 5 / Mythos 5 erben die Constraint (Migration-Guide: "sampling
   * parameters rejected" gilt unverändert weiter).
   * v920 — Sonnet 5 (und weitere Gen-5-Chat-Modelle) lehnen `temperature` ebenfalls ab
   * (live bewiesen: HTTP 400 "`temperature` is deprecated for this model"). Das \b nach
   * der 5 verhindert Fehltreffer bei "3-5-sonnet"/"3-5-haiku" (Claude 3.5, die temperature
   * unterstützen).
   */
  private supportsTemperature(): boolean {
    const model = (this.config.model ?? '').toLowerCase();
    if (/opus-4-(7|8|9)/.test(model)) return false;
    if (/(fable|mythos|sonnet|opus|haiku)-5\b/.test(model)) return false;
    return true;
  }

  /**
   * v860 — Claude Fable 5 hat Safety-Classifier die Requests ablehnen können.
   * Der server-seitige `fallbacks`-Param (beta, Claude API) retried refused
   * Requests automatisch auf dem angegebenen Modell. Die Response kommt dann
   * mit dem TATSÄCHLICH genutzten Modell zurück → Cost-Tracking (hängt am
   * response.model) stimmt automatisch; Fallback-Credit (Cache-Kosten-
   * Erstattung) verrechnet Anthropic serverseitig.
   * Nur für fable-5 gesetzt — mythos-5 hat keine Classifier.
   */
  private fallbacksParam(): Record<string, unknown> {
    const model = (this.config.model ?? '').toLowerCase();
    if (/^claude-fable-5/.test(model)) {
      return { fallbacks: ['claude-opus-4-8'] };
    }
    return {};
  }

  /**
   * v981 — Adaptive-Thinking-Steuerung für Gen-5-/Opus-4.8-Modelle:
   * reasoningEffort 'none'/'low' schaltet das Thinking ab. Live-Realfall
   * 04.07.: Sonnet 5 verbrannte beim Studio-Prompt ALLE 12000 maxTokens im
   * Thinking-Block (stop_reason max_tokens, null Text) — vier Runden lang.
   * Serienproduktion (JSON-Batches) braucht keine Deliberation; mit
   * thinking:disabled kam dieselbe Anfrage mit 3227 Tokens sauber zurück.
   * 'medium'/'high'/unset lassen das adaptive Verhalten unangetastet.
   */
  private thinkingParam(request: LLMRequest): Record<string, unknown> {
    if (this.supportsTemperature()) return {}; // ältere Modelle: kein Thinking-Param
    const effort = request.reasoningEffort;
    if (effort !== 'none' && effort !== 'low') return {};
    // v1156 — Fable/Mythos 5.x: Thinking ist IMMER an, `thinking:{type:'disabled'}`
    // wird mit 400 abgelehnt (Anthropic Models-Overview/Migration-Guide, 16.09.2026;
    // Live-Probe war wegen leerem Guthaben nicht möglich). Die Tiefe wird dort
    // ausschließlich über output_config.effort gesteuert — 'low' ist das Äquivalent
    // zum bisherigen Abschalten für Serienproduktion.
    if (this.thinkingImmerAn() || this.thinkingAusModus === 'effort') return { output_config: { effort: 'low' } };
    if (this.thinkingZwischenTools() || this.thinkingAusModus === 'between_tools') return { thinking: { type: 'between_tools' } };
    return { thinking: { type: 'disabled' } };
  }

  /**
   * v1208 — Sonnet 5.5 (live 06.10.2026, HTTP 400): „To turn thinking off on this model, send
   * thinking: {type: between_tools} instead of {type: disabled}. The model does not think before
   * responding. The short updates it writes between tool calls come back as thinking blocks."
   * Drei Vollpässe der Reasoning-Engine (fast-Tier) scheiterten daran in Serie.
   */
  private thinkingZwischenTools(): boolean {
    return /^claude-sonnet-5-5/.test((this.config.model ?? '').toLowerCase());
  }

  /**
   * v1208 — Selbstheilung, modellunabhängig: lehnt die API die gewählte Abschalt-Form mit 400 ab,
   * wird aus der Fehlermeldung die verlangte Form gelernt (between_tools bzw. output_config.effort)
   * und der Aufruf einmal wiederholt. Künftige Modelle, die die Konvention erneut ändern, laufen
   * damit ohne Code-Änderung weiter.
   */
  private thinkingAusModus?: 'between_tools' | 'effort';
  private lerneThinkingAusFehler(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    const text = String((err as { message?: string })?.message ?? err ?? '');
    if (status !== 400 || !/thinking/i.test(text)) return false;
    let neu: 'between_tools' | 'effort' | undefined;
    if (/between_tools/.test(text)) neu = 'between_tools';
    else if (/output_config|effort|cannot be (turned off|disabled)|always on/i.test(text)) neu = 'effort';
    if (!neu || neu === this.thinkingAusModus) return false;
    this.thinkingAusModus = neu;
    console.warn('[anthropic] v1208 Thinking-Abschaltung gelernt: ' + neu + ' (' + this.config.model + ')');
    return true;
  }

  /**
   * Fable 5 / 5.1 und Mythos 5 / 5.1: adaptives Thinking lässt sich nicht abschalten.
   * v1204 — Opus 5.5 ebenso („Adaptive (always on)", Models-Overview 06.10.2026); Sonnet 5.5
   * ist „Adaptive" wie Sonnet 5 und behält thinking:disabled für Serienproduktion.
   */
  private thinkingImmerAn(): boolean {
    const model = (this.config.model ?? '').toLowerCase();
    return /^claude-(fable|mythos)-5/.test(model) || /^claude-opus-5-5/.test(model);
  }

  /** v1693 (K2) — letzte Antwort-ID je Gespräch für die Cache-Diagnose */
  private readonly diagnose = new DiagnoseKette();
  private diagnoseParam(request: LLMRequest): { diagnostics: { previous_message_id: string | null } } | Record<string, never> {
    return this.diagnose.aktiv(request.cacheDiagnose) ? { diagnostics: { previous_message_id: this.diagnose.vorher(request.cacheDiagnose) } } : {};
  }
  /** Lehnt die API den Parameter ab, ohne ihn wiederholen und für diese Instanz abschalten */
  private diagnoseAbgelehnt(err: unknown): boolean {
    if (this.diagnose.aus || !istDiagnoseAblehnung(err, 'diagnostics')) return false;
    this.diagnose.aus = true;
    console.warn('[anthropic] v1693 Cache-Diagnose abgelehnt — für ' + this.config.model + ' abgeschaltet');
    return true;
  }
  private mitDiagnose(r: LLMResponse, request: LLMRequest, roh: unknown, gesendet: boolean): LLMResponse {
    if (!gesendet) return r;
    const mitVorher = this.diagnose.vorher(request.cacheDiagnose!) !== null;
    this.diagnose.merke(request.cacheDiagnose, (roh as { id?: string })?.id);
    return { ...r, cacheDiagnose: anthropicDiagnose((roh as { diagnostics?: unknown })?.diagnostics, mitVorher) };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    try {
      return await this.completeEinmal(request);
    } catch (err) {
      if (this.diagnoseAbgelehnt(err)) return await this.completeEinmal(request);
      if (!this.lerneThinkingAusFehler(err)) throw err;
      return await this.completeEinmal(request); // v1208 — einmal mit gelernter Abschalt-Form
    }
  }

  private async completeEinmal(request: LLMRequest): Promise<LLMResponse> {
    const messages = markiereVerlaufFuerCache(this.mapMessages(request.messages)); // v1355
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const params: Anthropic.MessageCreateParams = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      ...(this.supportsTemperature()
        ? { temperature: request.temperature ?? this.config.temperature }
        : {}),
      ...this.thinkingParam(request),
      // v860 — server-side refusal-fallback für Fable 5 (beta-Param; SDK-Typen
      // kennen das Feld noch nicht → kommt über den unknown-cast unten mit).
      ...this.fallbacksParam(),
      ...this.diagnoseParam(request), // v1693 (K2) — nur Messung
      system: request.system ? [
        {
          type: 'text' as const,
          text: request.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ] : undefined,
      messages,
      tools,
    };

    // v916 — Retry bei transientem node-fetch „Premature close" (gzip-Stream-Abbruch).
    const gesendet = 'diagnostics' in params;
    const response = await withPrematureCloseRetry(() => this.client.messages.create(params));

    return this.mitDiagnose(this.mapResponse(response), request, response, gesendet);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // v1208 — scheitert der Stream vor dem ersten Ereignis an der Thinking-Abschaltung,
    // wird die verlangte Form gelernt und der Stream einmal neu gestartet.
    let geliefert = false;
    try {
      for await (const ev of this.streamEinmal(request)) { geliefert = true; yield ev; }
    } catch (err) {
      if (!geliefert && this.diagnoseAbgelehnt(err)) { yield* this.streamEinmal(request); return; }
      if (geliefert || !this.lerneThinkingAusFehler(err)) throw err;
      yield* this.streamEinmal(request);
    }
  }

  private async *streamEinmal(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const messages = markiereVerlaufFuerCache(this.mapMessages(request.messages)); // v1355
    const tools = request.tools ? this.mapTools(request.tools) : undefined;

    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
      ...(this.supportsTemperature()
        ? { temperature: request.temperature ?? this.config.temperature }
        : {}),
      ...this.thinkingParam(request),
      // v860 — server-side refusal-fallback für Fable 5 (beta).
      ...this.fallbacksParam(),
      ...this.diagnoseParam(request), // v1693 (K2) — nur Messung
      system: request.system ? [
        {
          type: 'text' as const,
          text: request.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ] : undefined,
      messages,
      tools,
    });

    const gesendet = this.diagnose.aktiv(request.cacheDiagnose);
    let startNachricht: unknown; // v1693 — diagnostics kommt im message_start-Event
    for await (const event of stream) {
      if (event.type === 'message_start') startNachricht = (event as { message?: unknown }).message;
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
        const roh = { id: finalMessage.id, diagnostics: (startNachricht as { diagnostics?: unknown } | undefined)?.diagnostics ?? (finalMessage as unknown as { diagnostics?: unknown }).diagnostics };
        yield {
          type: 'message_complete',
          response: this.mitDiagnose(this.mapResponse(finalMessage), request, roh, gesendet),
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

      const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block): Anthropic.ContentBlockParam => {
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
          default:
            return { type: 'text' as const, text: '[Unsupported block type]' };
        }
      }).filter((block): block is Anthropic.ContentBlockParam => block !== undefined);

      return { role: msg.role, content: blocks };
    });
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    const mapped = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
    // Cache all tool definitions — Anthropic caches everything up to the last breakpoint
    if (mapped.length > 0) {
      (mapped[mapped.length - 1] as any).cache_control = { type: 'ephemeral' };
    }
    return mapped;
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

    // v860 — Refusal-Handling (Claude Fable 5 Safety-Classifier).
    // Refusals kommen als HTTP-200 mit stop_reason:"refusal" und (meist) leerem
    // Content. Ohne diese Behandlung würde der leere Content downstream als
    // "(no response)" enden (gleiche Bug-Klasse wie der gpt-5.5-Reasoning-Bug).
    // Greift nur wenn der server-side fallbacks-Param nicht half (z.B. auch
    // der Fallback refused, oder fallbacks nicht verfügbar).
    // Cast: SDK 0.39-Typen kennen 'refusal' noch nicht (neuere API-Semantik).
    if ((response.stop_reason as string) === 'refusal' && !textContent) {
      const category = (response as unknown as { stop_details?: { category?: string | null } }).stop_details?.category;
      textContent = `Die Anfrage wurde vom Safety-Classifier des Modells abgelehnt` +
        `${category ? ` (Kategorie: ${category})` : ''}. ` +
        `Bitte formuliere die Anfrage um oder nutze ein anderes Modell (z.B. claude-opus-4-8).`;
    }

    return {
      content: textContent,
      model: response.model ?? this.config.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
      },
      stopReason: response.stop_reason as LLMResponse['stopReason'],
    };
  }
}
