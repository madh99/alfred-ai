/**
 * Phase 5 H2 (Spec Geräte §20.6) — Push an die Handys des Owners.
 * Regeln: nur Geräte mit Push-Weg; ist ein Handy gerade per WSS verbunden (App vorne), bekommt es keinen Push — die App zeigt
 * es selbst. Jeder Versand steht mit Ergebnis und Dauer im Log („v1518 Push“), ohne Token und ohne Inhalt. APNs 410 löscht den Token.
 * Schalter „Telegram stumm, wenn Push zugestellt“ (Owner 19.10.: zusätzlich zu Telegram, mit Schalter; Standard aus).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GeraetEintrag, GeraetPush } from '@alfred/types';
import type { ApnsErgebnis, ApnsNutzlast, ApnsUmgebung } from './push-apns.js';

export interface PushDienstDeps {
  repo: {
    mitPush(userId: string): Promise<Array<GeraetEintrag & { push: GeraetPush }>>;
    setzePush(id: string, push?: GeraetPush): Promise<void>;
  };
  /** fehlt, wenn kein APNs-Schlüssel eingerichtet ist — dann wird nichts versendet */
  apns?: { sende(token: string, umgebung: ApnsUmgebung, n: ApnsNutzlast): Promise<ApnsErgebnis> };
  istVerbunden: (geraetId: string) => boolean;
  ownerUserId: () => string | undefined;
  logger: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /** Ablage des Schalters (data/push-einstellungen.json) */
  einstellungenDatei?: string;
}

export interface PushEinstellungen { telegramStumm: boolean }

export class PushDienst {
  constructor(private readonly deps: PushDienstDeps) {}

  get bereit(): boolean { return !!this.deps.apns; }

  einstellungen(): PushEinstellungen {
    try { const j = JSON.parse(fs.readFileSync(this.deps.einstellungenDatei ?? '', 'utf8')) as Partial<PushEinstellungen>; return { telegramStumm: j.telegramStumm === true }; }
    catch { return { telegramStumm: false }; }
  }

  setzeEinstellungen(e: Partial<PushEinstellungen>): PushEinstellungen {
    const neu = { ...this.einstellungen(), ...(typeof e.telegramStumm === 'boolean' ? { telegramStumm: e.telegramStumm } : {}) };
    if (this.deps.einstellungenDatei) {
      fs.mkdirSync(path.dirname(this.deps.einstellungenDatei), { recursive: true });
      fs.writeFileSync(this.deps.einstellungenDatei, JSON.stringify(neu, null, 2));
    }
    return neu;
  }

  /** Token-Meldung der App (Route /api/geraete/push). */
  async merkeToken(geraet: { id: string; plattform: string }, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; grund: string }> {
    const art = body.art, token = body.token, umgebung = body.umgebung;
    if (art !== 'apns' || geraet.plattform !== 'ios') return { ok: false, grund: 'nur APNs für iOS' };
    if (typeof token !== 'string' || !/^[0-9a-f]{32,200}$/i.test(token)) return { ok: false, grund: 'Token ungültig' };
    if (umgebung !== 'sandbox' && umgebung !== 'production') return { ok: false, grund: 'Umgebung sandbox oder production' };
    await this.deps.repo.setzePush(geraet.id, { art: 'apns', token: token.toLowerCase(), umgebung });
    this.deps.logger.info({ geraetId: geraet.id, umgebung }, 'v1518 Push-Token gemerkt');
    return { ok: true };
  }

  private letzteAntwort = new Map<string, number>();

  /**
   * „Antwort fertig“ an genau das Handy, dessen Sitzung gefragt hat (App ging während der Antwort in den Hintergrund).
   * Höchstens ein Push je Gerät und Minute — eine Antwort kann aus mehreren Zeilen bestehen.
   */
  /** v1520 — an genau ein Handy (z. B. Zwischenablage); nicht, wenn es verbunden ist. */
  async anGeraet(geraetId: string, n: ApnsNutzlast): Promise<boolean> {
    const apns = this.deps.apns; const owner = this.deps.ownerUserId();
    if (!apns || !owner || this.deps.istVerbunden(geraetId)) return false;
    const g = (await this.deps.repo.mitPush(owner).catch(() => [])).find(x => x.id === geraetId && x.push.art === 'apns');
    if (!g) return false;
    const r = await apns.sende(g.push.token, g.push.umgebung ?? 'production', n);
    this.deps.logger.info({ geraet: g.name, art: n.art, status: r.status, grund: r.grund, dauerMs: r.dauerMs, umgebung: g.push.umgebung }, r.ok ? 'v1518 Push zugestellt' : 'v1518 Push fehlgeschlagen');
    if (r.tokenUngueltig) await this.deps.repo.setzePush(g.id, undefined).catch(() => undefined);
    return r.ok;
  }

  async antwortFertig(geraetId: string, faden?: string, jetzt = Date.now()): Promise<boolean> {
    const apns = this.deps.apns; const owner = this.deps.ownerUserId();
    if (!apns || !owner) return false;
    // nur Handys mit Push-Weg (Desktop-Satelliten haben keinen) — erst danach loggen, sonst stünde jede Desktop-Antwort im Log
    const g = (await this.deps.repo.mitPush(owner).catch(() => [])).find(x => x.id === geraetId && x.push.art === 'apns');
    if (!g) return false;
    if (this.deps.istVerbunden(geraetId)) { this.deps.logger.info({ geraet: g.name, art: 'antwort' }, 'v1518 Push ausgelassen — App vorne (verbunden)'); return false; }
    if (jetzt - (this.letzteAntwort.get(geraetId) ?? 0) < 60_000) return false;
    this.letzteAntwort.set(geraetId, jetzt);
    const r = await apns.sende(g.push.token, g.push.umgebung ?? 'production', { titel: 'Alfred', text: 'Antwort fertig', art: 'antwort', faden });
    this.deps.logger.info({ geraet: g.name, art: 'antwort', status: r.status, grund: r.grund, dauerMs: r.dauerMs, umgebung: g.push.umgebung }, r.ok ? 'v1518 Push zugestellt' : 'v1518 Push fehlgeschlagen');
    if (r.tokenUngueltig) await this.deps.repo.setzePush(g.id, undefined).catch(() => undefined);
    return r.ok;
  }

  /**
   * An alle nicht verbundenen Handys des Owners. Ergebnis: Anzahl zugestellt (APNs 200).
   * `ausser` — Geräte, die es schon anders wissen (z. B. die Sitzung, die gerade fragt).
   */
  async anOwner(n: ApnsNutzlast, opts?: { ausser?: string }): Promise<{ zugestellt: number; versucht: number }> {
    const apns = this.deps.apns; const owner = this.deps.ownerUserId();
    if (!apns || !owner) return { zugestellt: 0, versucht: 0 };
    let geraete: Array<GeraetEintrag & { push: GeraetPush }> = [];
    try { geraete = await this.deps.repo.mitPush(owner); } catch (err) { this.deps.logger.warn({ err: (err as Error).message }, 'v1518 Push: Geräte nicht lesbar'); return { zugestellt: 0, versucht: 0 }; }
    let zugestellt = 0, versucht = 0;
    for (const g of geraete) {
      if (g.push.art !== 'apns' || g.id === opts?.ausser) continue;
      if (this.deps.istVerbunden(g.id)) { this.deps.logger.info({ geraet: g.name, art: n.art }, 'v1518 Push ausgelassen — App vorne (verbunden)'); continue; }
      versucht++;
      const r = await apns.sende(g.push.token, g.push.umgebung ?? 'production', n);
      if (r.ok) zugestellt++;
      this.deps.logger.info({ geraet: g.name, art: n.art, status: r.status, grund: r.grund, dauerMs: r.dauerMs, umgebung: g.push.umgebung }, r.ok ? 'v1518 Push zugestellt' : 'v1518 Push fehlgeschlagen');
      if (r.tokenUngueltig) { await this.deps.repo.setzePush(g.id, undefined).catch(() => undefined); this.deps.logger.info({ geraet: g.name }, 'v1518 Push-Token ungültig — gelöscht'); }
    }
    return { zugestellt, versucht };
  }
}
