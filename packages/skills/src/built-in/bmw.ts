import type { SkillMetadata, SkillContext, SkillResult, BMWCarDataConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

type Action = 'authorize' | 'status' | 'charging' | 'charging_sessions' | 'consumption' | 'history';

// ── BMW CarData Customer API ──────────────────────────────
const DEVICE_CODE_URL = 'https://customer.bmwgroup.com/gcdm/oauth/device/code';
const TOKEN_URL = 'https://customer.bmwgroup.com/gcdm/oauth/token';
const API_BASE = 'https://api-cardata.bmwgroup.com';
const API_VERSION = 'v1';
const SCOPE = 'authenticate_user openid cardata:api:read cardata:streaming:read';
const CACHE_TTL = 5 * 60_000; // 5 min — in-memory apiGet cache for non-telematic calls
const DB_TELEMATIC_TTL = 60 * 60_000; // 60 min — DB-persisted telematic data considered fresh
const CONTAINER_NAME = 'Alfred';
function getTokenPath(userId: string): string {
  const safe = userId.replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
  return join(homedir(), '.alfred', `bmw-tokens-${safe}.json`);
}

// ── PKCE helpers ──────────────────────────────────────────
function generateCodeVerifier(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(86);
  return Array.from(bytes).map(b => charset[b % charset.length]).join('');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Telematik Descriptor Keys (from BMW Telematics Data Catalogue) ───
const DESCRIPTORS = [
  // Battery & SoC
  'vehicle.drivetrain.batteryManagement.header',
  'vehicle.drivetrain.batteryManagement.maxEnergy',
  'vehicle.drivetrain.batteryManagement.batterySizeMax',
  'vehicle.powertrain.electric.battery.stateOfHealth.displayed',
  'vehicle.powertrain.electric.battery.stateOfCharge.target',
  // Range
  'vehicle.drivetrain.electricEngine.remainingElectricRange',
  // Charging status
  'vehicle.drivetrain.electricEngine.charging.status',
  'vehicle.drivetrain.electricEngine.charging.level',
  'vehicle.drivetrain.electricEngine.charging.timeRemaining',
  'vehicle.drivetrain.electricEngine.charging.timeToFullyCharged',
  'vehicle.drivetrain.electricEngine.charging.hvStatus',
  'vehicle.drivetrain.electricEngine.charging.method',
  'vehicle.drivetrain.electricEngine.charging.phaseNumber',
  'vehicle.drivetrain.electricEngine.charging.lastChargingReason',
  'vehicle.drivetrain.electricEngine.charging.lastChargingResult',
  'vehicle.drivetrain.electricEngine.charging.reasonChargingEnd',
  // Charging power & limits
  'vehicle.powertrain.electric.battery.charging.power',
  'vehicle.drivetrain.electricEngine.charging.acVoltage',
  'vehicle.drivetrain.electricEngine.charging.acAmpere',
  'vehicle.powertrain.electric.battery.charging.acLimit.selected',
  // Plug & port
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.isPlugged',
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.flap.isOpen',
  'vehicle.body.chargingPort.lockedStatus',
  'vehicle.body.chargingPort.plugEventId',
  // Preconditioning
  'vehicle.powertrain.electric.battery.preconditioning.automaticMode.statusFeedback',
  'vehicle.powertrain.electric.battery.preconditioning.manualMode.statusFeedback',
  // Trip & energy
  'vehicle.vehicle.avgAuxPower',
  'vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc',
  'vehicle.trip.segment.accumulated.drivetrain.electricEngine.recuperationTotal',
  // Vehicle identification
  'vehicle.vehicleIdentification.basicVehicleData',
  // Odometer
  'vehicle.vehicle.travelledDistance',
  // Security — lock, doors, trunk, windows
  'vehicle.access.centralLocking.isLocked',
  'vehicle.body.door.driver.isOpen',
  'vehicle.body.trunk.isOpen',
  'vehicle.body.window.driver.isOpen',
  // GPS location
  'vehicle.location.gps.latitude',
  'vehicle.location.gps.longitude',
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

/** Read telematic value — tries multiple descriptor paths (REST vs MQTT use different keys). */
function tv(data: TelematicResponse, ...keys: string[]): string {
  for (const key of keys) {
    if (data[key]?.value !== undefined) return data[key].value;
  }
  return '?';
}

/** MQTT→REST descriptor mapping for common fields. */
const MQTT_ALT_KEYS: Record<string, string[]> = {
  'vehicle.drivetrain.batteryManagement.header': ['vehicle.powertrain.electric.battery.stateOfCharge.displayed'],
  'vehicle.drivetrain.electricEngine.remainingElectricRange': ['vehicle.drivetrain.lastRemainingRange', 'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange'],
  'vehicle.access.centralLocking.isLocked': ['vehicle.cabin.door.status'],
  'vehicle.location.gps.latitude': ['vehicle.cabin.infotainment.navigation.currentLocation.latitude'],
  'vehicle.location.gps.longitude': ['vehicle.cabin.infotainment.navigation.currentLocation.longitude'],
  'vehicle.body.door.driver.isOpen': ['vehicle.cabin.door.row1.driver.isOpen'],
  'vehicle.body.trunk.isOpen': ['vehicle.body.trunk.door.isOpen'],
  'vehicle.body.window.driver.isOpen': ['vehicle.cabin.window.row1.driver.status'],
};

/** Read with fallback to MQTT alternative keys. */
function tvm(data: TelematicResponse, key: string): string {
  return tv(data, key, ...(MQTT_ALT_KEYS[key] ?? []));
}

// ── Skill ─────────────────────────────────────────────────
export class BMWSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'bmw',
    category: 'infrastructure',
    description:
      'BMW CarData — Fahrzeugdaten abrufen. ' +
      'WICHTIG: Rufe IMMER zuerst "status" oder die gewünschte Action auf — NICHT "authorize". ' +
      'authorize ist NUR nötig wenn der Skill einen Auth-Fehler zurückgibt. Der Token wird automatisch gespeichert und überlebt Restarts. ' +
      'Wenn authorize nötig ist: Schritt 1 (ohne device_code) liefert User-Code + URL. ' +
      'Schritt 2: Nach Browser-Bestätigung, authorize ERNEUT ohne Parameter (auto-resume). ' +
      'NIEMALS Schritt 1 wiederholen wenn bereits ein Code ausgegeben wurde! ' +
      'KRITISCH: Nach authorize KEINE anderen BMW-Aktionen (status, consumption etc.) aufrufen bis der User die Autorisierung bestätigt hat! ' +
      'Wenn "Kein Container" Fehler kommt: EINMAL authorize aufrufen, dann WARTEN. ' +
      '"status" zeigt SoC, Reichweite, Modell, Batterie-Gesundheit. ' +
      '"charging" zeigt Ladestatus, Leistung, Restzeit, Ziel-SoC, Stecker. ' +
      '"charging_sessions" listet Lade-Sessions (from/to Zeitraum). ' +
      '"consumption" berechnet Durchschnittsverbrauch (kWh/100km) aus Lade-Sessions — ' +
      'optional mit period: "last" (letzte Fahrt), "week", "month", "year", "all" (default: month). ' +
      '"history" zeigt gespeicherte Telematik-Werte (SoC, Reichweite, Standort) über einen Zeitraum (from/to, default: 7 Tage).',
    riskLevel: 'read',
    version: '2.2.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['authorize', 'status', 'charging', 'charging_sessions', 'consumption', 'history'],
          description: 'BMW CarData action',
        },
        vin: {
          type: 'string',
          description: 'Vehicle Identification Number (optional — uses stored VIN if omitted)',
        },
        device_code: {
          type: 'string',
          description: 'Device code from authorize step 1 (optional — if omitted, auto-resumes pending authorization)',
        },
        from: {
          type: 'string',
          description: 'ISO date-time start for charging_sessions (required for that action)',
        },
        to: {
          type: 'string',
          description: 'ISO date-time end for charging_sessions (required for that action)',
        },
        period: {
          type: 'string',
          enum: ['last', 'week', 'month', 'year', 'all'],
          description: 'Zeitraum für consumption: last (letzte Fahrt), week, month, year, all (default: month)',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: BMWCarDataConfig;
  /** Per-user token storage keyed by alfredUserId (or 'default' for global). */
  private tokensByUser: Map<string, BMWTokens | null> = new Map();
  private cacheByUser: Map<string, Map<string, CacheEntry>> = new Map();
  private activeUserId = 'default';

  /** Injected from alfred.ts — available on ALL nodes, not just the one running execute(). */
  private injectedServiceResolver?: SkillContext['userServiceResolver'];
  private injectedAlfredUserId?: string;
  /** Injected from alfred.ts — DB persistence for telematic data (cross-node + history). */
  private telematicRepo?: { insert(userId: string, vin: string, source: 'mqtt' | 'rest', data: Record<string, unknown>): Promise<void>; getLatest(userId: string, vin: string): Promise<{ telematicData: Record<string, unknown>; createdAt: string } | undefined>; getLatestBySource(userId: string, vin: string, source: 'mqtt' | 'rest'): Promise<{ telematicData: Record<string, unknown>; createdAt: string } | undefined>; getHistory(userId: string, vin: string, from: string, to: string, limit?: number): Promise<Array<{ telematicData: Record<string, unknown>; source: string; createdAt: string }>> };

  private get tokens(): BMWTokens | null { return this.tokensByUser.get(this.activeUserId) ?? null; }
  private set tokens(t: BMWTokens | null) { this.tokensByUser.set(this.activeUserId, t); }
  private get cache(): Map<string, CacheEntry> {
    if (!this.cacheByUser.has(this.activeUserId)) this.cacheByUser.set(this.activeUserId, new Map());
    return this.cacheByUser.get(this.activeUserId)!;
  }

  /** Per-request override for user-specific BMW config. */
  private activeConfig?: BMWCarDataConfig;

  /** Return the active (per-user or global) BMW config, respecting multi-user isolation. */
  private get cfg(): BMWCarDataConfig {
    if (this.activeConfig) return this.activeConfig;
    if (this.activeContext?.alfredUserId && this.activeContext.userRole !== 'admin') return undefined as unknown as BMWCarDataConfig;
    return this.config;
  }
  private get hasCfg(): boolean {
    if (this.activeConfig) return true;
    if (this.activeContext?.alfredUserId && this.activeContext.userRole !== 'admin') return false;
    return !!this.config;
  }

  // ── Rate Limit ────────────────────────────────────────────
  private rateLimitedUntil = 0; // Timestamp when rate limit resets (00:00 UTC next day)

  // ── MQTT Streaming ────────────────────────────────────────
  private mqttClient?: any;
  private mqttReconnectTimer?: ReturnType<typeof setTimeout>;
  private mqttDbWriteTimer?: ReturnType<typeof setTimeout>;
  private mqttReconnectAttempts = 0;
  private mqttLastCloseWasError = false;
  private streamingActive = false;

  constructor(config: BMWCarDataConfig) {
    super();
    this.config = config;
  }

  /** Inject service resolver from alfred.ts so token persistence works on ALL HA nodes. */
  setServiceResolver(resolver: SkillContext['userServiceResolver'], alfredUserId?: string): void {
    this.injectedServiceResolver = resolver;
    this.injectedAlfredUserId = alfredUserId;
  }

  /** Inject telematic repository for DB-persisted BMW data (cross-node access + history). */
  setTelematicRepo(repo: BMWSkill['telematicRepo']): void {
    this.telematicRepo = repo;
  }

  /** Start MQTT streaming if configured. Call after authorization. */
  async startStreaming(): Promise<void> {
    if (!this.config?.streaming?.enabled) return;
    // If old client exists but is not active, clean it up first
    if (!this.streamingActive && this.mqttClient) {
      try { this.mqttClient.end(true); } catch { /* ignore */ }
      this.mqttClient = undefined;
    }
    if (this.streamingActive) return;
    const { username, topic } = this.config.streaming;
    if (!username || !topic) return;

    // Load tokens if not yet available (they're lazily loaded on first skill call)
    // Try 'default' userId first, then injected alfredUserId
    for (const uid of [this.activeUserId, this.injectedAlfredUserId ?? ''].filter(Boolean)) {
      this.activeUserId = uid;
      if (!this.tokens?.idToken) {
        const loaded = await this.loadTokens();
        if (loaded) { this.tokens = loaded; break; }
      } else { break; }
    }
    let tokens = this.tokens;
    if (!tokens?.idToken) return; // Still no tokens — user hasn't authorized yet

    // Refresh token before connecting — stale idTokens get rejected instantly
    if (tokens.expiresAt && tokens.expiresAt < Date.now() + 300_000) {
      try {
        await this.refreshAccessToken(tokens);
        tokens = this.tokens!;
        console.log('[BMW MQTT] Token refreshed before connect');
      } catch (err) {
        console.warn('[BMW MQTT] Token refresh failed, trying with existing token:', err);
      }
    }

    try {
      const mqtt = (await Function('return import("mqtt")')()) as typeof import('mqtt');
      const host = this.config.streaming.host ?? 'customer.streaming-cardata.bmwgroup.com';
      const port = this.config.streaming.port ?? 9000;
      const brokerUrl = `mqtts://${host}:${port}`;
      console.log(`[BMW MQTT] Connecting to ${brokerUrl}, token expires ${new Date(tokens.expiresAt ?? 0).toISOString()}`);

      this.mqttClient = mqtt.connect(brokerUrl, {
        username,
        password: tokens.idToken,
        clientId: `alfred_bmw_${Date.now().toString(36)}`,
        rejectUnauthorized: true,
        reconnectPeriod: 0, // Manual reconnect (we need to refresh token)
        connectTimeout: 30_000,
      });

      this.mqttClient.on('connect', () => {
        this.streamingActive = true;
        const fullTopic = `${username}/${topic}`;
        console.log(`[BMW MQTT] Connected, subscribing to ${fullTopic}`);
        this.mqttClient.subscribe(fullTopic, { qos: 0 });
        this.mqttClient.subscribe(`${username}/+`, { qos: 0 });
      });

      this.mqttClient.on('message', (_topic: string, payload: Buffer) => {
        try {
          const data = JSON.parse(payload.toString());
          console.log(`[BMW MQTT] Data received: ${Object.keys(data.data ?? {}).join(',')}`);
          this.mqttReconnectAttempts = 0; // Reset backoff on successful data
          if (data && typeof data === 'object') {
            const telematicData: TelematicResponse = {};
            if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
              // BMW streaming format: data is { "descriptor.path": { value, unit, timestamp } }
              for (const [key, entry] of Object.entries(data.data as Record<string, any>)) {
                if (entry && entry.value !== undefined) {
                  telematicData[key] = { value: String(entry.value), unit: entry.unit ?? '', timestamp: entry.timestamp ?? '' };
                }
              }
            } else if (Array.isArray(data.data)) {
              for (const entry of data.data) {
                if (entry.name && entry.value !== undefined) {
                  telematicData[entry.name] = { value: String(entry.value), unit: entry.unit ?? '', timestamp: entry.timestamp ?? '' };
                }
              }
            } else if (data.telematicData) {
              Object.assign(telematicData, data.telematicData);
            }
            // RAM cache (fast access on this node)
            const vin = data.vin ?? tokens.vin ?? 'unknown';
            const cacheKey = `telematic:${vin}`;
            const existing = this.cache.get(cacheKey);
            if (existing && typeof existing.data === 'object' && existing.data !== null) {
              const merged = { ...existing.data as Record<string, unknown>, telematicData: { ...(existing.data as any).telematicData, ...telematicData } };
              this.cache.set(cacheKey, { data: merged, ts: Date.now() });
            } else {
              this.cache.set(cacheKey, { data: { telematicData }, ts: Date.now() });
            }
            // DB persistence — debounced: write full merged snapshot after burst settles
            if (this.telematicRepo && Object.keys(telematicData).length > 0) {
              if (this.mqttDbWriteTimer) clearTimeout(this.mqttDbWriteTimer);
              const cachedSnapshot = this.cache.get(cacheKey);
              this.mqttDbWriteTimer = setTimeout(() => {
                if (!cachedSnapshot || !this.telematicRepo) return;
                const uid = this.injectedAlfredUserId ?? this.activeUserId;
                const fullData = (cachedSnapshot.data as any).telematicData ?? {};
                this.telematicRepo.insert(uid, vin, 'mqtt', fullData).catch(() => {});
              }, 5_000); // 5s debounce — write once after message burst
            }
          }
        } catch { /* ignore parse errors */ }
      });

      this.mqttClient.on('error', (err: unknown) => {
        this.streamingActive = false;
        this.mqttLastCloseWasError = true;
        console.warn('[BMW MQTT] Error:', err);
      });

      this.mqttClient.on('disconnect', (packet: any) => {
        console.warn('[BMW MQTT] Disconnect packet:', JSON.stringify(packet));
      });

      this.mqttClient.on('offline', () => {
        console.log('[BMW MQTT] Client offline');
      });

      this.mqttClient.on('close', () => {
        this.streamingActive = false;
        const wasError = this.mqttLastCloseWasError;
        this.mqttLastCloseWasError = false;
        if (wasError) {
          // Auth error / connection refused → exponential backoff
          console.log('[BMW MQTT] Connection closed after error, scheduling backoff reconnect...');
          this.scheduleReconnect(true);
        } else {
          // Normal disconnect (BMW closes idle connections) → fixed 60s reconnect, no backoff
          console.log('[BMW MQTT] Connection closed (normal), reconnect in 60s...');
          this.scheduleReconnect(false);
        }
      });

      // Schedule token refresh before expiry
      if (tokens.expiresAt) {
        const refreshIn = Math.max(10_000, (tokens.expiresAt - Date.now()) - 120_000); // 2 min before expiry
        this.mqttReconnectTimer = setTimeout(() => this.reconnectWithFreshToken(), refreshIn);
      }
    } catch (err) { console.warn('[BMW MQTT] Streaming setup failed:', err); }
  }

  private scheduleReconnect(useBackoff = true): void {
    if (this.mqttReconnectTimer) clearTimeout(this.mqttReconnectTimer);
    let delay: number;
    if (useBackoff) {
      // Exponential backoff for errors: 60s → 120s → 240s → ... → max 15 min
      this.mqttReconnectAttempts++;
      delay = Math.min(60_000 * Math.pow(2, Math.min(this.mqttReconnectAttempts - 1, 4)), 15 * 60_000);
    } else {
      // Normal disconnect (BMW idle close) → fixed 60s, no counter increment
      delay = 60_000;
    }
    console.log(`[BMW MQTT] Reconnect in ${Math.round(delay / 1000)}s (attempt ${this.mqttReconnectAttempts}, backoff=${useBackoff})`);
    this.mqttReconnectTimer = setTimeout(() => this.reconnectWithFreshToken(), delay);
  }

  private async reconnectWithFreshToken(): Promise<void> {
    try {
      // Always reload tokens from disk/DB first — another node or a fresh authorize may have saved new ones
      const freshFromDisk = await this.loadTokens();
      if (freshFromDisk) this.tokens = freshFromDisk;

      // Try to refresh the token
      const tokens = this.tokens;
      if (tokens) {
        await this.refreshAccessToken(tokens);
      }
      // Disconnect old connection
      if (this.mqttClient) {
        this.mqttClient.end(true);
        this.mqttClient = undefined;
      }
      this.streamingActive = false;
      // Reconnect with new token
      await this.startStreaming();
    } catch {
      // Schedule retry — will reload tokens from disk on next attempt
      this.scheduleReconnect(true);
    }
  }

  /** Stop MQTT streaming. */
  stopStreaming(): void {
    if (this.mqttReconnectTimer) clearTimeout(this.mqttReconnectTimer);
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = undefined;
    }
    this.streamingActive = false;
  }

  private activeContext?: SkillContext;

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    // Resolve per-user BMW config if available
    this.activeConfig = await this.resolveUserConfig(_context) ?? undefined;
    // Isolate tokens/cache per user
    this.activeUserId = _context.alfredUserId ?? _context.masterUserId ?? 'default';
    this.activeContext = _context;

    try {
      if (!this.hasCfg) {
        return { success: false, error: 'BMW ist nicht konfiguriert. Nutze "setup_service" um BMW Connected Drive zu verbinden.' };
      }
      const action = input.action as Action | undefined;
      if (!action) return { success: false, error: 'Missing required field "action"' };

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
        case 'consumption':
          return await this.getConsumption(
            input.vin as string | undefined,
            input.period as string | undefined,
          );
        case 'history':
          return await this.getHistory(
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
    } finally {
      this.activeConfig = undefined;
    }
  }

  /**
   * Resolve per-user BMW config from UserServiceResolver.
   * Returns null if no per-user config is available (fall back to global).
   */
  private async resolveUserConfig(context: SkillContext): Promise<BMWCarDataConfig | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const config = await context.userServiceResolver.getServiceConfig(context.alfredUserId, 'bmw');
    if (!config || !config.clientId) return null;
    return config as unknown as BMWCarDataConfig;
  }

  // ── OAuth Device Authorization Flow with PKCE ───────────

  private async authorize(deviceCode?: string): Promise<SkillResult> {
    if (deviceCode) {
      return await this.pollToken(deviceCode);
    }

    // Auto-resume: if a pending device code exists, poll it instead of generating a new one
    let pending: BMWTokens | null = null;
    const db = this.resolveDbAccess();
    if (db) {
      try {
        const svc = await db.resolver!.getServiceConfig(db.userId, 'bmw_tokens', 'partial');
        if (svc) pending = svc as unknown as BMWTokens;
      } catch { /* fallback to disk */ }
    }
    if (!pending) pending = await this.loadTokensFromDisk();
    if (pending?.deviceCode && pending?.codeVerifier) {
      // Check if the pending code is still fresh (<10 min) — don't overwrite with a new one
      const pendingAge = pending.expiresAt ? Date.now() - (pending.expiresAt - 600_000) : Infinity;
      const isFresh = pendingAge < 10 * 60_000;

      try {
        const pollResult = await this.pollToken(pending.deviceCode);
        // If authorization_pending, return it and tell LLM to WAIT
        if ((pollResult.data as Record<string, unknown>)?.status === 'pending') {
          return {
            ...pollResult,
            display: 'Autorisierung noch ausstehend — bitte zuerst im Browser bestätigen, dann erneut "authorize" aufrufen. WICHTIG: Keine anderen BMW-Aktionen aufrufen bis die Autorisierung abgeschlossen ist!',
          };
        }
        return pollResult;
      } catch {
        // If pending code is still fresh, don't generate a new one — tell user to confirm the existing one
        if (isFresh) {
          return {
            success: true,
            data: { status: 'pending' },
            display: 'Ein Autorisierungscode wurde bereits generiert. Bitte bestätige ihn im Browser und rufe dann erneut "authorize" auf. WICHTIG: Keine anderen BMW-Aktionen aufrufen bis die Autorisierung abgeschlossen ist!',
          };
        }
        // Code expired — fall through to generate a new one
      }
    }

    // Step 1: Request device code with PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
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

    // Persist PKCE verifier + device code for step 2 (with timestamp for freshness check)
    const partial: Partial<BMWTokens> = {
      codeVerifier,
      deviceCode: data.device_code as string,
      expiresAt: Date.now() + 10 * 60_000, // 10 min validity for the device code
    };
    await this.savePartialTokens(partial);
    this.tokens = null; // Invalidate cache so pollToken reads fresh file with codeVerifier

    return {
      success: true,
      data,
      display: [
        '## BMW Autorisierung',
        '',
        `1. Öffne: **${(data.verification_uri_complete as string) ?? (data.verification_uri as string)}**`,
        `2. Gib diesen Code ein: **${data.user_code as string}**`,
        '',
        'Danach rufe einfach `authorize` erneut auf (ohne Parameter) — der Token wird automatisch abgeholt.',
      ].join('\n'),
    };
  }

  private async pollToken(deviceCode: string): Promise<SkillResult> {
    // Load PKCE verifier from PARTIAL tokens (not the main access tokens)
    let partial: BMWTokens | null = null;
    const db = this.resolveDbAccess();
    if (db) {
      try {
        const svc = await db.resolver!.getServiceConfig(db.userId, 'bmw_tokens', 'partial');
        if (svc) partial = svc as unknown as BMWTokens;
      } catch { /* fallback to disk */ }
    }
    if (!partial) partial = await this.loadTokensFromDisk();
    const codeVerifier = partial?.codeVerifier;
    if (!codeVerifier) {
      throw new Error('Kein code_verifier gefunden. Bitte zuerst "authorize" ohne device_code aufrufen.');
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
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

    // Save tokens first so they're not lost if container setup fails
    const baseTokens: BMWTokens = {
      accessToken,
      refreshToken: data.refresh_token as string,
      idToken: data.id_token as string,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
      vin: '',
      containerId: '',
    };

    // Fetch VIN
    const vin = await this.fetchVin(accessToken);
    baseTokens.vin = vin;
    await this.saveTokens(baseTokens);

    // Setup container — save tokens even if this fails
    let containerId = '';
    let containerError = '';
    try {
      containerId = await this.ensureContainer(accessToken);
      baseTokens.containerId = containerId;
      await this.saveTokens(baseTokens);
    } catch (err) {
      containerError = err instanceof Error ? err.message : String(err);
    }

    this.tokens = baseTokens;

    // Restart MQTT streaming with new token (if streaming was active)
    if (this.streamingActive || this.mqttClient) {
      this.stopStreaming();
      this.startStreaming().catch(() => {});
    }

    // Reset rate limit + MQTT backoff (new token = fresh session)
    this.rateLimitedUntil = 0;
    this.mqttReconnectAttempts = 0;
    this.mqttLastCloseWasError = false;

    const lines = [
      '## BMW Autorisierung erfolgreich',
      '',
      `**VIN:** ${vin}`,
    ];
    if (containerId) {
      lines.push(`**Container:** ${containerId}`);
      lines.push('Tokens gespeichert. Du kannst jetzt Fahrzeugdaten abrufen.');
    } else {
      lines.push(`**Container-Fehler:** ${containerError}`);
      lines.push('Tokens + VIN gespeichert, aber Container konnte nicht erstellt werden.');
      lines.push('Erstelle den Container manuell im BMW CarData Portal oder versuche es erneut.');
    }

    return {
      success: containerId !== '',
      data: { vin, containerId, containerError: containerError || undefined },
      display: lines.join('\n'),
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
    // API returns a single VehicleMappingDto { vin, mappedSince, mappingType }
    // or possibly an array — handle both defensively
    if (typeof raw.vin === 'string') {
      return raw.vin;
    }
    if (Array.isArray(raw)) {
      const arr = raw as Array<{ vin: string; mappingType?: string }>;
      const primary = arr.find(v => v.mappingType === 'PRIMARY');
      return primary?.vin ?? arr[0]?.vin ?? (() => { throw new Error('No vehicles found'); })();
    }
    throw new Error(`No vehicles found in account (response: ${JSON.stringify(raw).slice(0, 200)})`);
  }

  private async ensureContainer(accessToken: string): Promise<string> {
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
      if (existing) {
        // Check if container has the right number of descriptors — if not, delete and recreate
        // This handles cases where new descriptors are added in code updates
        try {
          const detailRes = await fetch(`${API_BASE}/customers/containers/${existing.containerId}`, {
            headers: this.apiHeaders(accessToken),
            signal: AbortSignal.timeout(15_000),
          });
          if (detailRes.ok) {
            const detail = await detailRes.json() as Record<string, unknown>;
            const currentDescriptors = Array.isArray(detail.technicalDescriptors) ? detail.technicalDescriptors : [];
            if (currentDescriptors.length !== DESCRIPTORS.length) {
              // Descriptor mismatch — try to create new container FIRST, only delete old if successful
              try {
                const newId = await this.createContainer(accessToken);
                // New container succeeded — now safe to delete old one
                await fetch(`${API_BASE}/customers/containers/${existing.containerId}`, {
                  method: 'DELETE',
                  headers: this.apiHeaders(accessToken),
                  signal: AbortSignal.timeout(15_000),
                }).catch(() => {}); // best-effort delete
                return newId;
              } catch {
                // New container failed — keep old one (non-destructive)
                return existing.containerId;
              }
            } else {
              return existing.containerId;
            }
          } else {
            return existing.containerId;
          }
        } catch {
          return existing.containerId;
        }
      }
    }

    // Create new container
    return this.createContainer(accessToken);
  }

  private async createContainer(accessToken: string): Promise<string> {
    const createRes = await fetch(`${API_BASE}/customers/containers`, {
      method: 'POST',
      headers: {
        ...this.apiHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: CONTAINER_NAME,
        purpose: 'Alfred AI Assistant',
        technicalDescriptors: DESCRIPTORS,
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

    // Rate limit check: skip API call if rate limited
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error('API rate limit active — reset at 00:00 UTC');
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
      // Set rate limit flag on CU-429
      if (res.status === 403 && detail.includes('CU-429')) {
        const now = new Date();
        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        this.rateLimitedUntil = tomorrow.getTime();
      }
      throw new Error(`HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as T;
    this.cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  // ── Token management ────────────────────────────────────

  /** Resolve the best available service resolver + userId for DB token persistence. */
  private resolveDbAccess(): { resolver: SkillContext['userServiceResolver']; userId: string } | null {
    const resolver = this.injectedServiceResolver ?? this.activeContext?.userServiceResolver;
    const userId = this.activeContext?.alfredUserId ?? this.injectedAlfredUserId ?? '__global__';
    if (!resolver) return null;
    return { resolver, userId };
  }

  private async loadTokens(): Promise<BMWTokens | null> {
    if (this.tokens) return this.tokens;
    // Try DB first (HA-safe), then file fallback
    const db = this.resolveDbAccess();
    if (db) {
      try {
        const svc = await db.resolver!.getServiceConfig(db.userId, 'bmw_tokens', 'tokens');
        if (svc) { this.tokens = svc as unknown as BMWTokens; return this.tokens; }
      } catch { /* fallback to disk */ }
    }
    return await this.loadTokensFromDisk();
  }

  /** Read tokens from disk, bypassing in-memory cache */
  private async loadTokensFromDisk(): Promise<BMWTokens | null> {
    try {
      const raw = await readFile(getTokenPath(this.activeUserId), 'utf-8');
      const tokens = JSON.parse(raw) as BMWTokens;
      this.tokens = tokens;
      return tokens;
    } catch {
      return null;
    }
  }

  private async saveTokens(tokens: BMWTokens): Promise<void> {
    // Save to DB if available (HA-safe)
    const db = this.resolveDbAccess();
    if (db) {
      try {
        await db.resolver!.saveServiceConfig(
          db.userId, 'bmw_tokens', 'tokens', tokens as unknown as Record<string, unknown>,
        );
      } catch { /* best-effort DB write */ }
    }
    // Always write to disk as backup (backward compat + fallback)
    try {
      await mkdir(join(homedir(), '.alfred'), { recursive: true });
      await writeFile(getTokenPath(this.activeUserId), JSON.stringify(tokens, null, 2), 'utf-8');
      try { await chmod(getTokenPath(this.activeUserId), 0o600); } catch { /* Windows has no chmod */ }
    } catch { /* best-effort disk write */ }
  }

  private async savePartialTokens(partial: Partial<BMWTokens>): Promise<void> {
    // Merge with existing data
    let existing: Partial<BMWTokens> = {};
    try {
      const raw = await readFile(getTokenPath(this.activeUserId), 'utf-8');
      existing = JSON.parse(raw) as Partial<BMWTokens>;
    } catch {
      // no existing file
    }
    const merged = { ...existing, ...partial };

    // Save to DB if available (HA-safe)
    const db = this.resolveDbAccess();
    if (db) {
      try {
        await db.resolver!.saveServiceConfig(
          db.userId, 'bmw_tokens', 'partial', merged as unknown as Record<string, unknown>,
        );
      } catch { /* best-effort DB write */ }
    }

    // Always write to disk as backup
    try {
      await mkdir(join(homedir(), '.alfred'), { recursive: true });
      await writeFile(getTokenPath(this.activeUserId), JSON.stringify(merged, null, 2), 'utf-8');
    } catch { /* best-effort disk write */ }
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
    // Retry once on transient errors
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const params: Record<string, string> = {
          client_id: this.cfg.clientId,
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        };
        // Debug: log what we're sending (mask token for security)
        const hasRefresh = !!tokens.refreshToken && tokens.refreshToken.length > 10;
        const hasClientId = !!this.cfg.clientId;
        console.log(`[BMW] Token refresh attempt ${attempt + 1}: clientId=${hasClientId}, refreshToken=${hasRefresh ? tokens.refreshToken.slice(0, 8) + '...' + tokens.refreshToken.length + 'chars' : 'MISSING'}`);

        // Filter out undefined/empty values that would send "undefined" as string
        const cleanParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== 'undefined'));
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(cleanParams),
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const updated: BMWTokens = {
            ...tokens,
            accessToken: data.access_token as string,
            refreshToken: (data.refresh_token as string) ?? tokens.refreshToken,
            idToken: (data.id_token as string) ?? tokens.idToken,
            expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
          };
          delete updated.codeVerifier;
          delete updated.deviceCode;
          await this.saveTokens(updated);
          this.tokens = updated;
          return updated.accessToken;
        }

        // 400/401 = refresh token truly invalid → no retry
        if (res.status === 400 || res.status === 401) {
          const body = await res.text().catch(() => '');
          console.warn(`[BMW] Token refresh permanently failed (${res.status}): ${body.slice(0, 200)}`);
          this.tokens = null;
          throw new Error('Token-Refresh fehlgeschlagen. Bitte erneut "authorize" aufrufen.');
        }

        // 5xx or other → transient, retry after delay
        console.warn(`[BMW] Token refresh failed (${res.status}), attempt ${attempt + 1}/2`);
        if (attempt === 0) await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        // Network/timeout error → retry
        if (attempt === 0) {
          console.warn('[BMW] Token refresh network error, retrying in 3s...', err);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        // Second attempt also failed → keep tokens in RAM (don't null them!), reload from disk on next try
        console.warn('[BMW] Token refresh failed after 2 attempts, keeping tokens for next retry');
        throw new Error('Token-Refresh fehlgeschlagen (Netzwerk). Nächster Versuch beim nächsten Reconnect.');
      }
    }

    // Should not reach here, but just in case
    throw new Error('Token-Refresh fehlgeschlagen.');
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
    // Self-healing: try to create container if token exists but containerId is empty
    if (tokens?.accessToken) {
      try {
        const containerId = await this.ensureContainer(tokens.accessToken);
        tokens.containerId = containerId;
        await this.saveTokens(tokens);
        return containerId;
      } catch { /* fall through to error */ }
    }
    throw new Error('Kein Container gefunden. Bitte EINMAL "authorize" aufrufen und auf Browser-Bestätigung warten. Danach wird der Container automatisch erstellt. NICHT mehrfach authorize aufrufen!');
  }

  // ── Actions ─────────────────────────────────────────────

  private async getStatus(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const uid = this.injectedAlfredUserId ?? this.activeUserId;

    // Merged data from all sources: MQTT has realtime (GPS, doors, speed),
    // REST has battery data (SoC, SoH, capacity). Both are needed for full status.
    let merged: TelematicResponse = {};

    // 1. MQTT data (realtime fields: GPS, doors, speed, km)
    let mqttAge = 0;
    const streamingCacheKey = `telematic:${vin}`;
    const streamingCached = this.cache.get(streamingCacheKey);
    if (streamingCached) {
      Object.assign(merged, (streamingCached.data as any).telematicData ?? {});
      mqttAge = Date.now() - streamingCached.ts;
    } else if (this.telematicRepo) {
      // Always use latest MQTT from DB — no hard TTL cutoff
      const mqttEntry = await this.telematicRepo.getLatestBySource(uid, vin, 'mqtt');
      if (mqttEntry) {
        Object.assign(merged, mqttEntry.telematicData);
        mqttAge = Date.now() - new Date(mqttEntry.createdAt).getTime();
      }
    }

    // 2. REST data (SoC, SoH, battery capacity — not in MQTT stream)
    const REST_TTL = 25 * 60_000;
    let restData: TelematicResponse | undefined;

    if (this.telematicRepo) {
      const restEntry = await this.telematicRepo.getLatestBySource(uid, vin, 'rest');
      if (restEntry && (Date.now() - new Date(restEntry.createdAt).getTime()) < REST_TTL) {
        restData = restEntry.telematicData as TelematicResponse;
      }
    }

    if (!restData) {
      try {
        const containerId = await this.resolveContainerId();
        const apiResult = await this.apiGet<{ telematicData: TelematicResponse }>(
          `/customers/vehicles/${vin}/telematicData?containerId=${containerId}`,
        );
        restData = apiResult.telematicData ?? {};
        if (this.telematicRepo && Object.keys(restData).length > 0) {
          this.telematicRepo.insert(uid, vin, 'rest', restData).catch(() => {});
        }
      } catch {
        // Rate limit or API error — use stale REST data from DB as fallback (no TTL)
        if (this.telematicRepo) {
          const staleEntry = await this.telematicRepo.getLatestBySource(uid, vin, 'rest');
          if (staleEntry) restData = staleEntry.telematicData as TelematicResponse;
        }
      }
    }

    // Merge: REST as base, MQTT overwrites (fresher for shared fields)
    if (restData) {
      for (const [key, val] of Object.entries(restData)) {
        if (!merged[key]) merged[key] = val;
      }
    }

    // basicData (model name etc.) — cache aggressively, never changes
    let basicData: Record<string, unknown>;
    const basicCacheKey = `basic:${vin}`;
    const basicCached = this.cache.get(basicCacheKey);
    if (basicCached) {
      basicData = basicCached.data as Record<string, unknown>;
    } else {
      try {
        basicData = await this.apiGet<Record<string, unknown>>(`/customers/vehicles/${vin}/basicData`);
        this.cache.set(basicCacheKey, { data: basicData, ts: Date.now() });
      } catch {
        basicData = { modelName: 'BMW' }; // fallback
      }
    }

    const t = merged;
    const soc = tvm(t, 'vehicle.drivetrain.batteryManagement.header');
    const range = tvm(t, 'vehicle.drivetrain.electricEngine.remainingElectricRange');
    const maxEnergy = tvm(t, 'vehicle.drivetrain.batteryManagement.maxEnergy');
    const soh = tvm(t, 'vehicle.powertrain.electric.battery.stateOfHealth.displayed');

    const model = basicData.modelName ?? basicData.model ?? '?';

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

    // Odometer
    const km = tvm(t, 'vehicle.vehicle.travelledDistance');
    if (km && km !== '?') lines.push(`**Kilometerstand:** ${km} km`);

    // Security — MQTT uses door.status (SECURED/LOCKED/UNLOCKED/SELECTIVELOCKED), REST uses isLocked (true/false)
    const lockedRaw = tvm(t, 'vehicle.access.centralLocking.isLocked');
    const isLocked = lockedRaw === 'true' || lockedRaw === 'LOCKED' || lockedRaw === 'SECURED';
    const isUnlocked = lockedRaw === 'false' || lockedRaw === 'UNLOCKED';
    const isPartial = lockedRaw === 'SELECTIVELOCKED';
    if (isLocked || isUnlocked || isPartial) lines.push(`**Verriegelt:** ${isLocked ? 'Ja' : isPartial ? 'Teilweise' : 'Nein'}`);

    const doorOpen = tvm(t, 'vehicle.body.door.driver.isOpen');
    const trunkOpen = tvm(t, 'vehicle.body.trunk.isOpen');
    const windowRaw = tvm(t, 'vehicle.body.window.driver.isOpen');
    // MQTT uses CLOSED/OPEN for windows, REST uses true/false
    const windowOpen = windowRaw === 'true' || windowRaw === 'OPEN';
    if (doorOpen !== '?') lines.push(`**Fahrertür:** ${doorOpen === 'true' ? 'Offen' : 'Geschlossen'}`);
    if (trunkOpen !== '?') lines.push(`**Kofferraum:** ${trunkOpen === 'true' ? 'Offen' : 'Geschlossen'}`);
    if (windowRaw !== '?') lines.push(`**Fahrerfenster:** ${windowOpen ? 'Offen' : 'Geschlossen'}`);

    // GPS — MQTT uses currentLocation, REST uses gps
    const lat = tvm(t, 'vehicle.location.gps.latitude');
    const lon = tvm(t, 'vehicle.location.gps.longitude');
    if (lat !== '?' && lon !== '?') {
      const address = await this.reverseGeocode(parseFloat(lat), parseFloat(lon));
      lines.push(address ? `**Standort:** ${address} (${lat}, ${lon})` : `**Standort:** ${lat}, ${lon}`);
    }

    // Extra MQTT fields
    const avgConsumption = tv(t, 'vehicle.drivetrain.avgElectricRangeConsumption');
    if (avgConsumption !== '?') lines.push(`**Durchschnittsverbrauch:** ${avgConsumption} kWh/100km`);
    const avgSpeed = tv(t, 'vehicle.vehicle.avgSpeed');
    if (avgSpeed !== '?') lines.push(`**Durchschnittsgeschwindigkeit:** ${avgSpeed} km/h`);

    // Data age warning
    const maxAge = Math.max(mqttAge, 0);
    if (maxAge > 60 * 60_000) {
      const hours = Math.round(maxAge / (60 * 60_000));
      lines.push(`\n⚠️ *Daten ${hours}h alt (MQTT-Stream/API nicht erreichbar)*`);
    } else if (maxAge > 30 * 60_000) {
      const mins = Math.round(maxAge / 60_000);
      lines.push(`\n⚠️ *Daten ${mins} Min alt*`);
    }

    return { success: true, data: { telematic: t, basic: basicData }, display: lines.join('\n') };
  }

  private async getCharging(inputVin?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const uid = this.injectedAlfredUserId ?? this.activeUserId;

    // Charging needs REST data (power, time, HV status) + MQTT for realtime SoC/plug
    // Always call REST for charging — these fields are REST-only
    const containerId = await this.resolveContainerId();
    const apiResult = await this.apiGet<{ telematicData: TelematicResponse }>(
      `/customers/vehicles/${vin}/telematicData?containerId=${containerId}`,
    );
    const restData = apiResult.telematicData ?? {};
    if (this.telematicRepo && Object.keys(restData).length > 0) {
      this.telematicRepo.insert(uid, vin, 'rest', restData).catch(() => {});
    }

    // Merge MQTT on top for realtime fields (plug status, charger port)
    const merged: TelematicResponse = { ...restData };
    const streamingCacheKey = `telematic:${vin}`;
    const streamingCached = this.cache.get(streamingCacheKey);
    if (streamingCached && (Date.now() - streamingCached.ts) < DB_TELEMATIC_TTL) {
      const mqttData = (streamingCached.data as any).telematicData ?? {};
      for (const [key, val] of Object.entries(mqttData as TelematicResponse)) {
        merged[key] = val; // MQTT wins for shared fields
      }
    }

    const t = merged;
    const chargingStatus = tv(t, 'vehicle.drivetrain.electricEngine.charging.status');
    const soc = tvm(t, 'vehicle.drivetrain.batteryManagement.header');
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

    // BMW API returns max ~10 sessions per call. For longer ranges, chunk into 7-day windows.
    const fromMs = new Date(fromDate).getTime();
    const toMs = new Date(toDate).getTime();
    const WEEK = 7 * 24 * 60 * 60_000;
    const allSessions: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>();

    // Single call for short ranges, chunked for longer ones
    const needsChunking = (toMs - fromMs) > 14 * 24 * 60 * 60_000;
    if (needsChunking) {
      let chunkEnd = toMs;
      while (chunkEnd > fromMs) {
        const chunkStart = Math.max(chunkEnd - WEEK, fromMs);
        try {
          const chunk = await this.apiGet<Record<string, unknown>>(
            `/customers/vehicles/${vin}/chargingHistory?from=${encodeURIComponent(new Date(chunkStart).toISOString())}&to=${encodeURIComponent(new Date(chunkEnd).toISOString())}`,
          );
          const sessions = (chunk.data ?? chunk.chargingSessions ?? []) as Array<Record<string, unknown>>;
          for (const s of sessions) {
            const key = `${s.startTime}-${s.endTime}`;
            if (!seenIds.has(key)) { seenIds.add(key); allSessions.push(s); }
          }
        } catch { /* skip failed chunk */ }
        chunkEnd = chunkStart - 1; // avoid boundary overlap (exclusive end)
      }
      // Sort by startTime descending
      allSessions.sort((a, b) => ((b.startTime as number) ?? 0) - ((a.startTime as number) ?? 0));
    } else {
      const data = await this.apiGet<Record<string, unknown>>(
        `/customers/vehicles/${vin}/chargingHistory?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      );
      for (const s of ((data.data ?? data.chargingSessions ?? []) as Array<Record<string, unknown>>)) {
        const key = `${s.startTime}-${s.endTime}`;
        if (!seenIds.has(key)) { seenIds.add(key); allSessions.push(s); }
      }
    }

    const lines = [
      `## BMW Lade-Sessions (${fromDate.slice(0, 10)} – ${toDate.slice(0, 10)})`,
      '',
      '| # | Start | Ende | Dauer | Energie | Start-SoC | End-SoC | km-Stand | Ort |',
      '|---|-------|------|-------|---------|-----------|---------|----------|-----|',
    ];

    let totalEnergy = 0;
    for (let i = 0; i < allSessions.length; i++) {
      const s = allSessions[i];
      const startSec = s.startTime as number | undefined;
      const endSec = s.endTime as number | undefined;
      const fmtDateTime = (sec: number) => new Date(sec * 1000).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
      const start = startSec ? fmtDateTime(startSec) : '-';
      const end = endSec ? fmtDateTime(endSec) : '-';
      const durationSec = s.totalChargingDurationSec as number | undefined;
      const duration = durationSec != null ? Math.round(durationSec / 60) : '-';
      const energy = s.energyConsumedFromPowerGridKwh as number | undefined;
      const startSoc = s.displayedStartSoc ?? '-';
      const endSoc = s.displayedSoc ?? '-';
      const mileage = s.mileage != null ? `${s.mileage}` : '-';
      const loc = (s.chargingLocation as Record<string, unknown> | undefined);
      const address = (loc?.formattedAddress as string | undefined) ?? (loc?.streetAddress as string | undefined) ?? '-';
      lines.push(`| ${i + 1} | ${start} | ${end} | ${duration} min | ${energy ?? '-'} kWh | ${startSoc}% | ${endSoc}% | ${mileage} | ${address} |`);
      if (energy != null) totalEnergy += energy;
    }

    if (allSessions.length === 0) {
      lines.push('| - | - | - | Keine Sessions gefunden | - | - | - | - | - |');
    } else {
      lines.push('', `**Gesamt:** ${allSessions.length} Sessions, ${totalEnergy.toFixed(1)} kWh`);
    }

    return { success: true, data: { sessions: allSessions, totalSessions: allSessions.length, totalEnergyKwh: totalEnergy }, display: lines.join('\n') };
  }

  // ── Consumption calculation from charging sessions ──────

  private async getConsumption(inputVin?: string, period?: string): Promise<SkillResult> {
    const vin = await this.resolveVin(inputVin);
    const containerId = await this.resolveContainerId();

    // Determine time range
    const now = new Date();
    const periodDays: Record<string, number> = {
      last: 7,     // fetch last 7 days, then pick last segment
      week: 7,
      month: 30,
      year: 365,
      all: 730,
    };
    const days = periodDays[period ?? 'month'] ?? 30;
    const fromDate = new Date(now.getTime() - days * 86_400_000).toISOString();
    const toDate = now.toISOString();

    // Fetch charging sessions + battery capacity in parallel
    const [historyData, telematicRaw] = await Promise.all([
      this.apiGet<Record<string, unknown>>(
        `/customers/vehicles/${vin}/chargingHistory?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      ),
      this.apiGet<{ telematicData: TelematicResponse }>(
        `/customers/vehicles/${vin}/telematicData?containerId=${containerId}`,
      ),
    ]);

    const sessions = (historyData.data ?? historyData.chargingSessions ?? []) as Array<Record<string, unknown>>;
    const batteryCapacity = parseFloat(tv(telematicRaw.telematicData ?? {}, 'vehicle.drivetrain.batteryManagement.maxEnergy')) || 63;

    if (sessions.length < 2) {
      return { success: true, data: { sessions: sessions.length }, display: 'Nicht genügend Lade-Sessions für Verbrauchsberechnung (min. 2 nötig).' };
    }

    // Sort by mileage ascending
    const sorted = sessions
      .filter(s => typeof s.mileage === 'number' && typeof s.displayedStartSoc === 'number' && typeof s.displayedSoc === 'number')
      .sort((a, b) => (a.mileage as number) - (b.mileage as number));

    if (sorted.length < 2) {
      return { success: true, data: { sessions: sorted.length }, display: 'Nicht genügend Lade-Sessions mit vollständigen Daten.' };
    }

    // Calculate segments between consecutive charging sessions
    interface Segment {
      fromKm: number;
      toKm: number;
      distance: number;
      socUsed: number;
      kWhUsed: number;
      consumption: number;
      date: string;
    }
    const segments: Segment[] = [];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const fromKm = prev.mileage as number;
      const toKm = curr.mileage as number;
      const distance = toKm - fromKm;

      if (distance <= 0) continue;

      // SoC after previous charge (endSoC) → SoC before current charge (startSoC) = energy used
      const prevEndSoc = prev.displayedSoc as number;
      const currStartSoc = curr.displayedStartSoc as number;
      const socUsed = prevEndSoc - currStartSoc;

      if (socUsed <= 0) continue;

      const kWhUsed = (socUsed / 100) * batteryCapacity;
      const consumption = (kWhUsed / distance) * 100;

      const startSec = curr.startTime as number | undefined;
      const date = startSec ? new Date(startSec * 1000).toLocaleDateString('de-AT') : '-';

      segments.push({ fromKm, toKm, distance, socUsed, kWhUsed, consumption, date });
    }

    if (segments.length === 0) {
      return { success: true, data: {}, display: 'Keine auswertbaren Fahrtabschnitte gefunden.' };
    }

    // For "last" period, only show the most recent segment
    if (period === 'last') {
      const last = segments[segments.length - 1];
      return {
        success: true,
        data: last,
        display: [
          '## Letzte Fahrt (geschätzt)',
          '',
          `**Datum:** ${last.date}`,
          `**Strecke:** ${last.distance} km`,
          `**Verbrauch:** ${last.consumption.toFixed(1)} kWh/100km`,
          `**Energie:** ${last.kWhUsed.toFixed(1)} kWh (${last.socUsed}% SoC)`,
          `**km-Stand:** ${last.fromKm} → ${last.toKm}`,
        ].join('\n'),
      };
    }

    // Aggregate statistics
    const totalDistance = segments.reduce((sum, s) => sum + s.distance, 0);
    const totalKwh = segments.reduce((sum, s) => sum + s.kWhUsed, 0);
    const avgConsumption = (totalKwh / totalDistance) * 100;
    const consumptions = segments.map(s => s.consumption).sort((a, b) => a - b);
    const minC = consumptions[0];
    const maxC = consumptions[consumptions.length - 1];
    const medianC = consumptions[Math.floor(consumptions.length / 2)];

    const periodLabel: Record<string, string> = {
      week: 'Letzte Woche',
      month: 'Letzter Monat',
      year: 'Letztes Jahr',
      all: 'Gesamt',
    };

    const lines = [
      `## BMW Verbrauchsstatistik — ${periodLabel[period ?? 'month'] ?? 'Letzter Monat'}`,
      '',
      `**Batteriekapazität:** ${batteryCapacity} kWh`,
      `**Ausgewertete Fahrten:** ${segments.length}`,
      `**Gesamtstrecke:** ${totalDistance.toLocaleString('de-AT')} km`,
      `**Gesamtverbrauch:** ${totalKwh.toFixed(1)} kWh`,
      '',
      `**Durchschnitt:** ${avgConsumption.toFixed(1)} kWh/100km`,
      `**Min:** ${minC.toFixed(1)} kWh/100km`,
      `**Max:** ${maxC.toFixed(1)} kWh/100km`,
      `**Median:** ${medianC.toFixed(1)} kWh/100km`,
      '',
      '### Einzelne Fahrten',
      '',
      '| Datum | Strecke | Verbrauch | Energie |',
      '|-------|---------|-----------|---------|',
    ];

    for (const s of segments) {
      lines.push(`| ${s.date} | ${s.distance} km | ${s.consumption.toFixed(1)} kWh/100km | ${s.kWhUsed.toFixed(1)} kWh |`);
    }

    return {
      success: true,
      data: { avgConsumption, totalDistance, totalKwh, segments },
      display: lines.join('\n'),
    };
  }

  /** Reverse geocode coordinates to a human-readable address via Nominatim (OSM). */
  private async reverseGeocode(lat: number, lon: number): Promise<string | undefined> {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&addressdetails=1`,
        { headers: { 'User-Agent': 'Alfred-AI/1.0' }, signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return undefined;
      const data = await res.json() as Record<string, unknown>;
      const addr = data.address as Record<string, string> | undefined;
      if (!addr) return data.display_name as string | undefined;
      // Build compact address: street + house number, city
      const parts: string[] = [];
      const street = addr.road ?? addr.pedestrian ?? addr.footway ?? '';
      if (street) parts.push(addr.house_number ? `${street} ${addr.house_number}` : street);
      const city = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? '';
      if (city) parts.push(city);
      return parts.length > 0 ? parts.join(', ') : (data.display_name as string | undefined);
    } catch { return undefined; }
  }

  private async getHistory(inputVin?: string, from?: string, to?: string): Promise<SkillResult> {
    if (!this.telematicRepo) {
      return { success: false, error: 'Telematik-Historie nicht verfügbar (DB-Repository nicht konfiguriert).' };
    }

    const vin = await this.resolveVin(inputVin);
    const uid = this.injectedAlfredUserId ?? this.activeUserId;

    const now = new Date();
    const toDate = to ?? now.toISOString();
    const fromDate = from ?? new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();

    const entries = await this.telematicRepo.getHistory(uid, vin, fromDate, toDate, 200);

    if (entries.length === 0) {
      return { success: true, data: { entries: 0 }, display: `Keine Telematik-Daten für ${vin} im Zeitraum ${fromDate.slice(0, 10)} – ${toDate.slice(0, 10)}.` };
    }

    const lines = [
      `## BMW Telematik-Historie (${fromDate.slice(0, 10)} – ${toDate.slice(0, 10)})`,
      '',
      `**Einträge:** ${entries.length} (${entries.filter(e => e.source === 'mqtt').length} MQTT, ${entries.filter(e => e.source !== 'mqtt').length} REST)`,
      '',
      '| Zeitpunkt | Quelle | SoC | Reichweite | Verriegelt | km-Stand | Standort |',
      '|-----------|--------|-----|------------|------------|----------|----------|',
    ];

    for (const e of entries.slice(0, 50)) {
      const t = e.telematicData as TelematicResponse;
      const soc = tvm(t, 'vehicle.drivetrain.batteryManagement.header');
      const range = tvm(t, 'vehicle.drivetrain.electricEngine.remainingElectricRange');
      const lockedRaw = tvm(t, 'vehicle.access.centralLocking.isLocked');
      const lockedStr = lockedRaw === 'true' || lockedRaw === 'LOCKED' || lockedRaw === 'SECURED' ? 'Ja' : lockedRaw === 'false' || lockedRaw === 'UNLOCKED' ? 'Nein' : lockedRaw === 'SELECTIVELOCKED' ? 'Teilw.' : '-';
      const lat = tvm(t, 'vehicle.location.gps.latitude');
      const lon = tvm(t, 'vehicle.location.gps.longitude');
      const loc = lat !== '?' && lon !== '?' ? `${lat}, ${lon}` : '-';
      const km = tvm(t, 'vehicle.vehicle.travelledDistance');
      const time = new Date(e.createdAt).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

      lines.push(`| ${time} | ${e.source} | ${soc === '?' ? '-' : soc + '%'} | ${range === '?' ? '-' : range + ' km'} | ${lockedStr} | ${km === '?' ? '-' : km + ' km'} | ${loc} |`);
    }

    if (entries.length > 50) {
      lines.push(`| ... | ${entries.length - 50} weitere Einträge | | | | |`);
    }

    return { success: true, data: { entries: entries.length, from: fromDate, to: toDate }, display: lines.join('\n') };
  }
}
