import type { SkillMetadata, SkillContext, SkillResult, BMWCarDataConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

type Action = 'authorize' | 'status' | 'charging' | 'charging_sessions';

// ── BMW CarData Customer API ──────────────────────────────
const DEVICE_CODE_URL = 'https://customer.bmwgroup.com/gcdm/oauth/device/code';
const TOKEN_URL = 'https://customer.bmwgroup.com/gcdm/oauth/token';
const API_BASE = 'https://api-cardata.bmwgroup.com';
const API_VERSION = 'v1';
const SCOPE = 'authenticate_user openid cardata:api:read cardata:streaming:read';
const CACHE_TTL = 5 * 60_000; // 5 min — BMW allows max 50 calls/day
const CONTAINER_NAME = 'Alfred';
const TOKEN_PATH = join(homedir(), '.alfred', 'bmw-tokens.json');

// ── PKCE helpers ──────────────────────────────────────────
function generateCodeVerifier(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(86);
  return Array.from(bytes).map(b => charset[b % charset.length]).join('');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Telematik Descriptor Keys ─────────────────────────────
const DESCRIPTORS = [
  'vehicle.drivetrain.batteryManagement.header',
  'vehicle.drivetrain.batteryManagement.maxEnergy',
  'vehicle.drivetrain.electricEngine.remainingElectricRange',
  'vehicle.drivetrain.electricEngine.charging.status',
  'vehicle.drivetrain.electricEngine.charging.level',
  'vehicle.drivetrain.electricEngine.charging.timeRemaining',
  'vehicle.drivetrain.electricEngine.charging.hvStatus',
  'vehicle.powertrain.electric.battery.charging.power',
  'vehicle.drivetrain.electricEngine.charging.acVoltage',
  'vehicle.drivetrain.electricEngine.charging.acAmpere',
  'vehicle.powertrain.electric.battery.stateOfCharge.target',
  'vehicle.powertrain.electric.battery.stateOfHealth.displayed',
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.isPlugged',
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.flap.isOpen',
  'vehicle.body.chargingPort.lockedStatus',
];

// ── Types ─────────────────────────────────────────────────
interface BMWTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  vin: string;
  containerId: string;
  codeVerifier?: string;
  deviceCode?: string;
}

type TelematicResponse = Record<string, { value: string; unit: string; timestamp: string }>;

interface CacheEntry {
  data: unknown;
  ts: number;
}

function tv(data: TelematicResponse, key: string): string {
  return data[key]?.value ?? '?';
}

// ── Skill ─────────────────────────────────────────────────
export class BMWSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'bmw',
    category: 'infrastructure',
    description:
      'BMW CarData — Fahrzeugdaten abrufen. ' +
      '"authorize" startet den Device-Auth-Flow (einmalig). ' +
      '"status" zeigt SoC, Reichweite, Modell, Batterie-Gesundheit. ' +
      '"charging" zeigt Ladestatus, Leistung, Restzeit, Ziel-SoC, Stecker. ' +
      '"charging_sessions" listet Lade-Sessions (from/to Zeitraum).',
    riskLevel: 'read',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['authorize', 'status', 'charging', 'charging_sessions'],
          description: 'BMW CarData action',
        },
        vin: {
          type: 'string',
          description: 'Vehicle Identification Number (optional — uses stored VIN if omitted)',
        },
        device_code: {
          type: 'string',
          description: 'Device code from authorize step 1 (for polling token in step 2)',
        },
        from: {
          type: 'string',
          description: 'ISO date-time start for charging_sessions (required for that action)',
        },
        to: {
          type: 'string',
          description: 'ISO date-time end for charging_sessions (required for that action)',
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
        case 'charging':
          return await this.getCharging(input.vin as string | undefined);
        case 'charging_sessions':
          return await this.getChargingSessions(
            input.vin as string | undefined,
            input.from as string | undefined,
            input.to as string | undefined,
          );
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `BMW API error: ${msg}` };
    }
  }

  // ── OAuth Device Authorization Flow with PKCE ───────────

  private async authorize(deviceCode?: string): Promise<SkillResult> {
    if (deviceCode) {
      return await this.pollToken(deviceCode);
    }

    // Step 1: Request device code with PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        response_type: 'device_code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Device code request failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Persist PKCE verifier + device code for step 2
    const partial: Partial<BMWTokens> = {
      codeVerifier,
      deviceCode: data.device_code as string,
    };
    await this.savePartialTokens(partial);

    return {
      success: true,
      data,
      display: [
        '## BMW Autorisierung',
        '',
        `1. Öffne: **${(data.verification_uri_complete as string) ?? (data.verification_uri as string)}**`,
        `2. Gib diesen Code ein: **${data.user_code as string}**`,
        '',
        `Danach ruf diese Action erneut auf mit \`device_code: "${data.device_code as string}"\` um den Token abzuholen.`,
      ].join('\n'),
    };
  }

  private async pollToken(deviceCode: string): Promise<SkillResult> {
    // Load PKCE verifier from partial tokens
    const partial = await this.loadTokens();
    const codeVerifier = partial?.codeVerifier;
    if (!codeVerifier) {
      throw new Error('Kein code_verifier gefunden. Bitte zuerst "authorize" ohne device_code aufrufen.');
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        code_verifier: codeVerifier,
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
    const accessToken = data.access_token as string;

    // Fetch VIN + setup container
    const vin = await this.fetchVin(accessToken);
    const containerId = await this.ensureContainer(accessToken, vin);

    const tokens: BMWTokens = {
      accessToken,
      refreshToken: data.refresh_token as string,
      idToken: data.id_token as string,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
      vin,
      containerId,
    };

    await this.saveTokens(tokens);
    this.tokens = tokens;

    return {
      success: true,
      data: { vin, containerId },
      display: [
        '## BMW Autorisierung erfolgreich',
        '',
        `**VIN:** ${vin}`,
        `**Container:** ${containerId}`,
        'Tokens gespeichert. Du kannst jetzt Fahrzeugdaten abrufen.',
      ].join('\n'),
    };
  }

  // ── Vehicle + Container Setup ───────────────────────────

  private async fetchVin(accessToken: string): Promise<string> {
    const res = await fetch(`${API_BASE}/customers/vehicles/mappings`, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Failed to fetch vehicles: HTTP ${res.status}`);

    const raw = await res.json() as Record<string, unknown>;
    // API may return an array directly or wrap it in an object (e.g. { vehicles: [...] })
    const data: Array<{ vin: string; mappingType: string }> = Array.isArray(raw)
      ? raw as unknown as Array<{ vin: string; mappingType: string }>
      : Array.isArray(raw.vehicles) ? raw.vehicles as Array<{ vin: string; mappingType: string }>
      : Array.isArray(raw.mappings) ? raw.mappings as Array<{ vin: string; mappingType: string }>
      : [];
    const primary = data.find(v => v.mappingType === 'PRIMARY');
    if (!primary) {
      if (data.length > 0) return data[0].vin;
      throw new Error(`No vehicles found in account (response: ${JSON.stringify(raw).slice(0, 200)})`);
    }
    return primary.vin;
  }

  private async ensureContainer(accessToken: string, vin: string): Promise<string> {
    // Check existing containers
    const listRes = await fetch(`${API_BASE}/customers/containers`, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });
    if (listRes.ok) {
      const listRaw = await listRes.json() as Record<string, unknown>;
      const containers: Array<{ containerId: string; name: string }> = Array.isArray(listRaw)
        ? listRaw as unknown as Array<{ containerId: string; name: string }>
        : Array.isArray(listRaw.containers) ? listRaw.containers as Array<{ containerId: string; name: string }>
        : [];
      const existing = containers.find(c => c.name === CONTAINER_NAME);
      if (existing) return existing.containerId;
    }

    // Create new container
    const createRes = await fetch(`${API_BASE}/customers/containers`, {
      method: 'POST',
      headers: {
        ...this.apiHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: CONTAINER_NAME,
        purpose: 'Alfred AI Assistant',
        technicalDescriptors: DESCRIPTORS.map(key => ({ key })),
        vins: [vin],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw new Error(`Container creation failed: HTTP ${createRes.status} — ${text.slice(0, 300)}`);
    }

    const created = (await createRes.json()) as { containerId: string };
    return created.containerId;
  }

  // ── API helpers ─────────────────────────────────────────

  private apiHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'x-version': API_VERSION,
      Accept: 'application/json',
    };
  }

  private async apiGet<T = unknown>(path: string): Promise<T> {
    const cacheKey = path;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data as T;
    }

    let accessToken = await this.ensureToken();
    const url = `${API_BASE}${path}`;

    let res = await fetch(url, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });

    // Retry once on 401 with refreshed token
    if (res.status === 401) {
      const tokens = await this.loadTokens();
      if (tokens) {
        accessToken = await this.refreshAccessToken(tokens);
        res = await fetch(url, {
          headers: this.apiHeaders(accessToken),
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

  // ── Token management ────────────────────────────────────

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

  private async savePartialTokens(partial: Partial<BMWTokens>): Promise<void> {
    await mkdir(join(homedir(), '.alfred'), { recursive: true });
    let existing: Partial<BMWTokens> = {};
    try {
      const raw = await readFile(TOKEN_PATH, 'utf-8');
      existing = JSON.parse(raw) as Partial<BMWTokens>;
    } catch {
      // no existing file
    }
    await writeFile(TOKEN_PATH, JSON.stringify({ ...existing, ...partial }, null, 2), 'utf-8');
  }

  private async ensureToken(): Promise<string> {
    const tokens = await this.loadTokens();
    if (!tokens?.accessToken) {
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
    const res = await fetch(TOKEN_URL, {
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
      idToken: (data.id_token as string) ?? tokens.idToken,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    };
    // Clear temporary auth fields
    delete updated.codeVerifier;
    delete updated.deviceCode;

    await this.saveTokens(updated);
    this.tokens = updated;
    return updated.accessToken;
  }

  private async resolveVin(inputVin?: string): Promise<string> {
    if (inputVin) return inputVin;
    const tokens = await this.loadTokens();
    if (tokens?.vin) return tokens.vin;
    throw new Error('Keine VIN angegeben und keine gespeicherte VIN gefunden. Bitte zuerst "authorize" aufrufen.');
  }

  private async resolveContainerId(): Promise<string> {
    const tokens = await this.loadTokens();
    if (tokens?.containerId) return tokens.containerId;
    throw new Error('Kein Container gefunden. Bitte zuerst "authorize" aufrufen.');
  }

  // ── Actions ─────────────────────────────────────────────

  private async getStatus(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const containerId = await this.resolveContainerId();

    // Fetch telematic + basic data in parallel
    const [telematicRaw, basicData] = await Promise.all([
      this.apiGet<{ telematicData: TelematicResponse }>(
        `/customers/vehicles/${vin}/telematicData?containerId=${containerId}`,
      ),
      this.apiGet<Record<string, unknown>>(
        `/customers/vehicles/${vin}/basicData`,
      ),
    ]);

    const t = telematicRaw.telematicData ?? {};
    const soc = tv(t, 'vehicle.drivetrain.batteryManagement.header');
    const range = tv(t, 'vehicle.drivetrain.electricEngine.remainingElectricRange');
    const maxEnergy = tv(t, 'vehicle.drivetrain.batteryManagement.maxEnergy');
    const soh = tv(t, 'vehicle.powertrain.electric.battery.stateOfHealth.displayed');

    const model = basicData.model ?? basicData.modelName ?? '?';

    const lines = [
      '## BMW Fahrzeugstatus',
      '',
      `**Modell:** ${model as string}`,
      `**VIN:** ${vin}`,
      `**Ladestand (SoC):** ${soc} %`,
      `**Elektrische Reichweite:** ${range} km`,
      `**Batteriekapazität:** ${maxEnergy} kWh`,
      `**Batterie-Gesundheit (SoH):** ${soh} %`,
    ];

    return { success: true, data: { telematic: t, basic: basicData }, display: lines.join('\n') };
  }

  private async getCharging(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const containerId = await this.resolveContainerId();

    const telematicRaw = await this.apiGet<{ telematicData: TelematicResponse }>(
      `/customers/vehicles/${vin}/telematicData?containerId=${containerId}`,
    );

    const t = telematicRaw.telematicData ?? {};
    const chargingStatus = tv(t, 'vehicle.drivetrain.electricEngine.charging.status');
    const soc = tv(t, 'vehicle.drivetrain.batteryManagement.header');
    const level = tv(t, 'vehicle.drivetrain.electricEngine.charging.level');
    const timeRemaining = tv(t, 'vehicle.drivetrain.electricEngine.charging.timeRemaining');
    const power = tv(t, 'vehicle.powertrain.electric.battery.charging.power');
    const hvStatus = tv(t, 'vehicle.drivetrain.electricEngine.charging.hvStatus');
    const targetSoc = tv(t, 'vehicle.powertrain.electric.battery.stateOfCharge.target');
    const acVoltage = tv(t, 'vehicle.drivetrain.electricEngine.charging.acVoltage');
    const acAmpere = tv(t, 'vehicle.drivetrain.electricEngine.charging.acAmpere');
    const plugged = tv(t, 'vehicle.powertrain.tractionBattery.charging.port.anyPosition.isPlugged');
    const flapOpen = tv(t, 'vehicle.powertrain.tractionBattery.charging.port.anyPosition.flap.isOpen');
    const portLock = tv(t, 'vehicle.body.chargingPort.lockedStatus');

    const lines = [
      '## BMW Ladestatus',
      '',
      `**Status:** ${chargingStatus}`,
      `**Ladestand:** ${soc} %`,
      `**Ladelevel:** ${level}`,
      `**Ladeleistung:** ${power} kW`,
      `**Restzeit:** ${timeRemaining} min`,
      `**Ziel-SoC:** ${targetSoc} %`,
      `**HV-Batterie:** ${hvStatus}`,
      `**AC Spannung:** ${acVoltage} V`,
      `**AC Strom:** ${acAmpere} A`,
      `**Stecker eingesteckt:** ${plugged}`,
      `**Ladeklappe offen:** ${flapOpen}`,
      `**Ladeport-Schloss:** ${portLock}`,
    ];

    return { success: true, data: t, display: lines.join('\n') };
  }

  private async getChargingSessions(
    inputVin?: string,
    from?: string,
    to?: string,
  ): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);

    // Default: last 30 days
    const now = new Date();
    const toDate = to ?? now.toISOString();
    const fromDate = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();

    const data = await this.apiGet<Record<string, unknown>>(
      `/customers/vehicles/${vin}/chargingHistory?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
    );

    const sessions = (data.chargingSessions ?? data.sessions ?? []) as Array<Record<string, unknown>>;

    const lines = [
      `## BMW Lade-Sessions (${fromDate.slice(0, 10)} – ${toDate.slice(0, 10)})`,
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
