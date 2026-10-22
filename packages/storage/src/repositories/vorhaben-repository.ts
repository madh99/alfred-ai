import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * I2 (Spec Infrastruktur-Vorhaben, Owner 22.10.2026 „I2 wie vorgeschlagen umsetzen“) — ein Vorhaben bündelt ein Infrastruktur-Ziel
 * („Dockerhost aufteilen“), den Bestand, auf dem es aufbaut, die Zielarchitektur (Struktur + CMDB-Dokument), die Entscheidungen
 * des Owners und später die ITSM-Changes (I3). Es führt nichts aus.
 *   entwurf                  — angelegt, noch keine gültige Architektur
 *   architektur_vorgeschlagen — Architektur geprüft und als Dokument abgelegt, Owner-Entscheidung steht aus
 *   angenommen               — Owner hat die Architektur angenommen (Grundlage für Changes, I3)
 *   verworfen                — Owner hat das Vorhaben verworfen
 */
export type VorhabenStatus = 'entwurf' | 'architektur_vorgeschlagen' | 'angenommen' | 'verworfen';

export interface VorhabenEntscheidung { zeit: string; entscheidung: 'annehmen' | 'ablehnen' | 'ueberarbeiten'; wortlaut: string; architekturVersion: number }

export interface Vorhaben {
  id: string;
  userId: string;
  titel: string;
  ziel: string;
  /** Fernzugang-Namen, deren Bestand das Vorhaben umfasst */
  hosts: string[];
  status: VorhabenStatus;
  bestandDocId?: string;
  /** zuletzt geprüfte Architektur (Struktur, siehe core/infrastruktur/architektur.ts) */
  architektur?: unknown;
  architekturDocId?: string;
  architekturVersion: number;
  entscheidungen: VorhabenEntscheidung[];
  problemIds: string[];
  changeIds: string[];
  erstellt: string;
  geaendert: string;
}

const json = <T>(v: unknown, leer: T): T => { if (typeof v !== 'string' || !v) return leer; try { return JSON.parse(v) as T; } catch { return leer; } };

export class VorhabenRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async liste(userId: string, nurOffen = false): Promise<Vorhaben[]> {
    const rows = await this.db.query(
      `SELECT * FROM infra_vorhaben WHERE user_id = ?${nurOffen ? " AND status <> 'verworfen'" : ''} ORDER BY erstellt DESC`, [userId]);
    return rows.map(r => this.zeile(r as Record<string, unknown>));
  }

  async hole(userId: string, id: string): Promise<Vorhaben | null> {
    const r = await this.db.queryOne('SELECT * FROM infra_vorhaben WHERE user_id = ? AND id = ?', [userId, id]);
    return r ? this.zeile(r as Record<string, unknown>) : null;
  }

  /** Nach ID, ID-Anfang (ab 6 Zeichen) oder Titel (ohne Groß/Klein). */
  async finde(userId: string, schluessel: string): Promise<Vorhaben | null> {
    const k = schluessel.trim();
    const genau = await this.hole(userId, k);
    if (genau) return genau;
    const alle = await this.liste(userId);
    const treffer = alle.filter(v => (k.length >= 6 && v.id.startsWith(k)) || v.titel.toLowerCase() === k.toLowerCase());
    return treffer.length === 1 ? treffer[0]! : null;
  }

  async anlegen(userId: string, e: { titel: string; ziel: string; hosts: string[]; bestandDocId?: string; problemIds?: string[] }): Promise<Vorhaben> {
    const id = randomUUID();
    const jetzt = new Date().toISOString();
    await this.db.execute(
      'INSERT INTO infra_vorhaben (id, user_id, titel, ziel, hosts, status, bestand_doc_id, architektur_version, entscheidungen, problem_ids, change_ids, erstellt, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, userId, e.titel.trim(), e.ziel.trim(), JSON.stringify(e.hosts), 'entwurf', e.bestandDocId ?? null, 0, '[]', JSON.stringify(e.problemIds ?? []), '[]', jetzt, jetzt],
    );
    return (await this.hole(userId, id))!;
  }

  /** Neue geprüfte Architektur: Version +1, Status „architektur_vorgeschlagen“. */
  async setzeArchitektur(userId: string, id: string, architektur: unknown, docId: string, bestandDocId?: string): Promise<Vorhaben> {
    const v = await this.hole(userId, id);
    if (!v) throw new Error('Vorhaben nicht gefunden');
    await this.db.execute(
      'UPDATE infra_vorhaben SET architektur = ?, architektur_doc_id = ?, architektur_version = ?, status = ?, bestand_doc_id = COALESCE(?, bestand_doc_id), geaendert = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify(architektur), docId, v.architekturVersion + 1, 'architektur_vorgeschlagen', bestandDocId ?? null, new Date().toISOString(), id, userId],
    );
    return (await this.hole(userId, id))!;
  }

  async entscheide(userId: string, id: string, e: Omit<VorhabenEntscheidung, 'zeit'>, status: VorhabenStatus): Promise<Vorhaben> {
    const v = await this.hole(userId, id);
    if (!v) throw new Error('Vorhaben nicht gefunden');
    const jetzt = new Date().toISOString();
    await this.db.execute('UPDATE infra_vorhaben SET entscheidungen = ?, status = ?, geaendert = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify([...v.entscheidungen, { zeit: jetzt, ...e }]), status, jetzt, id, userId]);
    return (await this.hole(userId, id))!;
  }

  /** Einwand — Vorhaben zurück in den Entwurf (Architektur bleibt als Grundlage der Überarbeitung). */
  async setzeStatus(userId: string, id: string, status: VorhabenStatus): Promise<void> {
    await this.db.execute('UPDATE infra_vorhaben SET status = ?, geaendert = ? WHERE id = ? AND user_id = ?', [status, new Date().toISOString(), id, userId]);
  }

  /** I3 — Changes eines Vorhabens nachtragen (ohne Doppelte). */
  async fuegeChangesHinzu(userId: string, id: string, changeIds: string[]): Promise<void> {
    const v = await this.hole(userId, id);
    if (!v) throw new Error('Vorhaben nicht gefunden');
    const alle = [...new Set([...v.changeIds, ...changeIds])];
    await this.db.execute('UPDATE infra_vorhaben SET change_ids = ?, geaendert = ? WHERE id = ? AND user_id = ?', [JSON.stringify(alle), new Date().toISOString(), id, userId]);
  }

  private zeile(r: Record<string, unknown>): Vorhaben {
    return {
      id: String(r.id), userId: String(r.user_id), titel: String(r.titel), ziel: String(r.ziel),
      hosts: json<string[]>(r.hosts, []), status: String(r.status) as VorhabenStatus,
      ...(r.bestand_doc_id ? { bestandDocId: String(r.bestand_doc_id) } : {}),
      ...(r.architektur ? { architektur: json<unknown>(r.architektur, undefined) } : {}),
      ...(r.architektur_doc_id ? { architekturDocId: String(r.architektur_doc_id) } : {}),
      architekturVersion: Number(r.architektur_version ?? 0),
      entscheidungen: json<VorhabenEntscheidung[]>(r.entscheidungen, []),
      problemIds: json<string[]>(r.problem_ids, []), changeIds: json<string[]>(r.change_ids, []),
      erstellt: String(r.erstellt), geaendert: String(r.geaendert),
    };
  }
}
