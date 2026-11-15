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
    status: r.status as string,
    createdAt: r.created_at as string,
  };
}

export class BauplanInstanzRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(userId: string, d: { name: string; dokumentart: 'testprotokoll' | 'betrieb'; changeIds: string[]; parameter?: string }): Promise<BauplanInstanz> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO infra_bauplan_instanzen (id, user_id, name, dokumentart, change_ids, parameter, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aktiv', ?, ?)`,
      [id, userId, d.name, d.dokumentart, JSON.stringify(d.changeIds), d.parameter ?? null, now, now],
    );
    return { id, name: d.name, dokumentart: d.dokumentart, changeIds: [...d.changeIds], ...(d.parameter !== undefined ? { parameter: d.parameter } : {}), status: 'aktiv', createdAt: now };
  }

  /** Nach id oder Name. */
  async finde(userId: string, idOderName: string): Promise<BauplanInstanz | undefined> {
    const r = await this.db.queryOne(
      'SELECT * FROM infra_bauplan_instanzen WHERE user_id = ? AND (id = ? OR name = ?) ORDER BY created_at DESC',
      [userId, idOderName, idOderName],
    );
    return r ? zuInstanz(r as Record<string, unknown>) : undefined;
  }

  async liste(userId: string): Promise<BauplanInstanz[]> {
    const rows = await this.db.query('SELECT * FROM infra_bauplan_instanzen WHERE user_id = ? ORDER BY created_at, name', [userId]);
    return rows.map(r => zuInstanz(r as Record<string, unknown>));
  }
}
