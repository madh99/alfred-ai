import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'portfolio' | 'balance' | 'trades' | 'buy' | 'sell' | 'ticker';

const BASE_URL = 'https://api.bitpanda.com';

interface BitpandaConfig {
  apiKey?: string;
}

export class BitpandaSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'bitpanda',
    category: 'information',
    description:
      'Bitpanda portfolio, trading, and crypto/stock/ETF prices. ' +
      'Use action "portfolio" to see all holdings with current value. ' +
      'Use action "balance" to see fiat wallet balances (EUR etc.). ' +
      'Use action "trades" to see recent trade history. ' +
      'Use action "buy" to buy an asset (requires Trade permission on API key). ' +
      'Use action "sell" to sell an asset. ' +
      'Use action "ticker" to see current prices (no API key needed). ' +
      'Supports Watch conditions on portfolio value, asset prices.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['portfolio', 'balance', 'trades', 'buy', 'sell', 'ticker'],
          description: 'Action to perform',
        },
        symbol: {
          type: 'string',
          description: 'Asset symbol for ticker/buy/sell (e.g. "BTC", "ETH", "NVDA", "XAU")',
        },
        symbols: {
          type: 'string',
          description: 'Comma-separated symbols for ticker (e.g. "BTC,ETH,XAU")',
        },
        amount: {
          type: 'number',
          description: 'Amount in EUR to buy/sell',
        },
        limit: {
          type: 'number',
          description: 'Number of trades to show (default 10, max 50)',
        },
        type: {
          type: 'string',
          enum: ['buy', 'sell'],
          description: 'Filter trades by type',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly config?: BitpandaConfig) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    try {
      switch (action) {
        case 'portfolio':
          return await this.getPortfolio();
        case 'balance':
          return await this.getBalance();
        case 'trades':
          return await this.getTrades(input.limit as number | undefined, input.type as string | undefined);
        case 'buy':
          return { success: false, error: 'Buy action is not yet implemented. Use the Bitpanda app for trading.' };
        case 'sell':
          return { success: false, error: 'Sell action is not yet implemented. Use the Bitpanda app for trading.' };
        case 'ticker':
          return await this.getTicker(input.symbol as string | undefined, input.symbols as string | undefined);
        default:
          return { success: false, error: `Unknown action "${action}". Use: portfolio, balance, trades, buy, sell, ticker` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Bitpanda API error: ${msg}` };
    }
  }

  // ── Actions ────────────────────────────────────────────────

  private async getPortfolio(): Promise<SkillResult> {
    this.requireKey();

    // Fetch wallets + ticker in parallel
    const [cryptoWallets, fiatWallets, ticker] = await Promise.all([
      this.fetchPrivate<{ data: WalletEntry[] }>('/v1/wallets'),
      this.fetchPrivate<{ data: FiatWalletEntry[] }>('/v1/fiatwallets'),
      this.fetchPublic<Record<string, Record<string, string>>>('/v1/ticker'),
    ]);

    const holdings: PortfolioItem[] = [];
    let totalValueEur = 0;

    // Crypto wallets
    for (const w of cryptoWallets.data) {
      const attrs = w.attributes;
      const balance = parseFloat(attrs.balance);
      if (balance <= 0 || attrs.deleted) continue;

      const symbol = attrs.cryptocoin_symbol;
      const priceEur = parseFloat(ticker[symbol]?.EUR ?? '0');
      const valueEur = balance * priceEur;
      totalValueEur += valueEur;

      holdings.push({
        symbol,
        name: attrs.name.replace(` Wallet`, ''),
        balance,
        priceEur,
        valueEur,
        type: 'crypto',
      });
    }

    // Sort by value descending
    holdings.sort((a, b) => b.valueEur - a.valueEur);

    const lines = ['**Bitpanda Portfolio:**\n'];
    for (const h of holdings) {
      lines.push(`- **${h.symbol}**: ${h.balance.toLocaleString('de-AT', { maximumFractionDigits: 8 })} × ${this.eur(h.priceEur)} = **${this.eur(h.valueEur)}**`);
    }

    // Fiat balances
    const fiatLines: string[] = [];
    let totalFiat = 0;
    for (const f of fiatWallets.data) {
      const balance = parseFloat(f.attributes.balance);
      if (balance <= 0) continue;
      const symbol = f.attributes.fiat_symbol;
      fiatLines.push(`- ${symbol}: ${balance.toLocaleString('de-AT', { minimumFractionDigits: 2 })} ${symbol}`);
      if (symbol === 'EUR') totalFiat += balance;
    }

    if (fiatLines.length > 0) {
      lines.push('\n**Fiat-Guthaben:**');
      lines.push(...fiatLines);
    }

    lines.push(`\n**Gesamtwert (Crypto):** ${this.eur(totalValueEur)}`);
    if (totalFiat > 0) {
      lines.push(`**Gesamt inkl. Fiat:** ${this.eur(totalValueEur + totalFiat)}`);
    }

    return {
      success: true,
      data: {
        holdings,
        totalValueEur,
        totalFiatEur: totalFiat,
        totalEur: totalValueEur + totalFiat,
        holdingCount: holdings.length,
      },
      display: lines.join('\n'),
    };
  }

  private async getBalance(): Promise<SkillResult> {
    this.requireKey();

    const fiatWallets = await this.fetchPrivate<{ data: FiatWalletEntry[] }>('/v1/fiatwallets');
    const balances: Array<{ symbol: string; balance: number }> = [];
    const lines = ['**Fiat-Guthaben:**\n'];

    for (const f of fiatWallets.data) {
      const balance = parseFloat(f.attributes.balance);
      const symbol = f.attributes.fiat_symbol;
      balances.push({ symbol, balance });
      if (balance > 0) {
        lines.push(`- **${symbol}**: ${balance.toLocaleString('de-AT', { minimumFractionDigits: 2 })} ${symbol}`);
      }
    }

    if (balances.every(b => b.balance <= 0)) {
      lines.push('Kein Fiat-Guthaben vorhanden.');
    }

    return {
      success: true,
      data: { balances },
      display: lines.join('\n'),
    };
  }

  private async getTrades(limit: number | undefined, tradeType: string | undefined): Promise<SkillResult> {
    this.requireKey();

    const count = Math.min(Math.max(1, limit ?? 10), 50);
    let url = `/v1/trades?page_size=${count}`;
    if (tradeType === 'buy' || tradeType === 'sell') {
      url += `&type=${tradeType}`;
    }

    const result = await this.fetchPrivate<{ data: TradeEntry[] }>(url);
    const trades = result.data.slice(0, count);

    if (trades.length === 0) {
      return { success: true, data: { trades: [] }, display: 'Keine Trades gefunden.' };
    }

    const lines = [`**Letzte ${trades.length} Trades:**\n`];
    const items: Array<Record<string, unknown>> = [];

    for (const t of trades) {
      const attrs = t.attributes;
      const type = attrs.type === 'buy' ? '🟢 Kauf' : '🔴 Verkauf';
      const date = new Date(attrs.time.date_iso8601).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const amount = parseFloat(attrs.amount_cryptocoin);
      const fiatAmount = parseFloat(attrs.amount_fiat);
      const price = parseFloat(attrs.price);

      lines.push(`- ${date} ${type} **${attrs.cryptocoin_symbol}**: ${amount.toLocaleString('de-AT', { maximumFractionDigits: 8 })} für ${this.eur(fiatAmount)} (@ ${this.eur(price)})`);

      items.push({
        type: attrs.type,
        symbol: attrs.cryptocoin_symbol,
        amount,
        fiatAmount,
        price,
        date: attrs.time.date_iso8601,
        status: attrs.status,
      });
    }

    return {
      success: true,
      data: { trades: items, count: items.length },
      display: lines.join('\n'),
    };
  }

  private async getTicker(symbol: string | undefined, symbols: string | undefined): Promise<SkillResult> {
    const ticker = await this.fetchPublic<Record<string, Record<string, string>>>('/v1/ticker');

    const requested = (symbols ?? symbol ?? '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);

    if (requested.length === 0) {
      return { success: false, error: 'Missing "symbol" or "symbols". E.g. symbol: "BTC" or symbols: "BTC,ETH,XAU"' };
    }

    const lines: string[] = [];
    const data: Record<string, unknown> = {};

    for (const sym of requested) {
      const prices = ticker[sym];
      if (!prices) {
        lines.push(`**${sym}**: nicht gefunden`);
        continue;
      }
      const eur = parseFloat(prices.EUR ?? '0');
      const usd = parseFloat(prices.USD ?? '0');
      lines.push(`**${sym}**: ${this.eur(eur)} (${usd.toLocaleString('de-AT', { style: 'currency', currency: 'USD' })})`);
      data[sym] = { eur, usd, chf: parseFloat(prices.CHF ?? '0'), gbp: parseFloat(prices.GBP ?? '0') };
    }

    // Flatten for single symbol (watch-friendly)
    const flat = requested.length === 1 && data[requested[0]]
      ? { ...data[requested[0]] as Record<string, unknown>, symbol: requested[0] }
      : data;

    return {
      success: true,
      data: flat,
      display: lines.join('\n'),
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  private requireKey(): void {
    if (!this.config?.apiKey) {
      throw new Error('Bitpanda API Key nicht konfiguriert. Setze ALFRED_BITPANDA_API_KEY in der .env Datei.');
    }
  }

  private eur(value: number): string {
    return value.toLocaleString('de-AT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private async fetchPrivate<T>(path: string): Promise<T> {
    this.requireKey();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'X-Api-Key': this.config!.apiKey! },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  private async fetchPublic<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}

// ── API Response Types ───────────────────────────────────────

interface WalletEntry {
  attributes: {
    cryptocoin_id: string;
    cryptocoin_symbol: string;
    balance: string;
    is_default: boolean;
    name: string;
    deleted: boolean;
  };
  id: string;
}

interface FiatWalletEntry {
  attributes: {
    fiat_id: string;
    fiat_symbol: string;
    balance: string;
    name: string;
  };
  id: string;
}

interface TradeEntry {
  attributes: {
    status: string;
    type: 'buy' | 'sell';
    cryptocoin_id: string;
    cryptocoin_symbol: string;
    fiat_id: string;
    amount_fiat: string;
    amount_cryptocoin: string;
    price: string;
    time: { date_iso8601: string; unix: string };
  };
  id: string;
}

interface PortfolioItem {
  symbol: string;
  name: string;
  balance: number;
  priceEur: number;
  valueEur: number;
  type: string;
}
