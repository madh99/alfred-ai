import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Jarvis Schicht 3 — Vorgänge statt Insights.
 *
 * Ein Vorgang ist eine Handlung mit Besitzer, Status, nächstem Schritt und Frist.
 * Jede Ausführung schreibt einen Schritt ins Ausführungsgedächtnis
 * (`vorgang_schritte`), das der Kontext als „Bereits getan" einspeist.
 */
export type VorgangStatus = 'offen' | 'wartet' | 'erledigt' | 'verworfen';
export type Autonomie = 'auto' | 'bestaetigen' | 'nie';
export type SchrittArt = 'vorgeschlagen' | 'ausgefuehrt' | 'zur_bestaetigung' | 'bestaetigt' | 'abgelehnt' | 'fehlgeschlagen' | 'blockiert' | 'uebersprungen' | 'notiz';

export interface Vorgang {
  id: string;
  userId: string;
  titel: string;
  ziel?: string;
  besitzer: 'alfred' | 'user';
  status: VorgangStatus;
  naechsterSchritt?: string;
  frist?: string;
  quelle: string;
  ergebnis?: string;
  autonomie: Autonomie;
  dedupeKey?: string;
  erstellt: string;
  aktualisiert: string;
}

export interface VorgangSchritt {
  id: string;
  vorgangId?: string;
  userId: string;
  zeit: string;
  art: SchrittArt;
  skill?: string;
  aktion?: string;
  params?: Record<string, unknown>;
  beschreibung: string;
  ergebnis?: string;
  autonomie?: Autonomie;
  quelle: string;
}

export class VorgaengeRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(v: Omit<Vorgang, 'id' | 'erstellt' | 'aktualisiert'>): Promise<Vorgang> {
    const jetzt = new Date().toISOString();
    // Dedupe: offener Vorgang mit gleichem Schlüssel wird aktualisiert, nicht dupliziert
    if (v.dedupeKey) {
      const alt = await this.db.queryOne(
        `SELECT * FROM vorgaenge WHERE user_id = ? AND dedupe_key = ? AND status IN ('offen', 'wartet') ORDER BY erstellt DESC LIMIT 1`,
        [v.userId, v.dedupeKey],
      ) as Record<string, unknown> | undefined;
      if (alt) {
        await this.db.execute('UPDATE vorgaenge SET aktualisiert = ?, naechster_schritt = COALESCE(?, naechster_schritt) WHERE id = ?', [jetzt, v.naechsterSchritt ?? null, alt.id]);
        return { ...this.map(alt), aktualisiert: jetzt };
      }
    }
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO vorgaenge (id, user_id, titel, ziel, besitzer, status, naechster_schritt, frist, quelle, ergebnis, autonomie, dedupe_key, erstellt, aktualisiert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, v.userId, v.titel, v.ziel ?? null, v.besitzer, v.status, v.naechsterSchritt ?? null, v.frist ?? null, v.quelle, v.ergebnis ?? null, v.autonomie, v.dedupeKey ?? null, jetzt, jetzt],
    );
    return { ...v, id, erstellt: jetzt, aktualisiert: jetzt };
  }

  async setzeStatus(userId: string, id: string, status: VorgangStatus, ergebnis?: string): Promise<void> {
    await this.db.execute('UPDATE vorgaenge SET status = ?, ergebnis = COALESCE(?, ergebnis), aktualisiert = ? WHERE user_id = ? AND id = ?', [status, ergebnis ?? null, new Date().toISOString(), userId, id]);
  }

  async offene(userId: string, limit = 50): Promise<Vorgang[]> {
    const rows = await this.db.query(`SELECT * FROM vorgaenge WHERE user_id = ? AND status IN ('offen', 'wartet') ORDER BY aktualisiert DESC LIMIT ?`, [userId, limit]) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  async schritt(s: Omit<VorgangSchritt, 'id' | 'zeit'> & { zeit?: string }): Promise<string> {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO vorgang_schritte (id, vorgang_id, user_id, zeit, art, skill, aktion, params, beschreibung, ergebnis, autonomie, quelle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, s.vorgangId ?? null, s.userId, s.zeit ?? new Date().toISOString(), s.art, s.skill ?? null, s.aktion ?? null, s.params ? JSON.stringify(s.params).slice(0, 4000) : null, s.beschreibung.slice(0, 500), s.ergebnis?.slice(0, 1000) ?? null, s.autonomie ?? null, s.quelle],
    );
    if (s.vorgangId) await this.db.execute('UPDATE vorgaenge SET aktualisiert = ? WHERE id = ?', [new Date().toISOString(), s.vorgangId]).catch(() => undefined);
    return id;
  }

  /** Ausführungsgedächtnis: Schritte der letzten `tage` Tage, jüngste zuerst. */
  async schritte(userId: string, tage = 14, limit = 200): Promise<VorgangSchritt[]> {
    const seit = new Date(Date.now() - tage * 86_400_000).toISOString();
    const rows = await this.db.query('SELECT * FROM vorgang_schritte WHERE user_id = ? AND zeit >= ? ORDER BY zeit DESC LIMIT ?', [userId, seit, limit]) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string, vorgangId: (r.vorgang_id as string | null) ?? undefined, userId: r.user_id as string, zeit: r.zeit as string,
      art: r.art as SchrittArt, skill: (r.skill as string | null) ?? undefined, aktion: (r.aktion as string | null) ?? undefined,
      params: typeof r.params === 'string' && r.params ? safeJson(r.params) : undefined,
      beschreibung: r.beschreibung as string, ergebnis: (r.ergebnis as string | null) ?? undefined,
      autonomie: (r.autonomie as Autonomie | null) ?? undefined, quelle: r.quelle as string,
    }));
  }

  async aufraeumen(tage = 90): Promise<number> {
    const cutoff = new Date(Date.now() - tage * 86_400_000).toISOString();
    const r = await this.db.execute('DELETE FROM vorgang_schritte WHERE zeit < ?', [cutoff]);
    return r.changes ?? 0;
  }

  private map(r: Record<string, unknown>): Vorgang {
    return {
      id: r.id as string, userId: r.user_id as string, titel: r.titel as string, ziel: (r.ziel as string | null) ?? undefined,
      besitzer: r.besitzer as 'alfred' | 'user', status: r.status as VorgangStatus,
      naechsterSchritt: (r.naechster_schritt as string | null) ?? undefined, frist: (r.frist as string | null) ?? undefined,
      quelle: r.quelle as string, ergebnis: (r.ergebnis as string | null) ?? undefined, autonomie: r.autonomie as Autonomie,
      dedupeKey: (r.dedupe_key as string | null) ?? undefined, erstellt: r.erstellt as string, aktualisiert: r.aktualisiert as string,
    };
  }
}

function safeJson(s: string): Record<string, unknown> | undefined { try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; } }
