import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelTier,
  MultiModelConfig,
} from '@alfred/types';
import { LLMProvider } from './provider.js';
import type { ContextWindow, EmbeddingResult } from './provider.js';
import { createLLMProvider } from './provider-factory.js';
import { TokenCostTracker } from './token-costs.js';
import type { TokenCostSummary, UsagePersistFn } from './token-costs.js';

const TIERS: ModelTier[] = ['default', 'strong', 'fast', 'embeddings', 'local', 'fallback'];

/** v868 — Payload des Billing-Alert-Callbacks (Owner-Benachrichtigung).
 *  v868.3 — kind: 'failure' (Guthaben/Quota-Fehler) | 'recovered' (Entwarnung). */
export interface BillingAlertInfo {
  kind: 'failure' | 'recovered';
  tier: ModelTier;
  provider: string;
  model: string;
  message: string;
}

/** v868.3 — Billing-Cooldown: nach einem Guthaben-Fehler wird der Primary des
 *  Tiers 5 min übersprungen (direkt Fallback-Kette) — ein leeres Guthaben heilt
 *  nicht in Sekunden. Danach automatischer Re-Probe; Erfolg → Entwarnung +
 *  kompletter Reset (auch des Alert-Dedupe-Fensters, damit ein ERNEUTER Ausfall
 *  sofort wieder alarmiert). Bewusst NUR für Billing — 529/Transient bleiben
 *  stateless (SDK-Retries gelingen dort meist, ein Breaker würde Qualität kosten). */
const BILLING_COOLDOWN_MS = 5 * 60_000;

/** v868 — Fallback-Reihenfolge: 'fallback' (Notfall-Provider, z.B. Mistral)
 *  steht bewusst am ENDE — er springt nur ein wenn alle regulären Tiers
 *  ausgefallen sind. 'fallback' wird nie regulär geroutet (resolve() kennt
 *  ihn nicht als Request-Tier-Ziel; er lebt nur in dieser Kette). */
const FALLBACK_ORDER: ModelTier[] = ['default', 'strong', 'fast', 'fallback'];

/**
 * Default reasoning_effort per tier — only applied when the underlying model is a
 * reasoning model (gpt-5.5, o-series). Chat models and non-OpenAI providers ignore it.
 *
 * Rationale: reasoning tokens are billed as output ($30/M for gpt-5.5), so calls that
 * don't need deep thinking should use 'low' to save real money.
 */
const TIER_DEFAULT_EFFORT: Partial<Record<ModelTier, 'none' | 'low' | 'medium' | 'high' | 'xhigh'>> = {
  fast: 'low',
  default: 'medium',
  strong: 'high',
};

/** Minimal logger interface to avoid hard pino dependency. */
interface RouterLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Routes LLM requests to different providers based on the requested tier.
 * Extends LLMProvider so it can be used as a drop-in replacement everywhere.
 */
export class ModelRouter extends LLMProvider {
  private readonly providers = new Map<ModelTier, LLMProvider>();
  private readonly multiConfig: MultiModelConfig;
  private readonly logger?: RouterLogger;
  private readonly costTracker = new TokenCostTracker();

  constructor(config: MultiModelConfig, logger?: RouterLogger) {
    super(config.default);
    this.multiConfig = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    for (const tier of TIERS) {
      const tierConfig = this.multiConfig[tier];
      if (tierConfig) {
        const provider = createLLMProvider(tierConfig);
        await provider.initialize();
        this.providers.set(tier, provider);
        this.logger?.info(
          { tier, provider: tierConfig.provider, model: tierConfig.model },
          'LLM tier initialized',
        );
      }
    }
    if (!this.providers.has('default')) {
      throw new Error(
        'ModelRouter: no "default" tier configured. ' +
        `Available tiers: [${[...this.providers.keys()].join(', ')}]`,
      );
    }
  }

  private resolve(tier?: ModelTier): { provider: LLMProvider; resolvedTier: ModelTier } {
    // v868 — 'fallback' ist kein reguläres Routing-Ziel (nur Notfall-Kette)
    if (tier && tier !== 'fallback' && this.providers.has(tier)) {
      return { provider: this.providers.get(tier)!, resolvedTier: tier };
    }
    const defaultProvider = this.providers.get('default');
    if (!defaultProvider) {
      throw new Error(
        'ModelRouter: no "default" tier available. Was initialize() called?',
      );
    }
    return { provider: defaultProvider, resolvedTier: 'default' };
  }

  /** Strip unpaired Unicode surrogates that cause JSON serialization errors in API requests. */
  private sanitizeRequest(request: LLMRequest): LLMRequest {
    const clean = (s: string | undefined): string | undefined => {
      if (!s) return s;
      // Remove lone surrogates (high without low, or low without high)
      // eslint-disable-next-line no-control-regex
      return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
    };
    return {
      ...request,
      system: clean(request.system),
      messages: request.messages.map(m => ({
        ...m,
        content: typeof m.content === 'string' ? (clean(m.content) ?? '') : m.content,
      })),
    };
  }

  /** Apply the tier's default reasoning_effort if the caller didn't set one explicitly. */
  private withTierEffort(request: LLMRequest, tier: ModelTier): LLMRequest {
    if (request.reasoningEffort) return request;
    const tierEffort = TIER_DEFAULT_EFFORT[tier];
    if (!tierEffort) return request;
    return { ...request, reasoningEffort: tierEffort };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const sanitized = this.sanitizeRequest(request);
    const { provider, resolvedTier } = this.resolve(sanitized.tier);
    const tierConfig = this.multiConfig[resolvedTier];
    const withEffort = this.withTierEffort(sanitized, resolvedTier);
    this.logger?.debug(
      { requestedTier: sanitized.tier ?? 'default', resolvedTier, model: tierConfig?.model },
      'LLM routing request',
    );
    // v868.3 — Billing-Cooldown: Primary für 5 min überspringen statt pro Call
    // einen toten 400er zu produzieren. Nach Ablauf automatischer Re-Probe.
    if (this.isInBillingCooldown(resolvedTier)) {
      this.logger?.info({ tier: resolvedTier }, 'v868.3 billing-cooldown aktiv — Primary übersprungen, Fallback-Kette');
      return this.completeWithFallback(withEffort, resolvedTier, new Error(`Tier "${resolvedTier}" im Billing-Cooldown (Guthaben/Quota-Fehler vor < 5 min)`));
    }
    try {
      const response = await this.executeComplete(provider, resolvedTier, withEffort);
      // v868.3 — Re-Probe erfolgreich → Entwarnung + Reset (inkl. Alert-Dedupe)
      this.maybeNotifyRecovery(resolvedTier);
      return response;
    } catch (err) {
      // v868 — Billing-Fehler (Guthaben leer, Quota erschöpft) lösen jetzt
      // ebenfalls den Tier-Fallback aus. Vorher: 400 → sofort throw, der
      // Fallback-Code eine Zeile darunter wurde nie erreicht — beim
      // Anthropic-Guthaben-Vorfall 11.06. fielen dadurch Insight/Reasoning/
      // Summarizer aus, obwohl OpenAI als default-Tier verfügbar war.
      const billing = this.isBillingError(err);
      if (billing) this.registerBillingFailure(resolvedTier, err);
      if (!billing && !this.isRetryableError(err)) throw err;
      this.logger?.warn(
        { err, tier: resolvedTier, billing },
        billing ? 'Provider billing failure (credit/quota), attempting fallback' : 'Provider failed, attempting fallback',
      );
      return this.completeWithFallback(withEffort, resolvedTier, err);
    }
  }

  /** v868 — Guthaben-/Quota-Fehler: nicht retrybar beim selben Provider,
   *  aber ein ANDERER Provider kann übernehmen. */
  private isBillingError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('credit balance is too low') ||
      msg.includes('insufficient_quota') ||
      msg.includes('insufficient credits') ||
      msg.includes('exceeded your current quota') ||
      msg.includes('billing') && msg.includes('error');
  }

  /** v868 — Owner-Alert bei Billing-Fehlern, dedupe 6h pro Tier. */
  private billingAlertCallback?: (info: BillingAlertInfo) => void;
  private lastBillingAlertAt = new Map<ModelTier, number>();
  /** v868.3 — Cooldown pro Tier (Primary überspringen bis Timestamp). */
  private billingCooldownUntil = new Map<ModelTier, number>();
  /** v868.3 — Tiers mit offenem Billing-Vorfall (für die Entwarnung). */
  private pendingRecovery = new Set<ModelTier>();
  setBillingAlertCallback(cb: (info: BillingAlertInfo) => void): void { this.billingAlertCallback = cb; }

  /** v868.3 — zentraler Einstieg für Billing-Fehler: Cooldown setzen + Alert (deduped). */
  private registerBillingFailure(tier: ModelTier, err: unknown): void {
    this.billingCooldownUntil.set(tier, Date.now() + BILLING_COOLDOWN_MS);
    this.pendingRecovery.add(tier);
    this.notifyBillingError(tier, err);
  }

  private isInBillingCooldown(tier: ModelTier): boolean {
    return (this.billingCooldownUntil.get(tier) ?? 0) > Date.now();
  }

  /** v868.3 — erfolgreicher Call auf einem Tier mit offenem Billing-Vorfall:
   *  Entwarnung senden + ALLES zurücksetzen, inkl. Alert-Dedupe-Fenster —
   *  ein erneuter Ausfall nach der Gut-Meldung alarmiert sofort wieder. */
  private maybeNotifyRecovery(tier: ModelTier): void {
    if (!this.pendingRecovery.has(tier)) return;
    this.pendingRecovery.delete(tier);
    this.lastBillingAlertAt.delete(tier);
    this.billingCooldownUntil.delete(tier);
    const cfg = this.multiConfig[tier];
    try {
      this.billingAlertCallback?.({
        kind: 'recovered',
        tier,
        provider: cfg?.provider ?? 'unknown',
        model: cfg?.model ?? 'unknown',
        message: 'Provider antwortet wieder regulär — Fallback nicht mehr aktiv.',
      });
    } catch { /* Alert darf nichts brechen */ }
  }

  private notifyBillingError(tier: ModelTier, err: unknown): void {
    if (!this.billingAlertCallback) return;
    const last = this.lastBillingAlertAt.get(tier) ?? 0;
    if (Date.now() - last < 6 * 3600_000) return;
    this.lastBillingAlertAt.set(tier, Date.now());
    const cfg = this.multiConfig[tier];
    try {
      this.billingAlertCallback({
        kind: 'failure',
        tier,
        provider: cfg?.provider ?? 'unknown',
        model: cfg?.model ?? 'unknown',
        message: (err as Error).message.slice(0, 300),
      });
    } catch { /* Alert darf nichts brechen */ }
  }

  private async executeComplete(provider: LLMProvider, resolvedTier: ModelTier, request: LLMRequest): Promise<LLMResponse> {
    const tierConfig = this.multiConfig[resolvedTier];
    const response = await provider.complete(request);
    const model = response.model ?? tierConfig?.model ?? 'unknown';
    if (!response.model) response.model = model;
    const costUsd = this.costTracker.record(model, response.usage);
    this.logger?.info(
      {
        tier: resolvedTier, model, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
        inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens,
        cacheReadTokens: response.usage?.cacheReadTokens, cacheWriteTokens: response.usage?.cacheCreationTokens,
      },
      'LLM call completed',
    );
    return response;
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      // Network errors, 5xx, rate limits → retryable
      if (msg.includes('econnrefused') || msg.includes('enotfound') ||
          msg.includes('etimedout') || msg.includes('econnreset') ||
          msg.includes('socket hang up') || msg.includes('fetch failed')) return true;
      // HTTP status-based
      if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
          msg.includes('504') || msg.includes('529') || msg.includes('rate limit') ||
          msg.includes('overloaded') || msg.includes('too many requests')) return true;
    }
    // Check for status code on error object
    const status = (err as Record<string, unknown>)?.status ?? (err as Record<string, unknown>)?.statusCode;
    if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
    return false;
  }

  private async completeWithFallback(request: LLMRequest, failedTier: ModelTier, originalErr: unknown): Promise<LLMResponse> {
    // v868 — 'fallback'-Tier (Notfall-Provider) ans Ende der Kette
    const fallbackOrder = FALLBACK_ORDER.filter(t => t !== failedTier);
    for (const tier of fallbackOrder) {
      // v868.3 — Tiers im Billing-Cooldown überspringen (bekannt leer)
      if (this.isInBillingCooldown(tier)) continue;
      const provider = this.providers.get(tier);
      if (!provider) continue;
      try {
        this.logger?.info({ tier }, 'Fallback to tier');
        const response = await this.executeComplete(provider, tier, request);
        this.maybeNotifyRecovery(tier); // v868.3 — Tier hat sich bewiesen
        return response;
      } catch (err) {
        // v868/v868.3 — Billing-Fehler im Fallback-Tier: Cooldown + Alert (deduped)
        if (this.isBillingError(err)) this.registerBillingFailure(tier, err);
        continue;
      }
    }
    throw originalErr;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const { provider, resolvedTier } = this.resolve(request.tier);
    const withEffort = this.withTierEffort(request, resolvedTier);
    // v868.3 — Billing-Cooldown: Primary überspringen, direkt Fallback-Kette
    if (this.isInBillingCooldown(resolvedTier)) {
      this.logger?.info({ tier: resolvedTier }, 'v868.3 billing-cooldown aktiv — Stream direkt über Fallback-Kette');
      yield* this.streamFallback(request, resolvedTier, new Error(`Tier "${resolvedTier}" im Billing-Cooldown`));
      return;
    }
    let hasYielded = false;
    try {
      for await (const event of provider.stream(withEffort)) {
        hasYielded = true;
        yield event;
      }
      this.maybeNotifyRecovery(resolvedTier); // v868.3 — Re-Probe erfolgreich
      return;
    } catch (err) {
      // If we already yielded chunks, fallback would produce a spliced/garbled stream
      // v868 — Billing-Fehler (Guthaben/Quota) lösen den Fallback ebenfalls aus
      const billing = this.isBillingError(err);
      if (billing) this.registerBillingFailure(resolvedTier, err);
      if (hasYielded || (!billing && !this.isRetryableError(err))) throw err;
      this.logger?.warn(
        { err, tier: resolvedTier, billing },
        'Stream provider failed before first chunk, attempting fallback',
      );
      yield* this.streamFallback(request, resolvedTier, err);
    }
  }

  /** v868.3 — Fallback-Kette für Streams (Cooldown-aware, mit Recovery-Check). */
  private async *streamFallback(request: LLMRequest, failedTier: ModelTier, originalErr: unknown): AsyncIterable<LLMStreamEvent> {
    const fallbackOrder = FALLBACK_ORDER.filter(t => t !== failedTier);
    for (const tier of fallbackOrder) {
      if (this.isInBillingCooldown(tier)) continue; // bekannt leer — überspringen
      const fbProvider = this.providers.get(tier);
      if (!fbProvider) continue;
      try {
        this.logger?.info({ tier }, 'Stream fallback to tier');
        yield* fbProvider.stream(this.withTierEffort(request, tier));
        this.maybeNotifyRecovery(tier);
        return;
      } catch (fbErr) {
        if (this.isBillingError(fbErr)) this.registerBillingFailure(tier, fbErr);
        continue;
      }
    }
    throw originalErr;
  }

  async embed(text: string): Promise<EmbeddingResult | undefined> {
    const result = await (this.providers.get('embeddings') ?? this.resolve().provider).embed(text);
    if (result?.totalTokens) {
      this.costTracker.record(result.model, { inputTokens: result.totalTokens, outputTokens: 0 });
    }
    return result;
  }

  supportsEmbeddings(): boolean {
    return (this.providers.get('embeddings') ?? this.resolve().provider).supportsEmbeddings();
  }

  isAvailable(): boolean {
    return this.resolve().provider.isAvailable();
  }

  getContextWindow(): ContextWindow {
    return this.resolve().provider.getContextWindow();
  }

  getProviderStatuses(): Record<string, { model: string; available: boolean }> {
    const result: Record<string, { model: string; available: boolean }> = {};
    for (const tier of TIERS) {
      const provider = this.providers.get(tier);
      if (provider) {
        const tierConfig = this.multiConfig[tier];
        result[tier] = {
          model: tierConfig?.model ?? 'unknown',
          available: provider.isAvailable(),
        };
      }
    }
    return result;
  }

  getCostSummary(): TokenCostSummary {
    return this.costTracker.getSummary();
  }

  /** Wire SQLite persistence for usage tracking. */
  setPersist(fn: UsagePersistFn): void {
    this.costTracker.setPersist(fn);
  }
}

export function createModelRouter(config: MultiModelConfig, logger?: RouterLogger): ModelRouter {
  return new ModelRouter(config, logger);
}
