import type { SkillMetadata, SkillContext, SkillResult, RoutingConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'route' | 'departure_time';

interface Waypoint {
  location: {
    latLng: { latitude: number; longitude: number };
  };
}

interface RouteResponse {
  routes: Array<{
    distanceMeters: number;
    duration: string;
    staticDuration: string;
    polyline?: { encodedPolyline: string };
    legs?: Array<{
      distanceMeters: number;
      duration: string;
      staticDuration: string;
    }>;
  }>;
}

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export class RoutingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'routing',
    category: 'information',
    description:
      'Routenberechnung mit Live-Traffic via Google Routes API. ' +
      '"route" berechnet Route mit Distanz, Dauer und Dauer im aktuellen Verkehr. ' +
      '"departure_time" empfiehlt wann man losfahren soll, um zu einer bestimmten Zeit anzukommen. ' +
      'Orte als Adresse oder "lat,lng" angeben.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['route', 'departure_time'],
          description: 'Routing action',
        },
        origin: {
          type: 'string',
          description: 'Start-Adresse oder "lat,lng"',
        },
        destination: {
          type: 'string',
          description: 'Ziel-Adresse oder "lat,lng"',
        },
        departure_time: {
          type: 'string',
          description: 'ISO-Zeitpunkt für Abfahrt (optional, für Traffic-Berechnung)',
        },
        arrival_time: {
          type: 'string',
          description: 'ISO-Zeitpunkt gewünschte Ankunft (für departure_time-Action)',
        },
        travel_mode: {
          type: 'string',
          enum: ['DRIVE', 'BICYCLE', 'WALK', 'TRANSIT'],
          description: 'Fortbewegungsart (Standard: DRIVE)',
        },
      },
      required: ['action', 'origin', 'destination'],
    },
  };

  private readonly config: RoutingConfig;

  constructor(config: RoutingConfig) {
    super();
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    const origin = input.origin as string | undefined;
    const destination = input.destination as string | undefined;
    if (!origin) return { success: false, error: 'Missing required field "origin"' };
    if (!destination) return { success: false, error: 'Missing required field "destination"' };

    try {
      switch (action) {
        case 'route':
          return await this.computeRoute(
            origin,
            destination,
            input.departure_time as string | undefined,
            input.travel_mode as string | undefined,
          );
        case 'departure_time':
          return await this.computeDepartureTime(
            origin,
            destination,
            input.arrival_time as string | undefined,
            input.travel_mode as string | undefined,
          );
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Google Routes API error: ${msg}` };
    }
  }

  // ── Route calculation ─────────────────────────────────────

  private async computeRoute(
    origin: string,
    destination: string,
    departureTime?: string,
    travelMode?: string,
  ): Promise<SkillResult> {
    const body = this.buildRequestBody(origin, destination, travelMode, departureTime);
    const data = await this.callRoutesApi(body);
    const route = data.routes?.[0];

    if (!route) {
      return { success: false, error: 'Keine Route gefunden.' };
    }

    const distKm = (route.distanceMeters / 1000).toFixed(1);
    const durationMin = this.parseDuration(route.duration);
    const staticMin = this.parseDuration(route.staticDuration);
    const trafficDelay = durationMin - staticMin;

    const lines = [
      '## Route',
      '',
      `**${origin}** → **${destination}**`,
      '',
      `**Distanz:** ${distKm} km`,
      `**Fahrzeit (aktuell):** ${this.formatMinutes(durationMin)}`,
      `**Fahrzeit (ohne Verkehr):** ${this.formatMinutes(staticMin)}`,
    ];

    if (trafficDelay > 1) {
      lines.push(`**Verkehrsverzögerung:** +${this.formatMinutes(trafficDelay)}`);
    }

    if (departureTime) {
      const arrival = new Date(new Date(departureTime).getTime() + durationMin * 60_000);
      lines.push(`**Geschätzte Ankunft:** ${arrival.toLocaleString('de-AT')}`);
    }

    return {
      success: true,
      data: { distanceKm: parseFloat(distKm), durationMinutes: durationMin, staticDurationMinutes: staticMin },
      display: lines.join('\n'),
    };
  }

  private async computeDepartureTime(
    origin: string,
    destination: string,
    arrivalTime?: string,
    travelMode?: string,
  ): Promise<SkillResult> {
    if (!arrivalTime) {
      return { success: false, error: 'Missing required field "arrival_time" for departure_time action' };
    }

    // Compute route without explicit departureTime — Google defaults to "now"
    // (sending an explicit "now" timestamp is rejected: "Timestamp must be set to a future time.")
    const body = this.buildRequestBody(origin, destination, travelMode);
    const data = await this.callRoutesApi(body);
    const route = data.routes?.[0];

    if (!route) {
      return { success: false, error: 'Keine Route gefunden.' };
    }

    const durationMin = this.parseDuration(route.duration);
    const bufferMin = Math.max(5, Math.round(durationMin * 0.15)); // 15% Puffer
    const arrivalDate = new Date(arrivalTime);
    const departureDate = new Date(arrivalDate.getTime() - (durationMin + bufferMin) * 60_000);

    const lines = [
      '## Abfahrtszeit-Empfehlung',
      '',
      `**Route:** ${origin} → ${destination}`,
      `**Gewünschte Ankunft:** ${arrivalDate.toLocaleString('de-AT')}`,
      `**Geschätzte Fahrzeit:** ${this.formatMinutes(durationMin)} (inkl. Verkehr)`,
      `**Puffer:** ${bufferMin} min`,
      '',
      `**Empfohlene Abfahrt:** ${departureDate.toLocaleString('de-AT')}`,
    ];

    return {
      success: true,
      data: {
        departureTime: departureDate.toISOString(),
        durationMinutes: durationMin,
        bufferMinutes: bufferMin,
      },
      display: lines.join('\n'),
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private buildWaypoint(place: string): Waypoint | { address: string } {
    const latLng = place.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (latLng) {
      return {
        location: {
          latLng: { latitude: parseFloat(latLng[1]), longitude: parseFloat(latLng[2]) },
        },
      };
    }
    return { address: place };
  }

  /**
   * Normalize a timestamp to RFC 3339 (required by Google Routes API).
   * If the input has no timezone info, treat it as local time and append
   * the system's UTC offset so Google interprets it correctly.
   */
  private normalizeTimestamp(ts: string): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts; // pass through, let API report the error

    // If input already has Z or +/- offset, it's fine — use ISO
    if (/[Zz]|[+-]\d{2}:\d{2}$/.test(ts)) {
      return d.toISOString();
    }

    // No timezone → treat as local: build RFC 3339 with local offset
    const off = d.getTimezoneOffset();
    const sign = off <= 0 ? '+' : '-';
    const absOff = Math.abs(off);
    const hh = String(Math.floor(absOff / 60)).padStart(2, '0');
    const mm = String(absOff % 60).padStart(2, '0');
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
  }

  private buildRequestBody(
    origin: string,
    destination: string,
    travelMode?: string,
    departureTime?: string,
    arrivalTime?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      origin: this.buildWaypoint(origin),
      destination: this.buildWaypoint(destination),
      travelMode: travelMode ?? 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    };

    // Google rejects departureTime/arrivalTime that are not strictly in the future.
    // If omitted, Google defaults to "now" which is what we want for current-time queries.
    if (departureTime) {
      const normalized = this.normalizeTimestamp(departureTime);
      const dt = new Date(normalized);
      if (dt.getTime() > Date.now() + 60_000) {
        // Only send if at least 1 min in the future
        body.departureTime = normalized;
      }
    }
    if (arrivalTime) {
      const normalized = this.normalizeTimestamp(arrivalTime);
      const dt = new Date(normalized);
      if (dt.getTime() > Date.now() + 60_000) {
        body.arrivalTime = normalized;
      }
    }

    return body;
  }

  private async callRoutesApi(body: Record<string, unknown>): Promise<RouteResponse> {
    const res = await fetch(ROUTES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.config.apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.legs',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }

    return (await res.json()) as RouteResponse;
  }

  private parseDuration(d: string): number {
    // Google returns "123s" format
    const match = d?.match(/(\d+)s/);
    return match ? Math.round(parseInt(match[1], 10) / 60) : 0;
  }

  private formatMinutes(min: number): string {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
}
