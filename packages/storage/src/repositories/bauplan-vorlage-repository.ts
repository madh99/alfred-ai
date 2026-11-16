import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Bauplan-Vorlagen V3 — versionierte Vorlagen. Jede Änderung ist eine neue Version (Status `entwurf`);
 * die Freigabe ist an den Abdruck (SHA-256 der kanonischen JSON-Form) der jeweiligen Version gebunden.
 */
export type BauplanVorlageStatus = 'entwurf' | 'angefragt' | 'freigegeben' | 'widerrufen' | 'ueberpruefen';

export interface BauplanVorlageZeile {
  id: string;
  key: string;
  version: number;
  json: string;
  abdruck: string;
  status: BauplanVorlageStatus;
  frageHash?: string;
  frageBis?: string;
  freigegebenAt?: string;
  widerrufenAt?: string;
  grund?: string;
  abgeleitetAus?: string;
  /** V4 Final-Welle — Begleitinformation der Ableitung (JSON: quellen, fest, hinweise, ohneAnnahme); nur beim Speichern gesetzt, nicht im Abdruck */
  ableitung?: string;
  createdAt: string;
  updatedAt: string;
}

const opt = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function zuZeile(r: Record<string, unknown>): BauplanVorlageZeile {
  const z: BauplanVorlageZeile = {
    id: r.id as string,
    key: r.key as string,
    version: Number(r.version),
    json: r.json as string,
    abdruck: r.abdruck as string,
    status: r.status as BauplanVorlageStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
  const f = opt(r.frage_hash); if (f) z.frageHash = f;
  const b = opt(r.frage_bis); if (b) z.frageBis = b;
  const g = opt(r.freigegeben_at); if (g) z.freigegebenAt = g;
  const w = opt(r.widerrufen_at); if (w) z.widerrufenAt = w;
  const gr = opt(r.grund); if (gr) z.grund = gr;
  const a = opt(r.abgeleitet_aus); if (a) z.abgeleitetAus = a;
  const ab = opt(r.ableitung); if (ab) z.ableitung = ab;
  return z;
}

type Setzbar = Partial<Pick<BauplanVorlageZeile, 'status' | 'frageHash' | 'frageBis' | 'freigegebenAt' | 'widerrufenAt' | 'grund'>>;

const SPALTE: Record<keyof Setzbar, string> = {
  status: 'status',
  frageHash: 'frage_hash',
  frageBis: 'frage_bis',
  freigegebenAt: 'freigegeben_at',
  widerrufenAt: 'widerrufen_at',
  grund: 'grund',
};

export class BauplanVorlageRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /** Neue Version (bisherige höchste + 1), Status `entwurf`. */
  async speichere(userId: string, d: { key: string; json: string; abdruck: string; abgeleitetAus?: string; ableitung?: string }): Promise<BauplanVorlageZeile> {
    const m = await this.db.queryOne('SELECT MAX(version) AS v FROM infra_bauplan_vorlagen WHERE user_id = ? AND key = ?', [userId, d.key]);
    const version = Number((m as Record<string, unknown> | undefined)?.v ?? 0) + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO infra_bauplan_vorlagen (id, user_id, key, version, json, abdruck, status, abgeleitet_aus, ableitung, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'entwurf', ?, ?, ?, ?)`,
      [id, userId, d.key, version, d.json, d.abdruck, d.abgeleitetAus ?? null, d.ableitung ?? null, now, now],
    );
    return {
      id, key: d.key, version, json: d.json, abdruck: d.abdruck, status: 'entwurf',
      ...(d.abgeleitetAus ? { abgeleitetAus: d.abgeleitetAus } : {}),
      ...(d.ableitung ? { ableitung: d.ableitung } : {}),
      createdAt: now, updatedAt: now,
    };
  }

  /** Ohne `version`: die höchste. */
  async finde(userId: string, key: string, version?: number): Promise<BauplanVorlageZeile | undefined> {
    const r = version === undefined
      ? await this.db.queryOne('SELECT * FROM infra_bauplan_vorlagen WHERE user_id = ? AND key = ? ORDER BY version DESC', [userId, key])
      : await this.db.queryOne('SELECT * FROM infra_bauplan_vorlagen WHERE user_id = ? AND key = ? AND version = ?', [userId, key, version]);
    return r ? zuZeile(r as Record<string, unknown>) : undefined;
  }

  async liste(userId: string): Promise<BauplanVorlageZeile[]> {
    const rows = await this.db.query('SELECT * FROM infra_bauplan_vorlagen WHERE user_id = ? ORDER BY key, version', [userId]);
    return rows.map(r => zuZeile(r as Record<string, unknown>));
  }

  /** Schreibt nur die übergebenen Spalten (undefined bleibt unberührt). */
  async setze(userId: string, id: string, d: Setzbar): Promise<void> {
    const teile: string[] = [];
    const params: unknown[] = [];
    for (const k of Object.keys(SPALTE) as Array<keyof Setzbar>) {
      if (d[k] === undefined) continue;
      teile.push(`${SPALTE[k]} = ?`);
      params.push(d[k]);
    }
    if (teile.length === 0) return;
    teile.push('updated_at = ?');
    params.push(new Date().toISOString(), id, userId);
    await this.db.execute(`UPDATE infra_bauplan_vorlagen SET ${teile.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }
}
