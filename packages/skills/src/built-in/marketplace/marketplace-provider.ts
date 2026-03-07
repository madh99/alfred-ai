export interface MarketplaceListing {
  id: string;
  title: string;
  price: number | null;
  currency: string;
  condition?: string;
  location?: string;
  url: string;
  imageUrl?: string;
  seller?: string;
  publishedAt?: string;
  platform: 'willhaben' | 'ebay';
}

export interface MarketplaceSearchParams {
  query: string;
  priceMin?: number;
  priceMax?: number;
  rows?: number;
}

export interface MarketplaceSearchResult {
  listings: MarketplaceListing[];
  totalCount: number;
  query: string;
  platform: string;
}

export abstract class MarketplaceProvider {
  abstract readonly platform: string;
  abstract search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult>;
}
