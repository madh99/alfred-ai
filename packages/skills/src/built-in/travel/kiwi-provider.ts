import { TravelProvider } from './travel-provider.js';
import type { FlightResult } from './travel-provider.js';

interface LocationCache {
  code: string;
  cachedAt: number;
}

export class KiwiProvider extends TravelProvider {
  readonly type = 'flights' as const;
  private readonly locationCache = new Map<string, LocationCache>();
  private static readonly LOCATION_TTL = 24 * 60 * 60 * 1000; // 24h

  constructor(private readonly apiKey: string) {
    super();
  }

  async search(params: Record<string, unknown>): Promise<FlightResult[]> {
    const origin = await this.resolveLocation(params.origin as string);
    const destination = await this.resolveLocation(params.destination as string);
    const dateFrom = this.formatDate(params.dateFrom as string);
    const dateTo = params.dateTo ? this.formatDate(params.dateTo as string) : dateFrom;
    const returnFrom = params.returnFrom ? this.formatDate(params.returnFrom as string) : undefined;
    const returnTo = params.returnTo ? this.formatDate(params.returnTo as string) : returnFrom;
    const adults = params.adults ?? 1;
    const currency = (params.currency as string) ?? 'EUR';
    const limit = Math.min((params.limit as number) ?? 10, 50);
    const maxStopovers = params.maxStopovers as number | undefined;

    const url = new URL('https://api.tequila.kiwi.com/v2/search');
    url.searchParams.set('fly_from', origin);
    url.searchParams.set('fly_to', destination);
    url.searchParams.set('date_from', dateFrom);
    url.searchParams.set('date_to', dateTo);
    if (returnFrom) url.searchParams.set('return_from', returnFrom);
    if (returnTo) url.searchParams.set('return_to', returnTo);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('curr', currency);
    url.searchParams.set('sort', (params.sort as string) ?? 'price');
    url.searchParams.set('limit', String(limit));
    if (maxStopovers != null) url.searchParams.set('max_stopovers', String(maxStopovers));

    const res = await fetch(url.toString(), {
      headers: { 'apikey': this.apiKey },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Kiwi API Fehler: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { data?: any[] };
    const flights = data.data ?? [];

    return flights.map((f: any) => ({
      id: f.id ?? '',
      airlines: [...new Set((f.airlines ?? []) as string[])],
      departure: f.dTime ?? f.local_departure ?? '',
      arrival: f.aTime ?? f.local_arrival ?? '',
      origin: f.flyFrom ?? origin,
      destination: f.flyTo ?? destination,
      duration: Math.round((f.duration?.total ?? f.fly_duration ?? 0) / 60),
      stopovers: (f.route?.length ?? 1) - 1,
      price: f.price ?? 0,
      currency: currency,
      deepLink: f.deep_link ?? undefined,
    }));
  }

  async resolveLocation(input: string): Promise<string> {
    if (!input) throw new Error('Ort fehlt');
    // IATA code: 3 uppercase letters
    if (/^[A-Z]{3}$/.test(input)) return input;

    // Check cache
    const cached = this.locationCache.get(input.toLowerCase());
    if (cached && Date.now() - cached.cachedAt < KiwiProvider.LOCATION_TTL) {
      return cached.code;
    }

    const url = new URL('https://api.tequila.kiwi.com/locations/query');
    url.searchParams.set('term', input);
    url.searchParams.set('location_types', 'airport');
    url.searchParams.set('limit', '1');

    const res = await fetch(url.toString(), {
      headers: { 'apikey': this.apiKey },
    });

    if (!res.ok) {
      throw new Error(`Kiwi Location-Suche fehlgeschlagen: HTTP ${res.status}`);
    }

    const data = await res.json() as { locations?: any[] };
    const loc = data.locations?.[0];
    if (!loc?.code) {
      throw new Error(`Kein Flughafen gefunden für "${input}"`);
    }

    this.locationCache.set(input.toLowerCase(), { code: loc.code, cachedAt: Date.now() });
    return loc.code;
  }

  /** Convert YYYY-MM-DD or ISO to DD/MM/YYYY (Kiwi format) */
  private formatDate(dateStr: string): string {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr; // already DD/MM/YYYY
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
}
