import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1217 — Jarvis Schicht 3: Befunde mit Identität.
 *
 * Ein Befund ist ein Objekt mit Schlüssel Quelle + Gegenstand (z. B. sensorbatterien /
 * sensor.temp_terrasse_battery), nicht ein Satz. Er entsteht, wenn das Weltmodell den
 * Gegenstand als auffällig einstuft, wird bei jeder Beobachtung fortgeschrieben
 * (zuletzt gesehen, Anzahl) und gilt als erledigt, sobald er nicht mehr auffällig ist.
 * Realfall 06.10.: „Proxmox git-server 95 % RAM" existierte fünfmal als Vorgang in
 * neuem Wortlaut — weil das Modell jeden Pass Prosa schrieb und daraus Objekte
 * abgeleitet wurden. Mit Befunden ist die Identität deterministisch.
 */
export type BefundZustand = 'offen' | 'erledigt';

export interface Befund {
  id: string;
  userId: string;
  quelle: string;
  gegenstand: string;
  titel: string;
  detail?: string;
  zustand: BefundZustand;
  entstanden: string;
  zuletztGesehen: string;
  erledigtAm?: string;
  gesehenAnzahl: number;
  vorgangId?: string;
}

export interface BefundEingang { gegenstand: string; titel: string; detail?: string }
export interface BefundSync { neu: Befund[]; weiter: Befund[]; erledigt: Befund[] }

export class BefundeRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  /**
   * Aktuelle Auffälligkeiten einer Quelle mit dem Bestand abgleichen:
   * neu → anlegen (oder erledigten Befund wieder öffnen), bekannt → fortschreiben,
   * verschwunden → erledigt. Idempotent je Beobachtung.
   */
  async sync(userId: string, quelle: string, aktuelle: BefundEingang[]): Promise<BefundSync> {
    const jetzt = new Date().toISOString();
    const offene = await this.offeneDerQuelle(userId, quelle);
    const offenNachGegenstand = new Map(offene.map(b => [b.gegenstand, b]));
    const ergebnis: BefundSync = { neu: [], weiter: [], erledigt: [] };
    const gesehen = new Set<string>();

    for (const a of aktuelle) {
      if (!a.gegenstand || gesehen.has(a.gegenstand)) continue;
      gesehen.add(a.gegenstand);
      const alt = offenNachGegenstand.get(a.gegenstand);
      if (alt) {
        await this.db.execute(
          'UPDATE befunde SET zuletzt_gesehen = ?, gesehen_anzahl = gesehen_anzahl + 1, titel = ?, detail = COALESCE(?, detail) WHERE id = ?',
          [jetzt, a.titel.slice(0, 300), a.detail?.slice(0, 2000) ?? null, alt.id],
        );
        ergebnis.weiter.push({ ...alt, zuletztGesehen: jetzt, gesehenAnzahl: alt.gesehenAnzahl + 1, titel: a.titel.slice(0, 300), detail: a.detail ?? alt.detail });
        continue;
      }
      const erledigter = await this.db.queryOne(
        'SELECT * FROM befunde WHERE user_id = ? AND quelle = ? AND gegenstand = ? LIMIT 1',
        [userId, quelle, a.gegenstand],
      ) as Record<string, unknown> | undefined;
      if (erledigter) {
        // Wieder aufgetreten: derselbe Befund öffnet erneut (Identität bleibt, Zähler läuft weiter)
        await this.db.execute(
          'UPDATE befunde SET zustand = ?, entstanden = ?, zuletzt_gesehen = ?, erledigt_am = NULL, gesehen_anzahl = gesehen_anzahl + 1, titel = ?, detail = ?, vorgang_id = NULL WHERE id = ?',
          ['offen', jetzt, jetzt, a.titel.slice(0, 300), a.detail?.slice(0, 2000) ?? null, erledigter.id as string],
        );
        const b = this.map(erledigter);
        ergebnis.neu.push({ ...b, zustand: 'offen', entstanden: jetzt, zuletztGesehen: jetzt, erledigtAm: undefined, gesehenAnzahl: b.gesehenAnzahl + 1, titel: a.titel.slice(0, 300), detail: a.detail, vorgangId: undefined });
        continue;
      }
      const id = randomUUID();
      await this.db.execute(
        `INSERT INTO befunde (id, user_id, quelle, gegenstand, titel, detail, zustand, entstanden, zuletzt_gesehen, erledigt_am, gesehen_anzahl, vorgang_id)
         VALUES (?, ?, ?, ?, ?, ?, 'offen', ?, ?, NULL, 1, NULL)`,
        [id, userId, quelle, a.gegenstand, a.titel.slice(0, 300), a.detail?.slice(0, 2000) ?? null, jetzt, jetzt],
      );
      ergebnis.neu.push({ id, userId, quelle, gegenstand: a.gegenstand, titel: a.titel.slice(0, 300), detail: a.detail, zustand: 'offen', entstanden: jetzt, zuletztGesehen: jetzt, gesehenAnzahl: 1 });
    }

    for (const b of offene) {
      if (gesehen.has(b.gegenstand)) continue;
      await this.db.execute('UPDATE befunde SET zustand = ?, erledigt_am = ? WHERE id = ?', ['erledigt', jetzt, b.id]);
      ergebnis.erledigt.push({ ...b, zustand: 'erledigt', erledigtAm: jetzt });
    }
    return ergebnis;
  }

  async setzeVorgang(id: string, vorgangId: string): Promise<void> {
    await this.db.execute('UPDATE befunde SET vorgang_id = ? WHERE id = ?', [vorgangId, id]);
  }

  async offene(userId: string): Promise<Befund[]> {
    const rows = await this.db.query('SELECT * FROM befunde WHERE user_id = ? AND zustand = ? ORDER BY entstanden ASC', [userId, 'offen']) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  private async offeneDerQuelle(userId: string, quelle: string): Promise<Befund[]> {
    const rows = await this.db.query('SELECT * FROM befunde WHERE user_id = ? AND quelle = ? AND zustand = ?', [userId, quelle, 'offen']) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  async erledigtSeit(userId: string, seitIso: string): Promise<Befund[]> {
    const rows = await this.db.query('SELECT * FROM befunde WHERE user_id = ? AND zustand = ? AND erledigt_am >= ? ORDER BY erledigt_am DESC', [userId, 'erledigt', seitIso]) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  /** Für Kachel und Lage: offene Befunde (älteste zuerst) und die seit 24 h erledigten. */
  async uebersicht(userId: string): Promise<{ offen: Befund[]; erledigt24h: Befund[] }> {
    const seit = new Date(Date.now() - 24 * 3_600_000).toISOString();
    return { offen: await this.offene(userId), erledigt24h: await this.erledigtSeit(userId, seit) };
  }

  private map(r: Record<string, unknown>): Befund {
    return {
      id: r.id as string, userId: r.user_id as string, quelle: r.quelle as string, gegenstand: r.gegenstand as string,
      titel: r.titel as string, detail: (r.detail as string | null) ?? undefined, zustand: r.zustand as BefundZustand,
      entstanden: r.entstanden as string, zuletztGesehen: r.zuletzt_gesehen as string, erledigtAm: (r.erledigt_am as string | null) ?? undefined,
      gesehenAnzahl: Number(r.gesehen_anzahl ?? 0), vorgangId: (r.vorgang_id as string | null) ?? undefined,
    };
  }
}
