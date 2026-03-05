import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'journeys' | 'departures' | 'search_stop';

export interface TransitClientInterface {
  searchStops(query: string): Promise<TransitStop[]>;
  journeys(from: string, to: string, options?: JourneyOptions): Promise<TransitJourney[]>;
  departures(stopId: string, options?: DepartureOptions): Promise<TransitDeparture[]>;
}

export interface TransitStop {
  id: string;
  name: string;
  location?: { latitude: number; longitude: number };
}

export interface JourneyOptions {
  departure?: Date;
  arrival?: Date;
  results?: number;
  products?: Record<string, boolean>;
}

export interface DepartureOptions {
  when?: Date;
  duration?: number; // minutes
}

export interface TransitLeg {
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  line?: string;
  direction?: string;
  mode: string;
  walking?: boolean;
}

export interface TransitJourney {
  legs: TransitLeg[];
  departure: string;
  arrival: string;
  duration: number; // minutes
  transfers: number;
}

export interface TransitDeparture {
  line: string;
  direction: string;
  when: string;
  delay?: number; // minutes
  platform?: string;
}

export class TransitSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'transit_search',
    category: 'information',
    description:
      'Öffentlicher Nahverkehr in Österreich (ÖBB, Wiener Linien, etc.). ' +
      '"search_stop" sucht Haltestellen nach Name. ' +
      '"journeys" berechnet Verbindungen zwischen zwei Orten (Name oder Stop-ID). ' +
      '"departures" zeigt Abfahrten an einer Haltestelle (Stop-ID erforderlich, zuerst search_stop verwenden). ' +
      'Deckt Busse, Straßenbahnen, U-Bahn, S-Bahn, Regionalzüge und Fernzüge ab.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['journeys', 'departures', 'search_stop'],
          description: 'Transit action',
        },
        query: {
          type: 'string',
          description: 'Haltestellenname für search_stop',
        },
        from: {
          type: 'string',
          description: 'Start-Haltestelle (Name oder ID) für journeys',
        },
        to: {
          type: 'string',
          description: 'Ziel-Haltestelle (Name oder ID) für journeys',
        },
        stop_id: {
          type: 'string',
          description: 'Stop-ID für departures (von search_stop erhalten)',
        },
        departure: {
          type: 'string',
          description: 'ISO-Zeitpunkt für gewünschte Abfahrt (optional)',
        },
        arrival: {
          type: 'string',
          description: 'ISO-Zeitpunkt für gewünschte Ankunft (optional, nur für journeys)',
        },
        results: {
          type: 'number',
          description: 'Anzahl Ergebnisse (Standard: 3)',
        },
        duration: {
          type: 'number',
          description: 'Zeitfenster in Minuten für departures (Standard: 30)',
        },
      },
      required: ['action'],
    },
  };

  private readonly client: TransitClientInterface;

  constructor(client: TransitClientInterface) {
    super();
    this.client = client;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    try {
      switch (action) {
        case 'search_stop':
          return await this.searchStop(input);
        case 'journeys':
          return await this.findJourneys(input);
        case 'departures':
          return await this.findDepartures(input);
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Transit API error: ${msg}` };
    }
  }

  private async searchStop(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string | undefined;
    if (!query) return { success: false, error: 'Missing required field "query" for search_stop' };

    const stops = await this.client.searchStops(query);
    if (stops.length === 0) {
      return { success: true, data: [], display: `Keine Haltestellen gefunden für "${query}".` };
    }

    const lines = ['## Haltestellen', ''];
    for (const stop of stops.slice(0, 10)) {
      lines.push(`- **${stop.name}** (ID: \`${stop.id}\`)`);
    }

    return { success: true, data: stops, display: lines.join('\n') };
  }

  private async findJourneys(input: Record<string, unknown>): Promise<SkillResult> {
    const from = input.from as string | undefined;
    const to = input.to as string | undefined;
    if (!from) return { success: false, error: 'Missing required field "from" for journeys' };
    if (!to) return { success: false, error: 'Missing required field "to" for journeys' };

    const options: JourneyOptions = {};
    if (input.departure) options.departure = new Date(input.departure as string);
    if (input.arrival) options.arrival = new Date(input.arrival as string);
    if (input.results) options.results = input.results as number;

    const journeys = await this.client.journeys(from, to, options);
    if (journeys.length === 0) {
      return { success: true, data: [], display: `Keine Verbindungen gefunden von ${from} nach ${to}.` };
    }

    const lines = [`## Verbindungen: ${from} → ${to}`, ''];
    for (let i = 0; i < journeys.length; i++) {
      const j = journeys[i];
      const dep = this.formatTime(j.departure);
      const arr = this.formatTime(j.arrival);
      lines.push(`### Verbindung ${i + 1}: ${dep} → ${arr} (${j.duration} min, ${j.transfers} Umstieg${j.transfers !== 1 ? 'e' : ''})`);
      for (const leg of j.legs) {
        if (leg.walking) {
          lines.push(`  - 🚶 Fußweg → ${leg.destination} (${this.formatTime(leg.departure)}–${this.formatTime(leg.arrival)})`);
        } else {
          lines.push(`  - ${leg.line || leg.mode} Ri. ${leg.direction || leg.destination}: ${leg.origin} ${this.formatTime(leg.departure)} → ${leg.destination} ${this.formatTime(leg.arrival)}`);
        }
      }
      lines.push('');
    }

    return { success: true, data: journeys, display: lines.join('\n') };
  }

  private async findDepartures(input: Record<string, unknown>): Promise<SkillResult> {
    const stopId = input.stop_id as string | undefined;
    if (!stopId) return { success: false, error: 'Missing required field "stop_id" for departures. Use search_stop first to find the stop ID.' };

    const options: DepartureOptions = {};
    if (input.departure) options.when = new Date(input.departure as string);
    if (input.duration) options.duration = input.duration as number;

    const departures = await this.client.departures(stopId, options);
    if (departures.length === 0) {
      return { success: true, data: [], display: 'Keine Abfahrten gefunden.' };
    }

    const lines = ['## Abfahrten', ''];
    for (const d of departures) {
      const time = this.formatTime(d.when);
      const delay = d.delay ? ` (+${d.delay} min)` : '';
      const platform = d.platform ? ` [Steig ${d.platform}]` : '';
      lines.push(`- **${time}${delay}** ${d.line} → ${d.direction}${platform}`);
    }

    return { success: true, data: departures, display: lines.join('\n') };
  }

  private formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }
}
