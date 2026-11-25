import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Spec Schwachstellen-Überwachung (25.11.2026) §3.7 — Komponenten (was läuft wo in welcher Version) und Treffer je Komponente.
 * Ein Treffer ist offen, bis ein Lauf die Komponente ohne ihn sieht (behoben_am). Das erste Erkennen bestimmt die Frist.
 * Strukturen: core/infrastruktur/schwachstellen/bewertung.ts.
 */
export interface SicherheitsKomponente {
  schluessel: string; host: string; name: string; art: string; image?: string; version?: string; anwendung?: string; erreichbar: boolean;
  nichtGeprueft: string[]; zaehler: Record<string, number>; zuletzt: string;
}
export interface SicherheitsTreffer {
  komponente: string; id: string; paket: string; installiert: string; behoben?: string; cvss?: number; vektor?: string; schwere: string; stufe: string;
  epss?: number; kev?: string; titel: string; link: string; quellen: string[]; aliase: string[]; erkannt: string; zuletzt: string; behobenAm?: string;
}
export interface LaufTreffer { id: string; paket: string; installiert: string; behoben?: string; cvss?: number; vektor?: string; schwere: string; stufe: string; epss?: number; kev?: string; titel: string; link: string; quellen: string[]; aliase: string[] }

const json = <T>(v: unknown, leer: T): T => { if (typeof v !== 'string' || !v) return leer; try { return JSON.parse(v) as T; } catch { return leer; } };
const zahl = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));

export class SchwachstellenRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /** Vorgeschichte der offenen Treffer je Komponente: `${id}|${paket}` → erstes Erkennen, zuletzt gespeicherte EPSS/KEV und Stufe (neu kritisch = vorher nicht kritisch) */
  async erkannt(userId: string): Promise<Map<string, Map<string, { erkannt: string; epss?: number; kev?: string; stufe: string }>>> {
    const rows = await this.db.query('SELECT komponente, treffer_id, paket, erkannt, epss, kev, stufe FROM sicherheit_treffer WHERE user_id = ? AND behoben_am IS NULL', [userId]);
    const m = new Map<string, Map<string, { erkannt: string; epss?: number; kev?: string; stufe: string }>>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const k = String(r.komponente);
      if (!m.has(k)) m.set(k, new Map());
      const e = zahl(r.epss);
      m.get(k)!.set(`${String(r.treffer_id)}|${String(r.paket)}`, { erkannt: String(r.erkannt), stufe: String(r.stufe), ...(e !== undefined ? { epss: e } : {}), ...(r.kev ? { kev: String(r.kev) } : {}) });
    }
    return m;
  }

  /**
   * Ergebnis eines Laufs speichern: Komponenten ersetzen, Treffer neu/aktualisiert, nicht mehr gesehene einer erfassten Komponente als
   * behoben markieren. Gespeichert werden Treffer ab mittel oder mit behobener Version (Rest nur gezählt). Rückgabe: neue Treffer.
   */
  /**
   * Fail-closed: ein offener Treffer gilt nur als behoben, wenn eine seiner Quellen in diesem Lauf für die Komponente erfolgreich lief
   * (`geprueft`); verschwundene Komponenten nur auf Hosts, die dieser Lauf vollständig gelesen hat (`erfassteHosts`).
   */
  async speichereLauf(userId: string, komponenten: Array<Omit<SicherheitsKomponente, 'zuletzt'> & { treffer: LaufTreffer[]; geprueft: string[] }>, erfassteHosts: ReadonlySet<string>, jetzt = new Date().toISOString()): Promise<{ neu: Array<{ komponente: string; id: string; stufe: string }>; behoben: number; entfernt: string[] }> {
    const neu: Array<{ komponente: string; id: string; stufe: string }> = []; let behoben = 0;
    for (const k of komponenten) {
      const da = await this.db.queryOne('SELECT id FROM sicherheit_komponenten WHERE user_id = ? AND schluessel = ?', [userId, k.schluessel]);
      const werte = [k.host, k.name, k.art, k.image ?? null, k.version ?? null, k.anwendung ?? null, k.erreichbar ? 1 : 0, JSON.stringify(k.nichtGeprueft), JSON.stringify(k.zaehler), jetzt];
      if (da) await this.db.execute('UPDATE sicherheit_komponenten SET host = ?, name = ?, art = ?, image = ?, version = ?, anwendung = ?, erreichbar = ?, nicht_geprueft = ?, zaehler = ?, zuletzt = ? WHERE user_id = ? AND schluessel = ?', [...werte, userId, k.schluessel]);
      else await this.db.execute('INSERT INTO sicherheit_komponenten (host, name, art, image, version, anwendung, erreichbar, nicht_geprueft, zaehler, zuletzt, id, user_id, schluessel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...werte, randomUUID(), userId, k.schluessel]);
      const offenRoh = await this.db.query('SELECT id, treffer_id, paket, quellen FROM sicherheit_treffer WHERE user_id = ? AND komponente = ? AND behoben_am IS NULL', [userId, k.schluessel]) as Array<Record<string, unknown>>;
      const offen = new Map(offenRoh.map(r => [`${String(r.treffer_id)}|${String(r.paket)}`, String(r.id)]));
      const quellenVon = new Map(offenRoh.map(r => [String(r.id), json(r.quellen, [] as string[])]));
      const gesehen = new Set<string>();
      for (const t of k.treffer.filter(x => x.stufe !== 'niedrig' || !!x.behoben)) {
        const key = `${t.id}|${t.paket}`; if (gesehen.has(key)) continue; gesehen.add(key);
        const w = [t.installiert, t.behoben ?? null, t.cvss ?? null, t.vektor ?? null, t.schwere, t.stufe, t.epss ?? null, t.kev ?? null, t.titel, t.link, JSON.stringify(t.quellen), JSON.stringify(t.aliase), jetzt];
        const id = offen.get(key);
        if (id) await this.db.execute('UPDATE sicherheit_treffer SET installiert = ?, behoben = ?, cvss = ?, vektor = ?, schwere = ?, stufe = ?, epss = ?, kev = ?, titel = ?, link = ?, quellen = ?, aliase = ?, zuletzt = ? WHERE id = ?', [...w, id]);
        else {
          await this.db.execute('INSERT INTO sicherheit_treffer (installiert, behoben, cvss, vektor, schwere, stufe, epss, kev, titel, link, quellen, aliase, zuletzt, id, user_id, komponente, treffer_id, paket, erkannt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...w, randomUUID(), userId, k.schluessel, t.id, t.paket, jetzt]);
          neu.push({ komponente: k.schluessel, id: t.id, stufe: t.stufe });
        }
      }
      for (const [key, id] of offen) {
        if (gesehen.has(key) || !quellenVon.get(id)!.some(q => k.geprueft.includes(q))) continue;
        await this.db.execute('UPDATE sicherheit_treffer SET behoben_am = ? WHERE id = ?', [jetzt, id]); behoben++;
      }
    }
    // Komponenten, die auf einem vollständig gelesenen Host nicht mehr laufen: Treffer behoben, Komponente entfernt
    const imLauf = new Set(komponenten.map(k => k.schluessel)); const entfernt: string[] = [];
    for (const r of await this.db.query('SELECT schluessel, host FROM sicherheit_komponenten WHERE user_id = ?', [userId]) as Array<Record<string, unknown>>) {
      const sch = String(r.schluessel);
      if (imLauf.has(sch) || !erfassteHosts.has(String(r.host))) continue;
      await this.db.execute('UPDATE sicherheit_treffer SET behoben_am = ? WHERE user_id = ? AND komponente = ? AND behoben_am IS NULL', [jetzt, userId, sch]);
      await this.db.execute('DELETE FROM sicherheit_komponenten WHERE user_id = ? AND schluessel = ?', [userId, sch]);
      entfernt.push(sch);
    }
    return { neu, behoben, entfernt };
  }

  async komponenten(userId: string): Promise<SicherheitsKomponente[]> {
    const rows = await this.db.query('SELECT * FROM sicherheit_komponenten WHERE user_id = ? ORDER BY host, name', [userId]);
    return (rows as Array<Record<string, unknown>>).map(x => ({
      schluessel: String(x.schluessel), host: String(x.host), name: String(x.name), art: String(x.art), ...(x.image ? { image: String(x.image) } : {}), ...(x.version ? { version: String(x.version) } : {}),
      ...(x.anwendung ? { anwendung: String(x.anwendung) } : {}), erreichbar: Number(x.erreichbar) === 1 || x.erreichbar === true, nichtGeprueft: json(x.nicht_geprueft, [] as string[]), zaehler: json(x.zaehler, {} as Record<string, number>), zuletzt: String(x.zuletzt),
    }));
  }

  async treffer(userId: string, opts: { komponente?: string; offen?: boolean } = {}): Promise<SicherheitsTreffer[]> {
    const w = ['user_id = ?']; const p: unknown[] = [userId];
    if (opts.komponente) { w.push('komponente = ?'); p.push(opts.komponente); }
    if (opts.offen !== false) w.push('behoben_am IS NULL');
    const rows = await this.db.query(`SELECT * FROM sicherheit_treffer WHERE ${w.join(' AND ')} ORDER BY komponente, cvss DESC`, p);
    return (rows as Array<Record<string, unknown>>).map(x => ({
      komponente: String(x.komponente), id: String(x.treffer_id), paket: String(x.paket), installiert: String(x.installiert ?? ''), ...(x.behoben ? { behoben: String(x.behoben) } : {}),
      ...(zahl(x.cvss) !== undefined ? { cvss: zahl(x.cvss) } : {}), ...(x.vektor ? { vektor: String(x.vektor) } : {}), schwere: String(x.schwere), stufe: String(x.stufe),
      ...(zahl(x.epss) !== undefined ? { epss: zahl(x.epss) } : {}), ...(x.kev ? { kev: String(x.kev) } : {}), titel: String(x.titel ?? ''), link: String(x.link ?? ''),
      quellen: json(x.quellen, [] as string[]), aliase: json(x.aliase, [] as string[]), erkannt: String(x.erkannt), zuletzt: String(x.zuletzt), ...(x.behoben_am ? { behobenAm: String(x.behoben_am) } : {}),
    }));
  }
}
