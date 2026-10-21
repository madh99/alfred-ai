/**
 * v1540 (Owner 21.10. „live bei rot mitmachen“) — Live-Aktivität auf Sperrbildschirm und Dynamic Island, solange die Lage rot ist.
 *
 * Ablauf: Die App meldet ihren „Push-to-Start“-Token (iOS 17.2+) und je laufender Aktivität deren Update-Token. Wird die Lage
 * rot, startet der Server die Aktivität per APNs auf jedem gemeldeten iPhone; ändert sich der Zustand, aktualisiert er sie; ist
 * die Lage fünf Minuten lang nicht mehr rot, beendet er sie (Entwarnung bleibt 15 Minuten sichtbar). Über Apple gehen nur Ampel,
 * Zähler und Uhrzeit — keine Namen und Werte (Spec Geräte §20.5 Punkt 4); Details zeigt die App selbst.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApnsUmgebung } from './push-apns.js';
import type { LageKurz } from '../lebenszeichen/lage-kurz.js';

/** content-state der Aktivität — Felder und Typen genau wie `LageAktivitaet.Zustand` in ios/Lage (Swift Codable). */
export interface LiveZustand { ampel: 'ok' | 'warn' | 'bad'; titel: string; zeile: string; anzahl: number; stand: string }

export interface LiveSender {
  sendeLive(token: string, umgebung: ApnsUmgebung, koerper: string, prioritaet: 5 | 10): Promise<{ ok: boolean; status: number; grund?: string; tokenUngueltig: boolean }>;
}

interface GeraetLive { umgebung: ApnsUmgebung; startToken?: string; aktivitaeten: Record<string, string> }
interface LiveStand { geraete: Record<string, GeraetLive>; aktiv: { seit: string; zustand: LiveZustand } | null; gutSeit: string | null }

export const ENDE_NACH_MS = 5 * 60_000;
export const ENTWARNUNG_SICHTBAR_S = 15 * 60;
export const VERALTET_NACH_S = 3 * 3600;

export function liveZustand(k: LageKurz, jetzt: Date, zeitzone = 'Europe/Vienna'): LiveZustand {
  const stand = jetzt.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: zeitzone });
  return k.ampel === 'bad'
    ? { ampel: 'bad', titel: 'Störung', zeile: k.text, anzahl: k.modelleGestoert + k.waechter, stand }
    : { ampel: k.ampel, titel: 'Entwarnung', zeile: 'Wieder in Ordnung', anzahl: 0, stand };
}

/** APNs-Körper für eine Live-Aktivität (start | update | end). */
export function liveKoerper(event: 'start' | 'update' | 'end', z: LiveZustand, jetztSek: number): string {
  const aps: Record<string, unknown> = { timestamp: jetztSek, event, 'content-state': z };
  if (event === 'start') {
    aps['attributes-type'] = 'LageAttribute';
    aps.attributes = { name: 'Alfred' };
    aps.alert = { title: `Alfred: ${z.titel}`, body: z.zeile };
    aps['stale-date'] = jetztSek + VERALTET_NACH_S;
  } else if (event === 'update') {
    aps['stale-date'] = jetztSek + VERALTET_NACH_S;
  } else {
    aps['dismissal-date'] = jetztSek + ENTWARNUNG_SICHTBAR_S;
  }
  return JSON.stringify({ aps });
}

export class LiveAktivitaet {
  private stand: LiveStand;

  constructor(private readonly deps: { datei: string; apns?: LiveSender; logger: { info(o: object, m: string): void; warn(o: object, m: string): void }; jetzt?: () => Date }) {
    this.stand = this.lade();
  }

  private jetzt(): Date { return this.deps.jetzt?.() ?? new Date(); }

  private lade(): LiveStand {
    try {
      const j = JSON.parse(fs.readFileSync(this.deps.datei, 'utf8')) as Partial<LiveStand>;
      return { geraete: j.geraete ?? {}, aktiv: j.aktiv ?? null, gutSeit: j.gutSeit ?? null };
    } catch { return { geraete: {}, aktiv: null, gutSeit: null }; }
  }

  private sichere(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.datei), { recursive: true });
      fs.writeFileSync(this.deps.datei, JSON.stringify(this.stand, null, 2), { mode: 0o600 });
    } catch (err) { this.deps.logger.warn({ err: (err as Error).message }, 'v1540 Live-Aktivität: Stand nicht gesichert'); }
  }

  get aktiv(): boolean { return !!this.stand.aktiv; }

  /** Meldung der App (Route /api/geraete/live): start = Push-to-Start-Token, aktivitaet = Update-Token einer Aktivität, ende = Aktivität beendet. */
  merke(geraetId: string, body: Record<string, unknown>): { ok: true } | { ok: false; grund: string } {
    const art = body.art, token = body.token, id = body.id, umgebung = body.umgebung;
    if (umgebung !== 'sandbox' && umgebung !== 'production') return { ok: false, grund: 'Umgebung sandbox oder production' };
    const g = this.stand.geraete[geraetId] ?? { umgebung, aktivitaeten: {} };
    g.umgebung = umgebung;
    const gueltig = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-fA-F]{32,400}$/.test(t);
    const gueltigeId = (t: unknown): t is string => typeof t === 'string' && /^[\w.-]{1,100}$/.test(t);
    if (art === 'start') { if (!gueltig(token)) return { ok: false, grund: 'Token fehlt' }; g.startToken = token.toLowerCase(); }
    else if (art === 'aktivitaet') { if (!gueltig(token) || !gueltigeId(id)) return { ok: false, grund: 'Token oder id fehlt' }; g.aktivitaeten[id] = token.toLowerCase(); }
    else if (art === 'ende') { if (!gueltigeId(id)) return { ok: false, grund: 'id fehlt' }; delete g.aktivitaeten[id]; }
    else return { ok: false, grund: 'art: start | aktivitaet | ende' };
    this.stand.geraete[geraetId] = g;
    this.sichere();
    this.deps.logger.info({ geraetId, art, aktivitaeten: Object.keys(g.aktivitaeten).length }, 'v1540 Live-Aktivität: Token gemerkt');
    return { ok: true };
  }

  /** Nach jeder Lage-Aktualisierung und im 10-Minuten-Takt: starten, aktualisieren oder beenden. */
  async pruefe(k: LageKurz): Promise<'gestartet' | 'aktualisiert' | 'beendet' | 'unveraendert'> {
    const apns = this.deps.apns;
    if (!apns) return 'unveraendert';
    const jetzt = this.jetzt();
    const sek = Math.floor(jetzt.getTime() / 1000);
    const z = liveZustand(k, jetzt);
    if (k.ampel === 'bad') {
      this.stand.gutSeit = null;
      if (!this.stand.aktiv) {
        let n = 0;
        for (const [id, g] of Object.entries(this.stand.geraete)) {
          if (!g.startToken) continue;
          const r = await apns.sendeLive(g.startToken, g.umgebung, liveKoerper('start', z, sek), 10);
          if (r.ok) n++;
          this.deps.logger.info({ geraetId: id, status: r.status, grund: r.grund }, r.ok ? 'v1540 Live-Aktivität gestartet' : 'v1540 Live-Aktivität: Start fehlgeschlagen');
          if (r.tokenUngueltig) delete g.startToken;
        }
        this.stand.aktiv = { seit: jetzt.toISOString(), zustand: z };
        this.sichere();
        return n > 0 ? 'gestartet' : 'unveraendert';
      }
      if (this.stand.aktiv.zustand.zeile === z.zeile && this.stand.aktiv.zustand.anzahl === z.anzahl) return 'unveraendert';
      await this.anAlle('update', z, sek, 5);
      this.stand.aktiv.zustand = z;
      this.sichere();
      return 'aktualisiert';
    }
    if (!this.stand.aktiv) return 'unveraendert';
    // nicht mehr rot: erst nach fünf ruhigen Minuten beenden (kein Flackern bei kurzen Aussetzern)
    if (!this.stand.gutSeit) { this.stand.gutSeit = jetzt.toISOString(); this.sichere(); return 'unveraendert'; }
    if (jetzt.getTime() - Date.parse(this.stand.gutSeit) < ENDE_NACH_MS) return 'unveraendert';
    await this.anAlle('end', z, sek, 10);
    for (const g of Object.values(this.stand.geraete)) g.aktivitaeten = {};
    this.stand.aktiv = null; this.stand.gutSeit = null;
    this.sichere();
    this.deps.logger.info({}, 'v1540 Live-Aktivität beendet (Entwarnung)');
    return 'beendet';
  }

  private async anAlle(event: 'update' | 'end', z: LiveZustand, sek: number, prioritaet: 5 | 10): Promise<void> {
    for (const [geraetId, g] of Object.entries(this.stand.geraete)) {
      for (const [id, token] of Object.entries(g.aktivitaeten)) {
        const r = await this.deps.apns!.sendeLive(token, g.umgebung, liveKoerper(event, z, sek), prioritaet);
        this.deps.logger.info({ geraetId, aktivitaet: id, event, status: r.status, grund: r.grund }, r.ok ? 'v1540 Live-Aktivität zugestellt' : 'v1540 Live-Aktivität fehlgeschlagen');
        if (r.tokenUngueltig) delete g.aktivitaeten[id];
      }
    }
  }
}
