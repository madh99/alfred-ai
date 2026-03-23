import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'price' | 'top' | 'search' | 'history';

const BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFAULT_CURRENCY = 'eur';
const CACHE_TTL_MS = 60_000; // 60s cache to stay within rate limits

// Common aliases: symbol → CoinGecko ID
const SYMBOL_MAP: Record<string, string> = {
  btc: 'bitcoin', eth: 'ethereum', sol: 'solana', ada: 'cardano',
  dot: 'polkadot', matic: 'polygon', avax: 'avalanche-2', link: 'chainlink',
  uni: 'uniswap', atom: 'cosmos', xrp: 'ripple', doge: 'dogecoin',
  shib: 'shiba-inu', ltc: 'litecoin', bnb: 'binancecoin', trx: 'tron',
  xlm: 'stellar', algo: 'algorand', near: 'near', apt: 'aptos',
  sui: 'sui', op: 'optimism', arb: 'arbitrum', fet: 'fetch-ai',
  ren: 'republic-protocol', iota: 'iota', xtz: 'tezos', eos: 'eos',
};

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CryptoPriceSkill extends Skill {
  private cache = new Map<string, CacheEntry<unknown>>();

  readonly metadata: SkillMetadata = {
    name: 'crypto_price',
    category: 'information',
    description:
      'Cryptocurrency prices and market data. ' +
      'Use action "price" for current price of one or more coins (e.g. bitcoin, ethereum). ' +
      'Use action "top" for top coins by market cap. ' +
      'Use action "search" to find a coin by name or symbol. ' +
      'Use action "history" for price history over days. ' +
      'Supports Watch conditions on price, change_24h, market_cap.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['price', 'top', 'search', 'history'],
          description: 'Action to perform',
        },
        coins: {
          type: 'string',
          description: 'Comma-separated coin IDs or symbols (for price). E.g. "bitcoin,ethereum" or "btc,eth"',
        },
        query: {
          type: 'string',
          description: 'Search query (for search)',
        },
        coin: {
          type: 'string',
          description: 'Single coin ID or symbol (for history). E.g. "bitcoin" or "btc"',
        },
        days: {
          type: 'number',
          description: 'Number of days for history (default 7). Options: 1, 7, 30, 90, 365',
        },
        limit: {
          type: 'number',
          description: 'Number of results for top (default 10, max 50)',
        },
        currency: {
          type: 'string',
          description: 'Fiat currency (default "eur"). E.g. "usd", "eur", "chf"',
        },
      },
      required: ['action'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    const currency = ((input.currency as string) ?? DEFAULT_CURRENCY).toLowerCase();

    try {
      switch (action) {
        case 'price':
          return await this.getPrice(input.coins as string | undefined, currency);
        case 'top':
          return await this.getTop(input.limit as number | undefined, currency);
        case 'search':
          return await this.searchCoin(input.query as string | undefined);
        case 'history':
          return await this.getHistory(input.coin as string | undefined, input.days as number | undefined, currency);
        default:
          return { success: false, error: `Unknown action "${action}". Use: price, top, search, history` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Crypto API error: ${msg}` };
    }
  }

  // ── Actions ────────────────────────────────────────────────

  private async getPrice(coinsInput: string | undefined, currency: string): Promise<SkillResult> {
    if (!coinsInput) return { success: false, error: 'Missing "coins". E.g. "bitcoin,ethereum" or "btc,eth"' };

    const ids = coinsInput.split(',').map(s => this.resolveId(s.trim())).join(',');
    const url = `${BASE_URL}/simple/price?ids=${ids}&vs_currencies=${currency}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;

    const data = await this.fetchCached<Record<string, Record<string, number>>>(url);
    if (!data || Object.keys(data).length === 0) {
      return { success: false, error: `No data found for "${coinsInput}". Use action "search" to find the correct coin ID.` };
    }

    const entries = Object.entries(data);
    const lines: string[] = [];
    const resultData: Record<string, unknown> = {};

    for (const [coinId, values] of entries) {
      const price = values[currency];
      const change = values[`${currency}_24h_change`];
      const marketCap = values[`${currency}_market_cap`];
      const volume = values[`${currency}_24h_vol`];
      const changeStr = change != null ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)` : '';

      lines.push(`**${coinId}**: ${this.formatPrice(price, currency)}${changeStr}`);

      resultData[coinId] = { price, change_24h: change, market_cap: marketCap, volume_24h: volume };
    }

    // For single coin, flatten data for easier watch conditions
    const flat = entries.length === 1
      ? { ...resultData[entries[0][0]] as Record<string, unknown>, coin: entries[0][0] }
      : resultData;

    return {
      success: true,
      data: flat,
      display: lines.join('\n'),
    };
  }

  private async getTop(limit: number | undefined, currency: string): Promise<SkillResult> {
    const count = Math.min(Math.max(1, limit ?? 10), 50);
    const url = `${BASE_URL}/coins/markets?vs_currency=${currency}&order=market_cap_desc&per_page=${count}&page=1&sparkline=false&price_change_percentage=24h`;

    const coins = await this.fetchCached<Array<Record<string, unknown>>>(url);
    if (!coins || coins.length === 0) {
      return { success: false, error: 'Failed to fetch market data' };
    }

    const lines = [`**Top ${coins.length} Kryptowährungen** (${currency.toUpperCase()}):\n`];
    const items: Array<Record<string, unknown>> = [];

    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      const price = c.current_price as number;
      const change = c.price_change_percentage_24h as number;
      const mcap = c.market_cap as number;
      const changeStr = change != null ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)` : '';

      lines.push(`${i + 1}. **${c.name}** (${(c.symbol as string).toUpperCase()}): ${this.formatPrice(price, currency)}${changeStr} — MCap: ${this.formatLargeNumber(mcap, currency)}`);

      items.push({
        rank: i + 1,
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price,
        change_24h: change,
        market_cap: mcap,
        volume_24h: c.total_volume,
      });
    }

    return {
      success: true,
      data: { coins: items, count: items.length },
      display: lines.join('\n'),
    };
  }

  private async searchCoin(query: string | undefined): Promise<SkillResult> {
    if (!query) return { success: false, error: 'Missing "query" for search' };

    const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}`;
    const result = await this.fetchCached<{ coins: Array<Record<string, unknown>> }>(url);
    const coins = result?.coins?.slice(0, 10) ?? [];

    if (coins.length === 0) {
      return { success: true, data: { coins: [] }, display: `Keine Ergebnisse für "${query}".` };
    }

    const lines = [`**Suchergebnisse für "${query}":**\n`];
    for (const c of coins) {
      lines.push(`- **${c.name}** (${(c.symbol as string).toUpperCase()}) — ID: \`${c.id}\`, Rang #${c.market_cap_rank ?? '?'}`);
    }

    return {
      success: true,
      data: { coins: coins.map(c => ({ id: c.id, symbol: c.symbol, name: c.name, rank: c.market_cap_rank })) },
      display: lines.join('\n'),
    };
  }

  private async getHistory(coinInput: string | undefined, days: number | undefined, currency: string): Promise<SkillResult> {
    if (!coinInput) return { success: false, error: 'Missing "coin". E.g. "bitcoin" or "btc"' };

    const coinId = this.resolveId(coinInput.trim());
    const numDays = days ?? 7;
    const url = `${BASE_URL}/coins/${coinId}/market_chart?vs_currency=${currency}&days=${numDays}`;

    const data = await this.fetchCached<{ prices: number[][] }>(url);
    if (!data?.prices || data.prices.length === 0) {
      return { success: false, error: `No history data for "${coinInput}". Use action "search" to verify the coin ID.` };
    }

    const prices = data.prices;
    const current = prices[prices.length - 1][1];
    const oldest = prices[0][1];
    const high = Math.max(...prices.map(p => p[1]));
    const low = Math.min(...prices.map(p => p[1]));
    const change = ((current - oldest) / oldest) * 100;

    // Sample points for display (max 10)
    const step = Math.max(1, Math.floor(prices.length / 10));
    const samples = prices.filter((_, i) => i % step === 0 || i === prices.length - 1);

    const lines = [
      `**${coinId}** — ${numDays} Tage (${currency.toUpperCase()}):\n`,
      `Aktuell: ${this.formatPrice(current, currency)}`,
      `Hoch: ${this.formatPrice(high, currency)}`,
      `Tief: ${this.formatPrice(low, currency)}`,
      `Veränderung: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n`,
      `Verlauf:`,
    ];

    for (const [ts, price] of samples) {
      const date = new Date(ts).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
      lines.push(`  ${date}: ${this.formatPrice(price, currency)}`);
    }

    return {
      success: true,
      data: { coin: coinId, current, high, low, change_percent: change, days: numDays, prices: prices.length },
      display: lines.join('\n'),
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  private resolveId(input: string): string {
    const lower = input.toLowerCase();
    return SYMBOL_MAP[lower] ?? lower;
  }

  private formatPrice(price: number, currency: string): string {
    if (price >= 1) {
      return price.toLocaleString('de-AT', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    // Small prices (< 1): show more decimals
    return price.toLocaleString('de-AT', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 4, maximumFractionDigits: 6 });
  }

  private formatLargeNumber(num: number, currency: string): string {
    const sym = currency.toUpperCase() === 'EUR' ? '€' : currency.toUpperCase() === 'USD' ? '$' : currency.toUpperCase();
    if (num >= 1e12) return `${sym} ${(num / 1e12).toFixed(2)} T`;
    if (num >= 1e9) return `${sym} ${(num / 1e9).toFixed(2)} Mrd`;
    if (num >= 1e6) return `${sym} ${(num / 1e6).toFixed(2)} Mio`;
    return `${sym} ${num.toLocaleString('de-AT')}`;
  }

  private async fetchCached<T>(url: string): Promise<T> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data as T;
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json() as T;
    this.cache.set(url, { data, timestamp: Date.now() });
    return data;
  }
}
