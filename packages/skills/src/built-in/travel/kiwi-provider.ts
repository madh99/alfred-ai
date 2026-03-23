import { TravelProvider } from './travel-provider.js';
import type { FlightResult } from './travel-provider.js';

// City code mapping for common cities
const CITY_CODES: Record<string, string> = {
  wien: 'vienna_at', vienna: 'vienna_at', vie: 'vienna_at',
  barcelona: 'barcelona_es', bcn: 'barcelona_es',
  berlin: 'berlin_de', ber: 'berlin_de',
  london: 'london_gb', lhr: 'london_gb',
  paris: 'paris_fr', cdg: 'paris_fr',
  rom: 'rome_it', rome: 'rome_it', fco: 'rome_it',
  mailand: 'milan_it', milan: 'milan_it', mxp: 'milan_it',
  amsterdam: 'amsterdam_nl', ams: 'amsterdam_nl',
  madrid: 'madrid_es', mad: 'madrid_es',
  lissabon: 'lisbon_pt', lisbon: 'lisbon_pt', lis: 'lisbon_pt',
  prag: 'prague_cz', prague: 'prague_cz', prg: 'prague_cz',
  budapest: 'budapest_hu', bud: 'budapest_hu',
  zagreb: 'zagreb_hr', zag: 'zagreb_hr',
  dubrovnik: 'dubrovnik_hr', dbv: 'dubrovnik_hr',
  split: 'split_hr', spu: 'split_hr',
  athen: 'athens_gr', athens: 'athens_gr', ath: 'athens_gr',
  istanbul: 'istanbul_tr', ist: 'istanbul_tr',
  new_york: 'new-york-city_ny_us', nyc: 'new-york-city_ny_us', jfk: 'new-york-city_ny_us',
  bangkok: 'bangkok_th', bkk: 'bangkok_th',
  tokio: 'tokyo_jp', tokyo: 'tokyo_jp', nrt: 'tokyo_jp',
  münchen: 'munich_de', munich: 'munich_de', muc: 'munich_de',
  zürich: 'zurich_ch', zurich: 'zurich_ch', zrh: 'zurich_ch',
  graz: 'graz_at', grz: 'graz_at',
  salzburg: 'salzburg_at', szg: 'salzburg_at',
  innsbruck: 'innsbruck_at', inn: 'innsbruck_at',
  linz: 'linz_at', lnz: 'linz_at',
  klagenfurt: 'klagenfurt_at', klf: 'klagenfurt_at',
  hamburg: 'hamburg_de', ham: 'hamburg_de',
  frankfurt: 'frankfurt_de', fra: 'frankfurt_de',
  düsseldorf: 'dusseldorf_de', dus: 'dusseldorf_de',
  köln: 'cologne_de', cologne: 'cologne_de', cgn: 'cologne_de',
  brüssel: 'brussels_be', brussels: 'brussels_be', bru: 'brussels_be',
  kopenhagen: 'copenhagen_dk', copenhagen: 'copenhagen_dk', cph: 'copenhagen_dk',
  stockholm: 'stockholm_se', arn: 'stockholm_se',
  oslo: 'oslo_no', osl: 'oslo_no',
  helsinki: 'helsinki_fi', hel: 'helsinki_fi',
  warschau: 'warsaw_pl', warsaw: 'warsaw_pl', waw: 'warsaw_pl',
  krakau: 'krakow_pl', krakow: 'krakow_pl', krk: 'krakow_pl',
  dubai: 'dubai_ae', dxb: 'dubai_ae',
  malaga: 'malaga_es', agp: 'malaga_es',
  palma: 'palma-mallorca_es', pmi: 'palma-mallorca_es', mallorca: 'palma-mallorca_es',
  nizza: 'nice_fr', nice: 'nice_fr', nce: 'nice_fr',
};

export class KiwiProvider extends TravelProvider {
  readonly type = 'flights' as const;

  constructor(private readonly rapidApiKey: string) {
    super();
  }

  async search(params: Record<string, unknown>): Promise<FlightResult[]> {
    const origin = this.resolveCity(params.origin as string);
    const destination = this.resolveCity(params.destination as string);
    const returnTrip = !!(params.returnFrom || params.returnTo);
    const currency = ((params.currency as string) ?? 'EUR').toLowerCase();
    const limit = Math.min((params.limit as number) ?? 10, 20);
    const sort = (params.sort as string) ?? 'PRICE';

    const endpoint = returnTrip ? 'round-trip' : 'one-way';
    const url = new URL(`https://kiwi-com-cheap-flights.p.rapidapi.com/${endpoint}`);
    url.searchParams.set('source', `City:${origin}`);
    url.searchParams.set('destination', `City:${destination}`);
    url.searchParams.set('currency', currency);
    url.searchParams.set('locale', 'de');
    url.searchParams.set('adults', String(params.adults ?? 1));
    url.searchParams.set('cabinClass', 'ECONOMY');
    url.searchParams.set('sortBy', sort.toUpperCase());
    url.searchParams.set('sortOrder', 'ASCENDING');
    url.searchParams.set('transportTypes', 'FLIGHT');
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url.toString(), {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-key': this.rapidApiKey,
        'x-rapidapi-host': 'kiwi-com-cheap-flights.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Kiwi Flugsuche fehlgeschlagen: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { itineraries?: any[] };
    const itineraries = data.itineraries ?? [];

    return itineraries.map((it: any) => this.mapItinerary(it, origin, destination, currency));
  }

  private mapItinerary(it: any, origin: string, destination: string, currency: string): FlightResult {
    const price = Number(it.price?.amount ?? it.priceEur?.amount ?? 0);
    const segments = it.sector?.sectorSegments ?? [];
    const firstSeg = segments[0]?.segment;
    const lastSeg = segments[segments.length - 1]?.segment;

    // Extract carrier names
    const airlines = new Set<string>();
    for (const ss of segments) {
      const carrier = ss.segment?.carrier?.name;
      if (carrier) airlines.add(carrier);
    }

    // Calculate total duration from first departure to last arrival
    const depTime = firstSeg?.source?.utcTime ?? '';
    const arrTime = lastSeg?.destination?.utcTime ?? '';
    let durationMin = 0;
    if (depTime && arrTime) {
      durationMin = Math.round((new Date(arrTime).getTime() - new Date(depTime).getTime()) / 60_000);
    }

    // Origin/destination from segments
    const originCode = firstSeg?.source?.station?.code ?? origin;
    const destCode = lastSeg?.destination?.station?.code ?? destination;
    const originCity = firstSeg?.source?.station?.city?.name ?? origin;
    const destCity = lastSeg?.destination?.station?.city?.name ?? destination;

    return {
      id: it.id ?? '',
      airlines: [...airlines],
      departure: firstSeg?.source?.localTime ?? '',
      arrival: lastSeg?.destination?.localTime ?? '',
      origin: `${originCode} (${originCity})`,
      destination: `${destCode} (${destCity})`,
      duration: durationMin,
      stopovers: Math.max(0, segments.length - 1),
      price,
      currency: currency.toUpperCase(),
      deepLink: it.bookingOptions?.edges?.[0]?.node?.bookingUrl
        ? `https://www.kiwi.com${it.bookingOptions.edges[0].node.bookingUrl}`
        : undefined,
    };
  }

  private resolveCity(input: string): string {
    if (!input) throw new Error('Ort fehlt');
    const normalized = input.toLowerCase().trim().replace(/\s+/g, '_');

    // Direct match in city codes
    const code = CITY_CODES[normalized];
    if (code) return code;

    // Try without underscores
    const noUnderscore = normalized.replace(/_/g, '');
    const code2 = CITY_CODES[noUnderscore];
    if (code2) return code2;

    // Fallback: assume it's already a city code (e.g. "vienna_at")
    if (normalized.includes('_')) return normalized;

    // Last resort: construct city code pattern
    return normalized;
  }
}
