/**
 * v1429 R4a — Beobachter am Satelliten (Spec Jarvis „R4 Beobachter am Satelliten", Owner 13.10.: „komplett", Regeln am Server
 * mit sichtbaren Schaltern, lokales Veto am Gerät). Der Satellit beobachtet nur, was das Gehirn ihm als Regel schickt, nur in
 * freigegebenen Verzeichnissen, und meldet ausschließlich Kopfdaten (Name, Größe, relativer Pfad) — nie Inhalte.
 * Gebündelt (5 s) und gedrosselt (höchstens 30 je Minute, Rest als Sammel-Ereignis).
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';

export type OrdnerArt = 'neu' | 'geaendert' | 'geloescht';
export interface OrdnerRegel { id: string; quelle: 'ordner'; pfad: string; muster?: string; ereignisse?: OrdnerArt[]; unterordner?: boolean }
/** v1430 R4b — Benachrichtigungen (Windows/macOS): nur Apps aus der Regel, nur App + Titel verlassen das Gerät */
export interface BenachrichtigungRegel { id: string; quelle: 'benachrichtigung'; apps: string[]; titel?: string }
/** v1430 R4b — Outlook-Posteingang (Windows): neue Mails, optional nach Absender/Betreff; nur Kopfdaten */
export interface OutlookRegel { id: string; quelle: 'outlook'; absender?: string; betreff?: string }
/** v1431 R4c — Build-Wache: die freigegebenen Prüfbefehle eines Geräte-Projekts regelmäßig ausführen, Wechsel rot/grün melden */
export interface BuildRegel { id: string; quelle: 'build'; pfad: string; befehle: string[]; intervallMin?: number }
export type BeobachterRegel = OrdnerRegel | BenachrichtigungRegel | OutlookRegel | BuildRegel;

export interface Beobachtung { regel: string; quelle: string; art: string; schluessel: string; zeit: string; kopf: Record<string, unknown> }
export interface BeobachterStand { regel: string; quelle: string; zustand: 'laeuft' | 'gestoert' | 'aus'; grund?: string; letzte?: string; anzahl: number; /** v1430 Outlook: Konten am Gerät (Server prüft Doppel-Lesen) */ konten?: string[] }

/** Glob-Muster („*.pdf, Rechnung*") → Prüfung auf den Dateinamen, ohne Groß/Klein. Leer = alles. */
export function musterPasst(muster: string | undefined, name: string): boolean {
  const teile = (muster ?? '').split(/[,;]/).map(m => m.trim()).filter(Boolean);
  if (!teile.length) return true;
  return teile.some(m => new RegExp(`^${m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(name));
}

/** Zwischenstände von Programmen (Office-Sperrdatei, Downloads in Arbeit, Editor-Sicherungen). */
export function istTemporaer(name: string): boolean {
  return /^~\$|^\.~lock\.|\.(part|crdownload|download|tmp|temp|swp|swx|lock)$|~$|^\.#|^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$/i.test(name);
}

/** Bündeln und drosseln: alle `intervallMs` senden, höchstens `maxProMinute`; Überlauf je Regel als ein Sammel-Ereignis. */
export class Buendler {
  private warte: Beobachtung[] = [];
  private gesendet: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly senden: (e: Beobachtung[]) => void, private readonly o: { intervallMs?: number; maxProMinute?: number; jetzt?: () => number } = {}) {}
  push(b: Beobachtung): void {
    this.warte.push(b);
    if (!this.timer) this.timer = setTimeout(() => this.leere(), this.o.intervallMs ?? 5000);
  }
  leere(): void {
    this.timer = undefined;
    if (!this.warte.length) return;
    const jetzt = (this.o.jetzt ?? Date.now)();
    this.gesendet = this.gesendet.filter(t => jetzt - t < 60_000);
    const frei = Math.max(0, (this.o.maxProMinute ?? 30) - this.gesendet.length);
    const raus = this.warte.slice(0, frei);
    const rest = this.warte.slice(frei);
    this.warte = [];
    const sammel = new Map<string, { b: Beobachtung; n: number }>();
    for (const r of rest) { const s = sammel.get(r.regel); if (s) s.n++; else sammel.set(r.regel, { b: r, n: 1 }); }
    const alle = [...raus, ...[...sammel.values()].map(({ b, n }) => ({ regel: b.regel, quelle: b.quelle, art: 'sammel', schluessel: `${b.regel}:sammel:${jetzt}`, zeit: new Date(jetzt).toISOString(), kopf: { anzahl: n, beispiel: b.kopf } }))];
    for (let i = 0; i < raus.length; i++) this.gesendet.push(jetzt);
    if (alle.length) this.senden(alle);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}

/** Ein Ordner: Erstbestand merken, Änderungen nach Stabilitätsprüfung (Größe gleich) als neu/geändert/gelöscht melden. */
export class OrdnerBeobachter {
  private watcher?: FSWatcher;
  private bekannt = new Map<string, { groesse: number; mtime: number }>();
  private pruefungen = new Map<string, ReturnType<typeof setTimeout>>();
  readonly stand: BeobachterStand;
  constructor(private readonly r: OrdnerRegel, private readonly melde: (b: Beobachtung) => void, private readonly o: { stabilMs?: number; maxDateien?: number } = {}) {
    this.stand = { regel: r.id, quelle: 'ordner', zustand: 'aus', anzahl: 0 };
  }

  start(): void {
    try {
      if (!existsSync(this.r.pfad) || !statSync(this.r.pfad).isDirectory()) { this.stoerung('Ordner fehlt'); return; }
      this.scan(this.r.pfad, 0);
      this.watcher = watch(this.r.pfad, { recursive: !!this.r.unterordner }, (_ev, name) => { if (name) this.plane(String(name)); });
      this.watcher.on('error', (err) => this.stoerung(`Beobachtung abgebrochen: ${(err as Error).message}`));
      this.stand.zustand = 'laeuft'; this.stand.grund = undefined;
    } catch (err) { this.stoerung((err as Error).message); }
  }

  stop(): void {
    try { this.watcher?.close(); } catch { /* schon zu */ }
    this.watcher = undefined;
    for (const t of this.pruefungen.values()) clearTimeout(t);
    this.pruefungen.clear();
    if (this.stand.zustand === 'laeuft') this.stand.zustand = 'aus';
  }

  private stoerung(grund: string): void { this.stand.zustand = 'gestoert'; this.stand.grund = grund.slice(0, 200); }

  private scan(dir: string, tiefe: number): void {
    if (this.bekannt.size >= (this.o.maxDateien ?? 5000)) return;
    let eintraege: import('node:fs').Dirent[] = [];
    try { eintraege = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { if (this.r.unterordner && tiefe < 6 && !e.name.startsWith('.')) this.scan(voll, tiefe + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = statSync(voll); this.bekannt.set(path.relative(this.r.pfad, voll), { groesse: st.size, mtime: st.mtimeMs }); } catch { /* weg */ }
    }
  }

  private plane(rel: string, vorher?: number): void {
    const name = path.basename(rel);
    if (istTemporaer(name) || !musterPasst(this.r.muster, name)) return;
    const alt = this.pruefungen.get(rel);
    if (alt) clearTimeout(alt);
    this.pruefungen.set(rel, setTimeout(() => this.pruefe(rel, vorher), this.o.stabilMs ?? 3000));
  }

  private pruefe(rel: string, vorher?: number): void {
    this.pruefungen.delete(rel);
    const voll = path.join(this.r.pfad, rel);
    let st: import('node:fs').Stats | undefined;
    try { st = statSync(voll); } catch { st = undefined; }
    const arten = this.r.ereignisse?.length ? this.r.ereignisse : ['neu'];
    if (!st) {
      if (!this.bekannt.has(rel)) return;
      this.bekannt.delete(rel);
      if (arten.includes('geloescht')) this.sende('geloescht', rel, { name: path.basename(rel), relativ: rel.split(path.sep).join('/') }, `weg:${Date.now()}`);
      return;
    }
    if (!st.isFile()) return;
    // stabil? Größe muss zwischen zwei Prüfungen gleich bleiben (Download/Kopie noch im Gange)
    if (vorher === undefined || vorher !== st.size) { this.plane(rel, st.size); return; }
    const alt = this.bekannt.get(rel);
    this.bekannt.set(rel, { groesse: st.size, mtime: st.mtimeMs });
    if (alt && alt.groesse === st.size && Math.abs(alt.mtime - st.mtimeMs) < 1) return; // nichts geändert (nur Zugriff)
    const art: OrdnerArt = alt ? 'geaendert' : 'neu';
    if (!arten.includes(art)) return;
    this.sende(art, rel, { name: path.basename(rel), relativ: rel.split(path.sep).join('/'), groesse: st.size, geaendert: new Date(st.mtimeMs).toISOString() }, String(Math.round(st.mtimeMs)));
  }

  private sende(art: string, rel: string, kopf: Record<string, unknown>, zusatz: string): void {
    const zeit = new Date().toISOString();
    this.stand.letzte = zeit; this.stand.anzahl++;
    this.melde({ regel: this.r.id, quelle: 'ordner', art, schluessel: `${this.r.id}:${rel.split(path.sep).join('/')}:${zusatz}`, zeit, kopf });
  }
}

/** Gemeinsame Form der Beobachter (Ordner per fs.watch, Benachrichtigungen/Outlook per Abfrage). */
interface Laeufer { readonly stand: BeobachterStand; start(): void; stop(): void }

const enthaelt = (s: string | undefined, teil: string | undefined) => !teil || (s ?? '').toLowerCase().includes(teil.toLowerCase());

/**
 * Abfrage-Beobachter: alle `intervallMs` lesen, beim ersten Lauf nur den Bestand merken (keine Altlasten melden), danach
 * Neues nach Filter melden. Lesefehler → gestört mit Grund (nie still), nächster Lauf versucht es erneut.
 */
export class AbfrageBeobachter<T> implements Laeufer {
  private timer?: ReturnType<typeof setInterval>;
  private bekannt = new Set<string>();
  private erster = true;
  readonly stand: BeobachterStand;
  constructor(private readonly o: { regel: string; quelle: string; intervallMs: number; lesen: () => Promise<T[]>; schluessel: (x: T) => string; passt: (x: T) => boolean; kopf: (x: T) => Record<string, unknown>; melde: (b: Beobachtung) => void; info?: () => Promise<Record<string, unknown>> }) {
    this.stand = { regel: o.regel, quelle: o.quelle, zustand: 'aus', anzahl: 0 };
  }
  start(): void {
    this.stand.zustand = 'laeuft';
    void this.runde();
    this.timer = setInterval(() => { void this.runde(); }, this.o.intervallMs);
    if (this.o.info) void this.o.info().then(i => Object.assign(this.stand, i)).catch(() => undefined);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; if (this.stand.zustand === 'laeuft') this.stand.zustand = 'aus'; }
  async runde(): Promise<void> {
    let liste: T[];
    try { liste = await this.o.lesen(); } catch (err) { this.stand.zustand = 'gestoert'; this.stand.grund = (err as Error).message.slice(0, 200); return; }
    this.stand.zustand = 'laeuft'; this.stand.grund = undefined;
    for (const x of liste) {
      const k = this.o.schluessel(x);
      if (this.bekannt.has(k)) continue;
      this.bekannt.add(k);
      if (this.erster || !this.o.passt(x)) continue;
      const zeit = new Date().toISOString();
      this.stand.letzte = zeit; this.stand.anzahl++;
      this.o.melde({ regel: this.o.regel, quelle: this.o.quelle, art: 'neu', schluessel: `${this.o.regel}:${k}`, zeit, kopf: this.o.kopf(x) });
    }
    if (this.bekannt.size > 2000) this.bekannt = new Set([...this.bekannt].slice(-1000));
    this.erster = false;
  }
}

/** v1431 R4c — Build-Wache: meldet nur Wechsel (unbekannt/grün → rot, rot → grün); pausiert, solange im Ordner ein Auftrag läuft. */
export class BuildWache implements Laeufer {
  private timer?: ReturnType<typeof setInterval>;
  private letzter?: boolean;
  private laeuft = false;
  readonly stand: BeobachterStand;
  constructor(private readonly r: BuildRegel, private readonly o: { pruefen: (pfad: string, befehle: string[]) => Promise<{ ok: boolean; text: string }>; beschaeftigt: (pfad: string) => boolean; melde: (b: Beobachtung) => void; intervallMs?: number }) {
    this.stand = { regel: r.id, quelle: 'build', zustand: 'aus', anzahl: 0 };
  }
  start(): void {
    this.stand.zustand = 'laeuft';
    const ms = this.o.intervallMs ?? Math.max(15, Math.min(1440, this.r.intervallMin ?? 60)) * 60_000;
    void this.runde();
    this.timer = setInterval(() => { void this.runde(); }, ms);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; if (this.stand.zustand === 'laeuft') this.stand.zustand = 'aus'; }
  async runde(): Promise<void> {
    if (this.laeuft || !this.r.befehle?.length) return;
    if (this.o.beschaeftigt(this.r.pfad)) { this.stand.grund = 'pausiert: Auftrag läuft im Projekt'; return; }
    this.laeuft = true;
    try {
      const e = await this.o.pruefen(this.r.pfad, this.r.befehle);
      this.stand.zustand = 'laeuft'; this.stand.grund = e.ok ? undefined : 'zuletzt rot';
      if (this.letzter !== e.ok && !(this.letzter === undefined && e.ok)) {
        const zeit = new Date().toISOString();
        this.stand.letzte = zeit; this.stand.anzahl++;
        this.o.melde({ regel: this.r.id, quelle: 'build', art: e.ok ? 'gruen' : 'rot', schluessel: `${this.r.id}:${e.ok ? 'gruen' : 'rot'}:${zeit}`, zeit, kopf: { pfad: this.r.pfad, befehle: this.r.befehle, auszug: e.text.slice(-600) } });
      }
      this.letzter = e.ok;
    } catch (err) { this.stand.zustand = 'gestoert'; this.stand.grund = (err as Error).message.slice(0, 200); }
    finally { this.laeuft = false; }
  }
}

/** Alle Beobachter eines Geräts: Regeln vom Gehirn übernehmen (Unterschiede starten/stoppen), Stand für die Sinne. */
export class BeobachterVerwaltung {
  private laufend = new Map<string, { sig: string; b: Laeufer }>();
  private abgelehnt: BeobachterStand[] = [];
  private readonly buendler: Buendler;
  constructor(private readonly o: { senden: (e: Beobachtung[]) => void; erlaubt: (pfad: string) => boolean; veto: () => boolean; log?: (t: string) => void; stabilMs?: number; intervallMs?: number;
    /** v1430 R4b — Quellen (eingespeist, damit Tests ohne Outlook/Benachrichtigungs-DB laufen) */
    benachrichtigungen?: () => Promise<Array<{ app: string; roh?: string; zeit: string; titel?: string }>>;
    /** v1431 R4c — Build-Wache: Prüfbefehle ausführen, laufende Aufträge erkennen */
    pruefen?: (pfad: string, befehle: string[]) => Promise<{ ok: boolean; text: string }>; beschaeftigt?: (pfad: string) => boolean; buildMs?: number; outlook?: () => Promise<Array<{ id: string; datum: string; von: string; betreff: string; anhaenge?: number }>>; outlookKonten?: () => Promise<string[]>; abfrageMs?: { benachrichtigung?: number; outlook?: number } }) {
    this.buendler = new Buendler(o.senden, { intervallMs: o.intervallMs });
  }

  setze(regeln: BeobachterRegel[]): void {
    this.abgelehnt = [];
    const veto = this.o.veto();
    const soll = new Map<string, BeobachterRegel>();
    for (const r of veto ? [] : regeln) {
      if (r.quelle === 'ordner') {
        if (!r.pfad || !this.o.erlaubt(r.pfad)) { this.abgelehnt.push({ regel: r.id, quelle: r.quelle, zustand: 'gestoert', grund: `Ordner nicht freigegeben: ${r.pfad}`, anzahl: 0 }); continue; }
      } else if (r.quelle === 'benachrichtigung') {
        if (!this.o.benachrichtigungen) { this.abgelehnt.push({ regel: r.id, quelle: r.quelle, zustand: 'gestoert', grund: 'Benachrichtigungen auf diesem System nicht lesbar (nur Windows/macOS)', anzahl: 0 }); continue; }
      } else if (r.quelle === 'outlook') {
        if (!this.o.outlook) { this.abgelehnt.push({ regel: r.id, quelle: r.quelle, zustand: 'gestoert', grund: 'Outlook nicht vorhanden (nur Windows mit Outlook)', anzahl: 0 }); continue; }
      } else if (r.quelle === 'build') {
        if (!this.o.pruefen || !r.pfad || !this.o.erlaubt(r.pfad) || !r.befehle?.length) { this.abgelehnt.push({ regel: r.id, quelle: r.quelle, zustand: 'gestoert', grund: !r.befehle?.length ? 'Projekt hat keine Prüfbefehle' : `Projektordner nicht freigegeben: ${r.pfad}`, anzahl: 0 }); continue; }
      } else continue;
      soll.set(r.id, r);
    }
    for (const [id, l] of this.laufend) {
      const r = soll.get(id);
      if (!r || JSON.stringify(r) !== l.sig) { l.b.stop(); this.laufend.delete(id); }
    }
    for (const [id, r] of soll) {
      if (this.laufend.has(id)) continue;
      const b = this.laeufer(r);
      b.start();
      this.laufend.set(id, { sig: JSON.stringify(r), b });
      this.o.log?.(`Beobachter ${id} (${r.quelle === 'ordner' ? `${r.pfad}${r.muster ? `, ${r.muster}` : ''}` : r.quelle === 'build' ? `build ${r.pfad}` : r.quelle}): ${b.stand.zustand}${b.stand.grund ? ` — ${b.stand.grund}` : ''}`);
    }
    if (veto && regeln.length) this.abgelehnt = regeln.map(r => ({ regel: r.id, quelle: r.quelle, zustand: 'aus' as const, grund: 'am Gerät abgeschaltet', anzahl: 0 }));
  }

  private laeufer(r: BeobachterRegel): Laeufer {
    const melde = (x: Beobachtung) => this.buendler.push(x);
    if (r.quelle === 'ordner') return new OrdnerBeobachter(r, melde, { stabilMs: this.o.stabilMs });
    if (r.quelle === 'build') return new BuildWache(r, { pruefen: this.o.pruefen!, beschaeftigt: this.o.beschaeftigt ?? (() => false), melde, intervallMs: this.o.buildMs });
    if (r.quelle === 'benachrichtigung') {
      const apps = (r.apps ?? []).map(a => a.toLowerCase()).filter(Boolean);
      return new AbfrageBeobachter({ regel: r.id, quelle: 'benachrichtigung', intervallMs: this.o.abfrageMs?.benachrichtigung ?? 60_000, lesen: this.o.benachrichtigungen!,
        schluessel: (b) => `${b.roh ?? b.app}|${b.zeit}|${b.titel ?? ''}`, passt: (b) => apps.some(a => b.app.toLowerCase().includes(a) || (b.roh ?? '').toLowerCase().includes(a)) && enthaelt(b.titel, r.titel), // v1431 lesbarer Name oder Kennung
        kopf: (b) => ({ app: b.app, titel: (b.titel ?? '').slice(0, 160), zeit: b.zeit }), melde });
    }
    return new AbfrageBeobachter({ regel: r.id, quelle: 'outlook', intervallMs: this.o.abfrageMs?.outlook ?? 120_000, lesen: this.o.outlook!,
      schluessel: (m) => m.id, passt: (m) => enthaelt(m.von, r.absender) && enthaelt(m.betreff, r.betreff),
      kopf: (m) => ({ id: m.id, von: m.von, betreff: m.betreff, datum: m.datum, anhaenge: m.anhaenge ?? 0 }), melde, // id = Outlook-EntryID (kein Inhalt), damit Alfred die Mail gezielt lesen kann
      ...(this.o.outlookKonten ? { info: async () => ({ konten: await this.o.outlookKonten!() }) } : {}) });
  }

  stand(): BeobachterStand[] { return [...[...this.laufend.values()].map(l => ({ ...l.b.stand })), ...this.abgelehnt]; }

  stopAlle(): void { for (const l of this.laufend.values()) l.b.stop(); this.laufend.clear(); this.buendler.stop(); }
}
