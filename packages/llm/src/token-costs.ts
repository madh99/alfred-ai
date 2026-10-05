import type { LLMUsage } from '@alfred/types';

/**
 * Pricing per 1 million tokens (USD).
 * Updated: 2026-04-02.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Known model pricing table.  Keys are matched via prefix (e.g. "gpt-5.4"
 * matches "gpt-5.4-turbo") so we don't need to list every variant.
 * Order matters — first match wins, so more specific entries come first.
 */
const PRICING_TABLE: [pattern: string, pricing: ModelPricing][] = [
  // ── OpenAI ──────────────────────────────────────────────────
  // v1156 (16.09.2026, developers.openai.com/api/docs/pricing): GPT-6 Astra
  // $10/$50 (Cache-Read $1), >272k Tokens 2x Input/1.5x Output (siehe
  // longPromptMultiplier). GPT-5.6 wurde im Preis GESENKT: Sol $4/$20,
  // Terra $2/$12, Luna $0.20/$1.20 (vorher 5/30, 2.5/15, 1/6).
  // v1204 — Modell-Update Oktober 2026 (Quellen 06.10.: OpenAI-Modellliste live, Preisvergleich 05.10.,
  // GPT-6.1-Sol-Ankündigung 29.09.): Sol/Luna-Varianten VOR dem generischen gpt-6-Präfix, sonst $10/$50.
  ['gpt-6.1-sol',     { input: 2.00, output: 10.00, cacheRead: 0.10, cacheWrite: 2.50 }],
  ['gpt-6-astra',     { input: 10.00, output: 50.00, cacheRead: 1.00 }],
  ['gpt-6-sol',       { input: 2.00, output: 10.00, cacheRead: 0.20 }],
  ['gpt-6-luna',      { input: 0.10, output: 0.50,  cacheRead: 0.01 }],
  ['gpt-6',           { input: 10.00, output: 50.00, cacheRead: 1.00 }],
  ['gpt-5.6-sol',     { input: 4.00, output: 20.00, cacheRead: 0.40 }],
  ['gpt-5.6-terra',   { input: 2.00, output: 12.00, cacheRead: 0.20 }],
  ['gpt-5.6-luna',    { input: 0.20, output: 1.20,  cacheRead: 0.02 }],
  // Pro-Varianten (kein Cache-Rabatt dokumentiert) — VOR ihren Basis-Präfixen.
  ['gpt-5.5-pro',     { input: 30.00, output: 180.00 }],
  ['gpt-5.5',         { input: 5.00, output: 30.00, cacheRead: 0.50 }],
  ['gpt-5.4-pro',     { input: 30.00, output: 180.00 }],
  ['gpt-5.4-nano',    { input: 0.20, output: 1.25,  cacheRead: 0.02 }],
  ['gpt-5.4-mini',    { input: 0.75, output: 4.50,  cacheRead: 0.075 }],
  ['gpt-5.4',         { input: 2.50, output: 15.00, cacheRead: 0.25 }],
  ['gpt-5.3-codex',   { input: 1.75, output: 14.00, cacheRead: 0.175 }],
  ['gpt-5.2-pro',     { input: 21.00, output: 168.00 }],
  ['gpt-5-pro',       { input: 15.00, output: 120.00 }],
  ['gpt-5',           { input: 0.625, output: 5.00, cacheRead: 0.125 }],
  // Bild-Modelle (Token-Preise laut Preisseite; Output = Bild-Tokens)
  ['gpt-image-2.5',   { input: 5.00, output: 30.00, cacheRead: 1.25 }],
  ['gpt-image-2',     { input: 5.00, output: 30.00, cacheRead: 1.25 }],
  ['gpt-image-1.5',   { input: 5.00, output: 10.00, cacheRead: 1.25 }],
  ['gpt-image-1-mini', { input: 2.00, output: 8.00, cacheRead: 0.20 }],
  ['gpt-image-1',     { input: 5.00, output: 40.00, cacheRead: 1.25 }],
  ['gpt-4.1-nano',    { input: 0.05, output: 0.20,  cacheRead: 0.025 }],
  ['gpt-4.1-mini',    { input: 0.20, output: 0.80,  cacheRead: 0.10 }],
  ['gpt-4.1',         { input: 2.00, output: 8.00,  cacheRead: 0.50 }],
  ['gpt-4o-mini',     { input: 0.15, output: 0.60,  cacheRead: 0.075 }],
  ['gpt-4o',          { input: 2.50, output: 10.00, cacheRead: 1.25 }],
  ['o4-mini',         { input: 1.10, output: 4.40,  cacheRead: 0.275 }],
  ['o3-mini',         { input: 1.10, output: 4.40,  cacheRead: 0.55 }],
  ['o3',              { input: 2.00, output: 8.00,  cacheRead: 0.50 }],

  // ── Anthropic ───────────────────────────────────────────────
  // v1156 (16.09.2026, platform.claude.com Pricing): Fable 5.1 / Mythos 5.1
  // $10/$50 wie Fable 5, aber Cache-Read nur 0.025x = $0.25 (statt $1).
  // Müssen VOR 'claude-fable-5'/'claude-mythos-5' stehen (Präfix-Match).
  ['claude-fable-5-1',  { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 }],
  ['claude-mythos-5-1', { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 }],
  // Fable 5 / Mythos 5: $10/$50, Cache standard-Multiplikatoren (write 1.25x, read 0.1x)
  ['claude-fable-5',    { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 }],
  ['claude-mythos-5',   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 }],
  // v1135 — Opus 5 (Juli 2026): gleiche Preise wie Opus 4.8 ($5/$25)
  // v1204 — Opus 5.5 ($4/$20, Cache-Read 5 % = $0.20, Write $5) und Sonnet 5.5 ($2/$10) laut
  // claude.com/pricing + Models-Overview 06.10.; Opus 5 / Sonnet 5 / Fable 5 sind „legacy".
  ['claude-opus-5-5',   { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 }],
  ['claude-sonnet-5-5', { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 }],
  ['claude-opus-5',     { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-8',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-7',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-6',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-5',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-1',   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }],
  ['claude-opus-4',     { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }],
  // v1156 — Sonnet 5: Der Einführungspreis $2/$10 ist laut Anthropic (Pricing-
  // Seite, 16.09.2026) jetzt der DAUERPREIS; die für 01.09. angekündigte
  // Erhöhung auf $3/$15 entfällt. Vorher wurde die medium-Stufe um 50% überzählt.
  ['claude-sonnet-5',   { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 }],
  ['claude-sonnet-4',   { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-haiku-4',    { input: 1.00, output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 }],
  ['claude-haiku-3-5',  { input: 0.80, output: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 }],
  ['claude-3.5-sonnet', { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-3-haiku',    { input: 0.25, output: 1.25,  cacheRead: 0.03, cacheWrite: 0.30 }],

  // ── Google Gemini ───────────────────────────────────────────
  // v1156 (16.09.2026, ai.google.dev Pricing): Gemini 3.8/3.7/3.6 Flash
  // Einführungspreis $0.75/$3.75 (Cache $0.075) bis 31.12.2026, danach
  // $1.50/$7.50 — am 01.01.2027 anpassen! 3.5 Flash $1.50/$9, 3.5 Flash-Lite
  // $0.30/$2.50. Gemini 3.5 Pro ist (Stand Sept.) nie erschienen.
  ['gemini-3.8-flash', { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ['gemini-3.7-flash', { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ['gemini-3.6-flash', { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ['gemini-3.5-flash-lite', { input: 0.30, output: 2.50, cacheRead: 0.03 }],
  ['gemini-3.5-flash', { input: 1.50, output: 9.00, cacheRead: 0.15 }],
  ['gemini-3.1-pro',  { input: 2.00, output: 12.00, cacheRead: 0.20 }],
  ['gemini-3.1-flash-lite', { input: 0.25, output: 1.50, cacheRead: 0.025 }],
  ['gemini-3.1-flash', { input: 0.50, output: 3.00, cacheRead: 0.05 }],
  ['gemini-3-pro',    { input: 2.00, output: 12.00, cacheRead: 0.20 }],
  ['gemini-3-flash',  { input: 0.50, output: 3.00,  cacheRead: 0.05 }],
  ['gemini-2.5-pro',  { input: 1.25, output: 10.00, cacheRead: 0.125 }],
  ['gemini-2.5-flash', { input: 0.30, output: 2.50, cacheRead: 0.03 }],
  ['gemini-2.0-flash', { input: 0.10, output: 0.40, cacheRead: 0.025 }],

  // ── OpenAI Embeddings ───────────────────────────────────────
  ['text-embedding-3-small', { input: 0.02, output: 0 }],
  ['text-embedding-3-large', { input: 0.13, output: 0 }],
  ['text-embedding-ada-002', { input: 0.10, output: 0 }],

  // ── Mistral (updated 2026-04-02 from mistral.ai/pricing) ──
  // v1156 — codestral-embed ($0.15) VOR dem generischen codestral-Präfix
  ['codestral-embed',         { input: 0.15, output: 0 }],
  ['codestral',               { input: 0.30, output: 0.90, cacheRead: 0.03 }],
  ['devstral-medium',         { input: 0.40, output: 2.00 }],
  ['devstral-small',          { input: 0.10, output: 0.30 }],
  ['magistral-medium',        { input: 2.00, output: 5.00 }],
  ['magistral-small',         { input: 0.50, output: 1.50 }],
  // v1204 — Ministral 3 (Dokumentations-IDs ministral-3-{3b,8b,14b}-25-12; Live-Liste führt ministral-{3b,8b,14b}-2512)
  ['ministral-3-14b',         { input: 0.20, output: 0.20, cacheRead: 0.02 }],
  ['ministral-3-8b',          { input: 0.15, output: 0.15, cacheRead: 0.015 }],
  ['ministral-3-3b',          { input: 0.10, output: 0.10, cacheRead: 0.01 }],
  ['ministral-3b',            { input: 0.10, output: 0.10 }],
  ['ministral-8b',            { input: 0.15, output: 0.15 }],
  ['ministral-14b',           { input: 0.20, output: 0.20 }],
  ['mistral-large',           { input: 0.50, output: 1.50, cacheRead: 0.05 }],
  // Mistral Medium 3.5 (April 2026) — 256k context, frontier multimodal.
  // Cached input billed at 10% of standard input (Mistral API doc: "Cached tokens are billed at 10%").
  // Must come BEFORE generic 'mistral-medium' so prefix-match catches the more specific entry first.
  ['mistral-medium-3-5',      { input: 1.50, output: 7.50, cacheRead: 0.15 }],
  // v1156 (16.09.2026, mistral.ai/pricing/api): Medium 3.5 heißt in der Live-
  // Modellliste auch 'mistral-medium-3.5' (Punkt) und 'mistral-medium-2604';
  // 'mistral-medium-latest' zeigt auf 2604. Alle drei fielen bisher auf den
  // generischen Medium-Preis ($0.40/$2) zurück — 73% Unterzählung.
  ['mistral-medium-3.5',      { input: 1.50, output: 7.50, cacheRead: 0.15 }],
  ['mistral-medium-2604',     { input: 1.50, output: 7.50, cacheRead: 0.15 }],
  ['mistral-medium-latest',   { input: 1.50, output: 7.50, cacheRead: 0.15 }],
  ['mistral-medium',          { input: 0.40, output: 2.00, cacheRead: 0.04 }],
  // v1156 — Drittanbieter-Modelle auf der Mistral-Plattform (GLM 5.2/5.3: $1.40/$4.40),
  // Codestral Embed $0.15, Leanstral (Labs) kostenlos.
  ['zai-glm',                 { input: 1.40, output: 4.40 }],
  ['glm-5',                   { input: 1.40, output: 4.40 }],
  ['labs-leanstral',          { input: 0, output: 0 }],
  ['mistral-small',           { input: 0.15, output: 0.60, cacheRead: 0.015 }],
  ['mistral-moderation',      { input: 0.10, output: 0 }],
  ['mistral-embed',           { input: 0.10, output: 0 }],
  ['pixtral-large',           { input: 2.00, output: 6.00 }],
  ['pixtral-12b',             { input: 0.15, output: 0.15 }],
  ['open-mixtral-8x22b',      { input: 2.00, output: 6.00 }],
  ['open-mixtral-8x7b',       { input: 0.70, output: 0.70 }],
  ['open-mistral-nemo',       { input: 0.15, output: 0.15 }],
  ['open-mistral-7b',         { input: 0.25, output: 0.25 }],
];

/**
 * Look up pricing for a model by prefix matching.
 * Returns undefined for unknown models (e.g. local/Ollama).
 */
export function getModelPricing(model: string): ModelPricing | undefined {
  const lower = model.toLowerCase();
  for (const [pattern, pricing] of PRICING_TABLE) {
    if (lower.startsWith(pattern.toLowerCase())) {
      return pricing;
    }
  }
  return undefined;
}

/**
 * Long-prompt multipliers — some models charge a premium when the prompt exceeds a
 * threshold. Returns { input: 1, output: 1 } when no multiplier applies.
 *
 * gpt-5.5: prompts >272K tokens incur 2x input and 1.5x output pricing.
 * v1156 — dieselbe Regel gilt laut Preisseite (16.09.2026) für gpt-6-astra,
 * die gpt-5.6-Familie und gpt-5.4 (Basis, nicht mini/nano); auch der
 * Cache-Read-Satz verdoppelt sich („2x input and cache rates").
 */
export function longPromptMultiplier(model: string, inputTokens: number): { input: number; output: number } {
  const lower = model.toLowerCase();
  if (inputTokens <= 272_000) return { input: 1.0, output: 1.0 };
  // v1204 — gpt-6.1-sol: >272k → 2× Input/Cache, 1,5× Output (Ankündigung 29.09.2026); Präfix gpt-6 deckt es ab
  const langkontext = /^(gpt-6|gpt-5\.6|gpt-5\.5($|-\d)|gpt-5\.4($|-\d|-pro))/.test(lower);
  return langkontext ? { input: 2.0, output: 1.5 } : { input: 1.0, output: 1.0 };
}

/**
 * Calculate the cost (USD) for a single LLM call.
 * Returns 0 for unknown models.
 */
export function calculateCost(model: string, usage: LLMUsage): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  const m = 1_000_000; // per-million divisor
  const mult = longPromptMultiplier(model, usage.inputTokens);
  let cost = 0;

  // Cache read tokens are charged at cacheRead rate instead of input rate
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const regularInput = Math.max(0, usage.inputTokens - cacheRead);

  cost += (regularInput / m) * pricing.input * mult.input;
  cost += (usage.outputTokens / m) * pricing.output * mult.output;

  if (cacheRead > 0 && pricing.cacheRead) {
    cost += (cacheRead / m) * pricing.cacheRead * mult.input;
  }
  if (cacheWrite > 0 && pricing.cacheWrite) {
    cost += (cacheWrite / m) * pricing.cacheWrite * mult.input;
  }

  return cost;
}

/**
 * Accumulated cost tracking for a session.
 */
export interface TokenCostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  byModel: Record<string, ModelCostEntry>;
}

export interface ModelCostEntry {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Callback to persist a single LLM call to storage. */
export type UsagePersistFn = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number) => void;

export class TokenCostTracker {
  private data: TokenCostSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
    byModel: {},
  };

  private persistFn?: UsagePersistFn;

  /** Set a callback to persist each record to SQLite. */
  setPersist(fn: UsagePersistFn): void {
    this.persistFn = fn;
  }

  record(model: string, usage: LLMUsage): number {
    const cost = calculateCost(model, usage);
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheCreationTokens ?? 0;

    this.data.totalInputTokens += usage.inputTokens;
    this.data.totalOutputTokens += usage.outputTokens;
    this.data.totalCacheReadTokens += cacheRead;
    this.data.totalCacheWriteTokens += cacheWrite;
    this.data.totalCostUsd += cost;

    let entry = this.data.byModel[model];
    if (!entry) {
      entry = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      this.data.byModel[model] = entry;
    }
    entry.calls++;
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.cacheReadTokens += cacheRead;
    entry.cacheWriteTokens += cacheWrite;
    entry.costUsd += cost;

    // Persist to SQLite if callback is set
    try {
      this.persistFn?.(model, usage.inputTokens, usage.outputTokens, cacheRead, cacheWrite, cost);
    } catch {
      // Don't let persistence errors break LLM calls
    }

    return cost;
  }

  getSummary(): TokenCostSummary {
    return {
      ...this.data,
      totalCostUsd: Math.round(this.data.totalCostUsd * 1_000_000) / 1_000_000, // 6 decimal precision
      byModel: Object.fromEntries(
        Object.entries(this.data.byModel).map(([k, v]) => [
          k,
          { ...v, costUsd: Math.round(v.costUsd * 1_000_000) / 1_000_000 },
        ]),
      ),
    };
  }
}
