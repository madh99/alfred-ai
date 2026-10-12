import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1362 — Spec „Entscheiden statt Abhaken" (Baustein D, Stufe E1): Regeln sind Entscheidungen des Owners für die Zukunft
 * — wie mit einem Befund (Quelle + Gegenstand) umgegangen wird. E1 kennt zwei Wirkungen:
 *   stumm         — aus diesem Befund entsteht bis `bis` kein Vorgang (der Befund selbst bleibt sichtbar)
 *   immer_fragen  — aus diesem Befund entsteht immer sofort ein Vorgang (gegen künftige Haltefristen, E2)
 * Herkunft owner (beim Abschluss gewählt) oder alfred (Vorschlag nach dreimal „kein Problem" — wird erst durch
 * „Übernehmen" aktiv). Widerrufbar; abgelaufene Regeln wirken nicht mehr.
 */
export type RegelWirkung = 'stumm' | 'immer_fragen';
export type RegelStatus = 'aktiv' | 'vorgeschlagen' | 'widerrufen' | 'abgelehnt';

export interface Regel {
  id: string;
  userId: string;
  quelle: string;
  gegenstand: string;
  /** Titel des Befunds bei Anlage (zur Anzeige) */
  titel: string;
  wirkung: RegelWirkung;
  bis?: string;
  begruendung?: string;
  herkunft: 'owner' | 'alfred';
  status: RegelStatus;
  vorgangId?: string;
  erstellt: string;
  geaendert: string;
}

export interface RegelEingang {
  quelle: string; gegenstand: string; titel: string; wirkung: RegelWirkung; bis?: string;
  begruendung?: string; herkunft: 'owner' | 'alfred'; vorgangId?: string;
}

export class RegelnRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /** Aktive Regel anlegen; eine bisher aktive oder vorgeschlagene für denselben Befund wird dabei abgelöst. */
  async anlegen(userId: string, e: RegelEingang): Promise<Regel> {
    return this.speichere(userId, e, 'aktiv');
  }

  /** Vorschlag von Alfred — wirkt erst nach „Übernehmen". Kein zweiter Vorschlag, solange einer offen oder eine Regel aktiv ist. */
  async vorschlagen(userId: string, e: RegelEingang): Promise<Regel | null> {
    const da = await this.db.queryOne(
      `SELECT id FROM regeln WHERE user_id = ? AND quelle = ? AND gegenstand = ? AND status IN ('aktiv', 'vorgeschlagen')`,
      [userId, e.quelle, e.gegenstand],
    );
    if (da) return null;
    return this.speichere(userId, e, 'vorgeschlagen');
  }

  private async speichere(userId: string, e: RegelEingang, status: RegelStatus): Promise<Regel> {
    const jetzt = new Date().toISOString();
    if (status === 'aktiv') {
      await this.db.execute(
        `UPDATE regeln SET status = 'widerrufen', geaendert = ? WHERE user_id = ? AND quelle = ? AND gegenstand = ? AND status IN ('aktiv', 'vorgeschlagen')`,
        [jetzt, userId, e.quelle, e.gegenstand],
      );
    }
    const r: Regel = { id: randomUUID(), userId, ...e, status, erstellt: jetzt, geaendert: jetzt };
    await this.db.execute(
      `INSERT INTO regeln (id, user_id, quelle, gegenstand, titel, wirkung, bis, begruendung, herkunft, status, vorgang_id, erstellt, geaendert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, userId, r.quelle, r.gegenstand, r.titel.slice(0, 300), r.wirkung, r.bis ?? null, r.begruendung?.slice(0, 500) ?? null, r.herkunft, r.status, r.vorgangId ?? null, jetzt, jetzt],
    );
    return r;
  }

  /** Die für einen Befund wirksame Regel (aktiv, nicht abgelaufen) oder null. */
  async wirksam(userId: string, quelle: string, gegenstand: string, jetzt = new Date()): Promise<Regel | null> {
    const rows = await this.db.query(
      `SELECT * FROM regeln WHERE user_id = ? AND quelle = ? AND gegenstand = ? AND status = 'aktiv' ORDER BY erstellt DESC`,
      [userId, quelle, gegenstand],
    ) as Record<string, unknown>[];
    const r = rows.map(x => this.map(x)).find(x => !x.bis || Date.parse(x.bis) > jetzt.getTime());
    return r ?? null;
  }

  /** Für App und Lage: offene Vorschläge und aktive (auch abgelaufene, zur Anzeige), jüngste zuerst. */
  async liste(userId: string): Promise<Regel[]> {
    const rows = await this.db.query(
      `SELECT * FROM regeln WHERE user_id = ? AND status IN ('aktiv', 'vorgeschlagen') ORDER BY erstellt DESC LIMIT 200`,
      [userId],
    ) as Record<string, unknown>[];
    return rows.map(x => this.map(x));
  }

  async hole(userId: string, id: string): Promise<Regel | null> {
    const r = await this.db.queryOne('SELECT * FROM regeln WHERE user_id = ? AND id = ?', [userId, id]) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  /** Übernehmen (Vorschlag → aktiv, ältere Regel zum Befund wird abgelöst), Ablehnen oder Widerrufen. */
  async setzeStatus(userId: string, id: string, status: 'aktiv' | 'abgelehnt' | 'widerrufen', bis?: string): Promise<Regel | null> {
    const r = await this.hole(userId, id);
    if (!r) return null;
    const jetzt = new Date().toISOString();
    if (status === 'aktiv') {
      await this.db.execute(
        `UPDATE regeln SET status = 'widerrufen', geaendert = ? WHERE user_id = ? AND quelle = ? AND gegenstand = ? AND status = 'aktiv' AND id <> ?`,
        [jetzt, userId, r.quelle, r.gegenstand, id],
      );
    }
    await this.db.execute('UPDATE regeln SET status = ?, bis = COALESCE(?, bis), geaendert = ? WHERE user_id = ? AND id = ?', [status, bis ?? null, jetzt, userId, id]);
    return { ...r, status, ...(bis ? { bis } : {}), geaendert: jetzt };
  }

  private map(r: Record<string, unknown>): Regel {
    return {
      id: r.id as string, userId: r.user_id as string, quelle: r.quelle as string, gegenstand: r.gegenstand as string,
      titel: (r.titel as string | null) ?? '', wirkung: r.wirkung as RegelWirkung, bis: (r.bis as string | null) ?? undefined,
      begruendung: (r.begruendung as string | null) ?? undefined, herkunft: r.herkunft as 'owner' | 'alfred',
      status: r.status as RegelStatus, vorgangId: (r.vorgang_id as string | null) ?? undefined,
      erstellt: r.erstellt as string, geaendert: r.geaendert as string,
    };
  }
}
