import type { Logger } from 'pino';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { SkillRegistry } from '@alfred/skills';
import type { GeraeteRepository } from '@alfred/storage';
import type { GeraetEintrag, GeraetManifest, GeraetNachricht, GeraetAktionErgebnis } from '@alfred/types';
import { GeraetSkill } from './geraet-skill.js';
import { Freigaben, VorhabenFreigaben, vorhabenDateiSpeicher } from './freigaben.js';
import { AuftragHerkunft } from './auftrag-herkunft.js'; // v1383
import { Transfers, TransferOffsetFehler } from './transfers.js'; // v1249
import { AKTION_TIMEOUT_MS, PAIRING_CODE_GUELTIG_MS, PULS_TIMEOUT_MS, erzeugePairingCode, erzeugeToken, geraetSkillName, hashToken, pruefeManifest } from './protokoll.js';

/**
 * v1224 — Geräte-Gateway (Gehirn-Seite): Pairing, WebSocket-Verbindungen, Skill-Proxy je Gerät,
 * Weiterleitung von Aktionen mit Zeitbudget. Spec docs/specs/2026-10-06-geraete-architektur.md.
 */
export interface GeraeteGatewayDeps {
  logger: Logger;
  repo: GeraeteRepository;
  skillRegistry: SkillRegistry;
  serverVersion: string;
  ownerUserId: () => string | undefined;
  /** v1268 — ist der Aufrufer der Owner (Master, verknüpfte Plattform-IDs)? */
  istOwner?: (ctx: import('@alfred/types').SkillContext) => boolean;
  /** Zustellziel für Bestätigungsfragen (Owner-Chat). */
  ownerZiel: () => { platform: string; chatId: string };
  enqueueBestaetigung?: (opts: { chatId: string; platform: string; source: 'geraet'; sourceId: string; description: string; skillName: string; skillParams: Record<string, unknown>; timeoutMinutes?: number; herkunft?: { chatId: string; platform: string } }) => Promise<boolean | void>; // v1319 herkunft
  schritt?: (s: { userId: string; art: string; skill: string; aktion?: string; params?: Record<string, unknown>; beschreibung: string; ergebnis?: string; autonomie?: string; quelle: string }) => Promise<void>;
  /** v1240 — Datei, in der laufende Vorhaben Neustarts überleben. */
  vorhabenDatei?: string;
  /** v1383 — Zuordnung Auftrag → Sitzung des Starts (übersteht Neustarts des Gehirns) */
  auftraegeDatei?: string;
  /** v1249 — Ordner für Teildateien des blockweisen Transfers. */
  transferOrdner?: string;
  /** v1258 — öffentlicher Release-Schlüssel für das Willkommen (Satelliten prüfen Updates damit). */
  releaseKey?: () => string | undefined;
  /** v1235 — Dateitransfer: Quelle laden / geholte Datei speichern (FileStore des Owners). */
  dateien?: { lade: (quelle: string) => Promise<{ name: string; data: Buffer } | undefined>; speichere: (name: string, data: Buffer) => Promise<string> };
  /** v1230 — nach der Freigabe eines Vorhabens: Alfred setzt im Owner-Chat selbst fort. */
  /** v1342 — Auftrag an Claude Code auf dem Gerät beendet: Alfred fasst in der anfragenden Sitzung zusammen. */
  /** v1418 G2 — Fortschritt eines laufenden Auftrags (Live-Aktivität) */
  beiFortschritt?: (f: { geraetId: string; geraet: string; auftragId: string; schritte: string[]; werkzeuge: number }) => void;
  /** v1415 — Gerät hat sich (wieder) verbunden (nach dem Willkommen) */
  beiVerbindung?: (geraetId: string) => void;
  /** v1429 R4a — Beobachtungen eines Geräts (nur Kopfdaten) */
  beiBeobachtung?: (geraetId: string, ereignisse: Array<{ regel: string; quelle: string; art: string; schluessel: string; zeit: string; kopf: Record<string, unknown> }>) => void;
  beiEreignis?: (e: { geraet: string; skillName: string; ereignis: import('@alfred/types').GeraetEreignis; herkunft?: import('./auftrag-herkunft.js').Herkunft }) => Promise<void>;
  nachFreigabe?: (v: { geraet: string; skillName: string; beschreibung: string; bis: number; aktionen: string[]; domains: string[]; herkunft?: { chatId: string; platform: string; userId: string } }) => Promise<void>;
  now?: () => number;
  /**
   * v1520 — Handy im Hintergrund (nicht verbunden): Aktionen, die auch dann sinnvoll sind (Zwischenablage), nimmt der Server
   * an und stellt sie per Push zu. `undefined` = für diese Aktion kein Weg ohne Verbindung.
   */
  offlineAktion?: (g: GeraetEintrag, aktion: string, params: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }> | undefined;
}

/** v1520 — Handys: im Hintergrund getrennt, ihr Werkzeug bleibt trotzdem angemeldet (Aktionen laufen dann über offlineAktion). */
const HANDY = new Set(['ios', 'android']);

interface Verbindung {
  eintrag: GeraetEintrag;
  ws: WebSocket;
  skillName: string;
  zuletztPuls: number;
  verbundenSeit: string;
  offen: Map<string, { resolve: (r: GeraetAktionErgebnis) => void; timer: ReturnType<typeof setTimeout> }>;
  /** v1237 — letzte Sinne (Leerlauf, Fenster, Akku) und ihr Zeitpunkt. */
  sinne?: Record<string, unknown>;
  sinneZeit?: number;
}

export class GeraeteGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** v1342/v1382 — gestartete Aufträge (Claude Code) je Gerät und die Sitzung, aus der sie kamen: das Ende wird dort gemeldet.
   *  Am Gateway statt an der Verbindung, damit ein Wiederverbinden des Satelliten die Zuordnung nicht verliert. */
  private readonly auftraege: AuftragHerkunft;
  /** v1490 — schon verarbeitete Auftragsenden (Gerät:Auftrag:Status → Zeit), gegen doppelte Meldungen */
  private readonly gemeldeteEnden: Map<string, number>;
  private readonly verbindungen = new Map<string, Verbindung>();
  private readonly pairingCodes = new Map<string, { userId: string; gueltigBis: number; fehlversuche: number }>();
  /** v1225 — Fehlversuche je Absender: nach 10 in 10 Minuten wird das Pairing für diesen Absender abgelehnt. */
  private readonly pairVersuche = new Map<string, { n: number; bis: number }>();
  /** v1225 — globale Drossel: höchstens 20 Fehlversuche je Minute über alle Absender. */
  private pairFehlerGlobal = { n: 0, bis: 0 };
  /** v1225 — Einmal-Freigaben für bestätigte Geräteaktionen. */
  private readonly freigaben = new Freigaben();
  /** v1230 — Vorhaben-Freigaben (ein Ja für viele Schritte). */
  private readonly vorhaben: VorhabenFreigaben;
  /** v1249 — blockweiser Dateitransfer (Upload Gerät → Server, Download Server → Gerät). */
  readonly transfers: Transfers;
  private wachhund?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: GeraeteGatewayDeps) {
    this.auftraege = new AuftragHerkunft(this.deps.auftraegeDatei); // v1383
    this.gemeldeteEnden = new Map(); // v1490
    this.vorhaben = new VorhabenFreigaben(() => this.deps.now?.() ?? Date.now(), this.deps.vorhabenDatei ? vorhabenDateiSpeicher(this.deps.vorhabenDatei) : undefined); // v1240
    this.transfers = new Transfers(this.deps.transferOrdner ?? path.join(os.tmpdir(), 'alfred-transfers'), () => this.deps.now?.() ?? Date.now()); // v1249
  }

  /** v1521 — Datei aus dem Dateispeicher laden (Ablage des Handys holt sie später ab). */
  async ladeDatei(quelle: string): Promise<{ name: string; data: Buffer } | undefined> {
    return this.deps.dateien ? await this.deps.dateien.lade(quelle).catch(() => undefined) : undefined;
  }

  /** v1520 — Einträge der Handys, deren Werkzeug ohne Verbindung angemeldet ist */
  private ohneVerbindung = new Map<string, GeraetEintrag>();
  private widerrufen = new Set<string>();

  /**
   * v1520 — Werkzeuge der Handys mit Aktionen anmelden, auch wenn sie gerade nicht verbunden sind (nach dem Serverstart
   * kämen sie sonst erst mit dem nächsten Öffnen der App). Nur mit offlineAktion — ohne Weg ohne Verbindung wäre das Werkzeug leer.
   */
  async handyWerkzeugeAnmelden(): Promise<number> {
    const owner = this.deps.ownerUserId();
    if (!owner || !this.deps.offlineAktion) return 0;
    let n = 0;
    for (const e of await this.deps.repo.liste(owner)) {
      if (e.status !== 'aktiv' || !HANDY.has(e.plattform) || e.manifest.aktionen.length === 0 || this.verbindungen.has(e.id)) continue;
      this.ohneVerbindung.set(e.id, e);
      this.registriereSkill({ eintrag: e, ws: undefined as unknown as WebSocket, skillName: geraetSkillName(e.name), zuletztPuls: 0, verbundenSeit: '', offen: new Map() });
      n++;
    }
    if (n) this.deps.logger.info({ handys: n }, 'v1520 Handy-Werkzeuge ohne Verbindung angemeldet');
    return n;
  }

  start(): void {
    if (this.wachhund) return;
    this.wachhund = setInterval(() => this.pruefePulse(), 30_000);
    (this.wachhund as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.wachhund) { clearInterval(this.wachhund); this.wachhund = undefined; }
    for (const v of this.verbindungen.values()) { try { v.ws.close(1001, 'Server fährt herunter'); } catch { /* */ } }
  }

  // ── Pairing ──
  erzeugePairingCode(): { code: string; gueltigBis: string } | { fehler: string } {
    const userId = this.deps.ownerUserId();
    if (!userId) return { fehler: 'Owner nicht aufgelöst' };
    for (const [c, p] of this.pairingCodes) if (p.gueltigBis < Date.now()) this.pairingCodes.delete(c);
    const code = erzeugePairingCode();
    const gueltigBis = Date.now() + PAIRING_CODE_GUELTIG_MS;
    this.pairingCodes.set(code, { userId, gueltigBis, fehlversuche: 0 });
    this.deps.logger.info({ gueltigBis: new Date(gueltigBis).toISOString() }, 'v1224 Pairing-Code erzeugt');
    return { code, gueltigBis: new Date(gueltigBis).toISOString() };
  }

  async paare(body: Record<string, unknown>, remote: string): Promise<{ ok: true; id: string; token: string; name: string; skillName: string } | { ok: false; grund: string }> {
    const code = String(body.code ?? '').trim();
    // v1225 — Drossel gegen Durchprobieren: je Absender höchstens 10 Fehlversuche in 10 Minuten,
    // je Code höchstens 5 Fehlversuche, dann ist der Code verbraucht.
    const jetzt = Date.now();
    const v = this.pairVersuche.get(remote);
    if (v && v.bis > jetzt && v.n >= 10) { this.deps.logger.warn({ remote }, 'v1225 Pairing gedrosselt'); return { ok: false, grund: 'Zu viele Versuche — später erneut' }; }
    if (this.pairFehlerGlobal.bis > jetzt && this.pairFehlerGlobal.n >= 20) { this.deps.logger.warn({ remote }, 'v1225 Pairing global gedrosselt'); return { ok: false, grund: 'Zu viele Versuche — später erneut' }; }
    const p = this.pairingCodes.get(code);
    if (!p || p.gueltigBis < jetzt) {
      this.pairVersuche.set(remote, { n: (v && v.bis > jetzt ? v.n : 0) + 1, bis: jetzt + 10 * 60_000 });
      this.pairFehlerGlobal = this.pairFehlerGlobal.bis > jetzt ? { n: this.pairFehlerGlobal.n + 1, bis: this.pairFehlerGlobal.bis } : { n: 1, bis: jetzt + 60_000 };
      for (const [c, pc] of this.pairingCodes) { if (pc.gueltigBis >= jetzt && ++pc.fehlversuche >= 5) { this.pairingCodes.delete(c); this.deps.logger.warn({}, 'v1225 Pairing-Code nach 5 Fehlversuchen verworfen'); } }
      this.deps.logger.warn({ remote }, 'v1224 Pairing abgelehnt (Code ungültig oder abgelaufen)');
      return { ok: false, grund: 'Code ungültig oder abgelaufen' };
    }
    const gepr = pruefeManifest(body.manifest);
    if (!gepr.ok) return { ok: false, grund: gepr.grund };
    const name = String(body.name ?? gepr.manifest.hostname ?? 'Gerät').trim().slice(0, 60) || 'Gerät';
    this.pairingCodes.delete(code);
    const token = erzeugeToken();
    const eintrag = await this.deps.repo.anlegen({ userId: p.userId, name, plattform: gepr.manifest.plattform, manifest: gepr.manifest, tokenHash: hashToken(token) });
    this.deps.logger.info({ geraetId: eintrag.id, name, plattform: eintrag.plattform, aktionen: gepr.manifest.aktionen.map(a => a.name), remote }, 'v1224 Gerät gekoppelt');
    return { ok: true, id: eintrag.id, token, name, skillName: geraetSkillName(name) };
  }

  async liste(): Promise<Array<GeraetEintrag & { online: boolean; verbundenSeit?: string; skillName?: string; sinne?: Record<string, unknown>; sinneZeit?: string }>> {
    const userId = this.deps.ownerUserId();
    if (!userId) return [];
    const rows = (await this.deps.repo.liste(userId)).filter(r => r.status === 'aktiv'); // v1274 — widerrufene Geräte verschwinden aus Kachel und Weltmodell
    return rows.map(r => { const v = this.verbindungen.get(r.id); return { ...r, online: !!v, verbundenSeit: v?.verbundenSeit, skillName: v?.skillName, sinne: v?.sinne, sinneZeit: v?.sinneZeit ? new Date(v.sinneZeit).toISOString() : undefined }; });
  }

  /** v1237 — Zustände für die Weltmodell-Deutung (normalzustaende/geraete.ts). */
  async zustaende(): Promise<import('../normalzustaende/geraete.js').GeraetZustand[]> {
    const l = await this.liste();
    return l.filter(g => g.status === 'aktiv').map(g => ({ name: g.name, plattform: g.manifest.plattform, online: g.online, verbundenSeit: g.verbundenSeit, zuletztGesehen: g.zuletztGesehen, sinne: g.sinne as import('../normalzustaende/geraete.js').GeraetSinne | undefined, sinneZeit: g.sinneZeit }));
  }

  /** v1238 — Zustände der gerade verbundenen Geräte, synchron aus dem Speicher (Prompt-Block, Skill-Aktion zustand). */
  zustaendeVerbunden(): import('../normalzustaende/geraete.js').GeraetZustand[] {
    return [...this.verbindungen.values()].map(v => ({ name: v.eintrag.name, plattform: v.eintrag.manifest.plattform, online: true, verbundenSeit: v.verbundenSeit, sinne: v.sinne as import('../normalzustaende/geraete.js').GeraetSinne | undefined, sinneZeit: v.sinneZeit ? new Date(v.sinneZeit).toISOString() : undefined }));
  }

  /** v1237 — Gerät, an dem der Owner gerade sitzt (frische Sinne, kurzer Leerlauf) — Zustellsignal. */
  aktivesGeraet(): { name: string; leerlaufSek: number } | undefined {
    const jetzt = this.deps.now?.() ?? Date.now();
    let best: { name: string; leerlaufSek: number } | undefined;
    for (const v of this.verbindungen.values()) {
      const sek = v.sinne?.leerlaufSek;
      if (typeof sek !== 'number' || !v.sinneZeit || jetzt - v.sinneZeit > 3 * 60_000) continue;
      if (!best || sek < best.leerlaufSek) best = { name: v.eintrag.name, leerlaufSek: sek };
    }
    return best;
  }

  /** v1274 — Entkoppeln aus dem Chat: Satellit entfernt Dienst und Kopplung lokal, dann widerruft das Gehirn das Token. */
  async entkoppeln(id: string): Promise<{ ok: boolean; geraet?: string; hinweis: string }> {
    const v = this.verbindungen.get(id);
    let hinweis = 'Gerät war nicht verbunden — Dienst und Kopplung dort mit „alfred satellit --entkoppeln" entfernen';
    if (v) {
      const r = await this.sendeAktion(id, 'entkoppeln', {}, 15_000);
      hinweis = r.success ? (r.display ?? 'Satellit entfernt sich') : `Satellit konnte sich nicht entfernen: ${r.error ?? 'unbekannt'}`;
    }
    const ok = await this.widerrufe(id);
    return { ok, geraet: v?.eintrag.name, hinweis };
  }

  async widerrufe(id: string): Promise<boolean> {
    const userId = this.deps.ownerUserId();
    if (!userId) return false;
    const ok = await this.deps.repo.widerrufe(userId, id);
    // v1520 — ein widerrufenes Handy behält kein Werkzeug ohne Verbindung
    if (ok) this.widerrufen.add(id);
    const off = this.ohneVerbindung.get(id);
    if (off) { this.ohneVerbindung.delete(id); const n = geraetSkillName(off.name); if (this.deps.skillRegistry.has(n) && !this.verbindungen.has(id)) this.deps.skillRegistry.unregister(n); }
    const v = this.verbindungen.get(id);
    if (v) { this.sende(v.ws, { typ: 'abgemeldet', grund: 'Token widerrufen' }); try { v.ws.close(4001, 'widerrufen'); } catch { /* */ } }
    return ok;
  }

  // ── Verbindung ──
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.verbinde(ws, req.socket.remoteAddress ?? '?'));
  }

  private verbinde(ws: WebSocket, remote: string): void {
    let verbindung: Verbindung | undefined;
    const halloTimer = setTimeout(() => { if (!verbindung) { this.sende(ws, { typ: 'fehler', grund: 'hallo fehlt' }); ws.close(4000, 'hallo fehlt'); } }, 10_000);
    ws.on('message', (raw) => {
      let n: GeraetNachricht;
      try { n = JSON.parse(String(raw)) as GeraetNachricht; } catch { this.sende(ws, { typ: 'fehler', grund: 'kein JSON' }); return; }
      if (!verbindung) {
        if (n.typ !== 'hallo') { this.sende(ws, { typ: 'fehler', grund: 'zuerst hallo' }); return; }
        clearTimeout(halloTimer);
        void this.begruesse(ws, n, remote).then(v => { verbindung = v; });
        return;
      }
      this.verarbeite(verbindung, n);
    });
    ws.on('close', () => { clearTimeout(halloTimer); if (verbindung) this.trenne(verbindung, 'Verbindung geschlossen'); });
    ws.on('error', (err) => { this.deps.logger.debug({ err: err.message, remote }, 'v1224 Geräte-Socket Fehler'); });
  }

  private async begruesse(ws: WebSocket, hallo: Extract<GeraetNachricht, { typ: 'hallo' }>, remote: string): Promise<Verbindung | undefined> {
    const eintrag = await this.deps.repo.findeDurchTokenHash(hashToken(String(hallo.token ?? '')));
    if (!eintrag || eintrag.id !== hallo.geraetId) {
      this.deps.logger.warn({ remote, geraetId: hallo.geraetId }, 'v1224 Gerät abgewiesen (Token)');
      this.sende(ws, { typ: 'fehler', grund: 'Token ungültig' }); ws.close(4003, 'Token ungültig');
      return undefined;
    }
    const gepr = pruefeManifest(hallo.manifest);
    if (!gepr.ok) {
      // v1493 — vorher still: im Server-Log stand nur „Verbindung geschlossen“ (Realfall Office-VM 17.10.)
      const m = hallo.manifest as { aktionen?: unknown[]; version?: string; plattform?: string } | undefined;
      this.deps.logger.warn({ remote, geraetId: hallo.geraetId, name: eintrag.name, grund: gepr.grund, aktionen: Array.isArray(m?.aktionen) ? m!.aktionen.length : undefined, version: m?.version, plattform: m?.plattform }, 'v1493 Gerät abgewiesen (Manifest)');
      this.sende(ws, { typ: 'fehler', grund: gepr.grund }); ws.close(4004, 'Manifest'); return undefined;
    }
    const alt = this.verbindungen.get(eintrag.id);
    if (alt) this.trenne(alt, 'neue Verbindung desselben Geräts');
    const skillName = geraetSkillName(eintrag.name);
    const verbindung: Verbindung = { eintrag: { ...eintrag, manifest: gepr.manifest }, ws, skillName, zuletztPuls: Date.now(), verbundenSeit: new Date().toISOString(), offen: new Map() };
    this.verbindungen.set(eintrag.id, verbindung);
    this.ohneVerbindung.delete(eintrag.id); // v1520
    await this.deps.repo.setzeZuletztGesehen(eintrag.id, gepr.manifest).catch(() => undefined);
    this.registriereSkill(verbindung);
    this.sende(ws, { typ: 'willkommen', geraetId: eintrag.id, name: eintrag.name, serverVersion: this.deps.serverVersion, skillName, releaseKey: this.deps.releaseKey?.() }); // v1258
    try { this.deps.beiVerbindung?.(eintrag.id); } catch { /* Folgearbeit darf die Verbindung nicht stören */ } // v1415
    this.deps.logger.info({ geraetId: eintrag.id, name: eintrag.name, plattform: gepr.manifest.plattform, aktionen: gepr.manifest.aktionen.map(a => a.name), skillName, remote }, 'v1224 Gerät verbunden');
    return verbindung;
  }

  private registriereSkill(v: Verbindung): void {
    if (this.deps.skillRegistry.has(v.skillName)) this.deps.skillRegistry.unregister(v.skillName);
    // Phase 5 H1 (Spec Geräte §20.5 Punkt 1) — ein Gerät ohne Aktionen (Handy-App) ist kein Werkzeug: kein leerer Skill in der Tool-Liste
    if (v.eintrag.manifest.aktionen.length === 0) return;
    const userId = v.eintrag.userId;
    const skill = new GeraetSkill({
      istOwner: this.deps.istOwner, // v1268
      geraetId: v.eintrag.id, name: v.eintrag.name, manifest: v.eintrag.manifest, skillName: v.skillName,
      sendeAktion: (aktion, params, timeoutMs) => this.sendeAktion(v.eintrag.id, aktion, params, timeoutMs),
      // v1411 R3d — Vertrauensstufen aus den Sinnen (nur frische Sinne, höchstens 5 min alt)
      vertrauen: () => (v.sinneZeit && Date.now() - v.sinneZeit < 5 * 60_000 && Array.isArray(v.sinne?.vertrauen) ? (v.sinne!.vertrauen as Array<{ pfad: string; bis: string }>).filter(x => typeof x?.pfad === 'string' && typeof x?.bis === 'string') : undefined),
      merkeAuftrag: (auftragId, herkunft) => { this.auftraege.merke(v.eintrag.id, auftragId, herkunft); }, // v1342/v1383
      bestaetigung: async (frage, herkunft) => {
        if (!this.deps.enqueueBestaetigung) return false;
        const ziel = this.deps.ownerZiel();
        if (!ziel.chatId) return false;
        const nonce = this.freigaben.erzeuge(v.skillName, frage.aktion, frage.params); // v1225
        const ok = await this.deps.enqueueBestaetigung({ herkunft, chatId: ziel.chatId, platform: ziel.platform, source: 'geraet', sourceId: `geraet-${v.eintrag.id.slice(0, 8)}-${Date.now()}`, description: frage.description, skillName: v.skillName, skillParams: { ...frage.params, action: frage.aktion, freigabe: nonce }, timeoutMinutes: 60 });
        return ok !== false; // v1226 — Dedup-Übersprung ehrlich melden
      },
      pruefeFreigabe: (nonce, aktion, params) => this.freigaben.verbrauche(nonce, v.skillName, aktion, params),
      dateien: this.deps.dateien, // v1235
      zustand: () => this.zustaendeVerbunden().find(z => z.name === v.eintrag.name), // v1238
      entkoppeln: () => this.entkoppeln(v.eintrag.id), // v1274
      transfer: { bereitstellen: (name, data) => this.transfers.bereitstellen(v.eintrag.id, name, data) }, // v1249
      vorhaben: {
        erzeuge: (x) => this.vorhaben.erzeuge(v.skillName, x),
        aktiviere: (nonce) => { const a = this.vorhaben.aktiviere(nonce, v.skillName); if (a) this.deps.logger.info({ geraet: v.eintrag.name, beschreibung: a.beschreibung, aktionen: a.aktionen, domains: a.domains, bis: new Date(a.bis).toISOString() }, 'v1230 Vorhaben freigegeben'); return a; },
        deckt: (aktion, params) => this.vorhaben.deckt(v.skillName, aktion, params),
        nachFreigabe: async (a) => {
          await this.deps.nachFreigabe?.({ geraet: v.eintrag.name, skillName: v.skillName, ...a });
          // v1297 — Fortsetzung beendet: Vorhaben auf eine Gnadenfrist verkürzen statt bis zum Ablauf aktiv zu lassen
          const nonce = (a as { nonce?: string }).nonce;
          const k = nonce ? this.vorhaben.verkuerze(nonce) : undefined;
          if (k) this.deps.logger.info({ geraet: v.eintrag.name, beschreibung: k.beschreibung.slice(0, 80), bis: new Date(k.bis).toISOString() }, 'v1297 Vorhaben verkürzt');
        },
      },
      schritt: async (s) => { await this.deps.schritt?.({ userId, art: s.art, skill: v.skillName, aktion: s.aktion, params: s.params, beschreibung: s.beschreibung, ergebnis: s.ergebnis, autonomie: s.autonomie, quelle: 'geraet' }); },
    });
    this.deps.skillRegistry.register(skill);
  }

  private trenne(v: Verbindung, grund: string): void {
    if (this.verbindungen.get(v.eintrag.id) === v) this.verbindungen.delete(v.eintrag.id);
    for (const [id, o] of v.offen) { clearTimeout(o.timer); o.resolve({ typ: 'aktion_ergebnis', id, zeit: new Date().toISOString(), version: 1, success: false, error: `Gerät getrennt (${grund})`, dauerMs: 0 }); }
    v.offen.clear();
    // v1520 — Handy mit Aktionen: Werkzeug bleibt (App im Hintergrund ist sein Normalzustand), Aktionen gehen dann über offlineAktion
    const bleibt = HANDY.has(v.eintrag.plattform) && v.eintrag.manifest.aktionen.length > 0 && !!this.deps.offlineAktion && !this.widerrufen.has(v.eintrag.id);
    if (bleibt) this.ohneVerbindung.set(v.eintrag.id, v.eintrag);
    else if (this.deps.skillRegistry.has(v.skillName) && !this.verbindungen.has(v.eintrag.id)) this.deps.skillRegistry.unregister(v.skillName);
    try { v.ws.close(); } catch { /* */ }
    this.deps.logger.info({ geraetId: v.eintrag.id, name: v.eintrag.name, grund }, 'v1224 Gerät getrennt');
  }

  private verarbeite(v: Verbindung, n: GeraetNachricht): void {
    switch (n.typ) {
      case 'puls':
        v.zuletztPuls = Date.now();
        this.sende(v.ws, { typ: 'puls_ok' });
        if (Date.now() % (5 * 60_000) < 31_000) void this.deps.repo.setzeZuletztGesehen(v.eintrag.id).catch(() => undefined);
        return;
      case 'aktion_ergebnis': {
        const o = v.offen.get(n.id);
        if (!o) return;
        clearTimeout(o.timer); v.offen.delete(n.id); o.resolve(n);
        return;
      }
      case 'fortschritt': { // v1418 G2
        const schritte = Array.isArray(n.schritte) ? n.schritte.slice(-10).map(x => String(x).slice(0, 200)) : [];
        try { this.deps.beiFortschritt?.({ geraetId: v.eintrag.id, geraet: v.eintrag.name, auftragId: String(n.auftragId), schritte, werkzeuge: Number(n.werkzeuge) || 0 }); } catch { /* Anzeige */ }
        return;
      }
      case 'ereignis': {
        // v1490 — Realfall 16.10. 20:03:49: dasselbe Auftragsende zweimal (Ende-Rückruf und Minuten-Wächter am Satelliten) → zwei Meldungen
        const schluessel = `${v.eintrag.id}:${String(n.auftragId)}:${String(n.status)}`;
        if (this.gemeldeteEnden.has(schluessel)) { this.deps.logger.info({ geraet: v.eintrag.name, auftrag: n.auftragId, status: n.status }, 'v1490 Auftragsende doppelt gemeldet — ignoriert'); return; }
        this.gemeldeteEnden.set(schluessel, Date.now());
        for (const [k, z] of this.gemeldeteEnden) if (Date.now() - z > 6 * 3_600_000) this.gemeldeteEnden.delete(k);
        // v1342 — Auftrag (Claude Code) auf dem Gerät beendet → Fortsetzung in der Sitzung, aus der er gestartet wurde
        const herkunft = this.auftraege.nimm(v.eintrag.id, n.auftragId);
        this.deps.logger.info({ geraet: v.eintrag.name, auftrag: n.auftragId, status: n.status, herkunft: herkunft?.chatId }, 'v1342 Auftrag beendet');
        this.deps.beiEreignis?.({ geraet: v.eintrag.name, skillName: v.skillName, ereignis: n, herkunft }).catch(err => this.deps.logger.warn({ err: (err as Error).message }, 'v1342 Ereignis nicht verarbeitet'));
        return;
      }
      case 'beobachtung': { // v1429 R4a
        const e = Array.isArray(n.ereignisse) ? n.ereignisse.slice(0, 50) : [];
        try { this.deps.beiBeobachtung?.(v.eintrag.id, e); } catch { /* Folgearbeit */ }
        return;
      }
      case 'sinne':
        v.zuletztPuls = Date.now();
        // v1237 — Sinne merken: Weltmodell-Quelle „Geräte" und Anwesenheitssignal lesen sie
        v.sinne = n.werte ?? {};
        v.sinneZeit = Date.now();
        return;
      default:
        this.deps.logger.debug({ typ: (n as { typ?: string }).typ }, 'v1224 unbekannter Nachrichtentyp');
    }
  }

  /** v1404 — Herkunft eines vom Gehirn direkt gestarteten Auftrags (Frage zum Projekt): die Ende-Meldung geht in die fragende Sitzung. */
  merkeAuftragHerkunft(geraetId: string, auftragId: string, h: import('./auftrag-herkunft.js').Herkunft): void { this.auftraege.merke(geraetId, auftragId, h); }
  /** v1509 — laufende Claude-Code-Aufträge eines Geräts (Kontomenü). */
  laufendeAuftraege(geraetId: string): Array<{ auftragId: string; seit: number; frage?: string }> { return this.auftraege.laufend(geraetId); }

  /** v1387 — verbundenes Gerät nach Name (ohne Groß-/Kleinschreibung) oder ID. */
  geraetNachName(name: string): { id: string; name: string; aktionen: string[] } | undefined {
    const n = name.trim().toLowerCase();
    for (const v of this.verbindungen.values()) if (v.eintrag.id === name || v.eintrag.name.toLowerCase() === n) return { id: v.eintrag.id, name: v.eintrag.name, aktionen: v.eintrag.manifest.aktionen.map(a => a.name) };
    return undefined;
  }

  sendeAktion(geraetId: string, aktion: string, params: Record<string, unknown>, timeoutMs = AKTION_TIMEOUT_MS): Promise<{ success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }> {
    const v = this.verbindungen.get(geraetId);
    if (!v) {
      const e = this.ohneVerbindung.get(geraetId);
      const ersatz = e ? this.deps.offlineAktion?.(e, aktion, params) : undefined;
      return ersatz ?? Promise.resolve({ success: false, error: e ? `${e.name} ist gerade nicht verbunden (App im Hintergrund) — diese Aktion geht nur mit offener App` : 'Gerät nicht verbunden', dauerMs: 0 });
    }
    const id = randomUUID();
    const start = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { v.offen.delete(id); resolve({ success: false, error: `Gerät antwortete nicht innerhalb von ${Math.round(timeoutMs / 1000)} s`, dauerMs: Date.now() - start }); }, timeoutMs);
      v.offen.set(id, { resolve: (r) => resolve({ success: r.success, data: r.data, display: r.display, error: r.error, dauerMs: r.dauerMs ?? Date.now() - start }), timer });
      this.sende(v.ws, { typ: 'aktion', id, aktion, params });
    });
  }

  /** v1249 — Upload abschließen: Prüfsumme, dann in den Dateispeicher des Owners. */
  async uploadAbschliessen(id: string, geraetId?: string): Promise<{ key: string; name: string; groesse: number; sha256: string }> {
    const f = this.transfers.schliesseUpload(id, geraetId);
    if (!this.deps.dateien) throw new Error('Dateispeicher nicht eingerichtet');
    const key = await this.deps.dateien.speichere(f.name, f.data);
    this.deps.logger.info({ id, name: f.name, groesse: f.data.length, key, geraetId }, 'v1249 Upload abgeschlossen');
    return { key, name: f.name, groesse: f.data.length, sha256: f.sha256 };
  }

  /** v1249 — HTTP-Routen für den blockweisen Transfer (Ausweis: Gerätetoken oder API-Token). */
  transferRoute(art: 'start' | 'block' | 'status' | 'fertig' | 'lesen', p: { id?: string; geraetId?: string; body?: unknown; offset?: number; laenge?: number; data?: Buffer }): Promise<unknown> | unknown {
    switch (art) {
      case 'start': { const b = (p.body ?? {}) as Record<string, unknown>; return this.transfers.starteUpload(p.geraetId ?? 'api', b.name, b.groesse, b.sha256); }
      case 'block': {
        try { return this.transfers.schreibeBlock(String(p.id), p.offset ?? -1, p.data ?? Buffer.alloc(0), p.geraetId); }
        catch (err) { if (err instanceof TransferOffsetFehler) return { offsetFehler: true, empfangen: err.empfangen, groesse: err.groesse }; throw err; }
      }
      case 'status': return this.transfers.status(String(p.id), p.geraetId);
      case 'fertig': return this.uploadAbschliessen(String(p.id), p.geraetId);
      case 'lesen': return this.transfers.leseBlock(String(p.id), p.offset ?? 0, p.laenge ?? 0, p.geraetId);
    }
  }

  /** v1232 — Sitzung: das Gerätetoken weist ein gekoppeltes Gerät gegenüber der HTTP-API aus. */
  async authentifiziere(token: string): Promise<{ userId: string; geraetId: string; name: string } | undefined> {
    if (!token || token.length < 20) return undefined;
    const e = await this.deps.repo.findeDurchTokenHash(hashToken(token)).catch(() => undefined);
    if (!e || e.status !== 'aktiv') return undefined;
    return { userId: e.userId, geraetId: e.id, name: e.name };
  }

  /** v1231 — laufende Vorhaben für die Kachel. */
  vorhabenAktive(): Array<{ geraet: string; beschreibung: string; aktionen: string[]; domains: string[]; bis: string; schritte: number }> {
    const namen = new Map([...this.verbindungen.values()].map(v => [v.skillName, v.eintrag.name]));
    return this.vorhaben.aktive().map(a => ({ geraet: namen.get(a.skillName) ?? a.skillName, beschreibung: a.beschreibung, aktionen: a.aktionen, domains: a.domains, bis: new Date(a.bis).toISOString(), schritte: a.schritte }));
  }

  verbundene(): Array<{ id: string; name: string; plattform: string; skillName: string; verbundenSeit: string }> {
    return [...this.verbindungen.values()].map(v => ({ id: v.eintrag.id, name: v.eintrag.name, plattform: v.eintrag.manifest.plattform, skillName: v.skillName, verbundenSeit: v.verbundenSeit }));
  }

  private pruefePulse(): void {
    const jetzt = this.deps.now?.() ?? Date.now();
    for (const v of [...this.verbindungen.values()]) {
      if (jetzt - v.zuletztPuls > PULS_TIMEOUT_MS) { this.trenne(v, 'Puls ausgeblieben'); try { v.ws.terminate(); } catch { /* */ } }
    }
  }

  /** v1302 — Nachricht an alle verbundenen Geräte (Bestätigungen für Sitzungen). Liefert die Zahl der Empfänger. */
  /** v1334 — Anzeigename eines verbundenen Geräts (für /verlauf und Spiegelung). */
  nameVon(geraetId: string): string | undefined {
    for (const v of this.verbindungen.values()) if (v.eintrag.id === geraetId) return v.eintrag.name;
    return undefined;
  }

  /** v1354 — IDs der gerade verbundenen Geräte (Empfänger nach Owner-Prüfung auswählen). */
  verbundeneIds(): string[] {
    return [...this.verbindungen.values()].filter(v => v.ws.readyState === WebSocket.OPEN).map(v => v.eintrag.id);
  }

  sendeAnAlle(n: Partial<GeraetNachricht> & { typ: string }): number {
    let z = 0;
    for (const v of this.verbindungen.values()) { if (v.ws.readyState === WebSocket.OPEN) { this.sende(v.ws, n); z++; } }
    return z;
  }

  /** v1318 — Nachricht an EIN Gerät (Antworten/Ergebnisse für dessen Sitzung, chatId sitzung:<geraetId>). */
  sendeAn(geraetId: string, n: { typ: string; text?: string; [k: string]: unknown }): boolean {
    for (const v of this.verbindungen.values()) {
      if (v.eintrag.id === geraetId && v.ws.readyState === WebSocket.OPEN) { this.sende(v.ws, n as unknown as Partial<GeraetNachricht> & { typ: string }); return true; }
    }
    return false;
  }

  private sende(ws: WebSocket, n: Partial<GeraetNachricht> & { typ: string; id?: string }): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ id: randomUUID(), zeit: new Date().toISOString(), version: 1, ...n })); } catch { /* */ }
  }
}

export type { GeraetManifest };
