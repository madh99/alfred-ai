import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'balance' | 'price' | 'buy' | 'sell' | 'limit_buy' | 'limit_sell' | 'orders' | 'cancel' | 'history' | 'exchanges';

interface TradingConfig {
  exchanges?: Record<string, { apiKey: string; secret: string }>;
  defaultExchange?: string;
  defaultQuote?: string;
  maxOrderEur?: number;
  sandbox?: boolean;
}

/** Minimal interface for a ccxt exchange instance (dynamically loaded). */
interface CcxtExchange {
  id: string;
  setSandboxMode(enable: boolean): void;
  loadMarkets(): Promise<unknown>;
  fetchBalance(): Promise<{
    total: Record<string, number>;
    free: Record<string, number>;
    used: Record<string, number>;
  }>;
  fetchTicker(symbol: string): Promise<{
    symbol: string;
    last: number | null;
    bid: number | null;
    ask: number | null;
    high: number | null;
    low: number | null;
    percentage: number | null;
    baseVolume: number | null;
  }>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<{
    id: string;
    symbol: string;
    side: string;
    type: string;
    amount: number;
    filled: number | null;
    cost: number | null;
    average: number | null;
    status: string;
    fee: unknown;
  }>;
  fetchOpenOrders(symbol?: string): Promise<Array<{
    id: string;
    symbol: string;
    side: string;
    type: string;
    amount: number;
    price: number | null;
    status: string;
  }>>;
  cancelOrder(id: string, symbol?: string): Promise<unknown>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number): Promise<Array<{
    id: string;
    symbol: string;
    side: string;
    amount: number;
    price: number;
    cost: number;
    timestamp: number;
    datetime: string;
    fee: unknown;
  }>>;
}

export class TradingSkill extends Skill {
  private exchangeInstances = new Map<string, CcxtExchange>();
  private ccxtModule?: any;

  readonly metadata: SkillMetadata = {
    name: 'trading',
    category: 'information',
    description:
      'Crypto trading on exchanges (Binance, Kraken, Coinbase, Bitget, KuCoin, OKX etc.) via CCXT. ' +
      'Use action "balance" to see exchange balance. ' +
      'Use action "price" to get current price for a trading pair (e.g. BTC/EUR). ' +
      'Use action "buy" for market buy, "sell" for market sell. ' +
      'Use action "limit_buy" or "limit_sell" for limit orders. ' +
      'Use action "orders" to see open orders, "cancel" to cancel an order. ' +
      'Use action "history" to see trade history. ' +
      'Use action "exchanges" to list configured exchanges. ' +
      'Supports Watch conditions on data.last, data.bid, data.ask for price alerts.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['balance', 'price', 'buy', 'sell', 'limit_buy', 'limit_sell', 'orders', 'cancel', 'history', 'exchanges'],
          description: 'Action to perform',
        },
        exchange: {
          type: 'string',
          description: 'Exchange name (e.g. "binance", "kraken"). Uses default if omitted.',
        },
        pair: {
          type: 'string',
          description: 'Trading pair in BASE/QUOTE format (e.g. "BTC/EUR", "ETH/USDT"). Quote defaults to EUR if omitted (e.g. "BTC" → "BTC/EUR").',
        },
        amount: {
          type: 'number',
          description: 'Amount in base currency to buy/sell (e.g. 0.01 for 0.01 BTC)',
        },
        price: {
          type: 'number',
          description: 'Limit price for limit_buy/limit_sell',
        },
        order_id: {
          type: 'string',
          description: 'Order ID for cancel action',
        },
        limit: {
          type: 'number',
          description: 'Number of results for history (default 10, max 50)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly config?: TradingConfig) {
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
        case 'exchanges':
          return this.listExchanges();
        case 'balance':
          return await this.getBalance(input.exchange as string | undefined);
        case 'price':
          return await this.getPrice(input.exchange as string | undefined, input.pair as string | undefined);
        case 'buy':
          return await this.marketOrder('buy', input.exchange as string | undefined, input.pair as string | undefined, input.amount as number | undefined);
        case 'sell':
          return await this.marketOrder('sell', input.exchange as string | undefined, input.pair as string | undefined, input.amount as number | undefined);
        case 'limit_buy':
          return await this.limitOrder('buy', input.exchange as string | undefined, input.pair as string | undefined, input.amount as number | undefined, input.price as number | undefined);
        case 'limit_sell':
          return await this.limitOrder('sell', input.exchange as string | undefined, input.pair as string | undefined, input.amount as number | undefined, input.price as number | undefined);
        case 'orders':
          return await this.getOpenOrders(input.exchange as string | undefined, input.pair as string | undefined);
        case 'cancel':
          return await this.cancelOrder(input.exchange as string | undefined, input.order_id as string | undefined, input.pair as string | undefined);
        case 'history':
          return await this.getHistory(input.exchange as string | undefined, input.pair as string | undefined, input.limit as number | undefined);
        default:
          return { success: false, error: `Unknown action "${action}".` };
      }
    } catch (err: any) {
      // Map CCXT exception types to user-friendly messages
      const name = err?.constructor?.name ?? '';
      if (name === 'InsufficientFunds') return { success: false, error: `Nicht genug Guthaben: ${err.message}` };
      if (name === 'InvalidOrder') return { success: false, error: `Ungültige Order: ${err.message}` };
      if (name === 'AuthenticationError') return { success: false, error: `Authentifizierung fehlgeschlagen. Prüfe API Key und Secret für die Exchange.` };
      if (name === 'BadSymbol') return { success: false, error: `Unbekanntes Trading-Paar. Verwende das Format BASE/QUOTE (z.B. BTC/EUR).` };
      if (name === 'RateLimitExceeded') return { success: false, error: `Rate-Limit erreicht. Versuche es in einigen Sekunden erneut.` };
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Trading error: ${msg}` };
    }
  }

  // ── Actions ────────────────────────────────────────────────

  private listExchanges(): SkillResult {
    const exchanges = this.config?.exchanges;
    if (!exchanges || Object.keys(exchanges).length === 0) {
      return { success: false, error: 'Keine Exchanges konfiguriert. Setze ALFRED_TRADING_EXCHANGES und die zugehörigen API Keys in der .env Datei.' };
    }
    const defaultEx = this.config?.defaultExchange ?? Object.keys(exchanges)[0];
    const lines = ['**Konfigurierte Exchanges:**\n'];
    for (const name of Object.keys(exchanges)) {
      const isDefault = name === defaultEx ? ' (default)' : '';
      lines.push(`- **${name}**${isDefault}`);
    }
    lines.push(`\nDefault Quote-Currency: ${this.config?.defaultQuote ?? 'EUR'}`);
    lines.push(`Sandbox-Modus: ${this.config?.sandbox ? 'aktiv' : 'aus'}`);
    lines.push(`Max Order: ${this.eur(this.config?.maxOrderEur ?? 500)}`);
    return { success: true, data: { exchanges: Object.keys(exchanges), default: defaultEx }, display: lines.join('\n') };
  }

  private async getBalance(exchangeName: string | undefined): Promise<SkillResult> {
    const exchange = await this.getExchange(exchangeName);
    const balance = await exchange.fetchBalance();

    const lines = [`**${exchange.id} Guthaben:**\n`];
    const balances: Array<{ currency: string; free: number; used: number; total: number }> = [];

    for (const [currency, data] of Object.entries(balance.total as Record<string, number>)) {
      if (data <= 0) continue;
      const free = (balance.free as Record<string, number>)[currency] ?? 0;
      const used = (balance.used as Record<string, number>)[currency] ?? 0;
      balances.push({ currency, free, used, total: data });
      const usedStr = used > 0 ? ` (${used} in Orders)` : '';
      lines.push(`- **${currency}**: ${data}${usedStr}`);
    }

    if (balances.length === 0) {
      lines.push('Kein Guthaben vorhanden.');
    }

    return { success: true, data: { exchange: exchange.id, balances }, display: lines.join('\n') };
  }

  private async getPrice(exchangeName: string | undefined, pair: string | undefined): Promise<SkillResult> {
    if (!pair) return { success: false, error: 'Missing "pair". E.g. "BTC/EUR" or "BTC"' };

    const exchange = await this.getExchange(exchangeName);
    const symbol = this.resolvePair(pair);
    const ticker = await exchange.fetchTicker(symbol);

    const change = ticker.percentage != null ? ` (${ticker.percentage >= 0 ? '+' : ''}${ticker.percentage.toFixed(2)}%)` : '';

    return {
      success: true,
      data: {
        exchange: exchange.id,
        symbol: ticker.symbol,
        last: ticker.last,
        bid: ticker.bid,
        ask: ticker.ask,
        high: ticker.high,
        low: ticker.low,
        change_24h: ticker.percentage,
        volume: ticker.baseVolume,
      },
      display: `**${ticker.symbol}** auf ${exchange.id}: ${ticker.last}${change}\nBid: ${ticker.bid} | Ask: ${ticker.ask} | 24h H/L: ${ticker.high}/${ticker.low}`,
    };
  }

  private async marketOrder(side: 'buy' | 'sell', exchangeName: string | undefined, pair: string | undefined, amount: number | undefined): Promise<SkillResult> {
    if (!pair) return { success: false, error: 'Missing "pair". E.g. "BTC/EUR"' };
    if (!amount || amount <= 0) return { success: false, error: 'Missing or invalid "amount".' };

    const exchange = await this.getExchange(exchangeName);
    const symbol = this.resolvePair(pair);

    // Safety: estimate EUR value
    await this.checkOrderLimit(exchange, symbol, amount);

    const order = await exchange.createOrder(symbol, 'market', side, amount);
    const label = side === 'buy' ? '🟢 Kauf' : '🔴 Verkauf';

    return {
      success: true,
      data: {
        exchange: exchange.id,
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        amount: order.amount,
        filled: order.filled,
        cost: order.cost,
        average: order.average,
        status: order.status,
        fee: order.fee,
      },
      display: `${label} auf ${exchange.id}: ${order.filled ?? order.amount} ${symbol.split('/')[0]} @ ${order.average ?? 'market'} — Status: ${order.status}`,
    };
  }

  private async limitOrder(side: 'buy' | 'sell', exchangeName: string | undefined, pair: string | undefined, amount: number | undefined, price: number | undefined): Promise<SkillResult> {
    if (!pair) return { success: false, error: 'Missing "pair". E.g. "BTC/EUR"' };
    if (!amount || amount <= 0) return { success: false, error: 'Missing or invalid "amount".' };
    if (!price || price <= 0) return { success: false, error: 'Missing or invalid "price".' };

    const exchange = await this.getExchange(exchangeName);
    const symbol = this.resolvePair(pair);

    // Safety: check EUR value of the order
    const eurValue = amount * price;
    const maxOrder = this.config?.maxOrderEur ?? 500;
    if (eurValue > maxOrder) {
      return { success: false, error: `Orderwert ${this.eur(eurValue)} übersteigt das Limit von ${this.eur(maxOrder)}.` };
    }

    const order = await exchange.createOrder(symbol, 'limit', side, amount, price);
    const label = side === 'buy' ? '🟢 Limit-Kauf' : '🔴 Limit-Verkauf';

    return {
      success: true,
      data: { exchange: exchange.id, orderId: order.id, symbol: order.symbol, side, type: 'limit', amount, price, status: order.status },
      display: `${label} auf ${exchange.id}: ${amount} ${symbol.split('/')[0]} @ ${price} — Order-ID: ${order.id} — Status: ${order.status}`,
    };
  }

  private async getOpenOrders(exchangeName: string | undefined, pair: string | undefined): Promise<SkillResult> {
    const exchange = await this.getExchange(exchangeName);
    const symbol = pair ? this.resolvePair(pair) : undefined;
    const orders = await exchange.fetchOpenOrders(symbol);

    if (orders.length === 0) {
      return { success: true, data: { orders: [], count: 0 }, display: `Keine offenen Orders auf ${exchange.id}.` };
    }

    const lines = [`**${orders.length} offene Order(s) auf ${exchange.id}:**\n`];
    for (const o of orders) {
      const label = o.side === 'buy' ? '🟢' : '🔴';
      lines.push(`- ${label} ${o.type} ${o.side} ${o.amount} ${o.symbol} @ ${o.price} — ID: ${o.id}`);
    }

    return {
      success: true,
      data: { exchange: exchange.id, orders: orders.map((o) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, amount: o.amount, price: o.price, status: o.status })), count: orders.length },
      display: lines.join('\n'),
    };
  }

  private async cancelOrder(exchangeName: string | undefined, orderId: string | undefined, pair: string | undefined): Promise<SkillResult> {
    if (!orderId) return { success: false, error: 'Missing "order_id".' };

    const exchange = await this.getExchange(exchangeName);
    const symbol = pair ? this.resolvePair(pair) : undefined;
    const result = await exchange.cancelOrder(orderId, symbol);

    return {
      success: true,
      data: { exchange: exchange.id, orderId, status: 'canceled' },
      display: `Order ${orderId} auf ${exchange.id} storniert.`,
    };
  }

  private async getHistory(exchangeName: string | undefined, pair: string | undefined, limit: number | undefined): Promise<SkillResult> {
    const exchange = await this.getExchange(exchangeName);
    const symbol = pair ? this.resolvePair(pair) : undefined;
    const count = Math.min(Math.max(1, limit ?? 10), 50);
    const trades = await exchange.fetchMyTrades(symbol, undefined, count);

    if (trades.length === 0) {
      return { success: true, data: { trades: [], count: 0 }, display: `Keine Trades auf ${exchange.id}.` };
    }

    const lines = [`**Letzte ${trades.length} Trades auf ${exchange.id}:**\n`];
    for (const t of trades) {
      const label = t.side === 'buy' ? '🟢 Kauf' : '🔴 Verkauf';
      const date = new Date(t.timestamp).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
      lines.push(`- ${date} ${label} ${t.amount} ${t.symbol} @ ${t.price} (Kosten: ${t.cost})`);
    }

    return {
      success: true,
      data: { exchange: exchange.id, trades: trades.map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, amount: t.amount, price: t.price, cost: t.cost, date: t.datetime, fee: t.fee })), count: trades.length },
      display: lines.join('\n'),
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  private async loadCcxt(): Promise<any> {
    if (!this.ccxtModule) {
      this.ccxtModule = await (Function('return import("ccxt")')() as Promise<any>);
      if (this.ccxtModule.default) this.ccxtModule = this.ccxtModule.default;
    }
    return this.ccxtModule;
  }

  private async getExchange(name?: string): Promise<CcxtExchange> {
    const exchanges = this.config?.exchanges;
    if (!exchanges || Object.keys(exchanges).length === 0) {
      throw new Error('Keine Exchanges konfiguriert. Setze ALFRED_TRADING_EXCHANGES in der .env Datei.');
    }

    const exchangeName = (name ?? this.config?.defaultExchange ?? Object.keys(exchanges)[0]).toLowerCase();
    const creds = exchanges[exchangeName];
    if (!creds) {
      throw new Error(`Exchange "${exchangeName}" nicht konfiguriert. Verfügbar: ${Object.keys(exchanges).join(', ')}`);
    }

    if (!this.exchangeInstances.has(exchangeName)) {
      const ccxt = await this.loadCcxt();
      const ExchangeClass = ccxt[exchangeName];
      if (!ExchangeClass) {
        throw new Error(`Exchange "${exchangeName}" wird von CCXT nicht unterstützt.`);
      }
      const instance = new ExchangeClass({
        apiKey: creds.apiKey,
        secret: creds.secret,
        enableRateLimit: true,
      });
      if (this.config?.sandbox) {
        instance.setSandboxMode(true);
      }
      await instance.loadMarkets();
      this.exchangeInstances.set(exchangeName, instance);
    }

    return this.exchangeInstances.get(exchangeName)!;
  }

  private resolvePair(input: string): string {
    const trimmed = input.trim().toUpperCase();
    if (trimmed.includes('/')) return trimmed;
    const quote = (this.config?.defaultQuote ?? 'EUR').toUpperCase();
    return `${trimmed}/${quote}`;
  }

  private async checkOrderLimit(exchange: CcxtExchange, symbol: string, amount: number): Promise<void> {
    const maxOrder = this.config?.maxOrderEur ?? 500;
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const quote = symbol.split('/')[1];
      let eurValue = amount * (ticker.last ?? 0);
      // If quote is not EUR, rough conversion
      if (quote !== 'EUR' && quote !== 'eur') {
        try {
          const eurTicker = await exchange.fetchTicker(`${quote}/EUR`);
          eurValue *= eurTicker.last ?? 1;
        } catch {
          // Can't convert, skip limit check for non-EUR pairs
          return;
        }
      }
      if (eurValue > maxOrder) {
        throw new Error(`Geschätzter Orderwert ${this.eur(eurValue)} übersteigt das Limit von ${this.eur(maxOrder)}. Anpassen: ALFRED_TRADING_MAX_ORDER_EUR in .env`);
      }
    } catch (err: any) {
      if (err.message?.includes('Limit')) throw err;
      throw new Error(`Limit-Check fehlgeschlagen (Ticker nicht verfügbar): ${err.message ?? err}. Order aus Sicherheitsgründen abgelehnt.`);
    }
  }

  private eur(value: number): string {
    return value.toLocaleString('de-AT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
