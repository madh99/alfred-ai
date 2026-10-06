import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { GeraetKonfig } from './pair.js';

/**
 * v1251 — Client des Hör-Relais (Sitzung → Server → Mistral Realtime).
 * Binärrahmen = PCM 16 kHz mono 16 Bit; JSON {typ:'start'|'ende'|'schluss'}; vom Relais {typ:'bereit'|'delta'|'fertig'|'fehler'|'limit'}.
 */
export interface HoerEreignis { typ: 'bereit' | 'delta' | 'fertig' | 'fehler' | 'limit'; text?: string; sekunden?: number; grund?: string }

export class HoerClient {
  private ws?: WebSocket;
  private offen = false;
  constructor(private readonly k: GeraetKonfig, private readonly aufEreignis: (e: HoerEreignis) => void, private readonly aufEnde: (grund: string) => void) {}

  verbinde(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.k.server.replace(/^http/i, 'ws') + '/api/geraete/hoeren';
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.k.token}` }, rejectUnauthorized: !this.k.insecure });
      this.ws = ws;
      let bereit = false;
      ws.on('open', () => { this.offen = true; });
      ws.on('message', (raw) => {
        let e: HoerEreignis; try { e = JSON.parse(String(raw)) as HoerEreignis; } catch { return; }
        if (e.typ === 'bereit' && !bereit) { bereit = true; resolve(); }
        this.aufEreignis(e);
      });
      ws.on('close', (code, reason) => { this.offen = false; if (!bereit) reject(new Error(`Relais abgelehnt (${code} ${String(reason)})`)); else this.aufEnde(`geschlossen (${code})`); });
      ws.on('error', (err) => { if (!bereit) reject(err); else this.aufEnde(err.message); });
      ws.on('unexpected-response', (_req, res) => { reject(new Error(`HTTP ${res.statusCode}`)); });
    });
  }

  start(): void { this.sendeJson({ typ: 'start' }); }
  audio(pcm: Buffer): void { if (this.offen && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm, { binary: true }); }
  ende(): void { this.sendeJson({ typ: 'ende' }); }
  schluss(): void { this.sendeJson({ typ: 'schluss' }); try { this.ws?.close(); } catch { /* */ } }
  private sendeJson(n: Record<string, unknown>): void { if (this.offen && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(n)); }
}

/** WAV (16 Bit mono, beliebige Rate) → PCM 16 kHz, lineare Interpolation. */
export function wavZuPcm16k(wav: Buffer): Buffer {
  if (wav.toString('latin1', 0, 4) !== 'RIFF') throw new Error('keine WAV-Datei');
  const rate = wav.readUInt32LE(24); const kanaele = wav.readUInt16LE(22);
  let daten = wav.subarray(44);
  if (kanaele === 2) { const m = Buffer.alloc(daten.length / 2); for (let i = 0; i + 3 < daten.length; i += 4) m.writeInt16LE(Math.round((daten.readInt16LE(i) + daten.readInt16LE(i + 2)) / 2), i / 2); daten = m; }
  if (rate === 16000) return daten;
  const n = daten.length / 2; const m = Math.floor(n * 16000 / rate); const out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) { const pos = i * rate / 16000; const a = Math.floor(pos); const b = Math.min(a + 1, n - 1); const f = pos - a; out.writeInt16LE(Math.round(daten.readInt16LE(a * 2) * (1 - f) + daten.readInt16LE(b * 2) * f), i * 2); }
  return out;
}

/** v1251 — `alfred sitzung --hoertest <wav>`: eine WAV-Datei durch das Relais schicken, Textstücke und Endtext zeigen. */
export async function hoerTest(k: GeraetKonfig, wavPfad: string): Promise<void> {
  const pcm = wavZuPcm16k(readFileSync(wavPfad));
  const t0 = Date.now(); let ersterDelta = 0; let fertig = false;
  const client = new HoerClient(k, (e) => {
    const t = ((Date.now() - t0) / 1000).toFixed(2);
    if (e.typ === 'delta') { if (!ersterDelta) ersterDelta = Date.now(); process.stdout.write(e.text ?? ''); }
    else if (e.typ === 'fertig') { fertig = true; process.stdout.write(`\n[${t} s] ■ fertig: „${e.text}" (${e.sekunden} s Audio, erstes Wort nach ${((ersterDelta - t0) / 1000).toFixed(2)} s)\n`); }
    else if (e.typ === 'bereit') process.stdout.write(`[${t} s] Relais bereit\n`);
    else process.stdout.write(`\n[${t} s] ${e.typ}: ${e.grund ?? ''}\n`);
  }, (grund) => process.stdout.write(`\nRelais: ${grund}\n`));
  await client.verbinde();
  client.start();
  const block = 2560; // 80 ms
  for (let off = 0; off < pcm.length; off += block) { client.audio(pcm.subarray(off, off + block)); await new Promise(r => setTimeout(r, 80)); }
  client.ende();
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(2)} s] Audio zu Ende gesendet (${(pcm.length / 32000).toFixed(1)} s)\n`);
  for (let i = 0; i < 100 && !fertig; i++) await new Promise(r => setTimeout(r, 100));
  client.schluss();
}
