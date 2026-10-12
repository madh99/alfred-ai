import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1398 — Spec „Projekte sichtbar und fortsetzbar" P1 (Owner-Freigabe 12.10.: „wie empfohlen" = Tabelle): ein Projekt ist
 * eine dauerhafte Akte, jeder Lauf (`sat-…`, Datei je Lauf) eine Episode darin. Schlüssel: Benutzer + Gerät + Pfad — ein
 * zweiter Lauf im selben Ordner landet ohne Zutun in derselben Akte. Läufe, Etappen und Kosten stehen in den Laufdateien;
 * die Akte hält nur, was über die Läufe hinaus gilt (Name, Beschreibung, Prüfbefehle, Status).
 */
export type AktenStatus = 'aktiv' | 'ruht' | 'archiviert';

export interface ProjektAkte {
  id: string;
  userId: string;
  name: string;
  geraetId: string;
  geraet: string;
  pfad: string;
  beschreibung?: string;
  pruefBefehle: string[];
  status: AktenStatus;
  erstellt: string;
  aktualisiert: string;
}

export class ProjektAktenRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(a: Omit<ProjektAkte, 'id' | 'erstellt' | 'aktualisiert' | 'status'> & { status?: AktenStatus }): Promise<ProjektAkte> {
    const jetzt = new Date().toISOString();
    const akte: ProjektAkte = { ...a, pfad: normalisierePfad(a.pfad), id: `prj-${randomUUID().slice(0, 8)}`, status: a.status ?? 'aktiv', erstellt: jetzt, aktualisiert: jetzt };
    await this.db.execute(
      `INSERT INTO projekt_akten (id, user_id, name, geraet_id, geraet, pfad, beschreibung, pruef_befehle, status, erstellt, aktualisiert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [akte.id, akte.userId, akte.name, akte.geraetId, akte.geraet, akte.pfad, akte.beschreibung ?? null, JSON.stringify(akte.pruefBefehle), akte.status, jetzt, jetzt],
    );
    return akte;
  }

  async holen(userId: string, id: string): Promise<ProjektAkte | null> {
    const r = await this.db.queryOne('SELECT * FROM projekt_akten WHERE user_id = ? AND id = ?', [userId, id]) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  async findePfad(userId: string, geraetId: string, pfad: string): Promise<ProjektAkte | null> {
    const r = await this.db.queryOne('SELECT * FROM projekt_akten WHERE user_id = ? AND geraet_id = ? AND pfad = ?', [userId, geraetId, normalisierePfad(pfad)]) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  async liste(userId: string, mitArchiv = false): Promise<ProjektAkte[]> {
    const rows = await this.db.query(
      `SELECT * FROM projekt_akten WHERE user_id = ?${mitArchiv ? '' : " AND status <> 'archiviert'"} ORDER BY aktualisiert DESC`, [userId]) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  async aendern(userId: string, id: string, f: Partial<Pick<ProjektAkte, 'name' | 'beschreibung' | 'pruefBefehle' | 'status' | 'geraet'>>): Promise<void> {
    const sets: string[] = []; const werte: unknown[] = [];
    if (f.name !== undefined) { sets.push('name = ?'); werte.push(f.name); }
    if (f.beschreibung !== undefined) { sets.push('beschreibung = ?'); werte.push(f.beschreibung); }
    if (f.pruefBefehle !== undefined) { sets.push('pruef_befehle = ?'); werte.push(JSON.stringify(f.pruefBefehle)); }
    if (f.status !== undefined) { sets.push('status = ?'); werte.push(f.status); }
    if (f.geraet !== undefined) { sets.push('geraet = ?'); werte.push(f.geraet); }
    sets.push('aktualisiert = ?'); werte.push(new Date().toISOString());
    await this.db.execute(`UPDATE projekt_akten SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, [...werte, userId, id]);
  }

  private map(r: Record<string, unknown>): ProjektAkte {
    let befehle: string[] = [];
    try { const j = JSON.parse(String(r.pruef_befehle ?? '[]')); if (Array.isArray(j)) befehle = j.map(String); } catch { /* leer */ }
    return {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), geraetId: String(r.geraet_id), geraet: String(r.geraet ?? ''),
      pfad: String(r.pfad), ...(r.beschreibung ? { beschreibung: String(r.beschreibung) } : {}), pruefBefehle: befehle,
      status: (String(r.status) as AktenStatus), erstellt: String(r.erstellt), aktualisiert: String(r.aktualisiert),
    };
  }
}

/** Pfad als Schlüssel: ohne abschließende Trenner (/home/x/game/ = /home/x/game). */
export function normalisierePfad(p: string): string {
  const t = p.trim();
  return t.length > 1 ? t.replace(/[\\/]+$/, '') : t;
}
