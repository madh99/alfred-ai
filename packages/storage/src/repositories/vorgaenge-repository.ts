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
  /** v1186 — Kategorie (Insight-Kategorie bzw. Skill) für die Erledigungsquote je Kategorie. */
  kategorie?: string;
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

/**
 * v1185 — Titel-Ähnlichkeit: Anteil der Wörter (≥ 4 Zeichen) des KÜRZEREN Titels, die
 * im anderen vorkommen — gleich oder als Wortbestandteil („Dateizugriff" ~ „Zugriff",
 * „E-Mails" ~ „E-Mail"). Mindestens zwei Treffer, sonst 0.
 *
 * Realfall 05.10.: „Kritische Systemfehler – E-Mail & Dateizugriff" (12:31) und
 * „Kritische Systemfehler: E-Mail- und File-Zugriff blockiert (50%/75% Error-Rate)"
 * (13:01) wurden zwei Vorgänge. Gegenbeispiel, das NICHT verschmelzen darf:
 * „Batterie Terrasse tauschen" vs. „Batterie Wohnzimmer tauschen" (zwei Sensoren) —
 * deshalb gilt als gleich nur, wenn JEDES Wort des kürzeren Titels wiederkehrt.
 */
export function titelAehnlichkeit(a: string, b: string): number {
  const woerter = (t: string) => [...new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4))];
  let wa = woerter(a); let wb = woerter(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  if (wa.length > wb.length) [wa, wb] = [wb, wa];
  const passt = (w: string) => wb.some(x => x === w || (x.length >= 4 && w.length >= 4 && (x.includes(w) || w.includes(x))));
  const gemeinsam = wa.filter(passt).length;
  if (gemeinsam < 2) return 0;
  return gemeinsam / wa.length;
}

/** Gleiches Thema nur, wenn jedes Wort des kürzeren Titels wiederkehrt. */
export const VORGANG_AEHNLICHKEIT_SCHWELLE = 1;

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
    // v1185 — gleiches Thema in anderem Wortlaut: offener Vorgang mit ähnlichem Titel wird fortgeschrieben
    const aehnlich = await this.findeAehnlichenOffenen(v.userId, v.titel);
    if (aehnlich) {
      await this.db.execute('UPDATE vorgaenge SET aktualisiert = ? WHERE id = ?', [jetzt, aehnlich.id]);
      return { ...aehnlich, aktualisiert: jetzt };
    }
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO vorgaenge (id, user_id, titel, ziel, besitzer, status, naechster_schritt, frist, quelle, ergebnis, autonomie, dedupe_key, kategorie, erstellt, aktualisiert)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, v.userId, v.titel, v.ziel ?? null, v.besitzer, v.status, v.naechsterSchritt ?? null, v.frist ?? null, v.quelle, v.ergebnis ?? null, v.autonomie, v.dedupeKey ?? null, v.kategorie ?? null, jetzt, jetzt],
    );
    return { ...v, id, erstellt: jetzt, aktualisiert: jetzt };
  }

  async setzeStatus(userId: string, id: string, status: VorgangStatus, ergebnis?: string): Promise<void> {
    await this.db.execute('UPDATE vorgaenge SET status = ?, ergebnis = COALESCE(?, ergebnis), aktualisiert = ? WHERE user_id = ? AND id = ?', [status, ergebnis ?? null, new Date().toISOString(), userId, id]);
  }

  /** v1185 — offener Vorgang, dessen Titel dem gegebenen ähnlich ist (Jaccard ≥ Schwelle). */
  async findeAehnlichenOffenen(userId: string, titel: string, schwelle = VORGANG_AEHNLICHKEIT_SCHWELLE): Promise<Vorgang | null> {
    const offene = await this.offene(userId, 100);
    let best: Vorgang | null = null; let bestWert = 0;
    for (const v of offene) {
      const w = titelAehnlichkeit(v.titel, titel);
      if (w >= schwelle && w > bestWert) { best = v; bestWert = w; }
    }
    return best;
  }

  /** v1185 — Vorgänge, deren Frist ohne Entscheidung abgelaufen ist, werden verworfen (Kachel bleibt ehrlich). */
  async verfalleAbgelaufene(now = new Date()): Promise<number> {
    const r = await this.db.execute(
      `UPDATE vorgaenge SET status = 'verworfen', ergebnis = COALESCE(ergebnis, 'Frist abgelaufen ohne Entscheidung'), aktualisiert = ?
        WHERE status IN ('offen', 'wartet') AND frist IS NOT NULL AND frist < ?`,
      [now.toISOString(), now.toISOString()],
    );
    return r.changes ?? 0;
  }

  /** v1185 — Kachel: offene Vorgänge plus die in den letzten `tage` Tagen abgeschlossenen. */
  async uebersicht(userId: string, tage = 7): Promise<{ offene: Vorgang[]; abgeschlossene: Vorgang[] }> {
    const seit = new Date(Date.now() - tage * 86_400_000).toISOString();
    const offene = await this.offene(userId, 100);
    const rows = await this.db.query(
      `SELECT * FROM vorgaenge WHERE user_id = ? AND status IN ('erledigt', 'verworfen') AND aktualisiert >= ? ORDER BY aktualisiert DESC LIMIT 100`,
      [userId, seit],
    ) as Record<string, unknown>[];
    return { offene, abgeschlossene: rows.map(r => this.map(r)) };
  }

  async hole(userId: string, id: string): Promise<Vorgang | null> {
    const r = await this.db.queryOne('SELECT * FROM vorgaenge WHERE user_id = ? AND id = ?', [userId, id]) as Record<string, unknown> | undefined;
    return r ? this.map(r) : null;
  }

  /**
   * v1186 — Entscheidung des Owners (Kachel): erledigt oder verworfen, mit Schritt im
   * Ausführungsgedächtnis (bestaetigt/abgelehnt, quelle 'owner'). Das ist das
   * Ergebnis-Signal der Spezifikation („Erledigung: Vorgang geschlossen").
   */
  async entscheideOwner(userId: string, id: string, status: 'erledigt' | 'verworfen', notiz?: string): Promise<Vorgang | null> {
    const v = await this.hole(userId, id);
    if (!v) return null;
    await this.setzeStatus(userId, id, status, notiz ?? (status === 'erledigt' ? 'vom Owner erledigt' : 'vom Owner verworfen'));
    await this.schritt({
      vorgangId: id, userId, art: status === 'erledigt' ? 'bestaetigt' : 'abgelehnt',
      beschreibung: v.titel, ergebnis: notiz, autonomie: v.autonomie, quelle: 'owner',
    });
    return this.hole(userId, id);
  }

  /** v1186 — Erledigungsquote je Kategorie über die letzten `tage` Tage (Basis für Schicht-4-Konsequenzen). */
  async erledigungJeKategorie(userId: string, tage = 28): Promise<Array<{ kategorie: string; angelegt: number; erledigt: number; verworfen: number; offen: number }>> {
    const seit = new Date(Date.now() - tage * 86_400_000).toISOString();
    const rows = await this.db.query(
      'SELECT COALESCE(kategorie, ?) AS kategorie, status, COUNT(*) AS n FROM vorgaenge WHERE user_id = ? AND erstellt >= ? GROUP BY COALESCE(kategorie, ?), status',
      ['ohne', userId, seit, 'ohne'],
    ) as Array<{ kategorie: string; status: string; n: number | string }>;
    const out = new Map<string, { kategorie: string; angelegt: number; erledigt: number; verworfen: number; offen: number }>();
    for (const r of rows) {
      const e = out.get(r.kategorie) ?? { kategorie: r.kategorie, angelegt: 0, erledigt: 0, verworfen: 0, offen: 0 };
      const n = Number(r.n);
      e.angelegt += n;
      if (r.status === 'erledigt') e.erledigt += n;
      else if (r.status === 'verworfen') e.verworfen += n;
      else e.offen += n;
      out.set(r.kategorie, e);
    }
    return [...out.values()].sort((a, b) => b.angelegt - a.angelegt);
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
      kategorie: (r.kategorie as string | null) ?? undefined,
      dedupeKey: (r.dedupe_key as string | null) ?? undefined, erstellt: r.erstellt as string, aktualisiert: r.aktualisiert as string,
    };
  }
}

function safeJson(s: string): Record<string, unknown> | undefined { try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; } }
