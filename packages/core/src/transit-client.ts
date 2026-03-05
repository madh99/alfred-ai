import type { Logger } from 'pino';
import type {
  TransitClientInterface,
  TransitStop,
  TransitJourney,
  TransitDeparture,
  TransitLeg,
  JourneyOptions,
  DepartureOptions,
} from '@alfred/skills';

export class TransitClient implements TransitClientInterface {
  private readonly logger: Logger;
  private hafasClient: any;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  private async getClient(): Promise<any> {
    if (this.hafasClient) return this.hafasClient;

    // @ts-ignore — hafas-client is an optional peer dependency
    const { createClient } = await import('hafas-client');
    // @ts-ignore
    const { profile: oebb } = await import('hafas-client/p/oebb/index.js');

    this.hafasClient = createClient(oebb, 'alfred-ai-assistant');
    return this.hafasClient;
  }

  async searchStops(query: string): Promise<TransitStop[]> {
    const client = await this.getClient();
    const results = await client.locations(query, { results: 10 });

    return results
      .filter((r: any) => r.type === 'stop' || r.type === 'station')
      .map((r: any): TransitStop => ({
        id: r.id,
        name: r.name,
        location: r.location
          ? { latitude: r.location.latitude, longitude: r.location.longitude }
          : undefined,
      }));
  }

  async journeys(from: string, to: string, options?: JourneyOptions): Promise<TransitJourney[]> {
    const client = await this.getClient();

    const hafasOpts: any = {
      results: options?.results ?? 3,
    };
    if (options?.departure) hafasOpts.departure = options.departure;
    if (options?.arrival) hafasOpts.arrival = options.arrival;

    const res = await client.journeys(from, to, hafasOpts);

    return (res.journeys || []).map((j: any): TransitJourney => {
      const legs: TransitLeg[] = (j.legs || []).map((leg: any): TransitLeg => ({
        origin: leg.origin?.name || leg.origin?.id || 'Unknown',
        destination: leg.destination?.name || leg.destination?.id || 'Unknown',
        departure: leg.departure || leg.plannedDeparture || '',
        arrival: leg.arrival || leg.plannedArrival || '',
        line: leg.line?.name,
        direction: leg.direction,
        mode: leg.line?.mode || (leg.walking ? 'walking' : 'unknown'),
        walking: leg.walking === true,
      }));

      const firstDep = legs[0]?.departure || '';
      const lastArr = legs[legs.length - 1]?.arrival || '';
      const duration = firstDep && lastArr
        ? Math.round((new Date(lastArr).getTime() - new Date(firstDep).getTime()) / 60_000)
        : 0;

      // Count transfers (legs with a line minus 1, walking doesn't count)
      const transitLegs = legs.filter(l => !l.walking);
      const transfers = Math.max(0, transitLegs.length - 1);

      return { legs, departure: firstDep, arrival: lastArr, duration, transfers };
    });
  }

  async departures(stopId: string, options?: DepartureOptions): Promise<TransitDeparture[]> {
    const client = await this.getClient();

    const hafasOpts: any = {
      duration: options?.duration ?? 30,
    };
    if (options?.when) hafasOpts.when = options.when;

    const deps = await client.departures(stopId, hafasOpts);

    return (deps.departures || deps || []).map((d: any): TransitDeparture => {
      const planned = d.plannedWhen ? new Date(d.plannedWhen) : null;
      const actual = d.when ? new Date(d.when) : null;
      const delayMin = planned && actual
        ? Math.round((actual.getTime() - planned.getTime()) / 60_000)
        : (d.delay != null ? Math.round(d.delay / 60) : undefined);

      return {
        line: d.line?.name || d.line?.fahrtNr || 'Unknown',
        direction: d.direction || d.destination?.name || 'Unknown',
        when: d.when || d.plannedWhen || '',
        delay: delayMin && delayMin > 0 ? delayMin : undefined,
        platform: d.platform || undefined,
      };
    });
  }
}
