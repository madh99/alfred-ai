import type { Logger } from 'pino';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { SkillRegistry } from '@alfred/skills';
import type { GeraeteRepository } from '@alfred/storage';
import type { GeraetEintrag, GeraetManifest, GeraetNachricht, GeraetAktionErgebnis } from '@alfred/types';
import { GeraetSkill } from './geraet-skill.js';
import { Freigaben } from './freigaben.js';
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
  /** Zustellziel für Bestätigungsfragen (Owner-Chat). */
  ownerZiel: () => { platform: string; chatId: string };
  enqueueBestaetigung?: (opts: { chatId: string; platform: string; source: 'geraet'; sourceId: string; description: string; skillName: string; skillParams: Record<string, unknown>; timeoutMinutes?: number }) => Promise<void>;
  schritt?: (s: { userId: string; art: string; skill: string; aktion?: string; params?: Record<string, unknown>; beschreibung: string; ergebnis?: string; autonomie?: string; quelle: string }) => Promise<void>;
  now?: () => number;
}

interface Verbindung {
  eintrag: GeraetEintrag;
  ws: WebSocket;
  skillName: string;
  zuletztPuls: number;
  verbundenSeit: string;
  offen: Map<string, { resolve: (r: GeraetAktionErgebnis) => void; timer: ReturnType<typeof setTimeout> }>;
}

export class GeraeteGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly verbindungen = new Map<string, Verbindung>();
  private readonly pairingCodes = new Map<string, { userId: string; gueltigBis: number; fehlversuche: number }>();
  /** v1225 — Fehlversuche je Absender: nach 10 in 10 Minuten wird das Pairing für diesen Absender abgelehnt. */
  private readonly pairVersuche = new Map<string, { n: number; bis: number }>();
  /** v1225 — globale Drossel: höchstens 20 Fehlversuche je Minute über alle Absender. */
  private pairFehlerGlobal = { n: 0, bis: 0 };
  /** v1225 — Einmal-Freigaben für bestätigte Geräteaktionen. */
  private readonly freigaben = new Freigaben();
  private wachhund?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: GeraeteGatewayDeps) {}

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

  async liste(): Promise<Array<GeraetEintrag & { online: boolean; verbundenSeit?: string; skillName?: string }>> {
    const userId = this.deps.ownerUserId();
    if (!userId) return [];
    const rows = await this.deps.repo.liste(userId);
    return rows.map(r => { const v = this.verbindungen.get(r.id); return { ...r, online: !!v, verbundenSeit: v?.verbundenSeit, skillName: v?.skillName }; });
  }

  async widerrufe(id: string): Promise<boolean> {
    const userId = this.deps.ownerUserId();
    if (!userId) return false;
    const ok = await this.deps.repo.widerrufe(userId, id);
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
    if (!gepr.ok) { this.sende(ws, { typ: 'fehler', grund: gepr.grund }); ws.close(4004, 'Manifest'); return undefined; }
    const alt = this.verbindungen.get(eintrag.id);
    if (alt) this.trenne(alt, 'neue Verbindung desselben Geräts');
    const skillName = geraetSkillName(eintrag.name);
    const verbindung: Verbindung = { eintrag: { ...eintrag, manifest: gepr.manifest }, ws, skillName, zuletztPuls: Date.now(), verbundenSeit: new Date().toISOString(), offen: new Map() };
    this.verbindungen.set(eintrag.id, verbindung);
    await this.deps.repo.setzeZuletztGesehen(eintrag.id, gepr.manifest).catch(() => undefined);
    this.registriereSkill(verbindung);
    this.sende(ws, { typ: 'willkommen', geraetId: eintrag.id, name: eintrag.name, serverVersion: this.deps.serverVersion, skillName });
    this.deps.logger.info({ geraetId: eintrag.id, name: eintrag.name, plattform: gepr.manifest.plattform, aktionen: gepr.manifest.aktionen.map(a => a.name), skillName, remote }, 'v1224 Gerät verbunden');
    return verbindung;
  }

  private registriereSkill(v: Verbindung): void {
    if (this.deps.skillRegistry.has(v.skillName)) this.deps.skillRegistry.unregister(v.skillName);
    const userId = v.eintrag.userId;
    const skill = new GeraetSkill({
      geraetId: v.eintrag.id, name: v.eintrag.name, manifest: v.eintrag.manifest, skillName: v.skillName,
      sendeAktion: (aktion, params, timeoutMs) => this.sendeAktion(v.eintrag.id, aktion, params, timeoutMs),
      bestaetigung: async (frage) => {
        if (!this.deps.enqueueBestaetigung) return false;
        const ziel = this.deps.ownerZiel();
        if (!ziel.chatId) return false;
        const nonce = this.freigaben.erzeuge(v.skillName, frage.aktion, frage.params); // v1225
        await this.deps.enqueueBestaetigung({ chatId: ziel.chatId, platform: ziel.platform, source: 'geraet', sourceId: `geraet-${v.eintrag.id.slice(0, 8)}-${Date.now()}`, description: frage.description, skillName: v.skillName, skillParams: { ...frage.params, action: frage.aktion, freigabe: nonce }, timeoutMinutes: 60 });
        return true;
      },
      pruefeFreigabe: (nonce, aktion, params) => this.freigaben.verbrauche(nonce, v.skillName, aktion, params),
      schritt: async (s) => { await this.deps.schritt?.({ userId, art: s.art, skill: v.skillName, aktion: s.aktion, params: s.params, beschreibung: s.beschreibung, ergebnis: s.ergebnis, autonomie: s.autonomie, quelle: 'geraet' }); },
    });
    this.deps.skillRegistry.register(skill);
  }

  private trenne(v: Verbindung, grund: string): void {
    if (this.verbindungen.get(v.eintrag.id) === v) this.verbindungen.delete(v.eintrag.id);
    for (const [id, o] of v.offen) { clearTimeout(o.timer); o.resolve({ typ: 'aktion_ergebnis', id, zeit: new Date().toISOString(), version: 1, success: false, error: `Gerät getrennt (${grund})`, dauerMs: 0 }); }
    v.offen.clear();
    if (this.deps.skillRegistry.has(v.skillName) && !this.verbindungen.has(v.eintrag.id)) this.deps.skillRegistry.unregister(v.skillName);
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
      case 'sinne':
        v.zuletztPuls = Date.now();
        this.deps.logger.debug({ geraet: v.eintrag.name, werte: Object.keys(n.werte ?? {}) }, 'v1224 Sinne empfangen (Phase 3 wertet aus)');
        return;
      default:
        this.deps.logger.debug({ typ: (n as { typ?: string }).typ }, 'v1224 unbekannter Nachrichtentyp');
    }
  }

  sendeAktion(geraetId: string, aktion: string, params: Record<string, unknown>, timeoutMs = AKTION_TIMEOUT_MS): Promise<{ success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }> {
    const v = this.verbindungen.get(geraetId);
    if (!v) return Promise.resolve({ success: false, error: 'Gerät nicht verbunden', dauerMs: 0 });
    const id = randomUUID();
    const start = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { v.offen.delete(id); resolve({ success: false, error: `Gerät antwortete nicht innerhalb von ${Math.round(timeoutMs / 1000)} s`, dauerMs: Date.now() - start }); }, timeoutMs);
      v.offen.set(id, { resolve: (r) => resolve({ success: r.success, data: r.data, display: r.display, error: r.error, dauerMs: r.dauerMs ?? Date.now() - start }), timer });
      this.sende(v.ws, { typ: 'aktion', id, aktion, params });
    });
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

  private sende(ws: WebSocket, n: Partial<GeraetNachricht> & { typ: string; id?: string }): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ id: randomUUID(), zeit: new Date().toISOString(), version: 1, ...n })); } catch { /* */ }
  }
}

export type { GeraetManifest };
