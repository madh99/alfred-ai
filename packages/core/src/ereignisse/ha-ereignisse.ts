import type { Logger } from 'pino';
import { entscheideStreamWatchdog } from '@alfred/skills';
import { klassifiziereHausEreignis, type HaZustand, type HausEreignisTyp } from '../normalzustaende/haus.js';

/**
 * Jarvis Schicht 2, Teil 2 — Echtzeit-Quelle Home Assistant (WebSocket).
 *
 * Abonniert `state_changed`, filtert deterministisch auf Haus-Ereignisse
 * (Rauch/CO/Wasser/Alarm immer; Anwesenheit; Öffnungen und Bewegung — deren
 * Bedeutung entscheidet die Deutung je nach Anwesenheit) und reicht sie an den
 * Mini-Pass. Verbindung mit Backoff; der Wächter-Job prüft alle 10 min
 * (gleiche Entscheidungslogik wie beim BMW-Stream). Node ≥ 22: globales WebSocket.
 */

export interface HaEreignis { typ: HausEreignisTyp; entity: HaZustand; vorher?: HaZustand; cooldownMin: number }

export interface HaEreignisQuelleDeps {
  baseUrl: string;
  accessToken: string;
  logger: Logger;
  onEreignis: (e: HaEreignis) => Promise<void>;
  /** Für Tests: WebSocket-Fabrik */
  wsFabrik?: (url: string) => WebSocketArtig;
}

export interface WebSocketArtig {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export function wsUrlAus(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/api/websocket';
}

/** Rein: eine WebSocket-Nachricht von HA auswerten. */
export function verarbeiteNachricht(roh: string, letzte: Map<string, HaZustand>): { art: 'auth_required' | 'auth_ok' | 'auth_invalid' | 'ereignis' | 'sonst'; ereignis?: HaEreignis } {
  let m: { type?: string; event?: { event_type?: string; data?: { entity_id?: string; old_state?: HaZustand | null; new_state?: HaZustand | null } } };
  try { m = JSON.parse(roh); } catch { return { art: 'sonst' }; }
  if (m.type === 'auth_required' || m.type === 'auth_ok' || m.type === 'auth_invalid') return { art: m.type };
  if (m.type !== 'event' || m.event?.event_type !== 'state_changed') return { art: 'sonst' };
  const neu = m.event.data?.new_state ?? undefined;
  const alt = m.event.data?.old_state ?? undefined;
  if (!neu?.entity_id) return { art: 'sonst' };
  const vorher = alt ?? letzte.get(neu.entity_id);
  letzte.set(neu.entity_id, neu);
  const k = klassifiziereHausEreignis(vorher, neu);
  if (!k) return { art: 'sonst' };
  return { art: 'ereignis', ereignis: { typ: k.typ, entity: neu, vorher, cooldownMin: k.cooldownMin } };
}

export class HaEreignisQuelle {
  private ws?: WebSocketArtig;
  private verbunden = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectFaelligAt?: number;
  private letztesEreignisAt?: number;
  private versuche = 0;
  private readonly letzte = new Map<string, HaZustand>();
  private gestoppt = false;
  /** Entprellen: gleiche Entität + Zustand innerhalb 60 s nur einmal. */
  private readonly zuletztGemeldet = new Map<string, number>();
  ereignisse = 0;

  constructor(private readonly deps: HaEreignisQuelleDeps) {}

  start(): void {
    this.gestoppt = false;
    this.verbinde();
  }

  stop(): void {
    this.gestoppt = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* egal */ }
    this.ws = undefined; this.verbunden = false;
  }

  status(): { verbunden: boolean; reconnectFaelligAt?: string; ereignisse: number; letztesEreignisAt?: string } {
    const iso = (n?: number) => n ? new Date(n).toISOString() : undefined;
    return { verbunden: this.verbunden, reconnectFaelligAt: iso(this.reconnectFaelligAt), ereignisse: this.ereignisse, letztesEreignisAt: iso(this.letztesEreignisAt) };
  }

  /** Wächter (10 min): hängt die Verbindung ohne geplanten Reconnect → neu verbinden. */
  ensureConnected(): 'ok' | 'reconnect-ausstehend' | 'neustart' | 'deaktiviert' {
    const urteil = entscheideStreamWatchdog({ enabled: !this.gestoppt, aktiv: this.verbunden, reconnectFaelligAt: this.reconnectFaelligAt, letztesEreignisAt: this.letztesEreignisAt });
    if (urteil === 'neustart') {
      this.deps.logger.warn({}, 'v1177 HA-Ereignisse: Verbindung hängt — Neustart');
      try { this.ws?.close(); } catch { /* egal */ }
      this.ws = undefined; this.verbunden = false; this.versuche = 0;
      this.verbinde();
    }
    return urteil;
  }

  private verbinde(): void {
    if (this.gestoppt) return;
    this.reconnectFaelligAt = undefined;
    const url = wsUrlAus(this.deps.baseUrl);
    try {
      const ws = this.deps.wsFabrik ? this.deps.wsFabrik(url) : (new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketArtig }).WebSocket(url));
      this.ws = ws;
      ws.onopen = () => { this.letztesEreignisAt = Date.now(); this.deps.logger.debug({ url }, 'v1177 HA-Ereignisse: Socket offen, warte auf auth_required'); };
      ws.onmessage = (ev) => { void this.nachricht(String(ev.data)); };
      ws.onerror = (ev) => { this.letztesEreignisAt = Date.now(); this.deps.logger.warn({ err: String((ev as { message?: string })?.message ?? 'websocket error') }, 'v1177 HA-Ereignisse: Fehler'); };
      ws.onclose = () => {
        this.letztesEreignisAt = Date.now();
        const war = this.verbunden; this.verbunden = false; this.ws = undefined;
        if (this.gestoppt) return;
        this.versuche++;
        const delay = Math.min(30_000 * Math.pow(2, Math.min(this.versuche - 1, 5)), 10 * 60_000);
        this.reconnectFaelligAt = Date.now() + delay;
        this.deps.logger[war ? 'warn' : 'info']({ inSek: Math.round(delay / 1000), versuch: this.versuche }, 'v1177 HA-Ereignisse: Verbindung geschlossen, Reconnect geplant');
        this.reconnectTimer = setTimeout(() => this.verbinde(), delay);
        (this.reconnectTimer as { unref?: () => void }).unref?.();
      };
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'v1177 HA-Ereignisse: Verbindungsaufbau fehlgeschlagen');
      this.versuche++;
      const delay = Math.min(30_000 * Math.pow(2, Math.min(this.versuche - 1, 5)), 10 * 60_000);
      this.reconnectFaelligAt = Date.now() + delay;
      this.reconnectTimer = setTimeout(() => this.verbinde(), delay);
    }
  }

  private async nachricht(roh: string): Promise<void> {
    this.letztesEreignisAt = Date.now();
    const r = verarbeiteNachricht(roh, this.letzte);
    if (r.art === 'auth_required') { this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.deps.accessToken })); return; }
    if (r.art === 'auth_ok') {
      this.verbunden = true; this.versuche = 0;
      this.ws?.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
      this.deps.logger.info({}, 'v1177 HA-Ereignisse: verbunden, state_changed abonniert');
      return;
    }
    if (r.art === 'auth_invalid') { this.deps.logger.warn({}, 'v1177 HA-Ereignisse: Token abgelehnt'); this.ws?.close(); return; }
    if (r.art !== 'ereignis' || !r.ereignis) return;
    const key = `${r.ereignis.entity.entity_id}:${r.ereignis.entity.state}`;
    const z = this.zuletztGemeldet.get(key) ?? 0;
    if (Date.now() - z < 60_000) return;
    this.zuletztGemeldet.set(key, Date.now());
    this.ereignisse++;
    try { await this.deps.onEreignis(r.ereignis); }
    catch (err) { this.deps.logger.warn({ err: (err as Error).message, entity: r.ereignis.entity.entity_id }, 'v1177 HA-Ereignis nicht verarbeitet'); }
  }
}
