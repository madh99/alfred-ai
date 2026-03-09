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
  sort?: 'price_asc' | 'price_desc' | 'date_desc';
  condition?: 'new' | 'used';
  postcode?: string;
}

export interface MarketplaceSearchResult {
  listings: MarketplaceListing[];
  totalCount: number;
  query: string;
  platform: string;
}

export interface MarketplaceListingDetail {
  id: string;
  title: string;
  price: number | null;
  currency: string;
  condition?: string;
  location?: string;
  url: string;
  imageUrls: string[];
  seller?: string;
  sellerSince?: string;
  publishedAt?: string;
  description: string;
  attributes: Record<string, string>;
  platform: 'willhaben' | 'ebay';
}

export abstract class MarketplaceProvider {
  abstract readonly platform: string;
  abstract search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult>;
  async getDetail(_id: string): Promise<MarketplaceListingDetail> {
    throw new Error('Detail not supported');
  }
}
