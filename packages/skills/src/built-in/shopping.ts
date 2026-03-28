import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export class ShoppingSkill extends Skill {
  private cache = new Map<string, { data: unknown; expiresAt: number }>();
  private readonly SEARCH_CACHE_TTL = 300_000;   // 5 min
  private readonly DETAIL_CACHE_TTL = 600_000;   // 10 min
  private readonly HISTORY_CACHE_TTL = 3600_000;  // 1h
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 2000;   // 2s between requests
  private puppeteerModule: any = null;
  private puppeteerBrowser: any = null;
  /** Track if fetch works or if we need Puppeteer */
  private usePuppeteer = false;

  private readonly HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  readonly metadata: SkillMetadata = {
    name: 'shopping',
    description: 'Produktsuche und Preisvergleich über Geizhals.at. ' +
      'Produkte suchen, Preise vergleichen, günstigste Angebote finden. ' +
      'Shopping, Preisvergleich, kaufen, bestellen, Preis, günstig, billig, Angebot, teuer, ' +
      'Geizhals, Produkt, Notebook, Laptop, Smartphone, Handy, Fernseher, TV, ' +
      'Grafikkarte, GPU, Monitor, SSD, Festplatte, Prozessor, CPU, Kopfhörer, ' +
      'Kamera, Tablet, Smartwatch, Kaffeemaschine, Staubsauger, Waschmaschine, ' +
      'Preishistorie, Preisverlauf, Preisalert, Testbericht. ' +
      'WICHTIG: Präsentiere Ergebnisse in der Sprache des Users.',
    version: '1.0.0',
    riskLevel: 'read',
    category: 'information',
    timeoutMs: 20_000,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'category', 'detail', 'price_history', 'compare', 'cheapest'],
          description: 'search (Freitextsuche), category (Kategorie-Suche), detail (Produkt-Details mit allen Anbietern), price_history (Preisverlauf), compare (Produkte vergleichen), cheapest (günstigstes Angebot, Watch-kompatibel)',
        },
        query: { type: 'string', description: 'Suchbegriff' },
        cat: {
          type: 'string',
          description: 'Geizhals Kategorie: nb (Notebooks), sm (Smartphones), tvlcd (Fernseher), gra16 (Grafikkarten), monlcd19wide (Monitore), hd (SSDs/Festplatten), cpu (Prozessoren), ram (RAM), sw (Smartwatches), kaf (Kaffeemaschinen), staub (Staubsauger), wama (Waschmaschinen), kuehl (Kühlschränke)',
        },
        filter: { type: 'string', description: 'Geizhals XF-Filter (z.B. "525_Apple", "148_Samsung")' },
        sort: { type: 'string', enum: ['price', 'rating', 'popularity'], description: 'Sortierung (default: price)' },
        maxPrice: { type: 'number', description: 'Max Preis in EUR' },
        limit: { type: 'number', description: 'Max Ergebnisse (default: 10, max: 30)' },
        url: { type: 'string', description: 'Geizhals Produkt-URL für detail/cheapest' },
        productId: { type: 'string', description: 'Geizhals Produkt-ID (z.B. "v192279", "a3434077")' },
        productIds: { type: 'array', items: { type: 'string' }, description: 'IDs zum Vergleichen' },
      },
    },
  };

  constructor() {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;
    try {
      switch (action) {
        case 'search':
          return await this.search(input);
        case 'category':
          return await this.categorySearch(input);
        case 'detail':
          return await this.detail(input);
        case 'price_history':
          return await this.priceHistory(input);
        case 'compare':
          return await this.compare(input);
        case 'cheapest':
          return await this.cheapest(input);
        default:
          return { success: false, error: `Unbekannte Action: ${action}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── Actions ──────────────────────────────────────────────────

  private async search(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string | undefined;
    if (!query) return { success: false, error: 'Suchbegriff (query) fehlt' };

    const sort = this.mapSort(input.sort as string | undefined);
    const limit = Math.min(Number(input.limit) || 10, 30);
    const maxPrice = input.maxPrice as number | undefined;

    let url = `https://geizhals.at/?fs=${encodeURIComponent(query)}&hloc=at&sort=${sort}`;
    if (maxPrice) url += `&bpmax=${maxPrice}`;

    // Prefer DOM extraction via Puppeteer (Geizhals is a JS SPA)
    let results = await this.extractProductsFromPage(url, limit);
    if (results.length === 0) {
      // Fallback: regex on HTML (works if Geizhals returns server-rendered HTML)
      const html = await this.fetchGeizhals(url, this.SEARCH_CACHE_TTL);
      results = this.parseSearchResults(html, limit);
    }

    if (results.length === 0) {
      return {
        success: true,
        data: { results: [], query },
        display: `Keine Ergebnisse für "${query}" auf Geizhals.at gefunden.`,
      };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. ${r.name}\n   💰 ab € ${r.price?.toFixed(2) ?? '–'} | ${r.url}`
    );

    return {
      success: true,
      data: { results, query, result_count: results.length },
      display: `Geizhals-Suche: "${query}" — ${results.length} Ergebnis(se)\n\n${lines.join('\n\n')}`,
    };
  }

  private async categorySearch(input: Record<string, unknown>): Promise<SkillResult> {
    const cat = input.cat as string | undefined;
    if (!cat) return { success: false, error: 'Kategorie (cat) fehlt' };

    const sort = this.mapSort(input.sort as string | undefined);
    const limit = Math.min(Number(input.limit) || 10, 30);
    const filter = input.filter as string | undefined;
    const maxPrice = input.maxPrice as number | undefined;

    let url = `https://geizhals.at/?cat=${encodeURIComponent(cat)}&sort=${sort}&hloc=at`;
    if (filter) url += `&xf=${encodeURIComponent(filter)}`;
    if (maxPrice) url += `&bpmax=${maxPrice}`;

    // Prefer DOM extraction via Puppeteer (Geizhals is a JS SPA)
    let results = await this.extractProductsFromPage(url, limit);
    if (results.length === 0) {
      const html = await this.fetchGeizhals(url, this.SEARCH_CACHE_TTL);
      results = this.parseSearchResults(html, limit);
    }

    if (results.length === 0) {
      return {
        success: true,
        data: { results: [], cat },
        display: `Keine Ergebnisse in Kategorie "${cat}" gefunden.`,
      };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. ${r.name}\n   ab € ${r.price?.toFixed(2) ?? '–'} | ${r.url}`
    );

    return {
      success: true,
      data: { results, cat, result_count: results.length },
      display: `Geizhals Kategorie "${cat}" — ${results.length} Ergebnis(se)\n\n${lines.join('\n\n')}`,
    };
  }

  private async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const url = this.resolveProductUrl(input);
    if (!url) return { success: false, error: 'Produkt-URL oder productId fehlt' };

    const html = await this.fetchGeizhals(url, this.DETAIL_CACHE_TTL);
    const productId = this.extractProductId(url);

    // Parse product name from <h1> or <title>
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const name = this.decodeEntities((h1Match?.[1] ?? titleMatch?.[1] ?? 'Unbekanntes Produkt').trim());

    // Parse prices from the page
    const prices = [...html.matchAll(/€\s*([\d.,]+)/g)]
      .map(m => parseFloat(m[1].replace('.', '').replace(',', '.')))
      .filter(p => !isNaN(p) && p > 0);

    const uniquePrices = [...new Set(prices)].sort((a, b) => a - b);
    const cheapest = uniquePrices[0];
    const offerCount = prices.length;

    // Try to parse shop offers
    const offers = this.parseOffers(html);

    const display = [
      `${name}`,
      cheapest ? `Günstigster Preis: € ${cheapest.toFixed(2)}` : 'Kein Preis verfügbar',
      `Angebote: ${offerCount > 0 ? offerCount : '–'}`,
      offers.length > 0
        ? '\nAnbieter:\n' + offers.slice(0, 10).map(o => `  • ${o.shop}: € ${o.price.toFixed(2)}`).join('\n')
        : '',
      `\n${url}`,
    ].filter(Boolean).join('\n');

    return {
      success: true,
      data: {
        productName: name,
        productId,
        cheapest_price: cheapest ?? null,
        offer_count: offerCount,
        offers: offers.slice(0, 20),
        url,
      },
      display,
    };
  }

  private async priceHistory(input: Record<string, unknown>): Promise<SkillResult> {
    const productId = input.productId as string | undefined ?? this.extractProductId(input.url as string | undefined ?? '');
    if (!productId) return { success: false, error: 'productId oder Produkt-URL fehlt' };

    const apiUrl = `https://geizhals.at/api/gh0/price_history/${productId}?hloc=at`;

    try {
      await this.throttle();
      const cached = this.getCached<string>(apiUrl);
      let text: string;
      if (cached) {
        text = cached;
      } else {
        const res = await fetch(apiUrl, {
          headers: { ...this.HEADERS, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        text = await res.text();
        this.setCache(apiUrl, text, this.HISTORY_CACHE_TTL);
      }

      const data = JSON.parse(text);
      // Geizhals price_history returns an array of [timestamp, price] pairs or similar
      let prices: number[] = [];
      if (Array.isArray(data)) {
        prices = data.map((d: unknown) => {
          if (Array.isArray(d) && d.length >= 2) return Number(d[1]);
          return NaN;
        }).filter((p: number) => !isNaN(p) && p > 0);
      } else if (data.history && Array.isArray(data.history)) {
        prices = data.history.map((d: unknown) => {
          if (Array.isArray(d) && d.length >= 2) return Number(d[1]);
          return NaN;
        }).filter((p: number) => !isNaN(p) && p > 0);
      }

      if (prices.length === 0) {
        return {
          success: true,
          data: { productId, history_available: false },
          display: `Preishistorie für ${productId} nicht verfügbar oder leer.`,
        };
      }

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const current = prices[prices.length - 1];
      const trend = prices.length >= 2
        ? (current > prices[prices.length - 2] ? 'steigend' : current < prices[prices.length - 2] ? 'fallend' : 'stabil')
        : 'unbekannt';

      return {
        success: true,
        data: { productId, min, max, current, trend, data_points: prices.length },
        display: [
          `Preisverlauf für ${productId}:`,
          `  Aktuell: € ${current.toFixed(2)}`,
          `  Minimum: € ${min.toFixed(2)}`,
          `  Maximum: € ${max.toFixed(2)}`,
          `  Trend: ${trend}`,
          `  Datenpunkte: ${prices.length}`,
        ].join('\n'),
      };
    } catch {
      return {
        success: true,
        data: { productId, history_available: false },
        display: `Preishistorie für ${productId} nicht verfügbar (API-Endpunkt nicht erreichbar).`,
      };
    }
  }

  private async compare(input: Record<string, unknown>): Promise<SkillResult> {
    const ids = input.productIds as string[] | undefined;
    if (!ids || ids.length < 2) return { success: false, error: 'Mindestens 2 productIds zum Vergleichen nötig' };

    const results: Array<{ productId: string; name: string; cheapest_price: number | null; url: string }> = [];

    for (const id of ids.slice(0, 5)) {
      const url = `https://geizhals.at/${id}.html`;
      try {
        const html = await this.fetchGeizhals(url, this.DETAIL_CACHE_TTL);
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const name = this.decodeEntities((h1Match?.[1] ?? titleMatch?.[1] ?? id).trim());
        const prices = [...html.matchAll(/€\s*([\d.,]+)/g)]
          .map(m => parseFloat(m[1].replace('.', '').replace(',', '.')))
          .filter(p => !isNaN(p) && p > 0);
        const cheapest = prices.length > 0 ? Math.min(...prices) : null;
        results.push({ productId: id, name, cheapest_price: cheapest, url });
      } catch {
        results.push({ productId: id, name: id, cheapest_price: null, url });
      }
    }

    const lines = results.map((r, i) =>
      `${i + 1}. ${r.name}\n   ab € ${r.cheapest_price?.toFixed(2) ?? '–'} | ${r.url}`
    );

    return {
      success: true,
      data: { products: results },
      display: `Produktvergleich (${results.length} Produkte):\n\n${lines.join('\n\n')}`,
    };
  }

  private async cheapest(input: Record<string, unknown>): Promise<SkillResult> {
    // If URL/ID given, get detail directly
    const productUrl = this.resolveProductUrl(input);
    if (productUrl) {
      const html = await this.fetchGeizhals(productUrl, this.DETAIL_CACHE_TTL);
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const name = this.decodeEntities((h1Match?.[1] ?? titleMatch?.[1] ?? 'Unbekannt').trim());
      const offers = this.parseOffers(html);
      const prices = [...html.matchAll(/€\s*([\d.,]+)/g)]
        .map(m => parseFloat(m[1].replace('.', '').replace(',', '.')))
        .filter(p => !isNaN(p) && p > 0);
      const cheapest = prices.length > 0 ? Math.min(...prices) : null;
      const cheapestOffer = offers.length > 0 ? offers[0] : null;

      return {
        success: true,
        data: {
          productName: name,
          cheapest_price: cheapest,
          cheapest_shop: cheapestOffer?.shop ?? null,
          offer_count: prices.length,
          url: productUrl,
        },
        display: cheapest
          ? `${name}: ab € ${cheapest.toFixed(2)}${cheapestOffer ? ` bei ${cheapestOffer.shop}` : ''} (${prices.length} Angebote)\n${productUrl}`
          : `${name}: Kein Preis verfügbar\n${productUrl}`,
      };
    }

    // Otherwise search first, then get cheapest from first result
    const query = input.query as string | undefined;
    if (!query) return { success: false, error: 'query oder url/productId fehlt' };

    const searchUrl = `https://geizhals.at/?fs=${encodeURIComponent(query)}&hloc=at&sort=p`;
    let results = await this.extractProductsFromPage(searchUrl, 1);
    if (results.length === 0) {
      const html = await this.fetchGeizhals(searchUrl, this.SEARCH_CACHE_TTL);
      results = this.parseSearchResults(html, 1);
    }

    if (results.length === 0) {
      return {
        success: true,
        data: { query, cheapest_price: null },
        display: `Keine Ergebnisse für "${query}" auf Geizhals.at.`,
      };
    }

    const top = results[0];
    return {
      success: true,
      data: {
        productName: top.name,
        cheapest_price: top.price,
        cheapest_shop: null,
        offer_count: null,
        url: top.url,
      },
      display: top.price
        ? `${top.name}: ab € ${top.price.toFixed(2)}\n${top.url}`
        : `${top.name}: Preis nicht verfügbar\n${top.url}`,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────

  private mapSort(sort: string | undefined): string {
    switch (sort) {
      case 'rating': return 'r';
      case 'popularity': return 't';
      default: return 'p';
    }
  }

  private resolveProductUrl(input: Record<string, unknown>): string | undefined {
    const url = input.url as string | undefined;
    if (url?.includes('geizhals.at/')) return url;
    const id = input.productId as string | undefined;
    if (id) return `https://geizhals.at/${id}.html`;
    return undefined;
  }

  private extractProductId(url: string): string | undefined {
    const m = url.match(/-(v\d+|a\d+)\.html/);
    return m?.[1];
  }

  private parseSearchResults(html: string, limit: number): Array<{ name: string; price: number | null; url: string; productId: string | undefined }> {
    const products = [...html.matchAll(/href="(https:\/\/geizhals\.at\/[^"]+\.html)"[^>]*title="([^"]+)"/g)]
      .map(m => ({ url: m[1], name: this.decodeEntities(m[2]) }))
      .filter(p => p.name.length > 10);

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique = products.filter(p => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    });

    // Prefer real products (v-IDs) over accessories (a-IDs)
    const hasMainProducts = unique.some(p => /-(v\d+)\.html/.test(p.url));
    const filtered = hasMainProducts
      ? unique.filter(p => !/-a\d+\.html/.test(p.url))
      : unique;

    // Try to extract price near each product link for accurate association
    return filtered.slice(0, limit).map(p => {
      // Find price closest to this product's link in the HTML
      const linkIdx = html.indexOf(p.url);
      let price: number | null = null;
      if (linkIdx >= 0) {
        // Search in a window around the link for the nearest price
        const window = html.slice(Math.max(0, linkIdx - 200), linkIdx + 500);
        const priceMatch = window.match(/€\s*([\d.,]+)/);
        if (priceMatch) {
          const parsed = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
          if (!isNaN(parsed) && parsed > 0) price = parsed;
        }
      }
      return {
        name: p.name,
        price,
        url: p.url,
        productId: this.extractProductId(p.url),
      };
    });
  }

  private parseOffers(html: string): Array<{ shop: string; price: number }> {
    // Try to extract shop name + price pairs from detail pages
    const offers: Array<{ shop: string; price: number }> = [];

    // Pattern: shop name near a price on detail pages
    const offerMatches = [...html.matchAll(/class="offer__clickout"[^>]*>.*?<\/a>.*?class="offer__price[^"]*"[^>]*>([\d.,]+)/gs)];
    if (offerMatches.length > 0) {
      for (const m of offerMatches) {
        const price = parseFloat(m[1].replace('.', '').replace(',', '.'));
        if (!isNaN(price) && price > 0) {
          offers.push({ shop: 'Anbieter', price });
        }
      }
    }

    // Fallback: simpler pattern for merchant names and prices
    if (offers.length === 0) {
      const merchantMatches = [...html.matchAll(/class="merchant__logo-caption"[^>]*>([^<]+)<\/span>.*?€\s*([\d.,]+)/gs)];
      for (const m of merchantMatches) {
        const shop = this.decodeEntities(m[1].trim());
        const price = parseFloat(m[2].replace('.', '').replace(',', '.'));
        if (!isNaN(price) && price > 0 && shop) {
          offers.push({ shop, price });
        }
      }
    }

    return offers.sort((a, b) => a.price - b.price);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.MIN_REQUEST_INTERVAL) {
      await new Promise(r => setTimeout(r, this.MIN_REQUEST_INTERVAL - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /** Stored Cloudflare cookies — persisted across requests to avoid repeated challenges. */
  private cfCookies = '';

  private async fetchGeizhals(url: string, ttl: number): Promise<string> {
    await this.throttle();
    const cached = this.getCached<string>(url);
    if (cached) return cached;

    // If previous requests needed Puppeteer, skip fetch and go straight to browser
    if (this.usePuppeteer) {
      return this.fetchWithPuppeteer(url, ttl);
    }

    // Try fetch first (fast path)
    const headers: Record<string, string> = { ...this.HEADERS };
    if (this.cfCookies) headers['Cookie'] = this.cfCookies;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (fetchErr: any) {
      // Network error — try Puppeteer
      return this.fetchWithPuppeteer(url, ttl);
    }

    this.extractCookies(res);

    if (res.ok) {
      const html = await res.text();
      this.setCache(url, html, ttl);
      return html;
    }

    if (res.status === 403) {
      console.warn(`[ShoppingSkill] Geizhals 403 — switching to Puppeteer fallback`);
      this.usePuppeteer = true;
      return this.fetchWithPuppeteer(url, ttl);
    }

    throw new Error(`Geizhals Fehler: ${res.status}`);
  }

  /** Fallback: use Puppeteer (headless Chromium) to bypass Cloudflare JS challenges. */
  private async fetchWithPuppeteer(url: string, ttl: number): Promise<string> {
    const pup = await this.loadPuppeteer();
    if (!pup) {
      throw new Error('Geizhals Cloudflare Challenge — Puppeteer/Chromium nicht installiert. Installiere: apt install chromium-browser && npm install puppeteer');
    }

    if (!this.puppeteerBrowser || !this.puppeteerBrowser.connected) {
      this.puppeteerBrowser = await pup.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }

    const page = await this.puppeteerBrowser.newPage();
    try {
      await page.setUserAgent(this.HEADERS['User-Agent']);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25_000 });
      // Wait for JS-rendered product list (Geizhals is a SPA)
      await page.waitForSelector('.productlist__item, .listview__item, .cat_list, [data-productid], .productlist', {
        timeout: 8000,
      }).catch(() => {});
      const html = await page.content();
      this.setCache(url, html, ttl);
      return html;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Extract products directly from the rendered DOM via Puppeteer.
   * Much more reliable than regex on HTML since Geizhals is a JS SPA.
   */
  private async extractProductsFromPage(url: string, limit: number): Promise<Array<{ name: string; price: number | null; url: string; productId: string | undefined }>> {
    const pup = await this.loadPuppeteer();
    if (!pup) return []; // fall back to regex parsing

    if (!this.puppeteerBrowser || !this.puppeteerBrowser.connected) {
      this.puppeteerBrowser = await pup.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }

    const page = await this.puppeteerBrowser.newPage();
    try {
      await page.setUserAgent(this.HEADERS['User-Agent']);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25_000 });
      await page.waitForSelector('.productlist__item, .listview__item, .cat_list, [data-productid]', {
        timeout: 8000,
      }).catch(() => {});

      const products: Array<{ name: string; price: number | null; url: string }> = await page.evaluate((maxResults: number) => {
        const items: Array<{ name: string; price: number | null; url: string }> = [];
        const selectors = [
          '.productlist__item',
          '.listview__item',
          '.cat-list-item',
          '[data-productid]',
        ];
        let elements: any[] = [];
        for (const sel of selectors) {
          elements = Array.from((globalThis as any).document.querySelectorAll(sel));
          if (elements.length > 0) break;
        }
        for (const el of elements.slice(0, maxResults)) {
          const linkEl = el.querySelector('a[href*="geizhals.at/"]') ?? el.querySelector('a[href$=".html"]') ?? el.querySelector('a');
          const nameEl = el.querySelector('.productlist__name, .listview__name, .productlist__link, a[title]');
          const priceEl = el.querySelector('.productlist__price, .listview__price, .price');
          const name = ((nameEl?.textContent ?? linkEl?.getAttribute('title')) || '').trim();
          const href = linkEl?.getAttribute('href') ?? '';
          const priceText = priceEl?.textContent ?? '';
          const priceMatch = priceText.match(/[\d.,]+/);
          let price: number | null = null;
          if (priceMatch) {
            price = parseFloat(priceMatch[0].replace(/\./g, '').replace(',', '.'));
            if (isNaN(price)) price = null;
          }
          if (name.length > 5 && href) {
            const fullUrl = href.startsWith('http') ? href : `https://geizhals.at${href}`;
            items.push({ name, price, url: fullUrl });
          }
        }
        return items;
      }, limit);

      return products.map((p: { name: string; price: number | null; url: string }) => ({
        ...p,
        productId: this.extractProductId(p.url),
      }));
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async loadPuppeteer(): Promise<any> {
    if (this.puppeteerModule) return this.puppeteerModule;
    try {
      const mod = await (Function('return import("puppeteer")')() as Promise<any>);
      this.puppeteerModule = mod.default ?? mod;
      return this.puppeteerModule;
    } catch {
      try {
        const mod = await (Function('return import("puppeteer-core")')() as Promise<any>);
        this.puppeteerModule = mod.default ?? mod;
        return this.puppeteerModule;
      } catch {
        return null;
      }
    }
  }

  private extractCookies(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      // Fallback: try raw header
      const raw = res.headers.get('set-cookie');
      if (raw) setCookies.push(...raw.split(/,(?=\s*\w+=)/));
    }
    if (setCookies.length > 0) {
      const existing = new Map<string, string>();
      // Parse existing cookies
      for (const c of this.cfCookies.split('; ').filter(Boolean)) {
        const [k] = c.split('=', 1);
        if (k) existing.set(k, c);
      }
      // Merge new cookies
      for (const sc of setCookies) {
        const cookiePart = sc.split(';')[0].trim();
        const [k] = cookiePart.split('=', 1);
        if (k) existing.set(k, cookiePart);
      }
      this.cfCookies = [...existing.values()].join('; ');
    }
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  }

  private getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  private setCache(key: string, data: unknown, ttl: number): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttl });
    // Evict old entries if cache grows too large
    if (this.cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (v.expiresAt < now) this.cache.delete(k);
      }
    }
  }
}
