import crypto from 'node:crypto';
import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult, SpotifyConfig } from '@alfred/types';

const PREMIUM_ACTIONS = new Set([
  'play', 'pause', 'resume', 'next', 'previous', 'seek', 'volume',
  'shuffle', 'repeat', 'transfer', 'queue',
]);

export class SpotifySkill extends Skill {
  /** Per-account access tokens, keyed by account name. */
  private accessTokens = new Map<string, string>();
  /** Premium status cache (30 min TTL). */
  private premiumCache = new Map<string, { isPremium: boolean; expiresAt: number }>();
  /** Pending OAuth PKCE flows. */
  private pendingAuths = new Map<string, { codeVerifier: string; userId: string; redirectUri: string; expiresAt: number; context?: SkillContext }>();

  readonly metadata: SkillMetadata;

  private readonly configs: Map<string, SpotifyConfig>;
  private activeConfigs?: Map<string, SpotifyConfig>;
  private mergedConfigs?: Map<string, SpotifyConfig>;
  private lastContext?: SkillContext;
  /** Persistent resolver reference — survives across execute() calls for OAuth callbacks on HA nodes. */
  private userServiceResolverRef?: SkillContext['userServiceResolver'];

  private readonly apiPublicUrl?: string;

  constructor(configs?: Map<string, SpotifyConfig> | SpotifyConfig, apiPublicUrl?: string) {
    super();
    this.apiPublicUrl = apiPublicUrl;

    if (configs instanceof Map) {
      this.configs = configs;
    } else if (configs) {
      this.configs = new Map([['default', configs]]);
    } else {
      this.configs = new Map();
    }

    const accountProp = {
      account: {
        type: 'string' as const,
        description: 'Spotify-Account Name. Nutze list_accounts um verfügbare Accounts zu sehen.',
      },
    };

    this.metadata = {
      name: 'spotify',
      description: 'Spotify-Steuerung: Musik abspielen, pausieren, überspringen, Lautstärke, ' +
        'Geräte wechseln, Suche, Playlists verwalten, Queue, Empfehlungen. ' +
        'Spotify-Musik, Song, Track, Artist, Album, Playlist, Wiedergabe, Gerät. ' +
        'Benötigt Spotify Premium für Playback-Steuerung. ' +
        'WICHTIG: Sonos-Speaker über Spotify Connect sind "restricted" — Playback-Start, ' +
        'Lautstärke und Transfer funktionieren NICHT über die Spotify-API. ' +
        'Nutze stattdessen den Sonos-Skill für Steuerung auf Sonos-Speakern. ' +
        'Dieser Skill ist für Nicht-Sonos-Geräte (Computer, Handy, etc.) und für ' +
        'Suche, Playlists, Empfehlungen, Queue, Like/Unlike.',
      version: '1.0.0',
      riskLevel: 'write',
      category: 'media',
      timeoutMs: 330_000,
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'authorize', 'confirm_auth', 'now_playing', 'play', 'pause', 'resume', 'next', 'previous',
              'seek', 'volume', 'shuffle', 'repeat', 'devices', 'transfer', 'search',
              'queue', 'queue_list', 'playlists', 'playlist_tracks', 'playlist_create',
              'playlist_add', 'playlist_remove', 'like', 'unlike', 'top_tracks',
              'top_artists', 'recently_played', 'recommend', 'list_accounts',
            ],
            description: 'Aktion: authorize (Spotify verbinden), confirm_auth (Callback-URL manuell eingeben wenn Redirect fehlschlägt), now_playing, play, pause, resume, next, previous, seek, volume, shuffle, repeat, devices, transfer, search, queue, queue_list, playlists, playlist_tracks, playlist_create, playlist_add, playlist_remove, like, unlike, top_tracks, top_artists, recently_played, recommend, list_accounts.',
          },
          ...accountProp,
          // play
          query: { type: 'string', description: 'Suchbegriff für play/search (Song, Artist, Album, Playlist).' },
          type: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'], description: 'Typ für search/play (default: track).' },
          uri: { type: 'string', description: 'Spotify URI (spotify:track:xxx) für play/queue.' },
          device: { type: 'string', description: 'Gerätename für play/transfer (z.B. "Wohnzimmer", "Sonos").' },
          // seek/volume
          position_ms: { type: 'number', description: 'Position in Millisekunden (seek).' },
          volume_percent: { type: 'number', description: 'Lautstärke 0-100 (volume).' },
          // shuffle/repeat
          state: { type: 'string', description: 'shuffle: true/false. repeat: off/track/context.' },
          // playlist
          playlist_id: { type: 'string', description: 'Playlist-ID für playlist_tracks/playlist_add/playlist_remove.' },
          name: { type: 'string', description: 'Name für playlist_create.' },
          description: { type: 'string', description: 'Beschreibung für playlist_create.' },
          public: { type: 'boolean', description: 'Öffentlich für playlist_create (default: false).' },
          uris: { type: 'array', items: { type: 'string' }, description: 'URIs für playlist_add/playlist_remove.' },
          // like/unlike
          ids: { type: 'array', items: { type: 'string' }, description: 'Track-IDs für like/unlike.' },
          // top/recently
          time_range: { type: 'string', enum: ['short_term', 'medium_term', 'long_term'], description: 'Zeitraum für top_tracks/top_artists.' },
          limit: { type: 'number', description: 'Anzahl Ergebnisse (max 50).' },
          // recommend
          seed_tracks: { type: 'array', items: { type: 'string' }, description: 'Seed Track-IDs für Empfehlungen.' },
          seed_artists: { type: 'array', items: { type: 'string' }, description: 'Seed Artist-IDs für Empfehlungen.' },
          seed_genres: { type: 'array', items: { type: 'string' }, description: 'Seed Genres für Empfehlungen (z.B. pop, rock, jazz).' },
          // authorize
          redirect_uri: { type: 'string', description: 'Basis-URL für OAuth Redirect (default: aus ALFRED_API_PUBLIC_URL).' },
          // confirm_auth
          callback_url: { type: 'string', description: 'Komplette Callback-URL aus der Browser-Adressleiste (für manuelle Auth-Bestätigung bei Self-signed Cert).' },
        },
      },
    };
  }

  // ── Execute ─────────────────────────────────────────────────────

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    this.lastContext = context;
    if (context.userServiceResolver) this.userServiceResolverRef = context.userServiceResolver;

    const userConfigs = await this.resolveUserConfigs(context);
    this.activeConfigs = userConfigs ?? undefined;

    try {
      let cfgs: Map<string, SpotifyConfig>;
      if (this.activeConfigs) {
        if (context.userRole === 'admin' || !context.alfredUserId) {
          cfgs = new Map([...this.configs, ...this.activeConfigs]);
        } else {
          cfgs = this.activeConfigs;
        }
      } else {
        cfgs = (context.userRole === 'admin' || !context.alfredUserId) ? this.configs : new Map();
      }
      this.mergedConfigs = cfgs;

      const action = input.action as string;

      if (action === 'list_accounts') return this.handleListAccounts(cfgs);
      if (action === 'authorize') return await this.authorize(input, context);

      if (cfgs.size === 0) {
        return { success: false, error: 'Spotify ist nicht konfiguriert. Nutze "authorize" oder "setup_service" um Spotify zu verbinden.' };
      }

      // Premium check for playback actions
      if (PREMIUM_ACTIONS.has(action)) {
        const resolved = this.resolveConfig(input);
        if ('success' in resolved) return resolved;
        const isPremium = await this.checkPremium(resolved.cfg, resolved.account);
        if (!isPremium) {
          return { success: false, error: 'Spotify Premium erforderlich für Playback-Steuerung. Dein Account ist Free/Open.' };
        }
      }

      try {
        switch (action) {
          case 'now_playing': return await this.nowPlaying(input);
          case 'play': return await this.play(input);
          case 'pause': return await this.pausePlayback(input);
          case 'resume': return await this.resumePlayback(input);
          case 'next': return await this.next(input);
          case 'previous': return await this.previous(input);
          case 'seek': return await this.seek(input);
          case 'volume': return await this.setVolume(input);
          case 'shuffle': return await this.setShuffle(input);
          case 'repeat': return await this.setRepeat(input);
          case 'devices': return await this.listDevices(input);
          case 'transfer': return await this.transferPlayback(input);
          case 'search': return await this.search(input);
          case 'queue': return await this.addToQueue(input);
          case 'queue_list': return await this.getQueue(input);
          case 'playlists': return await this.listPlaylists(input);
          case 'playlist_tracks': return await this.playlistTracks(input);
          case 'playlist_create': return await this.createPlaylist(input);
          case 'playlist_add': return await this.playlistAdd(input);
          case 'playlist_remove': return await this.playlistRemove(input);
          case 'like': return await this.likeTracks(input);
          case 'unlike': return await this.unlikeTracks(input);
          case 'top_tracks': return await this.topTracks(input);
          case 'top_artists': return await this.topArtists(input);
          case 'recently_played': return await this.recentlyPlayed(input);
          case 'recommend': return await this.recommend(input);
          case 'confirm_auth': return await this.confirmAuth(input, context);
          default:
            return { success: false, error: `Unbekannte Aktion: ${action}` };
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      this.activeConfigs = undefined;
      this.mergedConfigs = undefined;
    }
  }

  // ── OAuth authorize ─────────────────────────────────────────────

  private async authorize(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const cfgs = this.mergedConfigs ?? this.configs;
    const account = (input.account as string) ?? [...cfgs.keys()][0] ?? 'default';
    const cfg = cfgs.get(account);

    const clientId = cfg?.clientId;
    if (!clientId) {
      return { success: false, error: 'Spotify Client-ID nicht konfiguriert. Admin muss ALFRED_SPOTIFY_CLIENT_ID setzen.' };
    }

    // Generate PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = crypto.randomUUID();

    // Derive redirect URI: explicit param > constructor publicUrl > fallback
    const baseUrl = (input.redirect_uri as string)
      ?? this.apiPublicUrl
      ?? 'http://localhost:3420';
    const redirectUri = `${baseUrl.replace(/\/+$/, '')}/api/oauth/callback`;

    const userId = context.alfredUserId ?? context.userId;

    // Encode ALL auth data in state so ANY node can handle the callback (HA-safe).
    // State is opaque to Spotify — they just echo it back.
    const state = Buffer.from(JSON.stringify({
      service: 'spotify',
      account,
      userId,
      nonce,
      codeVerifier,
      redirectUri,
    })).toString('base64url');

    // Also keep in memory for polling (this node only)
    this.pendingAuths.set(nonce, {
      codeVerifier,
      userId,
      redirectUri,
      context,
      expiresAt: Date.now() + 5 * 60_000,
    });

    const scopes = [
      'user-read-private', 'user-read-playback-state', 'user-modify-playback-state',
      'user-read-currently-playing', 'playlist-read-private', 'playlist-modify-public',
      'playlist-modify-private', 'user-library-read', 'user-library-modify',
      'user-top-read', 'user-read-recently-played',
    ].join(' ');

    const authUrl = `https://accounts.spotify.com/authorize?` +
      `client_id=${clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&state=${state}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256`;

    const message = `**Spotify verbinden**\n\n` +
      `1. Öffne diesen Link: ${authUrl}\n` +
      `2. Melde dich bei Spotify an und erlaube den Zugriff\n` +
      `3. Du wirst weitergeleitet — **falls die Seite nicht lädt** (Self-signed Cert), ` +
      `kopiere die komplette URL aus der Adressleiste und schicke sie mir hier im Chat.\n\n` +
      `⏳ Warte auf Bestätigung (automatisch oder manuell)...`;

    if (context.onProgress) {
      context.onProgress(message);
    }

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const token = this.accessTokens.get(account);
      if (token) {
        return { success: true, display: '✅ Spotify erfolgreich verbunden!' };
      }
      if (!this.pendingAuths.has(nonce)) {
        const token2 = this.accessTokens.get(account);
        if (token2) return { success: true, display: '✅ Spotify erfolgreich verbunden!' };
        return { success: false, error: 'Autorisierung fehlgeschlagen.' };
      }
    }

    this.pendingAuths.delete(nonce);
    return { success: false, error: 'Timeout — keine Bestätigung innerhalb von 5 Minuten. Du kannst die Callback-URL auch manuell schicken.' };
  }

  // ── Manual auth confirmation (user pastes callback URL from browser) ────

  private async confirmAuth(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const callbackUrl = input.url as string ?? input.callback_url as string;
    if (!callbackUrl) {
      return { success: false, error: 'URL fehlt. Kopiere die komplette URL aus der Browser-Adressleiste nach dem Spotify-Redirect.' };
    }

    // Extract code and state from URL
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { success: false, error: 'Ungültige URL. Kopiere die komplette Adresse inkl. https://...' };
    }

    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return { success: false, error: `Spotify-Autorisierung abgelehnt: ${error}` };
    }

    if (!code || !stateParam) {
      return { success: false, error: 'URL enthält keinen Authorization-Code. Stelle sicher dass du die URL nach dem Spotify-Redirect kopiert hast.' };
    }

    // Decode state
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
    } catch {
      return { success: false, error: 'Ungültiger State-Parameter in der URL.' };
    }

    // Use handleOAuthCallback to do the token exchange
    const result = await this.handleOAuthCallback(code, state);
    if (result.success) {
      return { success: true, display: '✅ Spotify erfolgreich verbunden!' };
    }
    return { success: false, error: result.error ?? 'Token-Exchange fehlgeschlagen.' };
  }

  // ── OAuth callback (called from HttpAdapter via alfred.ts) ────

  async handleOAuthCallback(code: string, state: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    const nonce = state.nonce as string;
    const account = (state.account as string) ?? 'default';

    // HA-safe: pendingAuths may be on another node.
    // All auth data is encoded in state so ANY node can complete the exchange.
    const pending = this.pendingAuths.get(nonce);
    const codeVerifier = (pending?.codeVerifier ?? state.codeVerifier) as string;
    const redirectUri = (pending?.redirectUri ?? state.redirectUri) as string;
    const userId = (pending?.userId ?? state.userId) as string;

    if (!codeVerifier || !redirectUri) {
      return { success: false, error: 'Unbekannte oder abgelaufene Autorisierung (fehlende Auth-Daten).' };
    }

    const cfg = (this.mergedConfigs ?? this.configs).get(account);
    if (!cfg) return { success: false, error: `Account "${account}" nicht gefunden.` };

    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: codeVerifier,
    };
    if (cfg.clientSecret) params.client_secret = cfg.clientSecret;

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      this.pendingAuths.delete(nonce);
      return { success: false, error: `Token-Exchange fehlgeschlagen: ${res.status} ${errBody.slice(0, 200)}` };
    }

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
    this.accessTokens.set(account, data.access_token);

    // Persist refresh token — try pending context, then lastContext, then direct DB via config
    const ctx = pending?.context ?? this.lastContext;
    if (data.refresh_token && ctx?.userServiceResolver && userId) {
      await ctx.userServiceResolver.saveServiceConfig(
        userId, 'spotify', account,
        { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: data.refresh_token },
      );
    } else if (data.refresh_token && this.userServiceResolverRef && userId) {
      // Fallback: use stored resolver reference (set during initialize)
      await this.userServiceResolverRef.saveServiceConfig(
        userId, 'spotify', account,
        { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: data.refresh_token },
      );
    } else if (data.refresh_token) {
      console.warn('[SpotifySkill] Refresh-Token erhalten aber kein userServiceResolver — Token nur im Memory!');
    }

    this.pendingAuths.delete(nonce);
    return { success: true };
  }

  // ── Config Resolution ───────────────────────────────────────────

  private async resolveUserConfigs(context: SkillContext): Promise<Map<string, SpotifyConfig> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'spotify');
    if (services.length === 0) return null;

    const cfgs = new Map<string, SpotifyConfig>();
    for (const svc of services) {
      if (svc.config && (svc.config as any).clientId) {
        cfgs.set(svc.serviceName, svc.config as unknown as SpotifyConfig);
      }
    }
    return cfgs.size > 0 ? cfgs : null;
  }

  private resolveConfig(input: Record<string, unknown>): { cfg: SpotifyConfig; account: string } | SkillResult {
    const cfgs = this.mergedConfigs ?? this.activeConfigs ?? this.configs;
    const accountNames = [...cfgs.keys()];
    const defaultAccount = accountNames[0] ?? 'default';
    const account = (input.account as string) ?? defaultAccount;
    const cfg = cfgs.get(account);
    if (!cfg) {
      return {
        success: false,
        error: `Unbekannter Spotify-Account "${account}". Verfuegbar: ${accountNames.join(', ')}`,
      };
    }
    return { cfg, account };
  }

  private handleListAccounts(cfgs: Map<string, SpotifyConfig>): SkillResult {
    const names = [...cfgs.keys()];
    if (names.length === 0) {
      return { success: true, data: { accounts: [] }, display: 'Keine Spotify-Accounts konfiguriert.\nNutze "authorize" oder "setup_service" um Spotify zu verbinden.' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfuegbare Spotify-Accounts:\n${names.map((n, i) => `${i === 0 ? '- ' + n + ' (Standard)' : '- ' + n}`).join('\n')}`,
    };
  }

  // ── Token Management ────────────────────────────────────────────

  private async refreshAccessToken(cfg: SpotifyConfig, account: string): Promise<string> {
    if (!cfg.refreshToken) throw new Error('Kein Refresh-Token. Nutze "authorize" um Spotify zu verbinden.');

    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
    };
    if (cfg.clientSecret) params.client_secret = cfg.clientSecret;

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) throw new Error(`Spotify Token-Refresh fehlgeschlagen: ${res.status}`);
    const data = await res.json() as { access_token: string };
    this.accessTokens.set(account, data.access_token);
    return data.access_token;
  }

  private async spotifyRequest(cfg: SpotifyConfig, account: string, path: string, options: RequestInit = {}): Promise<any> {
    let token = this.accessTokens.get(account);
    if (!token) token = await this.refreshAccessToken(cfg, account);

    const doFetch = (t: string) => fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...options.headers as Record<string, string> },
      signal: AbortSignal.timeout(15_000),
    });

    let res = await doFetch(token);
    if (res.status === 401) {
      const newToken = await this.refreshAccessToken(cfg, account);
      res = await doFetch(newToken);
    }
    if (res.status === 204) return undefined;
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Spotify API ${res.status}: ${err.slice(0, 200)}`);
    }
    return res.json();
  }

  private async checkPremium(cfg: SpotifyConfig, account: string): Promise<boolean> {
    const cached = this.premiumCache.get(account);
    if (cached && Date.now() < cached.expiresAt) return cached.isPremium;
    const profile = await this.spotifyRequest(cfg, account, '/me');
    const isPremium = profile.product === 'premium';
    this.premiumCache.set(account, { isPremium, expiresAt: Date.now() + 30 * 60_000 });
    return isPremium;
  }

  // ── Device Resolution ───────────────────────────────────────────

  /**
   * Get all devices — merges /me/player/devices with the active device from /me/player.
   * Sonos speakers via Spotify Connect have is_restricted=true and often DON'T appear
   * in /devices, but DO appear as the active device in /player.
   */
  private async getAllDevices(cfg: SpotifyConfig, account: string): Promise<Array<{ id: string; name: string; type: string; is_active: boolean; volume_percent: number }>> {
    const data = await this.spotifyRequest(cfg, account, '/me/player/devices');
    const devices = [...((data?.devices ?? []) as Array<{ id: string | null; name: string; type: string; is_active: boolean; volume_percent: number }>)];

    // Also check /me/player for the active device (Sonos Connect devices often only appear here)
    try {
      const player = await this.spotifyRequest(cfg, account, '/me/player');
      if (player?.device?.name) {
        const activeDevice = player.device as { id: string | null; name: string; type: string; is_active: boolean; volume_percent: number };
        const alreadyListed = devices.some(d => d.name === activeDevice.name);
        if (!alreadyListed) {
          devices.push({ ...activeDevice, id: activeDevice.id ?? `active:${activeDevice.name}`, is_active: true });
        }
      }
    } catch { /* /me/player may fail if nothing is playing */ }

    return devices.filter(d => d.id != null) as Array<{ id: string; name: string; type: string; is_active: boolean; volume_percent: number }>;
  }

  private async resolveDevice(cfg: SpotifyConfig, account: string, device: string): Promise<string> {
    const devices = await this.getAllDevices(cfg, account);

    const byName = devices.find(d => d.name.toLowerCase() === device.toLowerCase());
    if (byName) return byName.id;

    const byPartial = devices.find(d => d.name.toLowerCase().includes(device.toLowerCase()));
    if (byPartial) return byPartial.id;

    const available = devices.map(d => `${d.name}${d.is_active ? ' (aktiv)' : ''}`).join(', ');
    throw new Error(`Gerät "${device}" nicht gefunden. Verfügbar: ${available || 'keine'}`);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private formatDuration(ms: number): string {
    const min = Math.floor(ms / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  private formatTrack(t: any): string {
    const artists = (t.artists ?? []).map((a: any) => a.name).join(', ');
    const album = t.album?.name ?? '';
    return `${t.name} — ${artists}${album ? ` (${album})` : ''}`;
  }

  // ── Actions ─────────────────────────────────────────────────────

  private async nowPlaying(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const data = await this.spotifyRequest(cfg, account, '/me/player/currently-playing');
    if (!data || !data.item) {
      return { success: true, data: null, display: 'Aktuell wird nichts abgespielt.' };
    }

    const track = data.item;
    const progress = this.formatDuration(data.progress_ms ?? 0);
    const duration = this.formatDuration(track.duration_ms ?? 0);
    const isPlaying = data.is_playing ? 'Spielt' : 'Pausiert';

    return {
      success: true,
      data: {
        track: track.name,
        artists: (track.artists ?? []).map((a: any) => a.name),
        album: track.album?.name,
        progress_ms: data.progress_ms,
        duration_ms: track.duration_ms,
        is_playing: data.is_playing,
        uri: track.uri,
        id: track.id,
      },
      display: `${isPlaying}: ${this.formatTrack(track)}\n${progress} / ${duration}`,
    };
  }

  private async play(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    let deviceId: string | undefined;
    if (input.device) {
      deviceId = await this.resolveDevice(cfg, account, input.device as string);
    }

    const body: Record<string, unknown> = {};

    if (input.uri) {
      const uri = input.uri as string;
      if (uri.includes(':track:') || uri.includes(':episode:')) {
        body.uris = [uri];
      } else {
        body.context_uri = uri;
      }
    } else if (input.query) {
      // Search first, then play
      const type = (input.type as string) ?? 'track';
      const searchData = await this.spotifyRequest(cfg, account,
        `/search?q=${encodeURIComponent(input.query as string)}&type=${type}&limit=1`);
      const items = searchData?.[`${type}s`]?.items;
      if (!items?.length) {
        return { success: false, error: `Nichts gefunden fuer "${input.query}".` };
      }
      const item = items[0];
      if (type === 'track') {
        body.uris = [item.uri];
      } else {
        body.context_uri = item.uri;
      }
    }

    const qs = deviceId ? `?device_id=${deviceId}` : '';
    await this.spotifyRequest(cfg, account, `/me/player/play${qs}`, {
      method: 'PUT',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });

    return { success: true, display: input.query ? `Spiele: ${input.query}` : 'Wiedergabe gestartet.' };
  }

  private async pausePlayback(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    await this.spotifyRequest(cfg, account, '/me/player/pause', { method: 'PUT' });
    return { success: true, display: 'Wiedergabe pausiert.' };
  }

  private async resumePlayback(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    await this.spotifyRequest(cfg, account, '/me/player/play', { method: 'PUT' });
    return { success: true, display: 'Wiedergabe fortgesetzt.' };
  }

  private async next(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    await this.spotifyRequest(cfg, account, '/me/player/next', { method: 'POST' });
    return { success: true, display: 'Naechster Track.' };
  }

  private async previous(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    await this.spotifyRequest(cfg, account, '/me/player/previous', { method: 'POST' });
    return { success: true, display: 'Vorheriger Track.' };
  }

  private async seek(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const posMs = Number(input.position_ms ?? 0);
    await this.spotifyRequest(cfg, account, `/me/player/seek?position_ms=${posMs}`, { method: 'PUT' });
    return { success: true, display: `Position: ${this.formatDuration(posMs)}` };
  }

  private async setVolume(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const vol = Math.max(0, Math.min(100, Number(input.volume_percent ?? 50)));
    await this.spotifyRequest(cfg, account, `/me/player/volume?volume_percent=${vol}`, { method: 'PUT' });
    return { success: true, display: `Lautstaerke: ${vol}%` };
  }

  private async setShuffle(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const state = String(input.state ?? 'true').toLowerCase() === 'true';
    await this.spotifyRequest(cfg, account, `/me/player/shuffle?state=${state}`, { method: 'PUT' });
    return { success: true, display: `Zufallswiedergabe: ${state ? 'An' : 'Aus'}` };
  }

  private async setRepeat(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const state = (input.state as string) ?? 'off';
    await this.spotifyRequest(cfg, account, `/me/player/repeat?state=${state}`, { method: 'PUT' });
    const labels: Record<string, string> = { off: 'Aus', track: 'Track', context: 'Kontext' };
    return { success: true, display: `Wiederholung: ${labels[state] ?? state}` };
  }

  private async listDevices(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const devices = await this.getAllDevices(cfg, account);

    if (devices.length === 0) {
      return { success: true, data: { devices: [] }, display: 'Keine Spotify-Geräte gefunden. Öffne Spotify auf einem Gerät.' };
    }

    const lines = devices.map(d =>
      `- ${d.name} (${d.type})${d.is_active ? ' [aktiv]' : ''} — ${d.volume_percent}%`
    );

    return {
      success: true,
      data: { devices: devices.map(d => ({ id: d.id, name: d.name, type: d.type, is_active: d.is_active, volume_percent: d.volume_percent })) },
      display: `Spotify-Geräte:\n${lines.join('\n')}`,
    };
  }

  private async transferPlayback(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.device) return { success: false, error: 'Geraetename fehlt (device).' };
    const deviceId = await this.resolveDevice(cfg, account, input.device as string);

    await this.spotifyRequest(cfg, account, '/me/player', {
      method: 'PUT',
      body: JSON.stringify({ device_ids: [deviceId], play: true }),
    });

    return { success: true, display: `Wiedergabe auf "${input.device}" uebertragen.` };
  }

  private async search(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.query) return { success: false, error: 'Suchbegriff fehlt (query).' };
    const type = (input.type as string) ?? 'track';
    const limit = Math.min(Number(input.limit ?? 10), 50);

    const data = await this.spotifyRequest(cfg, account,
      `/search?q=${encodeURIComponent(input.query as string)}&type=${type}&limit=${limit}`);

    const items = data?.[`${type}s`]?.items ?? [];
    if (items.length === 0) {
      return { success: true, data: { results: [] }, display: `Keine Ergebnisse fuer "${input.query}".` };
    }

    const results = items.map((item: any) => {
      if (type === 'track') {
        return { name: item.name, artists: (item.artists ?? []).map((a: any) => a.name), album: item.album?.name, uri: item.uri, id: item.id };
      }
      return { name: item.name, uri: item.uri, id: item.id, ...(item.artists ? { artists: item.artists.map((a: any) => a.name) } : {}) };
    });

    const lines = items.slice(0, 10).map((item: any, i: number) => {
      if (type === 'track') return `${i + 1}. ${this.formatTrack(item)} [${item.uri}]`;
      return `${i + 1}. ${item.name} [${item.uri}]`;
    });

    return {
      success: true,
      data: { results, total: data[`${type}s`]?.total },
      display: `Suchergebnisse (${type}):\n${lines.join('\n')}`,
    };
  }

  private async addToQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.uri) return { success: false, error: 'URI fehlt. Nutze search um eine URI zu finden.' };
    await this.spotifyRequest(cfg, account, `/me/player/queue?uri=${encodeURIComponent(input.uri as string)}`, { method: 'POST' });
    return { success: true, display: 'Zur Warteschlange hinzugefuegt.' };
  }

  private async getQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const data = await this.spotifyRequest(cfg, account, '/me/player/queue');
    const current = data?.currently_playing;
    const queue = (data?.queue ?? []).slice(0, 20) as any[];

    const lines: string[] = [];
    if (current) lines.push(`Aktuell: ${this.formatTrack(current)}`);
    if (queue.length > 0) {
      lines.push('Warteschlange:');
      queue.forEach((t: any, i: number) => lines.push(`${i + 1}. ${this.formatTrack(t)}`));
    } else {
      lines.push('Warteschlange ist leer.');
    }

    return {
      success: true,
      data: {
        currently_playing: current ? { name: current.name, uri: current.uri } : null,
        queue: queue.map((t: any) => ({ name: t.name, artists: (t.artists ?? []).map((a: any) => a.name), uri: t.uri })),
      },
      display: lines.join('\n'),
    };
  }

  private async listPlaylists(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const limit = Math.min(Number(input.limit ?? 20), 50);
    const data = await this.spotifyRequest(cfg, account, `/me/playlists?limit=${limit}`);
    const items = (data?.items ?? []) as any[];

    const lines = items.map((p: any, i: number) =>
      `${i + 1}. ${p.name} (${p.tracks?.total ?? 0} Tracks) [${p.id}]`
    );

    return {
      success: true,
      data: { playlists: items.map((p: any) => ({ id: p.id, name: p.name, tracks: p.tracks?.total, uri: p.uri })) },
      display: lines.length > 0 ? `Playlists:\n${lines.join('\n')}` : 'Keine Playlists gefunden.',
    };
  }

  private async playlistTracks(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.playlist_id) return { success: false, error: 'Playlist-ID fehlt (playlist_id).' };
    const limit = Math.min(Number(input.limit ?? 20), 50);
    const data = await this.spotifyRequest(cfg, account, `/playlists/${input.playlist_id}/tracks?limit=${limit}`);
    const items = (data?.items ?? []) as any[];

    const tracks = items
      .filter((i: any) => i.track)
      .map((i: any) => ({
        name: i.track.name,
        artists: (i.track.artists ?? []).map((a: any) => a.name),
        uri: i.track.uri,
        id: i.track.id,
      }));

    const lines = tracks.slice(0, 20).map((t: any, i: number) =>
      `${i + 1}. ${t.name} — ${t.artists.join(', ')}`
    );

    return {
      success: true,
      data: { tracks, total: data?.total },
      display: lines.length > 0 ? `Playlist-Tracks:\n${lines.join('\n')}` : 'Keine Tracks in Playlist.',
    };
  }

  private async createPlaylist(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.name) return { success: false, error: 'Playlist-Name fehlt (name).' };

    // Get user ID first
    const profile = await this.spotifyRequest(cfg, account, '/me');
    const userId = profile.id;

    const body: Record<string, unknown> = {
      name: input.name,
      public: input.public ?? false,
    };
    if (input.description) body.description = input.description;

    const data = await this.spotifyRequest(cfg, account, `/users/${userId}/playlists`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      success: true,
      data: { id: data.id, name: data.name, uri: data.uri },
      display: `Playlist "${data.name}" erstellt. [${data.id}]`,
    };
  }

  private async playlistAdd(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.playlist_id) return { success: false, error: 'Playlist-ID fehlt.' };
    const uris = (input.uris as string[]) ?? (input.uri ? [input.uri as string] : []);
    if (uris.length === 0) return { success: false, error: 'URIs fehlen.' };

    await this.spotifyRequest(cfg, account, `/playlists/${input.playlist_id}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris }),
    });

    return { success: true, display: `${uris.length} Track(s) zur Playlist hinzugefuegt.` };
  }

  private async playlistRemove(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    if (!input.playlist_id) return { success: false, error: 'Playlist-ID fehlt.' };
    const uris = (input.uris as string[]) ?? (input.uri ? [input.uri as string] : []);
    if (uris.length === 0) return { success: false, error: 'URIs fehlen.' };

    await this.spotifyRequest(cfg, account, `/playlists/${input.playlist_id}/tracks`, {
      method: 'DELETE',
      body: JSON.stringify({ tracks: uris.map(u => ({ uri: u })) }),
    });

    return { success: true, display: `${uris.length} Track(s) aus Playlist entfernt.` };
  }

  private async likeTracks(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const ids = (input.ids as string[]) ?? [];
    if (ids.length === 0) return { success: false, error: 'Track-IDs fehlen.' };

    await this.spotifyRequest(cfg, account, `/me/tracks?ids=${ids.join(',')}`, { method: 'PUT' });
    return { success: true, display: `${ids.length} Track(s) geliked.` };
  }

  private async unlikeTracks(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const ids = (input.ids as string[]) ?? [];
    if (ids.length === 0) return { success: false, error: 'Track-IDs fehlen.' };

    await this.spotifyRequest(cfg, account, `/me/tracks?ids=${ids.join(',')}`, { method: 'DELETE' });
    return { success: true, display: `${ids.length} Track(s) aus Bibliothek entfernt.` };
  }

  private async topTracks(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const timeRange = (input.time_range as string) ?? 'medium_term';
    const limit = Math.min(Number(input.limit ?? 10), 50);

    const data = await this.spotifyRequest(cfg, account, `/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
    const items = (data?.items ?? []) as any[];

    const tracks = items.map((t: any) => ({
      name: t.name,
      artists: (t.artists ?? []).map((a: any) => a.name),
      uri: t.uri,
      id: t.id,
    }));

    const rangeLabels: Record<string, string> = {
      short_term: 'letzte 4 Wochen',
      medium_term: 'letzte 6 Monate',
      long_term: 'alle Zeiten',
    };

    const lines = items.map((t: any, i: number) => `${i + 1}. ${this.formatTrack(t)}`);

    return {
      success: true,
      data: { tracks, time_range: timeRange },
      display: `Top-Tracks (${rangeLabels[timeRange] ?? timeRange}):\n${lines.join('\n')}`,
    };
  }

  private async topArtists(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const timeRange = (input.time_range as string) ?? 'medium_term';
    const limit = Math.min(Number(input.limit ?? 10), 50);

    const data = await this.spotifyRequest(cfg, account, `/me/top/artists?time_range=${timeRange}&limit=${limit}`);
    const items = (data?.items ?? []) as any[];

    const rangeLabels: Record<string, string> = {
      short_term: 'letzte 4 Wochen',
      medium_term: 'letzte 6 Monate',
      long_term: 'alle Zeiten',
    };

    const lines = items.map((a: any, i: number) =>
      `${i + 1}. ${a.name} (${(a.genres ?? []).slice(0, 3).join(', ')})`
    );

    return {
      success: true,
      data: { artists: items.map((a: any) => ({ name: a.name, genres: a.genres, uri: a.uri, id: a.id })), time_range: timeRange },
      display: `Top-Artists (${rangeLabels[timeRange] ?? timeRange}):\n${lines.join('\n')}`,
    };
  }

  private async recentlyPlayed(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const limit = Math.min(Number(input.limit ?? 10), 50);
    const data = await this.spotifyRequest(cfg, account, `/me/player/recently-played?limit=${limit}`);
    const items = (data?.items ?? []) as any[];

    const tracks = items
      .filter((i: any) => i.track)
      .map((i: any) => ({
        name: i.track.name,
        artists: (i.track.artists ?? []).map((a: any) => a.name),
        played_at: i.played_at,
        uri: i.track.uri,
      }));

    const lines = tracks.map((t: any, i: number) => {
      const time = new Date(t.played_at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. ${t.name} — ${t.artists.join(', ')} (${time})`;
    });

    return {
      success: true,
      data: { tracks },
      display: lines.length > 0 ? `Zuletzt gehoert:\n${lines.join('\n')}` : 'Keine kuerzlich gespielten Tracks.',
    };
  }

  private async recommend(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveConfig(input);
    if ('success' in resolved) return resolved;
    const { cfg, account } = resolved;

    const seedTracks = (input.seed_tracks as string[]) ?? [];
    const seedArtists = (input.seed_artists as string[]) ?? [];
    const seedGenres = (input.seed_genres as string[]) ?? [];
    const limit = Math.min(Number(input.limit ?? 10), 50);

    if (seedTracks.length === 0 && seedArtists.length === 0 && seedGenres.length === 0) {
      // Auto-seed from recently played
      try {
        const recent = await this.spotifyRequest(cfg, account, '/me/player/recently-played?limit=5');
        const recentItems = (recent?.items ?? []) as any[];
        for (const item of recentItems) {
          if (item.track?.id && seedTracks.length < 2) seedTracks.push(item.track.id);
          for (const a of (item.track?.artists ?? [])) {
            if (a.id && seedArtists.length < 2) seedArtists.push(a.id);
          }
        }
      } catch { /* ignore */ }
    }

    const params = new URLSearchParams();
    if (seedTracks.length > 0) params.set('seed_tracks', seedTracks.slice(0, 5).join(','));
    if (seedArtists.length > 0) params.set('seed_artists', seedArtists.slice(0, 5).join(','));
    if (seedGenres.length > 0) params.set('seed_genres', seedGenres.slice(0, 5).join(','));
    params.set('limit', String(limit));

    if (!params.has('seed_tracks') && !params.has('seed_artists') && !params.has('seed_genres')) {
      return { success: false, error: 'Keine Seeds angegeben. Nutze seed_tracks, seed_artists oder seed_genres.' };
    }

    const data = await this.spotifyRequest(cfg, account, `/recommendations?${params.toString()}`);
    const tracks = (data?.tracks ?? []) as any[];

    const results = tracks.map((t: any) => ({
      name: t.name,
      artists: (t.artists ?? []).map((a: any) => a.name),
      uri: t.uri,
      id: t.id,
    }));

    const lines = tracks.map((t: any, i: number) => `${i + 1}. ${this.formatTrack(t)} [${t.uri}]`);

    return {
      success: true,
      data: { recommendations: results },
      display: lines.length > 0 ? `Empfehlungen:\n${lines.join('\n')}` : 'Keine Empfehlungen erhalten.',
    };
  }
}
