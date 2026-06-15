import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter, DbRow } from '../db-adapter.js';

export type SandboxStatus = 'creating' | 'running' | 'paused' | 'merging' | 'discarded' | 'failed' | 'cleaned';
export type SandboxResult = 'merged_to_main' | 'merged_via_pr' | 'discarded' | 'failed' | null;
export type SandboxProjectType =
  | 'node-vite' | 'node-next' | 'node-astro' | 'node-remix' | 'node-cra' | 'node-generic'
  // v901 — Multi-Stack-Sandbox: Python/PHP/Ruby/Go
  | 'python-django' | 'python-fastapi' | 'python-generic'
  | 'php-laravel' | 'php-generic'
  | 'ruby-rails' | 'go'
  | 'unknown';

export interface Sandbox {
  id: string;
  projectId: string;
  sessionId: string | null;
  userId: string;

  worktreePath: string;
  branchName: string;
  baseCommitSha: string;

  containerId: string | null;
  containerImage: string;
  hostPort: number | null;
  internalPort: number;
  projectType: SandboxProjectType | null;

  status: SandboxStatus;
  statusReason: string | null;
  nodeId: string;

  ramPeakMb: number | null;
  diskUsedMb: number | null;

  createdAt: string;
  lastActiveAt: string;
  destroyedAt: string | null;

  result: SandboxResult;
  resultPrUrl: string | null;

  /** v817 — kumulierte „running" Sekunden über alle Pause/Resume-Zyklen. */
  totalRunSeconds: number;
  /** v817 — Zeitstempel des letzten Übergangs nach 'running' (für Live-Counter). */
  lastResumedAt: string | null;
  /** v817 — Zeitstempel des letzten Übergangs nach 'paused' (für UI-Anzeige). */
  lastPausedAt: string | null;
}

export interface SandboxInsert {
  projectId: string;
  sessionId: string | null;
  userId: string;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
  containerImage: string;
  internalPort: number;
  projectType: SandboxProjectType | null;
  nodeId: string;
  /** Default 'creating'. */
  status?: SandboxStatus;
}

/**
 * v696 — Project-Agent Sandbox: persistente State-Tabelle für Worktree+Container
 * + Live-Preview-Sessions. Wird nur befüllt wenn sandbox.enabled = true.
 */
export class SandboxRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  async create(insert: SandboxInsert): Promise<Sandbox> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: Sandbox = {
      id,
      projectId: insert.projectId,
      sessionId: insert.sessionId,
      userId: insert.userId,
      worktreePath: insert.worktreePath,
      branchName: insert.branchName,
      baseCommitSha: insert.baseCommitSha,
      containerId: null,
      containerImage: insert.containerImage,
      hostPort: null,
      internalPort: insert.internalPort,
      projectType: insert.projectType,
      status: insert.status ?? 'creating',
      statusReason: null,
      nodeId: insert.nodeId,
      ramPeakMb: null,
      diskUsedMb: null,
      createdAt: now,
      lastActiveAt: now,
      destroyedAt: null,
      result: null,
      resultPrUrl: null,
      // v817 — Lifecycle-Tracking. Initial: noch nicht resumed, total_run_seconds=0.
      // Wird beim ersten Übergang nach 'running' (in markResumed) auf now() gesetzt.
      totalRunSeconds: 0,
      lastResumedAt: null,
      lastPausedAt: null,
    };
    await this.db.execute(
      `INSERT INTO project_agent_sandboxes (
        id, project_id, session_id, user_id,
        worktree_path, branch_name, base_commit_sha,
        container_id, container_image, host_port, internal_port, project_type,
        status, status_reason, node_id,
        ram_peak_mb, disk_used_mb,
        created_at, last_active_at, destroyed_at,
        result, result_pr_url,
        total_run_seconds, last_resumed_at, last_paused_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.projectId, row.sessionId, row.userId,
        row.worktreePath, row.branchName, row.baseCommitSha,
        row.containerId, row.containerImage, row.hostPort, row.internalPort, row.projectType,
        row.status, row.statusReason, row.nodeId,
        row.ramPeakMb, row.diskUsedMb,
        row.createdAt, row.lastActiveAt, row.destroyedAt,
        row.result, row.resultPrUrl,
        row.totalRunSeconds, row.lastResumedAt, row.lastPausedAt,
      ],
    );
    return row;
  }

  async getById(id: string): Promise<Sandbox | null> {
    const row = await this.db.queryOne(`SELECT * FROM project_agent_sandboxes WHERE id = ?`, [id]) as DbRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async getBySessionId(sessionId: string): Promise<Sandbox | null> {
    const row = await this.db.queryOne(`SELECT * FROM project_agent_sandboxes WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`, [sessionId]) as DbRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** v810 — Lookup über Worktree-Pfad (für dev-server-Log-Fetch aus dem Project-Agent-Runner). */
  async getByWorktreePath(worktreePath: string): Promise<Sandbox | null> {
    const row = await this.db.queryOne(`SELECT * FROM project_agent_sandboxes WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1`, [worktreePath]) as DbRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listByProject(projectId: string, statuses?: SandboxStatus[]): Promise<Sandbox[]> {
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      const rows = await this.db.query(
        `SELECT * FROM project_agent_sandboxes WHERE project_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`,
        [projectId, ...statuses],
      );
      return rows.map(r => this.mapRow(r));
    }
    const rows = await this.db.query(`SELECT * FROM project_agent_sandboxes WHERE project_id = ? ORDER BY created_at DESC`, [projectId]);
    return rows.map(r => this.mapRow(r));
  }

  async listActiveByUser(userId: string): Promise<Sandbox[]> {
    const rows = await this.db.query(
      `SELECT * FROM project_agent_sandboxes WHERE user_id = ? AND status IN ('creating', 'running', 'paused') ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(r => this.mapRow(r));
  }

  async listIdleSince(cutoffIso: string, statuses: SandboxStatus[] = ['running']): Promise<Sandbox[]> {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = await this.db.query(
      `SELECT * FROM project_agent_sandboxes WHERE last_active_at < ? AND status IN (${placeholders}) ORDER BY last_active_at ASC`,
      [cutoffIso, ...statuses],
    );
    return rows.map(r => this.mapRow(r));
  }

  async listByNodeAndStatus(nodeId: string, statuses: SandboxStatus[]): Promise<Sandbox[]> {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = await this.db.query(
      `SELECT * FROM project_agent_sandboxes WHERE node_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`,
      [nodeId, ...statuses],
    );
    return rows.map(r => this.mapRow(r));
  }

  async updateStatus(id: string, status: SandboxStatus, reason?: string): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET status = ?, status_reason = ?, last_active_at = ? WHERE id = ?`,
      [status, reason ?? null, new Date().toISOString(), id],
    );
  }

  /**
   * v817 — Übergang nach 'running' (initial-start oder resume): last_resumed_at = now.
   * Wird vom sandbox-manager bei `createForSession` (nach Container-ready) und bei
   * `resume()` aufgerufen. Setzt zusätzlich status='running'.
   */
  async markResumed(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE project_agent_sandboxes
       SET status = 'running', status_reason = NULL,
           last_resumed_at = ?, last_active_at = ?
       WHERE id = ?`,
      [now, now, id],
    );
  }

  /**
   * v817 — Übergang nach 'paused': total_run_seconds += (now - last_resumed_at),
   * last_paused_at = now, status='paused'. SQLite/PG-kompatibel: wir holen die
   * Differenz in JS damit kein DB-spezifisches Datums-SQL nötig ist.
   */
  async markPaused(id: string, reason?: string): Promise<void> {
    const sb = await this.getById(id);
    if (!sb) return;
    const now = new Date().toISOString();
    let addSeconds = 0;
    if (sb.lastResumedAt) {
      const delta = Date.now() - new Date(sb.lastResumedAt).getTime();
      addSeconds = Math.max(0, Math.floor(delta / 1000));
    }
    await this.db.execute(
      `UPDATE project_agent_sandboxes
       SET status = 'paused', status_reason = ?,
           total_run_seconds = total_run_seconds + ?,
           last_paused_at = ?, last_active_at = ?
       WHERE id = ?`,
      [reason ?? null, addSeconds, now, now, id],
    );
  }

  async setContainerInfo(id: string, containerId: string, hostPort: number): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET container_id = ?, host_port = ?, last_active_at = ? WHERE id = ?`,
      [containerId, hostPort, new Date().toISOString(), id],
    );
  }

  async clearContainer(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET container_id = NULL, host_port = NULL, last_active_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  }

  async touchActivity(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET last_active_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  }

  async updateResourceUsage(id: string, ramPeakMb: number | null, diskUsedMb: number | null): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET ram_peak_mb = COALESCE(?, ram_peak_mb), disk_used_mb = COALESCE(?, disk_used_mb) WHERE id = ?`,
      [ramPeakMb, diskUsedMb, id],
    );
  }

  async markDestroyed(id: string, result: NonNullable<SandboxResult>, prUrl?: string): Promise<void> {
    await this.db.execute(
      `UPDATE project_agent_sandboxes SET status = 'cleaned', result = ?, result_pr_url = ?, destroyed_at = ?, container_id = NULL, host_port = NULL WHERE id = ?`,
      [result, prUrl ?? null, new Date().toISOString(), id],
    );
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.execute(`DELETE FROM project_agent_sandboxes WHERE id = ?`, [id]);
  }

  /** Disk-Quota-Check: liefert die Summe aller `disk_used_mb` aktiver Sandboxes des Users. */
  async getActiveDiskUsageMb(userId: string): Promise<number> {
    const row = await this.db.queryOne(
      `SELECT COALESCE(SUM(disk_used_mb), 0) AS total FROM project_agent_sandboxes WHERE user_id = ? AND status NOT IN ('cleaned', 'discarded', 'failed')`,
      [userId],
    ) as { total: number | string } | undefined;
    if (!row) return 0;
    return typeof row.total === 'number' ? row.total : Number(row.total) || 0;
  }

  private mapRow(row: DbRow): Sandbox {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      sessionId: row.session_id ? String(row.session_id) : null,
      userId: String(row.user_id),
      worktreePath: String(row.worktree_path),
      branchName: String(row.branch_name),
      baseCommitSha: String(row.base_commit_sha),
      containerId: row.container_id ? String(row.container_id) : null,
      containerImage: String(row.container_image),
      hostPort: row.host_port == null ? null : Number(row.host_port),
      internalPort: Number(row.internal_port),
      projectType: (row.project_type as SandboxProjectType | null) ?? null,
      status: row.status as SandboxStatus,
      statusReason: row.status_reason ? String(row.status_reason) : null,
      nodeId: String(row.node_id),
      ramPeakMb: row.ram_peak_mb == null ? null : Number(row.ram_peak_mb),
      diskUsedMb: row.disk_used_mb == null ? null : Number(row.disk_used_mb),
      createdAt: String(row.created_at),
      lastActiveAt: String(row.last_active_at),
      destroyedAt: row.destroyed_at ? String(row.destroyed_at) : null,
      result: (row.result as SandboxResult) ?? null,
      resultPrUrl: row.result_pr_url ? String(row.result_pr_url) : null,
      totalRunSeconds: row.total_run_seconds == null ? 0 : Number(row.total_run_seconds),
      lastResumedAt: row.last_resumed_at ? String(row.last_resumed_at) : null,
      lastPausedAt: row.last_paused_at ? String(row.last_paused_at) : null,
    };
  }
}
