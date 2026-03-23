import { TravelProvider } from './travel-provider.js';
import type { HotelResult } from './travel-provider.js';

interface LocationCache {
  destId: string;
  destType: string;
  cachedAt: number;
}

export class BookingProvider extends TravelProvider {
  readonly type = 'hotels' as const;
  private readonly locationCache = new Map<string, LocationCache>();
  private static readonly LOCATION_TTL = 24 * 60 * 60 * 1000; // 24h

  constructor(private readonly rapidApiKey: string) {
    super();
  }

  async search(params: Record<string, unknown>): Promise<HotelResult[]> {
    const destination = params.destination as string;
    if (!destination) throw new Error('Zielort fehlt');

    const { destId, destType } = await this.resolveLocation(destination);
    const checkin = params.checkinDate as string ?? params.dateFrom as string;
    const checkout = params.checkoutDate as string ?? params.dateTo as string;
    if (!checkin || !checkout) throw new Error('Check-in und Check-out Datum erforderlich');

    const adults = params.adults ?? 1;
    const currency = (params.currency as string) ?? 'EUR';
    const limit = Math.min((params.limit as number) ?? 10, 25);

    const url = new URL('https://booking-com.p.rapidapi.com/v2/hotels/search');
    url.searchParams.set('dest_id', destId);
    url.searchParams.set('dest_type', destType);
    url.searchParams.set('checkin_date', checkin);
    url.searchParams.set('checkout_date', checkout);
    url.searchParams.set('adults_number', String(adults));
    url.searchParams.set('room_number', '1');
    url.searchParams.set('currency', currency);
    url.searchParams.set('locale', 'de');
    url.searchParams.set('units', 'metric');
    url.searchParams.set('order_by', (params.sort as string) ?? 'popularity');
    url.searchParams.set('page_number', '0');

    if (params.stars) url.searchParams.set('categories_filter_ids', `class::${params.stars}`);
    if (params.priceMin) url.searchParams.set('price_min', String(params.priceMin));
    if (params.priceMax) url.searchParams.set('price_max', String(params.priceMax));

    const res = await fetch(url.toString(), {
      headers: {
        'x-rapidapi-key': this.rapidApiKey,
        'x-rapidapi-host': 'booking-com.p.rapidapi.com',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Booking.com API Fehler: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { results?: any[] };
    const hotels = (data.results ?? []).slice(0, limit);

    // Calculate nights
    const nights = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86_400_000));

    return hotels.map((h: any) => {
      const totalPrice = h.priceBreakdown?.grossPrice?.value ?? h.price_breakdown?.all_inclusive_price ?? h.min_total_price ?? 0;
      return {
        id: String(h.hotel_id ?? h.id ?? ''),
        name: h.hotel_name ?? h.name ?? '',
        stars: h.class ?? h.stars ?? undefined,
        rating: h.review_score ? Number(h.review_score) : undefined,
        reviewScore: h.review_score_word ?? undefined,
        pricePerNight: Math.round((totalPrice / nights) * 100) / 100,
        totalPrice: Math.round(totalPrice * 100) / 100,
        currency,
        address: h.address ?? undefined,
        imageUrl: h.max_photo_url ?? h.main_photo_url ?? h.photo_url ?? undefined,
        deepLink: h.url ?? undefined,
      };
    });
  }

  private async resolveLocation(input: string): Promise<{ destId: string; destType: string }> {
    const cacheKey = input.toLowerCase();
    const cached = this.locationCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < BookingProvider.LOCATION_TTL) {
      return { destId: cached.destId, destType: cached.destType };
    }

    const url = new URL('https://booking-com.p.rapidapi.com/v1/hotels/locations');
    url.searchParams.set('name', input);
    url.searchParams.set('locale', 'de');

    const res = await fetch(url.toString(), {
      headers: {
        'x-rapidapi-key': this.rapidApiKey,
        'x-rapidapi-host': 'booking-com.p.rapidapi.com',
      },
    });

    if (!res.ok) {
      throw new Error(`Booking.com Location-Suche fehlgeschlagen: HTTP ${res.status}`);
    }

    const data = await res.json() as any[];
    const loc = data?.[0];
    if (!loc?.dest_id) {
      throw new Error(`Kein Zielort gefunden für "${input}"`);
    }

    const result = { destId: String(loc.dest_id), destType: loc.dest_type ?? 'city' };
    this.locationCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    return result;
  }
}
