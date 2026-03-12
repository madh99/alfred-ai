import { MarketplaceProvider } from './marketplace-provider.js';
import type { MarketplaceSearchParams, MarketplaceSearchResult, MarketplaceListing, MarketplaceListingDetail } from './marketplace-provider.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class WillhabenProvider extends MarketplaceProvider {
  readonly platform = 'willhaben';

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const rows = Math.min(params.rows ?? 100, 100);
    const url = new URL('https://www.willhaben.at/iad/kaufen-und-verkaufen/marktplatz');
    url.searchParams.set('keyword', params.query);
    url.searchParams.set('rows', String(rows));
    if (params.priceMin != null) url.searchParams.set('PRICE_FROM', String(params.priceMin));
    if (params.priceMax != null) url.searchParams.set('PRICE_TO', String(params.priceMax));
    if (params.sort) {
      const sfIdMap: Record<string, string> = { date_desc: '1', price_asc: '2', price_desc: '3' };
      url.searchParams.set('sfId', sfIdMap[params.sort]);
    }
    if (params.postcode) url.searchParams.set('postcode', params.postcode);

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    });
    if (!res.ok) throw new Error(`willhaben HTTP ${res.status}`);

    const html = await res.text();
    const adverts = this.parseNextData(html);

    const listings: MarketplaceListing[] = adverts.map((ad: any) => this.mapAdvert(ad));

    // Post-filter: keep only listings whose title contains all query terms
    const queryTerms = params.query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const filtered = queryTerms.length > 0
      ? listings.filter(l => queryTerms.every(term => l.title.toLowerCase().includes(term)))
      : listings;

    return {
      listings: filtered,
      totalCount: this.extractTotalCount(html) ?? listings.length,
      query: params.query,
      platform: 'willhaben',
    };
  }

  async getDetail(id: string): Promise<MarketplaceListingDetail> {
    const url = `https://www.willhaben.at/iad/object?adId=${id}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`willhaben detail HTTP ${res.status}`);

    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('willhaben detail: __NEXT_DATA__ not found');

    const nextData = JSON.parse(match[1]);
    // Detail pages use "advertDetails" (plural), NOT "advertDetail"
    const ad = nextData?.props?.pageProps?.advertDetails;
    if (!ad) throw new Error('willhaben detail: advertDetails not found in page data');

    // Flat attributes (PRICE, DESCRIPTION, LOCATION/ADDRESS_*, etc.)
    const attrs: any[] = ad.attributes?.attribute ?? [];
    const attr = (name: string): string | undefined => {
      const found = attrs.find((a: any) => a.name === name);
      return found?.values?.[0] ?? undefined;
    };

    const allAttributes: Record<string, string> = {};
    for (const a of attrs) {
      if (a.name && a.values?.[0]) {
        allAttributes[a.name] = a.values[0];
      }
    }

    // Structured attributes (Zustand, Übergabe, etc.) from attributeInformation
    const attrInfo: any[] = ad.attributeInformation ?? [];
    for (const ai of attrInfo) {
      const label = ai.treeAttributeElement?.label;
      const value = ai.values?.[0]?.label;
      if (label && value) {
        allAttributes[label] = value;
      }
    }

    // Images
    const images: string[] = (ad.advertImageList?.advertImage ?? [])
      .map((img: any) => img.mainImageUrl ?? img.referenceImageUrl)
      .filter(Boolean);

    // Location from advertAddressDetails
    const addr = ad.advertAddressDetails;
    const location = addr
      ? [addr.postalName, addr.postCode, addr.district, addr.province].filter(Boolean).join(', ')
      : [attr('LOCATION/ADDRESS_2'), attr('LOCATION/ADDRESS_3')].filter(Boolean).join(', ');

    // Seller from sellerProfileUserData
    const sellerData = ad.sellerProfileUserData;

    // Description: strip HTML tags
    const rawDesc = attr('DESCRIPTION') ?? ad.description ?? '';
    const description = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    const priceStr = attr('PRICE');
    const condition = attrInfo.find((ai: any) => ai.treeAttributeElement?.code === 'Zustand')?.values?.[0]?.label;

    return {
      id,
      title: ad.description ?? 'Kein Titel',
      price: priceStr ? parseFloat(priceStr) : null,
      currency: 'EUR',
      condition,
      location,
      url: res.url || url,
      imageUrls: images,
      seller: sellerData?.name ?? undefined,
      sellerSince: sellerData?.registerDate ?? undefined,
      publishedAt: ad.publishedDate ?? undefined,
      description,
      attributes: allAttributes,
      platform: 'willhaben',
    };
  }

  private parseNextData(html: string): any[] {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('willhaben: __NEXT_DATA__ not found — page structure may have changed');
    const nextData = JSON.parse(match[1]);
    return nextData?.props?.pageProps?.searchResult?.advertSummaryList?.advertSummary ?? [];
  }

  private extractTotalCount(html: string): number | undefined {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return undefined;
    const nextData = JSON.parse(match[1]);
    return nextData?.props?.pageProps?.searchResult?.rowsFound;
  }

  private mapAdvert(ad: any): MarketplaceListing {
    const attrs = ad.attributes?.attribute ?? [];
    const attr = (name: string): string | undefined => {
      const found = attrs.find((a: any) => a.name === name);
      return found?.values?.[0] ?? undefined;
    };

    const priceStr = attr('PRICE');
    const price = priceStr ? parseFloat(priceStr) : null;

    return {
      id: String(ad.id),
      title: attr('HEADING') ?? ad.description ?? 'Kein Titel',
      price,
      currency: 'EUR',
      condition: attr('CONDITION'),
      location: [attr('LOCATION'), attr('POSTCODE')].filter(Boolean).join(' '),
      url: `https://www.willhaben.at/iad/object?adId=${ad.id}`,
      imageUrl: ad.advertImageList?.advertImage?.[0]?.mainImageUrl ?? undefined,
      seller: attr('ORGANIZER') ?? undefined,
      publishedAt: attr('PUBLISHED_String') ?? undefined,
      platform: 'willhaben',
    };
  }
}
