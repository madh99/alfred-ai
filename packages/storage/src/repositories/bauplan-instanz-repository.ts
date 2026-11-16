import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Dokument-Vorlagen V1 — Bauplan-Instanz: benannte Bündelung mehrerer Changes (in fester Reihenfolge)
 * für ein Dokument einer Art (Testprotokoll oder Betriebsdokument). Der Name ist je Benutzer eindeutig.
 */
export interface BauplanInstanz {
  id: string;
  name: string;
  dokumentart: 'testprotokoll' | 'betrieb';
  changeIds: string[];
  /** JSON, unverändert gespeichert (Betriebsdokument: Systemabgrenzung) */
  parameter?: string;
  /** Bauplan-Vorlagen V3 — Vorlage, aus der die Instanz angewendet wurde */
  vorlageKey?: string;
  vorlageVersion?: number;
  status: string;
  createdAt: string;
}

function zuInstanz(r: Record<string, unknown>): BauplanInstanz {
  let changeIds: string[] = [];
  try {
    const p = JSON.parse(String(r.change_ids ?? '[]'));
    if (Array.isArray(p)) changeIds = p.map(String);
  } catch { /* defektes JSON → leere Liste */ }
  return {
    id: r.id as string,
    name: r.name as string,
    dokumentart: r.dokumentart as BauplanInstanz['dokumentart'],
    changeIds,
    ...(typeof r.parameter === 'string' && r.parameter ? { parameter: r.parameter } : {}),
    ...(typeof r.vorlage_key === 'string' && r.vorlage_key ? { vorlageKey: r.vorlage_key } : {}),
    ...(r.vorlage_version != null ? { vorlageVersion: Number(r.vorlage_version) } : {}),
    status: r.status as string,
    createdAt: r.created_at as string,
  };
}

export class BauplanInstanzRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(userId: string, d: { name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[]; parameter?: string; vorlageKey?: string; vorlageVersion?: number }): Promise<BauplanInstanz> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO infra_bauplan_instanzen (id, user_id, name, dokumentart, change_ids, parameter, vorlage_key, vorlage_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aktiv', ?, ?)`,
      [id, userId, d.name, d.dokumentart, JSON.stringify(d.changeIds), d.parameter ?? null, d.vorlageKey ?? null, d.vorlageVersion ?? null, now, now],
    );
    return { id, name: d.name, dokumentart: d.dokumentart, changeIds: [...d.changeIds], ...(d.parameter !== undefined ? { parameter: d.parameter } : {}), ...(d.vorlageKey ? { vorlageKey: d.vorlageKey } : {}), ...(d.vorlageVersion !== undefined ? { vorlageVersion: d.vorlageVersion } : {}), status: 'aktiv', createdAt: now };
  }

  /** v1877 — Changes und Parameter einer bestehenden Instanz ersetzen (id und Name bleiben; Dokument-Versionen laufen weiter). */
  async aendern(userId: string, id: string, d: { changeIds: string[]; parameter?: string }): Promise<void> {
    await this.db.execute(
      'UPDATE infra_bauplan_instanzen SET change_ids = ?, parameter = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify(d.changeIds), d.parameter ?? null, new Date().toISOString(), id, userId],
    );
  }

  /** Nach id oder Name. */
  async finde(userId: string, idOderName: string): Promise<BauplanInstanz | undefined> {
    const r = await this.db.queryOne(
      'SELECT * FROM infra_bauplan_instanzen WHERE user_id = ? AND (id = ? OR name = ?) ORDER BY created_at DESC',
      [userId, idOderName, idOderName],
    );
    return r ? zuInstanz(r as Record<string, unknown>) : undefined;
  }

  /**
   * Bauplan-Vorlagen V3 — Instanz, deren change_ids die Change-ID enthalten (jüngste zuerst). Final-Welle T5(2): steckt der Change in
   * mehreren Instanzen (z. B. von Hand angelegte Instanz für dieselben Changes), gewinnt eine MIT vorlageKey — sonst entfiele das
   * Testprotokoll am Paket-Ende, weil die jüngere Hand-Instanz es verdeckt.
   */
  async findeNachChange(userId: string, changeId: string): Promise<BauplanInstanz | undefined> {
    const rows = await this.db.query(
      'SELECT * FROM infra_bauplan_instanzen WHERE user_id = ? AND change_ids LIKE ? ORDER BY created_at DESC',
      [userId, `%"${changeId}"%`],
    );
    const treffer = rows.map(r => zuInstanz(r as Record<string, unknown>)).filter(i => i.changeIds.includes(changeId));
    return treffer.find(i => i.vorlageKey) ?? treffer[0];
  }

  async liste(userId: string): Promise<BauplanInstanz[]> {
    const rows = await this.db.query('SELECT * FROM infra_bauplan_instanzen WHERE user_id = ? ORDER BY created_at, name', [userId]);
    return rows.map(r => zuInstanz(r as Record<string, unknown>));
  }
}
