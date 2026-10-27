import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * I4b Teil 1 (Spec Infrastruktur-Vorhaben, Owner 22.10.2026 5b-7/5b-12) — Wartungsfenster und Sperrzeiten (infra_kalender) sowie
 * Benachrichtigungsregeln „wer wann wie“ (infra_benachrichtigungen). Strukturen der JSON-Felder: core/infrastruktur/wartung.ts.
 */
export interface KalenderZeile { id: string; art: 'fenster' | 'sperre'; name: string; geltung: unknown; regel: unknown; aktiv: boolean; notiz?: string; erstellt: string }
export interface RegelZeile { id: string; name: string; geltung: unknown; empfaenger: unknown[]; kanaele: string[]; zeitpunkte: string[]; aktiv: boolean; erstellt: string }

const json = <T>(v: unknown, leer: T): T => { if (typeof v !== 'string' || !v) return leer; try { return JSON.parse(v) as T; } catch { return leer; } };

export class WartungRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async kalender(userId: string): Promise<KalenderZeile[]> {
    const rows = await this.db.query('SELECT * FROM infra_kalender WHERE user_id = ? ORDER BY erstellt', [userId]);
    return rows.map(r => { const x = r as Record<string, unknown>; return { id: String(x.id), art: String(x.art) as KalenderZeile['art'], name: String(x.name), geltung: json(x.geltung, {}), regel: json(x.regel, {}), aktiv: Number(x.aktiv) !== 0 && x.aktiv !== false, ...(x.notiz ? { notiz: String(x.notiz) } : {}), erstellt: String(x.erstellt) }; });
  }

  async kalenderAnlegen(userId: string, e: { art: 'fenster' | 'sperre'; name: string; geltung: unknown; regel: unknown; notiz?: string }): Promise<string> {
    const id = randomUUID(); const jetzt = new Date().toISOString();
    await this.db.execute('INSERT INTO infra_kalender (id, user_id, art, name, geltung, regel, aktiv, notiz, erstellt, geaendert) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, userId, e.art, e.name.trim(), JSON.stringify(e.geltung), JSON.stringify(e.regel), e.notiz ?? null, jetzt, jetzt]);
    return id;
  }

  async regeln(userId: string): Promise<RegelZeile[]> {
    const rows = await this.db.query('SELECT * FROM infra_benachrichtigungen WHERE user_id = ? ORDER BY erstellt', [userId]);
    return rows.map(r => { const x = r as Record<string, unknown>; return { id: String(x.id), name: String(x.name), geltung: json(x.geltung, {}), empfaenger: json<unknown[]>(x.empfaenger, []), kanaele: json<string[]>(x.kanaele, []), zeitpunkte: json<string[]>(x.zeitpunkte, []), aktiv: Number(x.aktiv) !== 0 && x.aktiv !== false, erstellt: String(x.erstellt) }; });
  }

  async regelAnlegen(userId: string, e: { name: string; geltung: unknown; empfaenger: unknown[]; kanaele: string[]; zeitpunkte: string[] }): Promise<string> {
    const id = randomUUID(); const jetzt = new Date().toISOString();
    await this.db.execute('INSERT INTO infra_benachrichtigungen (id, user_id, name, geltung, empfaenger, kanaele, zeitpunkte, aktiv, erstellt, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [id, userId, e.name.trim(), JSON.stringify(e.geltung), JSON.stringify(e.empfaenger), JSON.stringify(e.kanaele), JSON.stringify(e.zeitpunkte), jetzt, jetzt]);
    return id;
  }

  /** Eintrag (Fenster/Sperre oder Regel) nach ID entfernen; liefert, ob etwas gelöscht wurde. */
  async entferne(userId: string, id: string): Promise<boolean> {
    const k = await this.db.queryOne('SELECT id FROM infra_kalender WHERE user_id = ? AND id = ?', [userId, id]);
    if (k) { await this.db.execute('DELETE FROM infra_kalender WHERE user_id = ? AND id = ?', [userId, id]); return true; }
    const r = await this.db.queryOne('SELECT id FROM infra_benachrichtigungen WHERE user_id = ? AND id = ?', [userId, id]);
    if (r) { await this.db.execute('DELETE FROM infra_benachrichtigungen WHERE user_id = ? AND id = ?', [userId, id]); return true; }
    return false;
  }

  // ── I4b Teil 4 — Standard-Change-Vorlagen: einmalige Owner-Freigabe je Vorlage ──
  async standardStand(userId: string): Promise<Array<{ vorlage: string; abdruck: string; status: string; frageHash?: string; frageBis?: string; freigegebenAt?: string; widerrufenAt?: string }>> {
    const rows = await this.db.query('SELECT * FROM infra_standard_freigaben WHERE user_id = ?', [userId]);
    return rows.map(r => { const x = r as Record<string, unknown>; return { vorlage: String(x.vorlage), abdruck: String(x.abdruck), status: String(x.status), ...(x.frage_hash ? { frageHash: String(x.frage_hash) } : {}), ...(x.frage_bis ? { frageBis: String(x.frage_bis) } : {}), ...(x.freigegeben_at ? { freigegebenAt: String(x.freigegeben_at) } : {}), ...(x.widerrufen_at ? { widerrufenAt: String(x.widerrufen_at) } : {}) }; });
  }

  async standardSetze(userId: string, vorlage: string, d: { abdruck: string; status: 'angefragt' | 'freigegeben' | 'widerrufen' | 'ueberpruefen'; frageHash?: string | null; frageBis?: string | null }): Promise<void> {
    const jetzt = new Date().toISOString();
    const da = await this.db.queryOne('SELECT id FROM infra_standard_freigaben WHERE user_id = ? AND vorlage = ?', [userId, vorlage]);
    const fa = d.status === 'freigegeben' ? jetzt : null, wa = d.status === 'widerrufen' ? jetzt : null;
    if (da) await this.db.execute('UPDATE infra_standard_freigaben SET abdruck = ?, status = ?, frage_hash = ?, frage_bis = ?, freigegeben_at = COALESCE(?, freigegeben_at), widerrufen_at = ?, geaendert = ? WHERE user_id = ? AND vorlage = ?',
      [d.abdruck, d.status, d.frageHash ?? null, d.frageBis ?? null, fa, wa, jetzt, userId, vorlage]);
    else await this.db.execute('INSERT INTO infra_standard_freigaben (id, user_id, vorlage, abdruck, status, frage_hash, frage_bis, freigegeben_at, widerrufen_at, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), userId, vorlage, d.abdruck, d.status, d.frageHash ?? null, d.frageBis ?? null, fa, wa, jetzt]);
  }

  /** Schalter „Sicherheitsupdates automatisch“ je Fernzugang (5b-8): 'an' | 'aus' (leer = aus bei vorhandenen Hosts). */
  async updatesSchalter(userId: string): Promise<Record<string, string>> {
    const rows = await this.db.query('SELECT name, sicherheitsupdates FROM fernzugaenge WHERE user_id = ?', [userId]);
    return Object.fromEntries(rows.map(r => { const x = r as Record<string, unknown>; return [String(x.name), String(x.sicherheitsupdates ?? 'aus')]; }));
  }
  async setzeUpdatesSchalter(userId: string, name: string, an: boolean): Promise<boolean> {
    const r = await this.db.queryOne('SELECT id FROM fernzugaenge WHERE user_id = ? AND LOWER(name) = ?', [userId, name.trim().toLowerCase()]);
    if (!r) return false;
    await this.db.execute('UPDATE fernzugaenge SET sicherheitsupdates = ?, geaendert = ? WHERE id = ?', [an ? 'an' : 'aus', new Date().toISOString(), (r as { id: string }).id]);
    return true;
  }

  async setzeAktiv(userId: string, id: string, aktiv: boolean): Promise<boolean> {
    const jetzt = new Date().toISOString();
    for (const t of ['infra_kalender', 'infra_benachrichtigungen']) {
      const r = await this.db.queryOne(`SELECT id FROM ${t} WHERE user_id = ? AND id = ?`, [userId, id]);
      if (r) { await this.db.execute(`UPDATE ${t} SET aktiv = ?, geaendert = ? WHERE user_id = ? AND id = ?`, [aktiv ? 1 : 0, jetzt, userId, id]); return true; }
    }
    return false;
  }
}
