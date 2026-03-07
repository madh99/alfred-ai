import type { SkillMetadata, SkillContext, SkillResult, MarketplaceConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { MarketplaceProvider, MarketplaceListing, MarketplaceSearchResult } from './marketplace-provider.js';
import { WillhabenProvider } from './willhaben-provider.js';
import { EbayProvider } from './ebay-provider.js';

type Action = 'search' | 'compare';
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
      '"search" listet ALLE gefundenen Inserate als strukturierte Tabelle. ' +
      '"compare" liefert Preisstatistik (min, max, median, avg) + günstigste 5. ' +
      'willhaben funktioniert immer ohne Credentials, eBay nur mit API-Keys.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'compare'],
          description: 'Aktion: search = alle Inserate auflisten, compare = Preisstatistik',
        },
        query: {
          type: 'string',
          description: 'Suchbegriff',
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
      },
      required: ['action', 'query'],
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
    const query = params.query as string;
    const platform = (params.platform as Platform) ?? 'willhaben';
    const priceMin = params.priceMin as number | undefined;
    const priceMax = params.priceMax as number | undefined;
    const rows = Math.min((params.rows as number) ?? 50, 200);

    const providers = this.getProviders(platform);
    if (providers.length === 0) {
      return { success: false, error: 'Keine Marketplace-Provider verfügbar für diese Plattform' };
    }

    switch (action) {
      case 'search': return this.handleSearch(providers, { query, priceMin, priceMax, rows });
      case 'compare': return this.handleCompare(providers, { query, priceMin, priceMax, rows: Math.min(rows, 200) });
      default: return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private getProviders(platform: Platform): MarketplaceProvider[] {
    if (platform === 'all') return this.providers;
    return this.providers.filter(p => p.platform === platform);
  }

  private async handleSearch(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number },
  ): Promise<SkillResult> {
    const results = await this.searchAll(providers, params);
    const allListings = results.flatMap(r => r.listings);

    if (allListings.length === 0) {
      return { success: true, data: `Keine Inserate gefunden für "${params.query}".` };
    }

    const prices = allListings.map(l => l.price).filter((p): p is number => p != null);
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

    return { success: true, data: lines.join('\n') };
  }

  private async handleCompare(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number },
  ): Promise<SkillResult> {
    const results = await this.searchAll(providers, params);
    const allListings = results.flatMap(r => r.listings);
    const prices = allListings.map(l => l.price).filter((p): p is number => p != null);

    if (prices.length === 0) {
      return { success: true, data: `Keine Inserate mit Preisangabe gefunden für "${params.query}".` };
    }

    const sorted = allListings
      .filter((l): l is MarketplaceListing & { price: number } => l.price != null)
      .sort((a, b) => a.price - b.price);
    const cheapest = sorted.slice(0, 5);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

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

    return { success: true, data: lines.join('\n') };
  }

  private async searchAll(
    providers: MarketplaceProvider[],
    params: { query: string; priceMin?: number; priceMax?: number; rows: number },
  ): Promise<MarketplaceSearchResult[]> {
    const results = await Promise.all(
      providers.map(p => p.search(params).catch(err => ({
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
