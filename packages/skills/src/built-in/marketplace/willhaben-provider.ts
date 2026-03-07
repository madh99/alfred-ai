import { MarketplaceProvider } from './marketplace-provider.js';
import type { MarketplaceSearchParams, MarketplaceSearchResult, MarketplaceListing } from './marketplace-provider.js';

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

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    });
    if (!res.ok) throw new Error(`willhaben HTTP ${res.status}`);

    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('willhaben: __NEXT_DATA__ not found — page structure may have changed');

    const nextData = JSON.parse(match[1]);
    const adverts: any[] = nextData?.props?.pageProps?.searchResult?.advertSummaryList?.advertSummary ?? [];

    const listings: MarketplaceListing[] = adverts.map((ad: any) => {
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
    });

    return {
      listings,
      totalCount: nextData?.props?.pageProps?.searchResult?.rowsFound ?? listings.length,
      query: params.query,
      platform: 'willhaben',
    };
  }
}
