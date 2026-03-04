import type { SkillMetadata, SkillContext, SkillResult, BMWCarDataConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Action = 'authorize' | 'status' | 'location' | 'charging' | 'charging_sessions';

const TOKEN_PATH = join(homedir(), '.alfred', 'bmw-tokens.json');
const CACHE_TTL = 5 * 60_000; // 5 min — BMW allows max 50 calls/day
const BMW_API = 'https://b2vapi.bmwgroup.com';
const AUTH_URL = 'https://login.bmwgroup.com/gcdm/oauth';

interface BMWTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  vin: string;
}

interface CacheEntry {
  data: unknown;
  ts: number;
}

export class BMWSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'bmw',
    category: 'infrastructure',
    description:
      'BMW CarData — Fahrzeugdaten abrufen. ' +
      '"authorize" startet den Device-Auth-Flow (einmalig). ' +
      '"status" zeigt SoC, Reichweite, km-Stand, Türen/Fenster. ' +
      '"location" gibt GPS-Koordinaten. ' +
      '"charging" zeigt Ladestatus, Leistung, Restzeit. ' +
      '"charging_sessions" listet Lade-Sessions der letzten 30 Tage.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['authorize', 'status', 'location', 'charging', 'charging_sessions'],
          description: 'BMW CarData action',
        },
        vin: {
          type: 'string',
          description: 'Vehicle Identification Number (optional — uses stored VIN if omitted)',
        },
        device_code: {
          type: 'string',
          description: 'Device code from authorize step (for polling token)',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: BMWCarDataConfig;
  private tokens: BMWTokens | null = null;
  private cache: Map<string, CacheEntry> = new Map();

  constructor(config: BMWCarDataConfig) {
    super();
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Missing required field "action"' };

    try {
      switch (action) {
        case 'authorize':
          return await this.authorize(input.device_code as string | undefined);
        case 'status':
          return await this.getStatus(input.vin as string | undefined);
        case 'location':
          return await this.getLocation(input.vin as string | undefined);
        case 'charging':
          return await this.getCharging(input.vin as string | undefined);
        case 'charging_sessions':
          return await this.getChargingSessions(input.vin as string | undefined);
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `BMW API error: ${msg}` };
    }
  }

  // ── OAuth Device Authorization Flow ───────────────────────

  private async authorize(deviceCode?: string): Promise<SkillResult> {
    if (deviceCode) {
      return await this.pollToken(deviceCode);
    }

    const res = await fetch(`${AUTH_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        scope: 'vehicle_data remote_services',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Device code request failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    return {
      success: true,
      data,
      display: [
        '## BMW Autorisierung',
        '',
        `1. Öffne: **${data.verification_uri as string}**`,
        `2. Gib diesen Code ein: **${data.user_code as string}**`,
        '',
        `Danach ruf diese Action erneut auf mit \`device_code: "${data.device_code as string}"\` um den Token abzuholen.`,
      ].join('\n'),
    };
  }

  private async pollToken(deviceCode: string): Promise<SkillResult> {
    const res = await fetch(`${AUTH_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (text.includes('authorization_pending')) {
        return {
          success: true,
          data: { status: 'pending' },
          display: 'Autorisierung noch ausstehend — bitte zuerst im Browser bestätigen, dann erneut versuchen.',
        };
      }
      throw new Error(`Token poll failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Fetch VIN from vehicles list
    const vin = await this.fetchVin(data.access_token as string);

    const tokens: BMWTokens = {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
      vin,
    };

    await this.saveTokens(tokens);
    this.tokens = tokens;

    return {
      success: true,
      data: { vin },
      display: [
        '## BMW Autorisierung erfolgreich',
        '',
        `VIN: **${vin}**`,
        'Tokens gespeichert. Du kannst jetzt Fahrzeugdaten abrufen.',
      ].join('\n'),
    };
  }

  private async fetchVin(accessToken: string): Promise<string> {
    const res = await fetch(`${BMW_API}/api/me/vehicles/v2`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Failed to fetch vehicles: HTTP ${res.status}`);
    const vehicles = (await res.json()) as Array<{ vin: string }>;
    if (!vehicles.length) throw new Error('No vehicles found in account');
    return vehicles[0].vin;
  }

  // ── Token management ──────────────────────────────────────

  private async loadTokens(): Promise<BMWTokens | null> {
    if (this.tokens) return this.tokens;
    try {
      const raw = await readFile(TOKEN_PATH, 'utf-8');
      this.tokens = JSON.parse(raw) as BMWTokens;
      return this.tokens;
    } catch {
      return null;
    }
  }

  private async saveTokens(tokens: BMWTokens): Promise<void> {
    await mkdir(join(homedir(), '.alfred'), { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
  }

  private async ensureToken(): Promise<string> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      throw new Error(
        'Nicht autorisiert. Bitte zuerst die "authorize"-Action aufrufen, um den BMW-Account zu verbinden.',
      );
    }

    if (Date.now() > tokens.expiresAt - 60_000) {
      return await this.refreshAccessToken(tokens);
    }

    return tokens.accessToken;
  }

  private async refreshAccessToken(tokens: BMWTokens): Promise<string> {
    const res = await fetch(`${AUTH_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      this.tokens = null;
      throw new Error(
        'Token-Refresh fehlgeschlagen. Bitte erneut "authorize" aufrufen.',
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const updated: BMWTokens = {
      ...tokens,
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? tokens.refreshToken,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    };

    await this.saveTokens(updated);
    this.tokens = updated;
    return updated.accessToken;
  }

  // ── API helper with cache ─────────────────────────────────

  private async api<T = unknown>(path: string, vin: string): Promise<T> {
    const cacheKey = `${vin}:${path}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data as T;
    }

    let accessToken = await this.ensureToken();
    let res = await fetch(`${BMW_API}${path}`.replace('{vin}', vin), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    // Retry once on 401/403 with refreshed token
    if (res.status === 401 || res.status === 403) {
      const tokens = await this.loadTokens();
      if (tokens) {
        accessToken = await this.refreshAccessToken(tokens);
        res = await fetch(`${BMW_API}${path}`.replace('{vin}', vin), {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as T;
    this.cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  private async resolveVin(inputVin?: string): Promise<string> {
    if (inputVin) return inputVin;
    const tokens = await this.loadTokens();
    if (tokens?.vin) return tokens.vin;
    throw new Error('Keine VIN angegeben und keine gespeicherte VIN gefunden. Bitte zuerst "authorize" aufrufen.');
  }

  // ── Actions ───────────────────────────────────────────────

  private async getStatus(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const data = await this.api<Record<string, unknown>>('/api/vehicle/dynamic/v1/{vin}', vin);

    const attrs = (data.attributesMap ?? data) as Record<string, string>;
    const soc = attrs.chargingLevelHv ?? attrs.soc ?? '?';
    const range = attrs.beRemainingRangeElectric ?? attrs.remainingRangeElectric ?? '?';
    const mileage = attrs.mileage ?? attrs.head_unit_total_mileage ?? '?';
    const doorLock = attrs.door_lock_state ?? '?';
    const windows = attrs.window_driver_front ?? '?';

    const lines = [
      '## BMW Fahrzeugstatus',
      '',
      `**VIN:** ${vin}`,
      `**Ladestand (SoC):** ${soc} %`,
      `**Elektrische Reichweite:** ${range} km`,
      `**Kilometerstand:** ${mileage} km`,
      `**Türschloss:** ${doorLock}`,
      `**Fenster:** ${windows}`,
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  private async getLocation(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const data = await this.api<Record<string, unknown>>('/api/vehicle/dynamic/v1/{vin}', vin);

    const attrs = (data.attributesMap ?? data) as Record<string, string>;
    const lat = attrs.gps_lat ?? attrs.latitude ?? '?';
    const lng = attrs.gps_lng ?? attrs.longitude ?? '?';
    const heading = attrs.heading ?? '?';

    return {
      success: true,
      data: { lat, lng, heading },
      display: [
        '## BMW Fahrzeugposition',
        '',
        `**Latitude:** ${lat}`,
        `**Longitude:** ${lng}`,
        `**Richtung:** ${heading}°`,
      ].join('\n'),
    };
  }

  private async getCharging(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const data = await this.api<Record<string, unknown>>('/api/vehicle/dynamic/v1/{vin}', vin);

    const attrs = (data.attributesMap ?? data) as Record<string, string>;
    const chargingStatus = attrs.charging_status ?? attrs.chargingStatus ?? '?';
    const soc = attrs.chargingLevelHv ?? attrs.soc ?? '?';
    const remainingTime = attrs.chargingTimeRemaining ?? attrs.charging_time_remaining ?? '?';
    const range = attrs.beRemainingRangeElectric ?? attrs.remainingRangeElectric ?? '?';

    const lines = [
      '## BMW Ladestatus',
      '',
      `**Status:** ${chargingStatus}`,
      `**Ladestand:** ${soc} %`,
      `**Restzeit:** ${remainingTime} min`,
      `**Reichweite:** ${range} km`,
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  private async getChargingSessions(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const data = await this.api<Record<string, unknown>>('/api/vehicle/charging/sessions/v1/{vin}', vin);

    const sessions = (data.chargingSessions ?? data.sessions ?? []) as Array<Record<string, unknown>>;

    const lines = [
      '## BMW Lade-Sessions (letzte 30 Tage)',
      '',
      '| Datum | Dauer | Energie | Start-SoC | End-SoC |',
      '|-------|-------|---------|-----------|---------|',
    ];

    for (const s of sessions.slice(0, 20)) {
      const date = s.date ?? s.startTime ?? '-';
      const duration = s.duration ?? s.chargingDuration ?? '-';
      const energy = s.energyCharged ?? s.energy ?? '-';
      const startSoc = s.startSoc ?? '-';
      const endSoc = s.endSoc ?? '-';
      lines.push(`| ${date} | ${duration} min | ${energy} kWh | ${startSoc}% | ${endSoc}% |`);
    }

    if (sessions.length === 0) {
      lines.push('| - | Keine Sessions gefunden | - | - | - |');
    }

    return { success: true, data, display: lines.join('\n') };
  }
}
