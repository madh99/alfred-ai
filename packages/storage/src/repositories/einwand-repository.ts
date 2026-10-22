import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Einwand (Owner 22.10.2026 „Einwand wie vorgeschlagen umsetzen“) — Widerspruch des Owners zu einem Change (gesamt oder einzelner
 * Schritt) oder zur Zielarchitektur eines Vorhabens (gesamt oder Abschnitt). Offen → Alfred muss im überarbeiteten Plan antworten
 * (umgesetzt/abgelehnt mit Begründung) → beantwortet → mit der nächsten Owner-Freigabe bzw. Annahme erledigt.
 */
export type EinwandZiel = 'change' | 'vorhaben';
export type EinwandStatus = 'offen' | 'beantwortet' | 'erledigt';
export interface Einwand {
  id: string; zielArt: EinwandZiel; zielId: string; bezug: string; text: string; quelle: string;
  status: EinwandStatus; antwortArt?: 'umgesetzt' | 'abgelehnt'; antwort?: string; antwortAt?: string; erstellt: string;
}

export class EinwandRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(userId: string, e: { zielArt: EinwandZiel; zielId: string; bezug: string; text: string; quelle: string }): Promise<Einwand> {
    const id = randomUUID(); const jetzt = new Date().toISOString();
    await this.db.execute('INSERT INTO infra_einwaende (id, user_id, ziel_art, ziel_id, bezug, text, quelle, status, erstellt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, e.zielArt, e.zielId, e.bezug, e.text.trim(), e.quelle, 'offen', jetzt]);
    return (await this.liste(userId, e.zielArt, e.zielId)).find(x => x.id === id)!;
  }

  async liste(userId: string, zielArt: EinwandZiel, zielId: string): Promise<Einwand[]> {
    const rows = await this.db.query('SELECT * FROM infra_einwaende WHERE user_id = ? AND ziel_art = ? AND ziel_id = ? ORDER BY erstellt', [userId, zielArt, zielId]);
    return rows.map(r => {
      const x = r as Record<string, unknown>;
      return {
        id: String(x.id), zielArt: String(x.ziel_art) as EinwandZiel, zielId: String(x.ziel_id), bezug: String(x.bezug), text: String(x.text), quelle: String(x.quelle),
        status: String(x.status) as EinwandStatus, ...(x.antwort_art ? { antwortArt: String(x.antwort_art) as 'umgesetzt' | 'abgelehnt' } : {}),
        ...(x.antwort ? { antwort: String(x.antwort) } : {}), ...(x.antwort_at ? { antwortAt: String(x.antwort_at) } : {}), erstellt: String(x.erstellt),
      };
    });
  }

  async beantworte(userId: string, id: string, art: 'umgesetzt' | 'abgelehnt', antwort: string): Promise<void> {
    await this.db.execute("UPDATE infra_einwaende SET status = 'beantwortet', antwort_art = ?, antwort = ?, antwort_at = ? WHERE user_id = ? AND id = ? AND status = 'offen'",
      [art, antwort.trim(), new Date().toISOString(), userId, id]);
  }

  async erledige(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.db.execute("UPDATE infra_einwaende SET status = 'erledigt' WHERE user_id = ? AND id = ? AND status = 'beantwortet'", [userId, id]);
  }
}
