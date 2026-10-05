import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Jarvis Schicht 1 — Messwerte: Stichproben von Datenquellen (Home Assistant,
 * später ESS/Infra) als Zeitreihe. Daraus entstehen die Baselines (Median je
 * Tagesstunde) der Normalzustands-Schicht. Aufbewahrung 60 Tage.
 */
export interface Messwert {
  entity: string;
  wert?: number;
  text?: string;
  einheit?: string;
  zeit: string;
  quelle?: string;
}

export class MesswerteRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async record(userId: string, m: Messwert): Promise<void> {
    await this.db.execute(
      'INSERT INTO messwerte (id, user_id, entity, wert, text, einheit, gemessen_at, quelle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), userId, m.entity, m.wert ?? null, m.text ?? null, m.einheit ?? null, m.zeit, m.quelle ?? 'homeassistant'],
    );
  }

  /** Verlauf einer Entität seit `sinceIso`, aufsteigend. */
  async verlauf(userId: string, entity: string, sinceIso: string, limit = 2000): Promise<Messwert[]> {
    const rows = await this.db.query(
      'SELECT entity, wert, text, einheit, gemessen_at, quelle FROM messwerte WHERE user_id = ? AND entity = ? AND gemessen_at >= ? ORDER BY gemessen_at ASC LIMIT ?',
      [userId, entity, sinceIso, limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  /** Verlauf mehrerer Entitäten (für die Deutungsschicht) seit `sinceIso`. */
  async verlaufMehrere(userId: string, entities: string[], sinceIso: string): Promise<Messwert[]> {
    const out: Messwert[] = [];
    for (const e of entities) out.push(...await this.verlauf(userId, e, sinceIso));
    return out;
  }

  /** Jüngster Messwert je Entität einer Quelle (z. B. alle Sensorbatterien) — ohne zusätzlichen HA-Aufruf. */
  async letzteProEntity(userId: string, quelle: string, maxAlterStunden = 48): Promise<Messwert[]> {
    const since = new Date(Date.now() - maxAlterStunden * 3600_000).toISOString();
    const rows = await this.db.query(
      `SELECT m.entity, m.wert, m.text, m.einheit, m.gemessen_at, m.quelle
         FROM messwerte m
         JOIN (SELECT entity, MAX(gemessen_at) AS t FROM messwerte WHERE user_id = ? AND quelle = ? AND gemessen_at >= ? GROUP BY entity) j
           ON j.entity = m.entity AND j.t = m.gemessen_at
        WHERE m.user_id = ? AND m.quelle = ?
        ORDER BY m.entity`,
      [userId, quelle, since, userId, quelle],
    ) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  async anzahl(userId: string, entity: string): Promise<number> {
    const row = await this.db.queryOne('SELECT COUNT(*) AS n FROM messwerte WHERE user_id = ? AND entity = ?', [userId, entity]) as { n?: number | string } | undefined;
    return Number(row?.n ?? 0);
  }

  async aufraeumen(tage = 60): Promise<number> {
    const cutoff = new Date(Date.now() - tage * 86_400_000).toISOString();
    const r = await this.db.execute('DELETE FROM messwerte WHERE gemessen_at < ?', [cutoff]);
    return r.changes ?? 0;
  }

  private map(r: Record<string, unknown>): Messwert {
    return {
      entity: r.entity as string,
      wert: r.wert === null || r.wert === undefined ? undefined : Number(r.wert),
      text: (r.text as string | null) ?? undefined,
      einheit: (r.einheit as string | null) ?? undefined,
      zeit: r.gemessen_at as string,
      quelle: (r.quelle as string | null) ?? undefined,
    };
  }
}
