import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';
import type { GeraetEintrag, GeraetManifest, GeraetPlattform, GeraetPush } from '@alfred/types';

/**
 * v1224 — Geräte-Registry: ein Eintrag je physischem Gerät des Owners.
 * Das Token wird nur als SHA-256-Hash gespeichert; das Gerät hält das Token selbst.
 */
export class GeraeteRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async anlegen(e: { userId: string; name: string; plattform: GeraetPlattform; manifest: GeraetManifest; tokenHash: string; scopes?: string[] }): Promise<GeraetEintrag> {
    const id = randomUUID();
    const jetzt = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO geraete (id, user_id, name, plattform, manifest, token_hash, scopes, status, zuletzt_gesehen, erstellt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'aktiv', NULL, ?)`,
      [id, e.userId, e.name, e.plattform, JSON.stringify(e.manifest), e.tokenHash, JSON.stringify(e.scopes ?? []), jetzt],
    );
    return { id, userId: e.userId, name: e.name, plattform: e.plattform, manifest: e.manifest, scopes: e.scopes ?? [], status: 'aktiv', erstellt: jetzt };
  }

  async findeDurchTokenHash(tokenHash: string): Promise<GeraetEintrag | undefined> {
    const row = await this.db.queryOne('SELECT * FROM geraete WHERE token_hash = ? AND status = ? LIMIT 1', [tokenHash, 'aktiv']) as Record<string, unknown> | undefined;
    return row ? this.map(row) : undefined;
  }

  async hole(id: string): Promise<GeraetEintrag | undefined> {
    const row = await this.db.queryOne('SELECT * FROM geraete WHERE id = ? LIMIT 1', [id]) as Record<string, unknown> | undefined;
    return row ? this.map(row) : undefined;
  }

  async liste(userId: string): Promise<GeraetEintrag[]> {
    const rows = await this.db.query('SELECT * FROM geraete WHERE user_id = ? ORDER BY erstellt ASC', [userId]) as Record<string, unknown>[];
    return rows.map(r => this.map(r));
  }

  async setzeZuletztGesehen(id: string, manifest?: GeraetManifest): Promise<void> {
    const jetzt = new Date().toISOString();
    if (manifest) await this.db.execute('UPDATE geraete SET zuletzt_gesehen = ?, manifest = ? WHERE id = ?', [jetzt, JSON.stringify(manifest), id]);
    else await this.db.execute('UPDATE geraete SET zuletzt_gesehen = ? WHERE id = ?', [jetzt, id]);
  }

  async widerrufe(userId: string, id: string): Promise<boolean> {
    // Phase 5 H2 — beim Widerruf auch den Push-Weg löschen (Spec §20.5 Punkt 3)
    const r = await this.db.execute('UPDATE geraete SET status = ?, push_art = NULL, push_token = NULL, apns_umgebung = NULL WHERE user_id = ? AND id = ?', ['widerrufen', userId, id]);
    return (r.changes ?? 0) > 0;
  }

  async setzeScopes(userId: string, id: string, scopes: string[]): Promise<void> {
    await this.db.execute('UPDATE geraete SET scopes = ? WHERE user_id = ? AND id = ?', [JSON.stringify(scopes), userId, id]);
  }

  /** Phase 5 H2 (Spec Geräte §20.5 Punkt 3) — Push-Weg des Geräts setzen; `undefined` löscht ihn (Widerruf, APNs 410). */
  async setzePush(id: string, push?: GeraetPush): Promise<void> {
    await this.db.execute('UPDATE geraete SET push_art = ?, push_token = ?, apns_umgebung = ? WHERE id = ?', [push?.art ?? null, push?.token ?? null, push?.umgebung ?? null, id]);
  }

  /** Aktive Geräte des Owners mit Push-Weg. */
  async mitPush(userId: string): Promise<Array<GeraetEintrag & { push: GeraetPush }>> {
    const rows = await this.db.query("SELECT * FROM geraete WHERE user_id = ? AND status = 'aktiv' AND push_token IS NOT NULL ORDER BY erstellt ASC", [userId]) as Record<string, unknown>[];
    return rows.map(r => ({ ...this.map(r), push: { art: r.push_art as GeraetPush['art'], token: r.push_token as string, umgebung: (r.apns_umgebung as GeraetPush['umgebung'] | null) ?? undefined } }));
  }

  private map(r: Record<string, unknown>): GeraetEintrag {
    let manifest: GeraetManifest;
    try { manifest = JSON.parse(String(r.manifest ?? '{}')) as GeraetManifest; } catch { manifest = { protokoll: 1, plattform: 'linux', hostname: '', satellitVersion: '', aktionen: [], sinne: [] }; }
    let scopes: string[] = [];
    try { scopes = JSON.parse(String(r.scopes ?? '[]')) as string[]; } catch { scopes = []; }
    return {
      id: r.id as string, userId: r.user_id as string, name: r.name as string, plattform: r.plattform as GeraetPlattform,
      manifest, scopes, status: r.status as 'aktiv' | 'widerrufen', zuletztGesehen: (r.zuletzt_gesehen as string | null) ?? undefined, erstellt: r.erstellt as string,
    };
  }
}
