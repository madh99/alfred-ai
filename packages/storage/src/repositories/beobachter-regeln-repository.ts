import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1429 R4a — Beobachter-Regeln (Spec Jarvis „R4 Beobachter am Satelliten", Owner 13.10.): Was ein Satellit beobachtet und
 * was ein Treffer bewirkt. Am Server angelegt (Gespräch, App, Web), mit sichtbarem Schalter `aktiv`; das Gerät kann alle
 * Beobachter lokal abschalten. Eigene Tabelle — `regeln` gehört den Befund-Regeln (v1362).
 */
export type BeobachterQuelle = 'ordner' | 'benachrichtigung' | 'outlook' | 'build';
export type BeobachterWirkung = 'hinweis' | 'vorgang' | 'aufgabe' | 'projekt';

export interface BeobachterRegel {
  id: string;
  userId: string;
  geraetId: string;
  geraet: string;
  name: string;
  quelle: BeobachterQuelle;
  /** Quelle-spezifisch, z. B. Ordner: { pfad, muster?, ereignisse?, unterordner? } */
  filter: Record<string, unknown>;
  wirkung: BeobachterWirkung;
  /** Was Alfred bei einem Treffer tun soll (Vorgang: nächster Schritt; Aufgabe: Auftrag; Projekt: Wunsch) */
  auftrag?: string;
  skills?: string[];
  projektId?: string;
  aktiv: boolean;
  /** v1433 B11 — nach dem ersten Treffer aus */
  einmalig?: boolean;
  /** v1433 B11 — gilt bis (ISO), danach aus */
  bis?: string;
  erstellt: string;
  geaendert: string;
  letzterTreffer?: string;
  treffer: number;
}

export type BeobachterRegelEingang = Omit<BeobachterRegel, 'id' | 'erstellt' | 'geaendert' | 'treffer' | 'letzterTreffer'>;

function zeile(r: Record<string, unknown>): BeobachterRegel {
  const json = <T>(v: unknown, sonst: T): T => { if (typeof v !== 'string' || !v) return sonst; try { return JSON.parse(v) as T; } catch { return sonst; } };
  return {
    id: String(r.id), userId: String(r.user_id), geraetId: String(r.geraet_id), geraet: String(r.geraet ?? ''), name: String(r.name),
    quelle: String(r.quelle) as BeobachterQuelle, filter: json<Record<string, unknown>>(r.filter, {}), wirkung: String(r.wirkung) as BeobachterWirkung,
    ...(r.auftrag ? { auftrag: String(r.auftrag) } : {}), ...(r.skills ? { skills: json<string[]>(r.skills, []) } : {}),
    ...(r.projekt_id ? { projektId: String(r.projekt_id) } : {}),
    aktiv: Number(r.aktiv) === 1 || r.aktiv === true, ...(Number(r.einmalig) === 1 ? { einmalig: true } : {}), ...(r.bis ? { bis: String(r.bis) } : {}), erstellt: String(r.erstellt), geaendert: String(r.geaendert),
    ...(r.letzter_treffer ? { letzterTreffer: String(r.letzter_treffer) } : {}), treffer: Number(r.treffer ?? 0),
  };
}

export class BeobachterRegelnRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async liste(userId: string): Promise<BeobachterRegel[]> {
    const rows = await this.db.query('SELECT * FROM beobachter_regeln WHERE user_id = ? ORDER BY erstellt', [userId]) as Array<Record<string, unknown>>;
    return rows.map(zeile);
  }

  async aktiveFuerGeraet(userId: string, geraetId: string): Promise<BeobachterRegel[]> {
    return (await this.liste(userId)).filter(r => r.aktiv && r.geraetId === geraetId);
  }

  async hole(userId: string, id: string): Promise<BeobachterRegel | null> {
    const r = await this.db.queryOne('SELECT * FROM beobachter_regeln WHERE user_id = ? AND id = ?', [userId, id]) as Record<string, unknown> | undefined;
    return r ? zeile(r) : null;
  }

  async anlegen(e: BeobachterRegelEingang): Promise<BeobachterRegel> {
    const id = randomUUID();
    const jetzt = new Date().toISOString();
    await this.db.execute(
      'INSERT INTO beobachter_regeln (id, user_id, geraet_id, geraet, name, quelle, filter, wirkung, auftrag, skills, projekt_id, aktiv, einmalig, bis, erstellt, geaendert, treffer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [id, e.userId, e.geraetId, e.geraet, e.name, e.quelle, JSON.stringify(e.filter ?? {}), e.wirkung, e.auftrag ?? null, e.skills?.length ? JSON.stringify(e.skills) : null, e.projektId ?? null, e.aktiv ? 1 : 0, e.einmalig ? 1 : 0, e.bis ?? null, jetzt, jetzt],
    );
    return (await this.hole(e.userId, id))!;
  }

  async aendern(userId: string, id: string, p: Partial<Pick<BeobachterRegel, 'name' | 'filter' | 'wirkung' | 'auftrag' | 'skills' | 'projektId' | 'aktiv' | 'einmalig' | 'bis'>>): Promise<BeobachterRegel | null> {
    const alt = await this.hole(userId, id);
    if (!alt) return null;
    const n = { ...alt, ...p };
    await this.db.execute(
      'UPDATE beobachter_regeln SET name = ?, filter = ?, wirkung = ?, auftrag = ?, skills = ?, projekt_id = ?, aktiv = ?, einmalig = ?, bis = ?, geaendert = ? WHERE user_id = ? AND id = ?',
      [n.name, JSON.stringify(n.filter ?? {}), n.wirkung, n.auftrag ?? null, n.skills?.length ? JSON.stringify(n.skills) : null, n.projektId ?? null, n.aktiv ? 1 : 0, n.einmalig ? 1 : 0, n.bis ?? null, new Date().toISOString(), userId, id],
    );
    return this.hole(userId, id);
  }

  async loeschen(userId: string, id: string): Promise<boolean> {
    const r = await this.db.execute('DELETE FROM beobachter_regeln WHERE user_id = ? AND id = ?', [userId, id]);
    return (r?.changes ?? 0) > 0;
  }

  /** v1433 B10 — ausgeschaltete Beobachtungsarten je Gerät (Schlüssel geraetId). */
  async artenAus(userId: string): Promise<Record<string, string[]>> {
    const rows = await this.db.query('SELECT geraet_id, arten_aus FROM beobachter_geraete WHERE user_id = ?', [userId]) as Array<{ geraet_id: string; arten_aus: string }>;
    const aus: Record<string, string[]> = {};
    for (const r of rows) { try { const a = JSON.parse(r.arten_aus) as unknown; if (Array.isArray(a) && a.length) aus[r.geraet_id] = a.map(String); } catch { /* leer */ } }
    return aus;
  }

  async setzeArtenAus(userId: string, geraetId: string, arten: string[]): Promise<void> {
    await this.db.execute('DELETE FROM beobachter_geraete WHERE user_id = ? AND geraet_id = ?', [userId, geraetId]);
    if (arten.length) await this.db.execute('INSERT INTO beobachter_geraete (user_id, geraet_id, arten_aus, geaendert) VALUES (?, ?, ?, ?)', [userId, geraetId, JSON.stringify(arten), new Date().toISOString()]);
  }

  async treffer(id: string, zeit = new Date().toISOString()): Promise<void> {
    await this.db.execute('UPDATE beobachter_regeln SET treffer = treffer + 1, letzter_treffer = ? WHERE id = ?', [zeit, id]);
  }
}
