import type { LLMUsage } from '@alfred/types';

/**
 * Pricing per 1 million tokens (USD).
 * Updated: 2026-03-21.
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
  ['gpt-5.4-nano',    { input: 0.20, output: 1.25,  cacheRead: 0.02 }],
  ['gpt-5.4-mini',    { input: 0.75, output: 4.50,  cacheRead: 0.075 }],
  ['gpt-5.4',         { input: 2.50, output: 15.00, cacheRead: 0.25 }],
  ['gpt-5',           { input: 0.625, output: 5.00, cacheRead: 0.125 }],
  ['gpt-4.1-nano',    { input: 0.05, output: 0.20,  cacheRead: 0.025 }],
  ['gpt-4.1-mini',    { input: 0.20, output: 0.80,  cacheRead: 0.10 }],
  ['gpt-4.1',         { input: 2.00, output: 8.00,  cacheRead: 0.50 }],
  ['gpt-4o-mini',     { input: 0.15, output: 0.60,  cacheRead: 0.075 }],
  ['gpt-4o',          { input: 2.50, output: 10.00, cacheRead: 1.25 }],
  ['o4-mini',         { input: 1.10, output: 4.40,  cacheRead: 0.275 }],
  ['o3-mini',         { input: 1.10, output: 4.40,  cacheRead: 0.55 }],
  ['o3',              { input: 2.00, output: 8.00,  cacheRead: 0.50 }],

  // ── Anthropic ───────────────────────────────────────────────
  ['claude-opus-4-6',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4-5',   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 }],
  ['claude-opus-4',     { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }],
  ['claude-sonnet-4',   { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-haiku-4',    { input: 1.00, output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 }],
  ['claude-haiku-3-5',  { input: 0.80, output: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 }],
  ['claude-3.5-sonnet', { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-3-haiku',    { input: 0.25, output: 1.25,  cacheRead: 0.03, cacheWrite: 0.30 }],

  // ── Google Gemini ───────────────────────────────────────────
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

  // ── Mistral ─────────────────────────────────────────────────
  ['codestral',               { input: 0.30, output: 0.90, cacheRead: 0.03 }],
  ['magistral-medium-latest', { input: 0.40, output: 2.00, cacheRead: 0.04 }],
  ['magistral-small-latest',  { input: 0.10, output: 0.30, cacheRead: 0.01 }],
  ['ministral-8b-latest',     { input: 0.10, output: 0.10, cacheRead: 0.01 }],
  ['mistral-large-latest',    { input: 0.50, output: 1.50, cacheRead: 0.05 }],
  ['mistral-medium-latest',   { input: 0.40, output: 2.00, cacheRead: 0.04 }],
  ['mistral-small-latest',    { input: 0.10, output: 0.30, cacheRead: 0.01 }],
  ['mistral-embed',           { input: 0.10, output: 0.10, cacheRead: 0.01 }],
  ['mistral-large',           { input: 0.50, output: 1.50, cacheRead: 0.05 }],
  ['mistral-medium',          { input: 0.40, output: 2.00, cacheRead: 0.04 }],
  ['mistral-small',           { input: 0.10, output: 0.30, cacheRead: 0.01 }],
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
 * Calculate the cost (USD) for a single LLM call.
 * Returns 0 for unknown models.
 */
export function calculateCost(model: string, usage: LLMUsage): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  const m = 1_000_000; // per-million divisor
  let cost = 0;

  // Cache read tokens are charged at cacheRead rate instead of input rate
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const regularInput = Math.max(0, usage.inputTokens - cacheRead);

  cost += (regularInput / m) * pricing.input;
  cost += (usage.outputTokens / m) * pricing.output;

  if (cacheRead > 0 && pricing.cacheRead) {
    cost += (cacheRead / m) * pricing.cacheRead;
  }
  if (cacheWrite > 0 && pricing.cacheWrite) {
    cost += (cacheWrite / m) * pricing.cacheWrite;
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
