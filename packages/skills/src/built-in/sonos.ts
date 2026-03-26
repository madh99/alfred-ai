import crypto from 'node:crypto';
import { Skill } from '../skill.js';
import type { SkillMetadata, SkillContext, SkillResult, SonosConfig } from '@alfred/types';

type Action =
  | 'speakers' | 'speaker_info'
  | 'play' | 'pause' | 'stop' | 'next' | 'previous'
  | 'play_favorite' | 'play_radio' | 'play_uri' | 'now_playing'
  | 'volume' | 'volume_group' | 'mute'
  | 'group' | 'ungroup' | 'group_all' | 'ungroup_all' | 'groups'
  | 'night_mode' | 'speech_enhance' | 'sleep_timer'
  | 'line_in' | 'tv_input' | 'crossfade'
  | 'stereo_pair' | 'stereo_separate'
  | 'favorites' | 'queue' | 'clear_queue' | 'add_to_queue'
  | 'authorize_cloud';

interface DeviceEntry { device: any; description: any }

// Sonos Cloud API base URLs
const SONOS_AUTH_BASE = 'https://api.sonos.com/login/v3/oauth';
const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE = 'https://api.ws.sonos.com/control/api/v1';

export class SonosSkill extends Skill {
  private sonosModule: any;
  private devices = new Map<string, DeviceEntry>();
  private lastDiscovery = 0;
  private readonly DISCOVERY_TTL = 600_000; // 10 min

  // Cloud API state
  private cloudAccessToken?: string;
  private cloudTokenExpiry = 0;
  private cloudHouseholds?: any[];
  private cloudPlayers = new Map<string, { playerId: string; groupId: string; playerName: string }>();
  private pendingAuths = new Map<string, { userId: string; redirectUri: string; expiresAt: number }>();
  private lastContext?: SkillContext;

  readonly metadata: SkillMetadata = {
    name: 'sonos',
    description:
      'Sonos-Speaker steuern: Gruppierung, Lautstärke, Radio/TuneIn, ' +
      'Sleep-Timer, Nachtmodus, Line-In, TV-Audio, Stereopaare. ' +
      'Sonos, Lautsprecher, Speaker, Musik, Radio, Raum, Gruppe, Zimmerlautstärke. ' +
      'Fuer Spotify-Playback nutze den Spotify-Skill (Spotify Connect).',
    version: '1.0.0',
    riskLevel: 'write',
    category: 'media',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'speakers', 'speaker_info',
            'play', 'pause', 'stop', 'next', 'previous',
            'play_favorite', 'play_radio', 'play_uri', 'now_playing',
            'volume', 'volume_group', 'mute',
            'group', 'ungroup', 'group_all', 'ungroup_all', 'groups',
            'night_mode', 'speech_enhance', 'sleep_timer',
            'line_in', 'tv_input', 'crossfade',
            'stereo_pair', 'stereo_separate',
            'favorites', 'queue', 'clear_queue', 'add_to_queue',
            'authorize_cloud',
          ],
          description: 'Aktion auf dem Sonos-System.',
        },
        speaker: {
          type: 'string',
          description: 'Raumname des Speakers (z.B. "Wohnzimmer", "Kueche"). Fuzzy-Matching aktiv.',
        },
        level: {
          type: 'number',
          description: 'Lautstärke 0-100 (fuer volume/volume_group).',
        },
        target: {
          type: 'string',
          description: 'Ziel-Speaker fuer group (Coordinator-Name).',
        },
        name: {
          type: 'string',
          description: 'Name fuer play_favorite, play_radio (Sendername).',
        },
        uri: {
          type: 'string',
          description: 'URI fuer play_uri / add_to_queue.',
        },
        enabled: {
          type: 'boolean',
          description: 'Aktivieren/Deaktivieren fuer night_mode, speech_enhance, crossfade, mute.',
        },
        minutes: {
          type: 'number',
          description: 'Minuten fuer sleep_timer (0 = aus).',
        },
        left: {
          type: 'string',
          description: 'Linker Speaker fuer stereo_pair.',
        },
        right: {
          type: 'string',
          description: 'Rechter Speaker fuer stereo_pair.',
        },
        redirect_uri: {
          type: 'string',
          description: 'Basis-URL fuer OAuth Redirect (default: http://localhost:3420).',
        },
      },
    },
  };

  private readonly apiPublicUrl?: string;

  constructor(private readonly config?: SonosConfig, apiPublicUrl?: string) {
    super();
    this.apiPublicUrl = apiPublicUrl;
  }

  // ── Execute ─────────────────────────────────────────────────────

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    this.lastContext = context;
    const action = input.action as Action | undefined;
    if (!action) return { success: false, error: 'Fehlender Parameter "action".' };

    if (action === 'authorize_cloud') return this.authorizeCloud(input, context);

    try {
      // Ensure devices discovered (except for cloud-only auth)
      await this.discoverDevices();
    } catch (err) {
      // Discovery failure is NOT a skill-health failure
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      switch (action) {
        // Device management
        case 'speakers': return await this.handleSpeakers();
        case 'speaker_info': return await this.handleSpeakerInfo(input);

        // Playback
        case 'play': return await this.handlePlay(input);
        case 'pause': return await this.handlePause(input);
        case 'stop': return await this.handleStop(input);
        case 'next': return await this.handleNext(input);
        case 'previous': return await this.handlePrevious(input);
        case 'play_favorite': return await this.handlePlayFavorite(input);
        case 'play_radio': return await this.handlePlayRadio(input);
        case 'play_uri': return await this.handlePlayUri(input);
        case 'now_playing': return await this.handleNowPlaying(input);

        // Volume
        case 'volume': return await this.handleVolume(input);
        case 'volume_group': return await this.handleVolumeGroup(input);
        case 'mute': return await this.handleMute(input);

        // Grouping
        case 'group': return await this.handleGroup(input);
        case 'ungroup': return await this.handleUngroup(input);
        case 'group_all': return await this.handleGroupAll();
        case 'ungroup_all': return await this.handleUngroupAll();
        case 'groups': return await this.handleGroups();

        // Advanced
        case 'night_mode': return await this.handleNightMode(input);
        case 'speech_enhance': return await this.handleSpeechEnhance(input);
        case 'sleep_timer': return await this.handleSleepTimer(input);
        case 'line_in': return await this.handleLineIn(input);
        case 'tv_input': return await this.handleTvInput(input);
        case 'crossfade': return await this.handleCrossfade(input);

        // Stereo
        case 'stereo_pair': return await this.handleStereoPair(input);
        case 'stereo_separate': return await this.handleStereoSeparate(input);

        // Favorites & Queue
        case 'favorites': return await this.handleFavorites(input);
        case 'queue': return await this.handleQueue(input);
        case 'clear_queue': return await this.handleClearQueue(input);
        case 'add_to_queue': return await this.handleAddToQueue(input);

        default:
          return { success: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Lazy-load sonos npm package ──────────────────────────────

  private async loadSonos(): Promise<any> {
    if (!this.sonosModule) {
      try {
        // Direct import — sonos is bundled inline
        // @ts-ignore — no type declarations in monorepo
        const mod = await import('sonos');
        this.sonosModule = mod.default ?? mod;
      } catch {
        try {
          // Fallback: dynamic import for external installs
          const mod = await (Function('return import("sonos")')() as Promise<any>);
          this.sonosModule = mod.default ?? mod;
        } catch {
          throw new Error('sonos Paket nicht verfügbar.');
        }
      }
    }
    return this.sonosModule;
  }

  // ── Device Discovery ─────────────────────────────────────────

  private async discoverDevices(): Promise<Map<string, DeviceEntry>> {
    const now = Date.now();
    if (this.devices.size > 0 && now - this.lastDiscovery < this.DISCOVERY_TTL) {
      return this.devices;
    }

    const sonos = await this.loadSonos();

    try {
      const listener = new sonos.AsyncDeviceDiscovery();
      const found = await listener.discover({ timeout: 5000 });
      // found is a single device, use it to get all zone groups
      const groups = await found.getAllGroups();

      this.devices.clear();
      for (const group of groups) {
        for (const member of group.ZoneGroupMember) {
          const host = new URL(member.Location).hostname;
          const device = new sonos.Sonos(host);
          const desc = await device.deviceDescription();
          this.devices.set(desc.roomName, { device, description: desc });
        }
      }
      this.lastDiscovery = now;
      return this.devices;
    } catch {
      if (this.config?.cloud?.refreshToken) {
        return this.discoverViaCloud();
      }
      throw new Error(
        'Keine Sonos-Geraete im Netzwerk gefunden. ' +
        'Pruefe Netzwerk/Firewall oder konfiguriere Sonos Cloud API.',
      );
    }
  }

  // ── Cloud Discovery Fallback ─────────────────────────────────

  private async discoverViaCloud(): Promise<Map<string, DeviceEntry>> {
    await this.ensureCloudToken();
    const headers = { Authorization: `Bearer ${this.cloudAccessToken}` };

    // Get households
    const hhRes = await fetch(`${SONOS_API_BASE}/households`, { headers });
    if (!hhRes.ok) throw new Error(`Sonos Cloud: Haushalte abrufen fehlgeschlagen (${hhRes.status})`);
    const hhData = await hhRes.json() as { households: Array<{ id: string }> };
    this.cloudHouseholds = hhData.households;

    this.cloudPlayers.clear();
    this.devices.clear();

    for (const hh of hhData.households) {
      const grpRes = await fetch(`${SONOS_API_BASE}/households/${hh.id}/groups`, { headers });
      if (!grpRes.ok) continue;
      const grpData = await grpRes.json() as {
        players: Array<{ id: string; name: string; websocketUrl?: string }>;
        groups: Array<{ id: string; coordinatorId: string; playerIds: string[] }>;
      };

      for (const player of grpData.players) {
        const grp = grpData.groups.find(g => g.playerIds.includes(player.id));
        this.cloudPlayers.set(player.name, {
          playerId: player.id,
          groupId: grp?.id ?? '',
          playerName: player.name,
        });
        // Create a placeholder device entry for cloud-only players
        this.devices.set(player.name, {
          device: null, // no local device
          description: { roomName: player.name, modelName: 'Cloud', cloudPlayerId: player.id, cloudGroupId: grp?.id },
        });
      }
    }

    this.lastDiscovery = Date.now();
    return this.devices;
  }

  private async ensureCloudToken(): Promise<void> {
    if (this.cloudAccessToken && Date.now() < this.cloudTokenExpiry) return;

    const cloud = this.config?.cloud;
    if (!cloud?.clientId || !cloud?.clientSecret || !cloud?.refreshToken) {
      throw new Error('Sonos Cloud nicht konfiguriert. Nutze authorize_cloud oder setze ENV-Variablen.');
    }

    const basic = Buffer.from(`${cloud.clientId}:${cloud.clientSecret}`).toString('base64');
    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cloud.refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      throw new Error(`Sonos Cloud Token-Refresh fehlgeschlagen: ${res.status}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number; refresh_token?: string };
    this.cloudAccessToken = data.access_token;
    this.cloudTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

    // Persist new refresh token if provided
    if (data.refresh_token && this.lastContext?.userServiceResolver) {
      try {
        const userId = this.lastContext.alfredUserId ?? this.lastContext.userId;
        await this.lastContext.userServiceResolver.saveServiceConfig(
          userId, 'sonos', 'default',
          { ...this.config!.cloud!, refreshToken: data.refresh_token },
        );
      } catch { /* token still cached in memory */ }
    }
  }

  // ── Speaker Resolution (fuzzy) ──────────────────────────────

  private resolveDevice(name: string): DeviceEntry {
    // Exact
    const exact = this.devices.get(name);
    if (exact) return exact;
    // Case-insensitive
    const lower = name.toLowerCase();
    for (const [roomName, entry] of this.devices) {
      if (roomName.toLowerCase() === lower) return entry;
    }
    // Partial
    for (const [roomName, entry] of this.devices) {
      if (roomName.toLowerCase().includes(lower) || lower.includes(roomName.toLowerCase())) {
        return entry;
      }
    }
    throw new Error(`Speaker "${name}" nicht gefunden. Verfuegbar: ${[...this.devices.keys()].join(', ')}`);
  }

  private requireSpeaker(input: Record<string, unknown>): DeviceEntry {
    const name = input.speaker as string;
    if (!name) throw new Error('Parameter "speaker" (Raumname) erforderlich.');
    return this.resolveDevice(name);
  }

  private isCloudOnly(entry: DeviceEntry): boolean {
    return entry.device === null;
  }

  // ── Cloud API helpers ────────────────────────────────────────

  private async cloudPost(path: string, body?: Record<string, unknown>): Promise<any> {
    await this.ensureCloudToken();
    const res = await fetch(`${SONOS_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cloudAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sonos Cloud API Fehler (${res.status}): ${text}`);
    }
    const ct = res.headers.get('content-type');
    if (ct?.includes('json')) return res.json();
    return null;
  }

  private async cloudGet(path: string): Promise<any> {
    await this.ensureCloudToken();
    const res = await fetch(`${SONOS_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.cloudAccessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sonos Cloud API Fehler (${res.status}): ${text}`);
    }
    return res.json();
  }

  private getCloudGroupId(entry: DeviceEntry): string {
    const gid = entry.description?.cloudGroupId;
    if (!gid) throw new Error('Keine Gruppen-ID fuer Cloud-Player verfuegbar.');
    return gid;
  }

  private getCloudPlayerId(entry: DeviceEntry): string {
    const pid = entry.description?.cloudPlayerId;
    if (!pid) throw new Error('Keine Player-ID fuer Cloud-Player verfuegbar.');
    return pid;
  }

  // ── Action Handlers ──────────────────────────────────────────

  // -- Device Management --

  private async handleSpeakers(): Promise<SkillResult> {
    const speakers: Array<Record<string, unknown>> = [];
    for (const [roomName, entry] of this.devices) {
      if (this.isCloudOnly(entry)) {
        speakers.push({ room: roomName, model: 'Cloud', source: 'cloud' });
      } else {
        const desc = entry.description;
        speakers.push({
          room: roomName,
          model: desc.modelName ?? desc.displayName ?? 'Sonos',
          serial: desc.serialNum,
          softwareVersion: desc.softwareVersion,
          source: 'local',
        });
      }
    }
    return { success: true, data: { speakers, count: speakers.length } };
  }

  private async handleSpeakerInfo(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      return { success: true, data: { room: entry.description.roomName, source: 'cloud', playerId: entry.description.cloudPlayerId } };
    }
    const desc = entry.description;
    const state = await entry.device.getCurrentState();
    const vol = await entry.device.getVolume();
    return {
      success: true,
      data: {
        room: desc.roomName,
        model: desc.modelName,
        serial: desc.serialNum,
        softwareVersion: desc.softwareVersion,
        state,
        volume: vol,
      },
    };
  }

  // -- Playback --

  private async handlePlay(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/playback/play`);
    } else {
      await entry.device.play();
    }
    return { success: true, display: `Wiedergabe gestartet.` };
  }

  private async handlePause(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/playback/pause`);
    } else {
      await entry.device.pause();
    }
    return { success: true, display: `Wiedergabe pausiert.` };
  }

  private async handleStop(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/playback/pause`);
    } else {
      await entry.device.stop();
    }
    return { success: true, display: `Wiedergabe gestoppt.` };
  }

  private async handleNext(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/playback/skipToNextTrack`);
    } else {
      await entry.device.next();
    }
    return { success: true, display: `Naechster Track.` };
  }

  private async handlePrevious(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/playback/skipToPreviousTrack`);
    } else {
      await entry.device.previous();
    }
    return { success: true, display: `Vorheriger Track.` };
  }

  private async handlePlayFavorite(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const name = input.name as string;
    if (!name) return { success: false, error: 'Parameter "name" (Favoritenname) erforderlich.' };

    if (this.isCloudOnly(entry)) {
      // Cloud API: get favorites, find matching, load
      const hhId = this.cloudHouseholds?.[0]?.id;
      if (!hhId) return { success: false, error: 'Kein Sonos-Haushalt gefunden.' };
      const favs = await this.cloudGet(`/households/${hhId}/favorites`);
      const items = favs.items as Array<{ id: string; name: string }> ?? [];
      const match = items.find((f: any) => f.name.toLowerCase().includes(name.toLowerCase()));
      if (!match) return { success: false, error: `Favorit "${name}" nicht gefunden.` };
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/favorites`, { favoriteId: match.id, playOnCompletion: true });
      return { success: true, display: `Favorit "${match.name}" wird abgespielt.` };
    }

    const favs = await entry.device.getFavorites();
    const items = favs?.items ?? favs ?? [];
    const lower = name.toLowerCase();
    const match = items.find((f: any) => (f.title ?? f.name ?? '').toLowerCase().includes(lower));
    if (!match) return { success: false, error: `Favorit "${name}" nicht gefunden. Verfuegbar: ${items.map((f: any) => f.title ?? f.name).join(', ')}` };

    await entry.device.playNotification({ uri: match.uri, onlyWhenPlaying: false });
    return { success: true, display: `Favorit "${match.title ?? match.name}" wird abgespielt.` };
  }

  private async handlePlayRadio(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const name = input.name as string;
    if (!name) return { success: false, error: 'Parameter "name" (Sendername) erforderlich.' };

    if (this.isCloudOnly(entry)) {
      return { success: false, error: 'Radio-Wiedergabe nur ueber lokale Verbindung moeglich.' };
    }

    try {
      await entry.device.playTuneinRadio(name);
      return { success: true, display: `Radio "${name}" wird abgespielt.` };
    } catch (err: any) {
      // UPnP 402 = station not found by TuneIn. Try searching with alternative names.
      if (String(err).includes('402')) {
        // Known stream URLs for popular stations (TuneIn search is unreliable)
        const streamUrls: Record<string, { url: string; displayName: string }> = {
          'ö3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'oe3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'hitradio ö3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'hitradio oe3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'orf hitradio ö3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'orf hitradio oe3': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe3-q1a', displayName: 'Hitradio Ö3' },
          'ö1': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe1-q1a', displayName: 'Ö1' },
          'oe1': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/oe1-q1a', displayName: 'Ö1' },
          'fm4': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/fm4-q1a', displayName: 'FM4' },
          'kronehit': { url: 'x-rincon-mp3radio://onair.krone.at/kronehit.mp3', displayName: 'Kronehit' },
          'radio wien': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/wie-q1a', displayName: 'Radio Wien' },
          'radio nö': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/noe-q1a', displayName: 'Radio NÖ' },
          'radio niederösterreich': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/noe-q1a', displayName: 'Radio NÖ' },
          'radio burgenland': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/bgl-q1a', displayName: 'Radio Burgenland' },
          'radio steiermark': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/stm-q1a', displayName: 'Radio Steiermark' },
          'radio kärnten': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/ktn-q1a', displayName: 'Radio Kärnten' },
          'radio oberösterreich': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/ooe-q1a', displayName: 'Radio OÖ' },
          'radio salzburg': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/sbg-q1a', displayName: 'Radio Salzburg' },
          'radio tirol': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/tir-q1a', displayName: 'Radio Tirol' },
          'radio vorarlberg': { url: 'x-rincon-mp3radio://orf-live.ors-shoutcast.at/vbg-q1a', displayName: 'Radio Vorarlberg' },
          'lounge fm': { url: 'x-rincon-mp3radio://stream.lounge.fm/live', displayName: 'Lounge FM' },
          'klassik radio': { url: 'x-rincon-mp3radio://stream.klassikradio.de/live/mp3-192', displayName: 'Klassik Radio' },
        };

        const normalized = name.toLowerCase().replace(/^(spiele?|play)\s+/i, '').trim();
        const stream = streamUrls[normalized] ?? streamUrls[name.toLowerCase()];

        if (stream) {
          try {
            await entry.device.setAVTransportURI(stream.url);
            await entry.device.play();
            return { success: true, display: `${stream.displayName} wird abgespielt.` };
          } catch (streamErr: any) {
            return { success: false, error: `Stream-Wiedergabe fehlgeschlagen: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}` };
          }
        }

        // Fallback: try alternative TuneIn names
        const tuneinAlts: Record<string, string[]> = {
          'ö3': ['Hitradio OE3', 'OE3'],
          'ö1': ['OE1'],
          'fm4': ['FM4', 'ORF FM4'],
        };
        const alts = tuneinAlts[normalized] ?? [];
        for (const alt of alts) {
          try {
            await entry.device.playTuneinRadio(alt);
            return { success: true, display: `Radio "${alt}" wird abgespielt.` };
          } catch { /* try next */ }
        }

        return { success: false, error: `Sender "${name}" nicht gefunden. Bekannte Sender: Ö3, Ö1, FM4, Kronehit, Radio Wien, Radio NÖ, Lounge FM, Klassik Radio.` };
      }
      throw err;
    }
  }

  private async handlePlayUri(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const uri = input.uri as string;
    if (!uri) return { success: false, error: 'Parameter "uri" erforderlich.' };

    if (this.isCloudOnly(entry)) {
      return { success: false, error: 'URI-Wiedergabe nur ueber lokale Verbindung moeglich.' };
    }

    await entry.device.setAVTransportURI(uri);
    return { success: true, display: `URI wird abgespielt.` };
  }

  private async handleNowPlaying(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);

    if (this.isCloudOnly(entry)) {
      const meta = await this.cloudGet(`/groups/${this.getCloudGroupId(entry)}/playback/metadata`);
      return { success: true, data: meta };
    }

    const track = await entry.device.currentTrack();
    const state = await entry.device.getCurrentState();
    return {
      success: true,
      data: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        position: track.position,
        albumArtUri: track.albumArtURI,
        state,
      },
    };
  }

  // -- Volume --

  private async handleVolume(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const level = input.level as number | undefined;
    if (level === undefined) {
      // Get volume
      if (this.isCloudOnly(entry)) {
        const vol = await this.cloudGet(`/players/${this.getCloudPlayerId(entry)}/playerVolume`);
        return { success: true, data: vol };
      }
      const vol = await entry.device.getVolume();
      return { success: true, data: { volume: vol } };
    }

    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/players/${this.getCloudPlayerId(entry)}/playerVolume`, { volume: clamped });
    } else {
      await entry.device.setVolume(clamped);
    }
    return { success: true, display: `Lautstaerke auf ${clamped} gesetzt.` };
  }

  private async handleVolumeGroup(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const level = input.level as number | undefined;
    if (level === undefined) return { success: false, error: 'Parameter "level" (0-100) erforderlich.' };

    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/groups/${this.getCloudGroupId(entry)}/groupVolume`, { volume: clamped });
    } else {
      await entry.device.setGroupVolume(clamped);
    }
    return { success: true, display: `Gruppen-Lautstaerke auf ${clamped} gesetzt.` };
  }

  private async handleMute(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const enabled = input.enabled as boolean ?? true;

    if (this.isCloudOnly(entry)) {
      await this.cloudPost(`/players/${this.getCloudPlayerId(entry)}/playerVolume/mute`, { muted: enabled });
    } else {
      await entry.device.setMuted(enabled);
    }
    return { success: true, display: enabled ? `Stummgeschaltet.` : `Stummschaltung aufgehoben.` };
  }

  // -- Grouping --

  private async handleGroup(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const targetName = input.target as string;
    if (!targetName) return { success: false, error: 'Parameter "target" (Ziel-Coordinator) erforderlich.' };
    const target = this.resolveDevice(targetName);

    if (this.isCloudOnly(entry) || this.isCloudOnly(target)) {
      return { success: false, error: 'Gruppierung nur ueber lokale Verbindung moeglich.' };
    }

    await entry.device.joinGroup(target.description.roomName);
    // Invalidate cache
    this.lastDiscovery = 0;
    return { success: true, display: `"${entry.description.roomName}" zur Gruppe von "${target.description.roomName}" hinzugefuegt.` };
  }

  private async handleUngroup(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) {
      return { success: false, error: 'Gruppierung nur ueber lokale Verbindung moeglich.' };
    }
    await entry.device.leaveGroup();
    this.lastDiscovery = 0;
    return { success: true, display: `"${entry.description.roomName}" aus Gruppe entfernt.` };
  }

  private async handleGroupAll(): Promise<SkillResult> {
    const entries = [...this.devices.values()].filter(e => !this.isCloudOnly(e));
    if (entries.length < 2) return { success: false, error: 'Mindestens 2 lokale Speaker noetig.' };

    const coordinator = entries[0];
    for (let i = 1; i < entries.length; i++) {
      await entries[i].device.joinGroup(coordinator.description.roomName);
    }
    this.lastDiscovery = 0;
    return { success: true, display: `Alle Speaker unter "${coordinator.description.roomName}" gruppiert.` };
  }

  private async handleUngroupAll(): Promise<SkillResult> {
    const entries = [...this.devices.values()].filter(e => !this.isCloudOnly(e));
    for (const entry of entries) {
      try { await entry.device.leaveGroup(); } catch { /* already ungrouped */ }
    }
    this.lastDiscovery = 0;
    return { success: true, display: `Alle Gruppen aufgeloest.` };
  }

  private async handleGroups(): Promise<SkillResult> {
    // Re-discover to get fresh groups
    const sonos = await this.loadSonos();
    try {
      const listener = new sonos.AsyncDeviceDiscovery();
      const found = await listener.discover({ timeout: 5000 });
      const groups = await found.getAllGroups();

      const result = groups.map((g: any) => ({
        coordinator: g.host,
        name: g.Name,
        members: (g.ZoneGroupMember ?? []).map((m: any) => m.ZoneName ?? m.roomName),
      }));
      return { success: true, data: { groups: result } };
    } catch {
      // Fallback: list known devices
      return { success: true, data: { speakers: [...this.devices.keys()] } };
    }
  }

  // -- Advanced --

  private async handleNightMode(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Nachtmodus nur ueber lokale Verbindung.' };
    const enabled = input.enabled as boolean ?? true;
    await entry.device.renderingControlService().SetEQ({ InstanceID: 0, EQType: 'NightMode', DesiredValue: enabled ? 1 : 0 });
    return { success: true, display: `Nachtmodus ${enabled ? 'aktiviert' : 'deaktiviert'}.` };
  }

  private async handleSpeechEnhance(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Speech Enhancement nur ueber lokale Verbindung.' };
    const enabled = input.enabled as boolean ?? true;
    await entry.device.renderingControlService().SetEQ({ InstanceID: 0, EQType: 'DialogLevel', DesiredValue: enabled ? 1 : 0 });
    return { success: true, display: `Sprachverstaerkung ${enabled ? 'aktiviert' : 'deaktiviert'}.` };
  }

  private async handleSleepTimer(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Sleep-Timer nur ueber lokale Verbindung.' };
    const minutes = input.minutes as number ?? 0;
    if (minutes === 0) {
      await entry.device.avTransportService().ConfigureSleepTimer({ InstanceID: 0, NewSleepTimerDuration: '' });
      return { success: true, display: `Sleep-Timer ausgeschaltet.` };
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const duration = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
    await entry.device.avTransportService().ConfigureSleepTimer({ InstanceID: 0, NewSleepTimerDuration: duration });
    return { success: true, display: `Sleep-Timer auf ${minutes} Minuten gesetzt.` };
  }

  private async handleLineIn(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Line-In nur ueber lokale Verbindung.' };
    const host = new URL(entry.description.UDN ? `http://${entry.device.host}` : `http://${entry.device.host}`).hostname ?? entry.device.host;
    const lineInUri = `x-rincon-stream:RINCON_${entry.description.serialNum?.replace(/[:-]/g, '')}01400`;
    await entry.device.setAVTransportURI(lineInUri);
    return { success: true, display: `Line-In Eingang aktiviert.` };
  }

  private async handleTvInput(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'TV-Audio nur ueber lokale Verbindung.' };
    const tvUri = `x-sonos-htastream:RINCON_${entry.description.serialNum?.replace(/[:-]/g, '')}01400:spdif`;
    await entry.device.setAVTransportURI(tvUri);
    return { success: true, display: `TV-Audio (HDMI ARC) aktiviert.` };
  }

  private async handleCrossfade(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Crossfade nur ueber lokale Verbindung.' };
    const enabled = input.enabled as boolean ?? true;
    await entry.device.avTransportService().SetCrossfadeMode({ InstanceID: 0, CrossfadeMode: enabled });
    return { success: true, display: `Crossfade ${enabled ? 'aktiviert' : 'deaktiviert'}.` };
  }

  // -- Stereo --

  private async handleStereoPair(input: Record<string, unknown>): Promise<SkillResult> {
    const leftName = input.left as string;
    const rightName = input.right as string;
    if (!leftName || !rightName) return { success: false, error: 'Parameter "left" und "right" (Raumnamen) erforderlich.' };

    const left = this.resolveDevice(leftName);
    const right = this.resolveDevice(rightName);
    if (this.isCloudOnly(left) || this.isCloudOnly(right)) {
      return { success: false, error: 'Stereopaare nur ueber lokale Verbindung.' };
    }

    // Use DeviceProperties service to create stereo pair
    const leftUuid = left.description.UDN?.replace('uuid:', '') ?? left.description.serialNum;
    const rightUuid = right.description.UDN?.replace('uuid:', '') ?? right.description.serialNum;
    await left.device.devicePropertiesService().CreateStereoPair({
      ChannelMapSet: `${leftUuid}:LF,LF;${rightUuid}:RF,RF`,
    });

    this.lastDiscovery = 0;
    return { success: true, display: `Stereopaar erstellt: "${leftName}" (links) + "${rightName}" (rechts).` };
  }

  private async handleStereoSeparate(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Stereopaare nur ueber lokale Verbindung.' };

    const uuid = entry.description.UDN?.replace('uuid:', '') ?? entry.description.serialNum;
    await entry.device.devicePropertiesService().SeparateStereoPair({
      ChannelMapSet: `${uuid}:LF,LF`,
    });

    this.lastDiscovery = 0;
    return { success: true, display: `Stereopaar getrennt.` };
  }

  // -- Favorites & Queue --

  private async handleFavorites(input: Record<string, unknown>): Promise<SkillResult> {
    if (this.isCloudOnlySetup()) {
      const hhId = this.cloudHouseholds?.[0]?.id;
      if (!hhId) return { success: false, error: 'Kein Sonos-Haushalt gefunden.' };
      const favs = await this.cloudGet(`/households/${hhId}/favorites`);
      return { success: true, data: favs };
    }

    // Use first local device
    const entry = this.getFirstLocalDevice();
    if (!entry) return { success: false, error: 'Kein lokaler Speaker verfuegbar.' };
    const favs = await entry.device.getFavorites();
    // node-sonos returns different structures depending on version:
    // { items: [...] } or { Result: [...] } or a raw XML-parsed object
    let favList: any[] = [];
    if (Array.isArray(favs)) favList = favs;
    else if (Array.isArray(favs?.items)) favList = favs.items;
    else if (Array.isArray(favs?.Result)) favList = favs.Result;
    else if (favs && typeof favs === 'object') {
      // Try to extract from ContentDirectory browse result
      const values = Object.values(favs);
      const arrVal = values.find(v => Array.isArray(v));
      if (arrVal) favList = arrVal as any[];
    }

    const items = favList.map((f: any) => ({
      name: f.title ?? f.Title ?? f.name ?? f['dc:title'] ?? 'Unbekannt',
      uri: f.uri ?? f.URI ?? f.res ?? '',
      albumArtUri: f.albumArtURI ?? f.AlbumArtURI ?? f['upnp:albumArtURI'] ?? undefined,
    }));
    return { success: true, data: { favorites: items } };
  }

  private async handleQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Queue nur ueber lokale Verbindung.' };
    const queue = await entry.device.getQueue();
    const items = (queue?.items ?? queue ?? []).map((t: any) => ({
      title: t.title,
      artist: t.artist,
      album: t.album,
      uri: t.uri,
    }));
    return { success: true, data: { queue: items, count: items.length } };
  }

  private async handleClearQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    if (this.isCloudOnly(entry)) return { success: false, error: 'Queue nur ueber lokale Verbindung.' };
    await entry.device.flush();
    return { success: true, display: `Queue geleert.` };
  }

  private async handleAddToQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const entry = this.requireSpeaker(input);
    const uri = input.uri as string;
    if (!uri) return { success: false, error: 'Parameter "uri" erforderlich.' };
    if (this.isCloudOnly(entry)) return { success: false, error: 'Queue nur ueber lokale Verbindung.' };
    await entry.device.queue(uri);
    return { success: true, display: `Zur Queue hinzugefuegt.` };
  }

  // ── Cloud OAuth ──────────────────────────────────────────────

  private async authorizeCloud(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const clientId = this.config?.cloud?.clientId;
    if (!clientId) {
      return { success: false, error: 'Sonos Cloud Client-ID nicht konfiguriert. Admin muss ALFRED_SONOS_CLOUD_CLIENT_ID setzen.' };
    }

    const nonce = crypto.randomUUID();
    const baseUrl = (input.redirect_uri as string) ?? this.apiPublicUrl ?? 'http://localhost:3420';
    const redirectUri = `${baseUrl.replace(/\/+$/, '')}/api/oauth/callback`;
    const state = Buffer.from(JSON.stringify({
      service: 'sonos',
      nonce,
      userId: context.alfredUserId ?? context.userId,
    })).toString('base64url');

    this.pendingAuths.set(nonce, {
      userId: context.alfredUserId ?? context.userId,
      redirectUri,
      expiresAt: Date.now() + 5 * 60_000,
    });

    const authUrl = `${SONOS_AUTH_BASE}?` +
      `client_id=${clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=playback-control-all` +
      `&state=${state}`;

    if (context.onProgress) {
      context.onProgress(
        `**Sonos Cloud verbinden**\n\n` +
        `1. Oeffne: ${authUrl}\n` +
        `2. Melde dich bei Sonos an\n` +
        `3. Erlaube den Zugriff\n\n` +
        `Warte auf Bestaetigung...`,
      );
    }

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      if (this.cloudAccessToken) {
        return { success: true, display: 'Sonos Cloud erfolgreich verbunden!' };
      }
      if (!this.pendingAuths.has(nonce)) {
        if (this.cloudAccessToken) return { success: true, display: 'Sonos Cloud erfolgreich verbunden!' };
        return { success: false, error: 'Autorisierung fehlgeschlagen.' };
      }
    }

    this.pendingAuths.delete(nonce);
    return { success: false, error: 'Timeout — keine Bestaetigung innerhalb von 5 Minuten.' };
  }

  async handleOAuthCallback(code: string, state: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    const nonce = state.nonce as string;
    const pending = this.pendingAuths.get(nonce);
    if (!pending) return { success: false, error: 'Unbekannte oder abgelaufene Autorisierung.' };

    const cloud = this.config?.cloud;
    if (!cloud?.clientId || !cloud?.clientSecret) {
      this.pendingAuths.delete(nonce);
      return { success: false, error: 'Sonos Cloud nicht konfiguriert.' };
    }

    const basic = Buffer.from(`${cloud.clientId}:${cloud.clientSecret}`).toString('base64');
    const res = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
      }).toString(),
    });

    if (!res.ok) {
      this.pendingAuths.delete(nonce);
      return { success: false, error: `Token-Exchange fehlgeschlagen: ${res.status}` };
    }

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
    this.cloudAccessToken = data.access_token;
    this.cloudTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

    // Persist refresh token
    if (data.refresh_token && this.lastContext?.userServiceResolver) {
      try {
        await this.lastContext.userServiceResolver.saveServiceConfig(
          pending.userId, 'sonos', 'default',
          { clientId: cloud.clientId, clientSecret: cloud.clientSecret, refreshToken: data.refresh_token },
        );
      } catch { /* token still cached in memory */ }
    }

    this.pendingAuths.delete(nonce);
    return { success: true };
  }

  // ── Helpers ──────────────────────────────────────────────────

  private isCloudOnlySetup(): boolean {
    for (const entry of this.devices.values()) {
      if (!this.isCloudOnly(entry)) return false;
    }
    return this.devices.size > 0;
  }

  private getFirstLocalDevice(): DeviceEntry | undefined {
    for (const entry of this.devices.values()) {
      if (!this.isCloudOnly(entry)) return entry;
    }
    return undefined;
  }
}
