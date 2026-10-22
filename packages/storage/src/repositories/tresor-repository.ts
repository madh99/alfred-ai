import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * I4c (Spec Infrastruktur-Vorhaben, Owner 22.10.2026 5b-5) — Tresor: nur verschlüsselte Werte (AES-256-GCM, Schlüssel außerhalb der
 * DB in data/tresor.key) und ein Zugriffsprotokoll ohne Werte.
 */
export class TresorRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async liste(userId: string): Promise<Array<{ name: string; herkunft: string; zweck?: string; erstellt: string; geaendert: string }>> {
    const rows = await this.db.query('SELECT name, herkunft, zweck, erstellt, geaendert FROM tresor_eintraege WHERE user_id = ? ORDER BY name', [userId]);
    return rows.map(r => { const x = r as Record<string, unknown>; return { name: String(x.name), herkunft: String(x.herkunft), ...(x.zweck ? { zweck: String(x.zweck) } : {}), erstellt: String(x.erstellt), geaendert: String(x.geaendert) }; });
  }

  async roh(userId: string, name: string): Promise<string | undefined> {
    const r = await this.db.queryOne('SELECT wert FROM tresor_eintraege WHERE user_id = ? AND name = ?', [userId, name]);
    return r ? String((r as { wert: string }).wert) : undefined;
  }

  async setze(userId: string, name: string, chiffre: string, herkunft: string, zweck?: string): Promise<void> {
    const jetzt = new Date().toISOString();
    const da = await this.db.queryOne('SELECT id FROM tresor_eintraege WHERE user_id = ? AND name = ?', [userId, name]);
    if (da) await this.db.execute('UPDATE tresor_eintraege SET wert = ?, herkunft = ?, zweck = COALESCE(?, zweck), geaendert = ? WHERE user_id = ? AND name = ?', [chiffre, herkunft, zweck ?? null, jetzt, userId, name]);
    else await this.db.execute('INSERT INTO tresor_eintraege (id, user_id, name, wert, herkunft, zweck, erstellt, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), userId, name, chiffre, herkunft, zweck ?? null, jetzt, jetzt]);
  }

  async entferne(userId: string, name: string): Promise<boolean> {
    const da = await this.db.queryOne('SELECT id FROM tresor_eintraege WHERE user_id = ? AND name = ?', [userId, name]);
    if (!da) return false;
    await this.db.execute('DELETE FROM tresor_eintraege WHERE user_id = ? AND name = ?', [userId, name]);
    return true;
  }

  async protokolliere(userId: string, name: string, art: string, wofuer?: string): Promise<void> {
    await this.db.execute('INSERT INTO tresor_protokoll (id, user_id, name, art, wofuer, zeit) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), userId, name, art, wofuer ?? null, new Date().toISOString()]);
  }

  async protokoll(userId: string, limit = 50): Promise<Array<{ name: string; art: string; wofuer?: string; zeit: string }>> {
    const rows = await this.db.query('SELECT name, art, wofuer, zeit FROM tresor_protokoll WHERE user_id = ? ORDER BY zeit DESC LIMIT ?', [userId, limit]);
    return rows.map(r => { const x = r as Record<string, unknown>; return { name: String(x.name), art: String(x.art), ...(x.wofuer ? { wofuer: String(x.wofuer) } : {}), zeit: String(x.zeit) }; });
  }
}
