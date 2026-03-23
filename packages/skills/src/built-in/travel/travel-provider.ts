export interface FlightResult {
  id: string;
  airlines: string[];
  departure: string;
  arrival: string;
  origin: string;
  destination: string;
  duration: number; // minutes
  stopovers: number;
  price: number;
  currency: string;
  deepLink?: string;
}

export interface HotelResult {
  id: string;
  name: string;
  stars?: number;
  rating?: number;
  reviewScore?: string;
  pricePerNight: number;
  totalPrice: number;
  currency: string;
  address?: string;
  imageUrl?: string;
  deepLink?: string;
}

export abstract class TravelProvider {
  abstract readonly type: 'flights' | 'hotels' | 'cars' | 'activities';
  abstract search(params: Record<string, unknown>): Promise<FlightResult[] | HotelResult[]>;
  async getDetail(_id: string): Promise<Record<string, unknown> | null> { return null; }
}
