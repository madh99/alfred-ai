import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * v1539 (Owner 21.10. „ssh über cmdb plus skill fernzugriff“) — SSH-Zugänge zu Hosts, die Alfred nicht selbst angelegt hat
 * (Proxmox-Knoten u. a.). Je Zugang: Host, Port, Benutzer, Pfad des privaten Schlüssels auf dem Server (der Schlüssel selbst
 * steht nie in der DB), der vom Owner bestätigte Host-Schlüssel (Pinning) und die Verknüpfung zum CMDB-Eintrag.
 *   wartet  — angelegt, Host-Schlüssel gelesen, Bestätigung des Owners steht aus
 *   aktiv   — Host-Schlüssel bestätigt, nutzbar
 *   gesperrt — vom Owner gesperrt oder Host-Schlüssel hat sich geändert
 */
export type FernzugangStatus = 'wartet' | 'aktiv' | 'gesperrt';

export interface Fernzugang {
  id: string;
  userId: string;
  name: string;
  host: string;
  port: number;
  benutzer: string;
  schluesselPfad: string;
  /** known_hosts-Zeilen des bestätigten (bzw. bei „wartet“: des gelesenen) Host-Schlüssels */
  hostSchluessel?: string;
  fingerabdruck?: string;
  cmdbAssetId?: string;
  status: FernzugangStatus;
  zuletztOk?: string;
  zuletztFehler?: string;
  erstellt: string;
  geaendert: string;
}

export class FernzugaengeRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async liste(userId: string): Promise<Fernzugang[]> {
    const rows = await this.db.query('SELECT * FROM fernzugaenge WHERE user_id = ? ORDER BY name', [userId]);
    return rows.map(r => this.zeile(r as Record<string, unknown>));
  }

  /** Nach Name (ohne Groß/Klein) oder Host. */
  async finde(userId: string, nameOderHost: string): Promise<Fernzugang | null> {
    const n = nameOderHost.trim().toLowerCase();
    const r = await this.db.queryOne('SELECT * FROM fernzugaenge WHERE user_id = ? AND (LOWER(name) = ? OR LOWER(host) = ?) ORDER BY geaendert DESC', [userId, n, n]);
    return r ? this.zeile(r as Record<string, unknown>) : null;
  }

  async hole(userId: string, id: string): Promise<Fernzugang | null> {
    const r = await this.db.queryOne('SELECT * FROM fernzugaenge WHERE user_id = ? AND id = ?', [userId, id]);
    return r ? this.zeile(r as Record<string, unknown>) : null;
  }

  /** Anlegen oder (gleicher Name) ersetzen — ein ersetzter Zugang muss seinen Host-Schlüssel neu bestätigen lassen. */
  async speichere(userId: string, e: { name: string; host: string; port: number; benutzer: string; schluesselPfad: string; hostSchluessel?: string; fingerabdruck?: string; cmdbAssetId?: string; status: FernzugangStatus }): Promise<Fernzugang> {
    const jetzt = new Date().toISOString();
    const da = await this.finde(userId, e.name);
    if (da && da.name.toLowerCase() === e.name.trim().toLowerCase()) {
      await this.db.execute(
        'UPDATE fernzugaenge SET host = ?, port = ?, benutzer = ?, schluessel_pfad = ?, host_schluessel = ?, fingerabdruck = ?, cmdb_asset_id = ?, status = ?, geaendert = ? WHERE id = ? AND user_id = ?',
        [e.host, e.port, e.benutzer, e.schluesselPfad, e.hostSchluessel ?? null, e.fingerabdruck ?? null, e.cmdbAssetId ?? null, e.status, jetzt, da.id, userId],
      );
      return (await this.hole(userId, da.id))!;
    }
    const id = randomUUID();
    await this.db.execute(
      'INSERT INTO fernzugaenge (id, user_id, name, host, port, benutzer, schluessel_pfad, host_schluessel, fingerabdruck, cmdb_asset_id, status, erstellt, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, e.name.trim(), e.host, e.port, e.benutzer, e.schluesselPfad, e.hostSchluessel ?? null, e.fingerabdruck ?? null, e.cmdbAssetId ?? null, e.status, jetzt, jetzt],
    );
    return (await this.hole(userId, id))!;
  }

  async setzeStatus(userId: string, id: string, status: FernzugangStatus): Promise<void> {
    await this.db.execute('UPDATE fernzugaenge SET status = ?, geaendert = ? WHERE id = ? AND user_id = ?', [status, new Date().toISOString(), id, userId]);
  }

  async merkeErgebnis(userId: string, id: string, ok: boolean, fehler?: string): Promise<void> {
    const jetzt = new Date().toISOString();
    if (ok) await this.db.execute('UPDATE fernzugaenge SET zuletzt_ok = ?, zuletzt_fehler = NULL WHERE id = ? AND user_id = ?', [jetzt, id, userId]);
    else await this.db.execute('UPDATE fernzugaenge SET zuletzt_fehler = ? WHERE id = ? AND user_id = ?', [`${jetzt} ${(fehler ?? '').slice(0, 300)}`, id, userId]);
  }

  async entferne(userId: string, id: string): Promise<boolean> {
    const r = await this.db.execute('DELETE FROM fernzugaenge WHERE id = ? AND user_id = ?', [id, userId]);
    return r.changes > 0;
  }

  private zeile(r: Record<string, unknown>): Fernzugang {
    return {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), host: String(r.host), port: Number(r.port ?? 22),
      benutzer: String(r.benutzer), schluesselPfad: String(r.schluessel_pfad),
      hostSchluessel: (r.host_schluessel as string | null) ?? undefined, fingerabdruck: (r.fingerabdruck as string | null) ?? undefined,
      cmdbAssetId: (r.cmdb_asset_id as string | null) ?? undefined, status: r.status as FernzugangStatus,
      zuletztOk: (r.zuletzt_ok as string | null) ?? undefined, zuletztFehler: (r.zuletzt_fehler as string | null) ?? undefined,
      erstellt: String(r.erstellt), geaendert: String(r.geaendert),
    };
  }
}
