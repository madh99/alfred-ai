import type { SkillMetadata, SkillContext, SkillResult, MarketplaceConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { MarketplaceProvider, MarketplaceListing, MarketplaceSearchResult } from './marketplace-provider.js';
import { WillhabenProvider } from './willhaben-provider.js';
import { EbayProvider } from './ebay-provider.js';

type Action = 'search' | 'compare' | 'detail';
type Platform = 'willhaben' | 'ebay' | 'all';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatPrice(price: number | null, currency: string): string {
  if (price == null) return 'k.A.';
  return `${price.toFixed(2)} ${currency}`;
}

export class MarketplaceSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'marketplace',
    category: 'information',
    description:
      'Marktplatz-Suche auf willhaben.at und eBay. ' +
      '"search" liefert Inseratliste mit Preisstatistik. ' +
      '"compare" liefert Preisvergleich + günstigste 5. ' +
      '"detail" zeigt Einzelinserat mit Beschreibung, Fotos, Verkäufer. ' +
      'Filter: priceMin/priceMax, sort, condition (new/used), postcode. ' +
      'Watch-kompatibel: search→"count"/"minPrice", compare→"minPrice"/"avgPrice".',
    riskLevel: 'read',
    version: '2.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'compare', 'detail'],
          description: 'Aktion: search = Inserate auflisten, compare = Preisstatistik, detail = Einzelinserat',
        },
        query: {
          type: 'string',
          description: 'Suchbegriff (für search/compare)',
        },
        platform: {
          type: 'string',
          enum: ['willhaben', 'ebay', 'all'],
          description: 'Plattform (default: willhaben)',
        },
        priceMin: {
          type: 'number',
          description: 'Mindestpreis EUR',
        },
        priceMax: {
          type: 'number',
          description: 'Höchstpreis EUR',
        },
        rows: {
          type: 'number',
          description: 'Max Ergebnisse (default 50, max 200)',
        },
        sort: {
          type: 'string',
          enum: ['price_asc', 'price_desc', 'date_desc'],
          description: 'Sortierung',
        },
        condition: {
          type: 'string',
          enum: ['new', 'used'],
          description: 'Zustand',
        },
        postcode: {
          type: 'string',
          description: 'PLZ-Filter (z.B. "1010")',
        },
        listing_id: {
          type: 'string',
          description: 'Inserat-ID für detail-Aktion',
        },
      },
      required: ['action'],
    },
  };

  private readonly providers: MarketplaceProvider[] = [];

  constructor(config?: MarketplaceConfig) {
    super();
    this.providers.push(new WillhabenProvider());
    if (config?.ebay?.appId && config?.ebay?.certId) {
      this.providers.push(new EbayProvider(config.ebay.appId, config.ebay.certId));
    }
  }

  async execute(params: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = params.action as Action;
    const platform = (params.platform as Platform) ?? 'willhaben';
    const query = params.query as string | undefined;
    const priceMin = params.priceMin as number | undefined;
    const priceMax = params.priceMax as number | undefined;
    const rows = Math.min((params.rows as number) ?? 50, 200);
    const sort = params.sort as 'price_asc' | 'price_desc' | 'date_desc' | undefined;
    const condition = params.condition as 'new' | 'used' | undefined;
    const postcode = params.postcode as string | undefined;

    if (action === 'detail') {
      const listingId = params.listing_id as string | undefined;
      if (!listingId) return { success: false, error: 'listing_id ist erforderlich für detail-Aktion' };
      return this.handleDetail(platform, listingId);
    }

    if (!query) return { success: false, error: 'query ist erforderlich für search/compare' };

    const providers = this.getProviders(platform);
    if (providers.length === 0) {
      return { success: false, error: 'Keine Marketplace-Provider verfügbar für diese Plattform' };
    }

    const searchParams = { query, priceMin, priceMax, rows, sort, condition, postcode };

    switch (action) {
      case 'search': return this.handleSearch(providers, searchParams);
      case 'compare': return this.handleCompare(providers, { ...searchParams, rows: Math.min(rows, 200) });
      default: return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private getProviders(platform: Platform): MarketplaceProvider[] {
    if (platform === 'all') return this.providers;
    return this.providers.filter(p => p.platform === platform);
  }

  private async handleSearch(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number; sort?: string; condition?: string; postcode?: string },
  ): Promise<SkillResult> {
    const results = await this.searchAll(providers, params);
    const allListings = results.flatMap(r => r.listings);

    if (allListings.length === 0) {
      return {
        success: true,
        data: { query: params.query, count: 0, totalCount: 0, minPrice: null, maxPrice: null, medianPrice: null, listings: [] },
        display: `Keine Inserate gefunden für "${params.query}".`,
      };
    }

    const prices = allListings.map(l => l.price).filter((p): p is number => p != null);

    // Build display (Markdown table as before)
    const lines: string[] = [];
    lines.push(`**${allListings.length} Inserate** für "${params.query}"${results.length > 1 ? ` (${results.map(r => `${r.platform}: ${r.listings.length}`).join(', ')})` : ''}\n`);
    lines.push('| # | Titel | Preis | Standort | Plattform | Link |');
    lines.push('|---|-------|-------|----------|-----------|------|');

    for (let i = 0; i < allListings.length; i++) {
      const l = allListings[i];
      const title = l.title.length > 60 ? l.title.slice(0, 57) + '...' : l.title;
      lines.push(`| ${i + 1} | ${title} | ${formatPrice(l.price, l.currency)} | ${l.location ?? '—'} | ${l.platform} | [Link](${l.url}) |`);
    }

    if (prices.length > 0) {
      lines.push('');
      lines.push(`**Min:** ${Math.min(...prices).toFixed(2)} EUR | **Max:** ${Math.max(...prices).toFixed(2)} EUR | **Median:** ${median(prices).toFixed(2)} EUR`);
    }

    return {
      success: true,
      data: {
        query: params.query,
        count: allListings.length,
        totalCount: results.reduce((s, r) => s + r.totalCount, 0),
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        medianPrice: prices.length ? median(prices) : null,
        listings: allListings.map(l => ({
          id: l.id, title: l.title, price: l.price,
          location: l.location, url: l.url, platform: l.platform,
        })),
      },
      display: lines.join('\n'),
    };
  }

  private async handleCompare(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number; sort?: string; condition?: string; postcode?: string },
  ): Promise<SkillResult> {
    const results = await this.searchAll(providers, params);
    const allListings = results.flatMap(r => r.listings);
    const prices = allListings.map(l => l.price).filter((p): p is number => p != null);

    if (prices.length === 0) {
      return {
        success: true,
        data: { query: params.query, count: 0, minPrice: null, maxPrice: null, medianPrice: null, avgPrice: null, cheapest: [] },
        display: `Keine Inserate mit Preisangabe gefunden für "${params.query}".`,
      };
    }

    const sorted = allListings
      .filter((l): l is MarketplaceListing & { price: number } => l.price != null)
      .sort((a, b) => a.price - b.price);
    const cheapest = sorted.slice(0, 5);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    // Build display (Markdown table as before)
    const lines: string[] = [];
    lines.push(`**Preisvergleich** "${params.query}" — ${allListings.length} Inserate (${prices.length} mit Preis)\n`);
    lines.push('| Statistik | Wert |');
    lines.push('|-----------|------|');
    lines.push(`| Anzahl | ${prices.length} |`);
    lines.push(`| Minimum | ${Math.min(...prices).toFixed(2)} EUR |`);
    lines.push(`| Maximum | ${Math.max(...prices).toFixed(2)} EUR |`);
    lines.push(`| Median | ${median(prices).toFixed(2)} EUR |`);
    lines.push(`| Durchschnitt | ${avg.toFixed(2)} EUR |`);
    lines.push('');
    lines.push('**Günstigste 5:**\n');
    lines.push('| # | Titel | Preis | Standort | Plattform | Link |');
    lines.push('|---|-------|-------|----------|-----------|------|');

    for (let i = 0; i < cheapest.length; i++) {
      const l = cheapest[i];
      const title = l.title.length > 60 ? l.title.slice(0, 57) + '...' : l.title;
      lines.push(`| ${i + 1} | ${title} | ${formatPrice(l.price, l.currency)} | ${l.location ?? '—'} | ${l.platform} | [Link](${l.url}) |`);
    }

    return {
      success: true,
      data: {
        query: params.query,
        count: prices.length,
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        medianPrice: median(prices),
        avgPrice: avg,
        cheapest: cheapest.map(l => ({
          id: l.id, title: l.title, price: l.price,
          location: l.location, url: l.url, platform: l.platform,
        })),
      },
      display: lines.join('\n'),
    };
  }

  private async handleDetail(platform: Platform, listingId: string): Promise<SkillResult> {
    const providers = platform === 'all' ? this.providers : this.providers.filter(p => p.platform === platform);
    const provider = providers[0];
    if (!provider) return { success: false, error: 'Kein Provider verfügbar für diese Plattform' };

    const detail = await provider.getDetail(listingId);

    return {
      success: true,
      data: {
        id: detail.id,
        title: detail.title,
        price: detail.price,
        currency: detail.currency,
        condition: detail.condition,
        location: detail.location,
        url: detail.url,
        description: detail.description.slice(0, 1000),
        imageCount: detail.imageUrls.length,
        imageUrls: detail.imageUrls.slice(0, 3),
        seller: detail.seller,
        sellerSince: detail.sellerSince,
        publishedAt: detail.publishedAt,
        attributes: detail.attributes,
        platform: detail.platform,
      },
      display: `**${detail.title}** — ${formatPrice(detail.price, detail.currency)}\n📍 ${detail.location ?? 'k.A.'}\n${detail.description.slice(0, 500)}`,
    };
  }

  private async searchAll(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number; sort?: string; condition?: string; postcode?: string },
  ): Promise<MarketplaceSearchResult[]> {
    const results = await Promise.all(
      providers.map(p => p.search(params as any).catch(err => ({
        listings: [] as MarketplaceListing[],
        totalCount: 0,
        query: params.query,
        platform: p.platform,
        error: String(err),
      }))),
    );
    return results;
  }
}
