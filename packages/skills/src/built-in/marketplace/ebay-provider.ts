import { MarketplaceProvider } from './marketplace-provider.js';
import type { MarketplaceSearchParams, MarketplaceSearchResult, MarketplaceListing } from './marketplace-provider.js';

interface EbayTokenCache {
  token: string;
  expiresAt: number;
}

export class EbayProvider extends MarketplaceProvider {
  readonly platform = 'ebay';
  private tokenCache: EbayTokenCache | null = null;

  constructor(
    private readonly appId: string,
    private readonly certId: string,
  ) {
    super();
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });

    if (!res.ok) throw new Error(`eBay OAuth failed: HTTP ${res.status}`);
    const data = await res.json() as { access_token: string; expires_in: number };

    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 5 min buffer
    };
    return this.tokenCache.token;
  }

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const token = await this.getToken();
    const limit = Math.min(params.rows ?? 50, 200);

    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    url.searchParams.set('q', params.query);
    url.searchParams.set('limit', String(limit));

    if (params.sort) {
      const sortMap: Record<string, string> = { price_asc: 'price', price_desc: '-price', date_desc: 'newlyListed' };
      url.searchParams.set('sort', sortMap[params.sort]);
    }

    const filterParts: string[] = [];
    if (params.priceMin != null || params.priceMax != null) {
      const from = params.priceMin != null ? String(params.priceMin) : '';
      const to = params.priceMax != null ? String(params.priceMax) : '';
      filterParts.push(`price:[${from}..${to}]`);
    }
    if (params.condition === 'new') filterParts.push('conditionIds:{1000}');
    if (params.condition === 'used') filterParts.push('conditionIds:{3000}');
    if (filterParts.length > 0) {
      url.searchParams.set('filter', filterParts.join(','));
    }

    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AT',
      },
    });

    if (!res.ok) throw new Error(`eBay API error: HTTP ${res.status}`);
    const data = await res.json() as any;

    const items: any[] = data.itemSummaries ?? [];
    const listings: MarketplaceListing[] = items.map((item: any) => ({
      id: item.itemId ?? item.legacyItemId ?? '',
      title: item.title ?? '',
      price: item.price?.value ? parseFloat(item.price.value) : null,
      currency: item.price?.currency ?? 'EUR',
      condition: item.condition ?? item.conditionId ?? undefined,
      location: item.itemLocation?.postalCode
        ? `${item.itemLocation.city ?? ''} ${item.itemLocation.postalCode}`.trim()
        : item.itemLocation?.country ?? undefined,
      url: item.itemWebUrl ?? item.itemHref ?? '',
      imageUrl: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? undefined,
      seller: item.seller?.username ?? undefined,
      publishedAt: undefined,
      platform: 'ebay' as const,
    }));

    return {
      listings,
      totalCount: data.total ?? listings.length,
      query: params.query,
      platform: 'ebay',
    };
  }
}
