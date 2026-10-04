import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

/**
 * Jarvis Schicht 0 — Lebenszeichen: ein Lauf eines registrierten Jobs.
 * Jeder Lauf (je User oder global) wird mit Start, Ende, Ergebnis und Zählern
 * festgehalten — die Datenbasis für Proben („lief der Job innerhalb seines
 * Takts?") und die Dashboard-Kachel.
 */
export interface JobRun {
  id: string;
  jobKey: string;
  userId?: string;
  nodeId?: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  zaehler?: Record<string, number>;
  fehler?: string;
}

export class JobRunsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async start(jobKey: string, userId: string | null, nodeId: string): Promise<string> {
    const id = randomUUID();
    await this.db.execute(
      'INSERT INTO job_runs (id, job_key, user_id, node_id, started_at) VALUES (?, ?, ?, ?, ?)',
      [id, jobKey, userId, nodeId, new Date().toISOString()],
    );
    return id;
  }

  async finish(id: string, ok: boolean, zaehler?: Record<string, number>, fehler?: string): Promise<void> {
    await this.db.execute(
      'UPDATE job_runs SET finished_at = ?, ok = ?, zaehler = ?, fehler = ? WHERE id = ?',
      [new Date().toISOString(), ok ? 1 : 0, zaehler ? JSON.stringify(zaehler) : null, fehler ?? null, id],
    );
  }

  /** Jüngster abgeschlossener Lauf eines Jobs (für Proben und Kachel). */
  async letzterLauf(jobKey: string): Promise<JobRun | undefined> {
    const row = await this.db.queryOne(
      'SELECT * FROM job_runs WHERE job_key = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      [jobKey],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /** Letzte Läufe aller Jobs (Kachel). */
  async listeLetzte(limit = 100): Promise<JobRun[]> {
    const rows = await this.db.query(
      'SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?',
      [limit],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  /** Läufe älter als `tage` löschen (Standard 90). */
  async aufraeumen(tage = 90): Promise<number> {
    const cutoff = new Date(Date.now() - tage * 86_400_000).toISOString();
    const r = await this.db.execute('DELETE FROM job_runs WHERE started_at < ?', [cutoff]);
    return r.changes ?? 0;
  }

  private mapRow(r: Record<string, unknown>): JobRun {
    let zaehler: Record<string, number> | undefined;
    if (typeof r.zaehler === 'string' && r.zaehler) {
      try { zaehler = JSON.parse(r.zaehler) as Record<string, number>; } catch { /* leer */ }
    }
    return {
      id: r.id as string,
      jobKey: r.job_key as string,
      userId: (r.user_id as string | null) ?? undefined,
      nodeId: (r.node_id as string | null) ?? undefined,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? undefined,
      ok: r.ok === null || r.ok === undefined ? undefined : Number(r.ok) === 1,
      zaehler,
      fehler: (r.fehler as string | null) ?? undefined,
    };
  }
}
