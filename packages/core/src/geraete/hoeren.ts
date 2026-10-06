import type { Logger } from 'pino';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * v1251 — Echtzeit-Sprache, Schritt 2: das Relais am Server.
 *
 * Die Sitzung verbindet sich mit ihrem Gerätetoken zu `/api/geraete/hoeren` und schickt PCM (16 kHz, mono, 16 Bit)
 * als Binärrahmen plus kleine JSON-Steuerzeichen. Das Relais hält je Sitzung eine Verbindung zu Mistral Realtime
 * (`voxtral-mini-transcribe-realtime-2602`), reicht Audio als `input_audio.append` weiter und die Textstücke zurück.
 * Der Mistral-Schlüssel bleibt am Server; gezählt werden gesendete Audiosekunden (Kostenwächter, Tageslimit).
 *
 * Protokoll Sitzung → Relais: Binär = PCM; Text = {"typ":"start"} (Äußerung beginnt), {"typ":"ende"} (Äußerung fertig → Flush),
 * {"typ":"schluss"} (Sitzung zu). Relais → Sitzung: {"typ":"bereit"}, {"typ":"delta","text"}, {"typ":"fertig","text","sekunden"},
 * {"typ":"fehler","grund"}, {"typ":"limit","grund"}.
 * Empirisch 07.10.: eine Mistral-Verbindung trägt mehrere Äußerungen; jeder Flush liefert `transcription.done` mit dem
 * Text seit dem letzten Flush; `input_audio.end` schließt die Verbindung.
 */
export interface HoerRelaisDeps {
  logger: Logger;
  authentifiziere: (token: string) => Promise<{ userId: string; geraetId: string; name: string } | undefined>;
  mistralKey: () => string | undefined;
  modell?: string;
  verzoegerungMs?: number;
  sprache?: string;
  /** Verbuchen gesendeter Audiosekunden (Service-Nutzung). */
  verbuche?: (sekunden: number, modell: string) => void;
  /** Tageslimit in Minuten (Standard 180). */
  maxMinutenProTag?: number;
  /** Testbarkeit: Fabrik für die Anbieter-Verbindung. */
  upstreamFabrik?: (url: string, headers: Record<string, string>) => UpstreamSocket;
  now?: () => number;
}

export interface UpstreamSocket {
  send(data: string): void;
  close(): void;
  on(ev: 'open' | 'message' | 'close' | 'error', fn: (...a: unknown[]) => void): void;
  readonly readyState: number;
}

export const HOEREN_MODELL = 'voxtral-mini-transcribe-realtime-2602';
export const HOEREN_URL = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const BYTES_PRO_SEKUNDE = 32_000;

interface Sitzung {
  geraetId: string;
  name: string;
  ws: WebSocket;
  upstream?: UpstreamSocket;
  upstreamBereit: boolean;
  wartend: string[];
  text: string;
  bytes: number;
  bytesGesamt: number;
  begonnen: number;
}

export class HoerRelais {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sitzungen = new Map<string, Sitzung>();
  private tagesSekunden = 0;
  private tagesDatum = '';

  constructor(private readonly deps: HoerRelaisDeps) {}

  /** HTTP-Upgrade für /api/geraete/hoeren: Ausweis ist das Gerätetoken im Authorization-Header. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    this.deps.authentifiziere(token).then((g) => {
      if (!g) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      if (!this.deps.mistralKey()) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nkein Mistral-Schlüssel\n'); socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.starte(ws, g));
    }).catch(() => { try { socket.destroy(); } catch { /* */ } });
  }

  private starte(ws: WebSocket, g: { geraetId: string; name: string }): void {
    const alt = this.sitzungen.get(g.geraetId);
    if (alt) { this.beende(alt, 'neue Sitzung'); }
    const s: Sitzung = { geraetId: g.geraetId, name: g.name, ws, upstreamBereit: false, wartend: [], text: '', bytes: 0, bytesGesamt: 0, begonnen: this.now() };
    this.sitzungen.set(g.geraetId, s);
    this.deps.logger.info({ geraet: g.name }, 'v1251 Hören: Sitzung verbunden');
    this.sende(s, { typ: 'bereit' });
    ws.on('message', (raw, istBinaer) => {
      if (istBinaer) { this.audio(s, raw as Buffer); return; }
      let n: { typ?: string };
      try { n = JSON.parse(String(raw)); } catch { return; }
      if (n.typ === 'start') this.sichereUpstream(s);
      else if (n.typ === 'ende') this.flush(s);
      else if (n.typ === 'schluss') this.beende(s, 'Sitzung geschlossen');
    });
    ws.on('close', () => this.beende(s, 'Verbindung weg'));
    ws.on('error', () => this.beende(s, 'Fehler'));
  }

  private audio(s: Sitzung, pcm: Buffer): void {
    if (pcm.length === 0) return;
    if (this.limitErreicht()) { this.sende(s, { typ: 'limit', grund: `Tageslimit ${this.deps.maxMinutenProTag ?? 180} min erreicht` }); return; }
    s.bytes += pcm.length; s.bytesGesamt += pcm.length;
    this.sichereUpstream(s);
    const nachricht = JSON.stringify({ type: 'input_audio.append', audio: pcm.toString('base64') });
    if (s.upstreamBereit) s.upstream!.send(nachricht); else s.wartend.push(nachricht);
  }

  private flush(s: Sitzung): void {
    const nachricht = JSON.stringify({ type: 'input_audio.flush' });
    if (s.upstreamBereit) s.upstream!.send(nachricht); else s.wartend.push(nachricht);
  }

  private sichereUpstream(s: Sitzung): void {
    if (s.upstream && s.upstream.readyState <= 1) return; // verbindet oder offen
    const key = this.deps.mistralKey();
    if (!key) { this.sende(s, { typ: 'fehler', grund: 'kein Mistral-Schlüssel' }); return; }
    const modell = this.deps.modell ?? HOEREN_MODELL;
    const url = `${HOEREN_URL}?model=${encodeURIComponent(modell)}`;
    const fabrik = this.deps.upstreamFabrik ?? ((u, h) => new WebSocket(u, { headers: h }) as unknown as UpstreamSocket);
    const up = fabrik(url, { Authorization: `Bearer ${key}` });
    s.upstream = up; s.upstreamBereit = false; s.text = '';
    up.on('open', () => {
      up.send(JSON.stringify({ type: 'session.update', session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 }, target_streaming_delay_ms: this.deps.verzoegerungMs ?? 480, ...(this.deps.sprache ? { language: this.deps.sprache } : {}) } }));
      s.upstreamBereit = true;
      for (const w of s.wartend.splice(0)) up.send(w);
    });
    up.on('message', (raw) => {
      let j: { type?: string; text?: string; usage?: { prompt_audio_seconds?: number }; error?: unknown };
      try { j = JSON.parse(String(raw)); } catch { return; }
      if (j.type === 'transcription.text.delta') { s.text += j.text ?? ''; this.sende(s, { typ: 'delta', text: j.text ?? '' }); }
      else if (j.type === 'transcription.done') {
        const sekunden = Math.round(s.bytes / BYTES_PRO_SEKUNDE * 10) / 10;
        this.verbuche(sekunden, modell);
        this.sende(s, { typ: 'fertig', text: (j.text ?? s.text).trim(), sekunden });
        this.deps.logger.info({ geraet: s.name, sekunden, zeichen: (j.text ?? s.text).length, anbieterSekunden: j.usage?.prompt_audio_seconds }, 'v1251 Hören: Äußerung transkribiert');
        s.text = ''; s.bytes = 0;
      }
      else if (j.type === 'error') { this.sende(s, { typ: 'fehler', grund: JSON.stringify(j.error ?? j).slice(0, 200) }); }
    });
    up.on('close', () => { if (s.upstream === up) { s.upstream = undefined; s.upstreamBereit = false; } });
    up.on('error', (err) => { this.sende(s, { typ: 'fehler', grund: `Anbieter: ${(err as Error)?.message ?? 'Verbindung'}` }); });
  }

  private beende(s: Sitzung, grund: string): void {
    if (this.sitzungen.get(s.geraetId) !== s) return; // v1253 — schon beendet (schluss + close)
    this.sitzungen.delete(s.geraetId);
    try { s.upstream?.send(JSON.stringify({ type: 'input_audio.end' })); } catch { /* */ }
    try { s.upstream?.close(); } catch { /* */ }
    try { s.ws.close(); } catch { /* */ }
    this.deps.logger.info({ geraet: s.name, grund, sekundenGesamt: Math.round(s.bytesGesamt / BYTES_PRO_SEKUNDE), dauerMin: Math.round((this.now() - s.begonnen) / 60_000) }, 'v1251 Hören: Sitzung beendet');
  }

  private sende(s: Sitzung, n: Record<string, unknown>): void {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(n));
  }

  private verbuche(sekunden: number, modell: string): void {
    const heute = new Date(this.now()).toISOString().slice(0, 10);
    if (heute !== this.tagesDatum) { this.tagesDatum = heute; this.tagesSekunden = 0; }
    this.tagesSekunden += sekunden;
    try { this.deps.verbuche?.(sekunden, modell); } catch { /* optional */ }
  }

  private limitErreicht(): boolean {
    const heute = new Date(this.now()).toISOString().slice(0, 10);
    if (heute !== this.tagesDatum) return false;
    return this.tagesSekunden >= (this.deps.maxMinutenProTag ?? 180) * 60;
  }

  aktive(): Array<{ geraet: string; seitMin: number; sekunden: number }> {
    return [...this.sitzungen.values()].map(s => ({ geraet: s.name, seitMin: Math.round((this.now() - s.begonnen) / 60_000), sekunden: Math.round(s.bytesGesamt / BYTES_PRO_SEKUNDE) }));
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
}
