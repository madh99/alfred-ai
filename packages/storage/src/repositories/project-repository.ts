import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter } from '../db-adapter.js';

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'maintenance' | 'archived';
export type ProjectHealthMode = 'full' | 'minimal' | 'off';
/**
 * v665a — Speicher-Typ eines Projekts:
 *  - 'local'  : an eine Cluster-Node gebunden (node_id gesetzt)
 *  - 'shared' : auf einem konfigurierten Share (share_id gesetzt), allen Nodes zugänglich
 */
export type ProjectStorageType = 'local' | 'shared';
export type ProjectSessionType = 'project_agent' | 'code_agent' | 'delegate' | 'chat';
export type OpenItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type OpenItemPriority = 'low' | 'normal' | 'high';
export type HealthProbe = 'git' | 'build' | 'deps' | 'http';
export type HealthStatus = 'ok' | 'warning' | 'error' | 'skipped';

export interface ProjectHealthEntry {
  id: string;
  projectId: string;
  probe: HealthProbe;
  status: HealthStatus;
  details?: string;
  durationMs: number;
  checkedAt: string;
}

/**
 * v663a — Project Conventions: optional per-project rules für README/CHANGELOG/
 * Versioning/Branching/Commit-Style. Default = leer (alle opt-in).
 */
export interface ProjectConventions {
  readme?: {
    autoUpdate?: boolean;
    /** 'default' = Standard-Struktur, 'minimal' = nur Titel+Description, 'custom' = no-touch */
    template?: 'default' | 'minimal' | 'custom';
  };
  changelog?: {
    autoUpdate?: boolean;
    /** 'keepachangelog' = Keep a Changelog 1.1.0 Format mit [Unreleased]/[X.Y.Z] */
    format?: 'keepachangelog' | 'free';
  };
  commits?: {
    /** 'conventional' = feat:/fix:/refactor:/... Präfix erzwingen */
    convention?: 'conventional' | 'free';
    scopePolicy?: 'required' | 'optional' | 'forbidden';
  };
  branching?: {
    /** main-only = direkt auf main, feature-branches = pro Session ein Branch, gitflow = main/develop/feature */
    strategy?: 'main-only' | 'feature-branches' | 'gitflow';
    prTarget?: string;
  };
  versioning?: {
    scheme?: 'semver' | 'date' | 'custom';
    autoTag?: boolean;
  };
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description?: string;
  cwd?: string;
  repoUrl?: string;
  /** v643 — Default-Branch (HEAD), persisted from `git rev-parse --abbrev-ref HEAD`. */
  defaultBranch?: string;
  status: ProjectStatus;
  healthMode: ProjectHealthMode;
  tags: string[];
  createdAt: string;
  lastActiveAt: string;
  nextCheckAt?: string;
  /** v663a — Optional pro-Projekt Conventions (alle opt-in). */
  conventions?: ProjectConventions;
  /** v665a — Storage-Typ: 'local' an Node gebunden, 'shared' auf einem Cluster-Share */
  storageType?: ProjectStorageType;
  /** v665a — bei storageType='shared': ID des Shares aus infra.shares */
  shareId?: string;
  /** v665a — bei storageType='local': nodeId die das Projekt physisch hostet */
  nodeId?: string;
  /** v665a — Aktive Project-Lock: nodeId die gerade eine Session hält */
  lockedByNodeId?: string;
  /** v665a — TTL des Locks (ISO timestamp) — stale-cleanup bei `< now()` */
  lockedUntil?: string;
  /** v726 — Default-ENV-Stage für Sandbox-Erstellung (sandbox/dev/prod/custom). */
  defaultEnvStage?: string;
  /** v732 — Default-DB-Seed-ID für Sandbox-Erstellung. */
  defaultDbSeedId?: string;
  /** v755 — Maximale gleichzeitig aktive Sandboxes für dieses Projekt. NULL = nutzt User-Quota. */
  maxConcurrentSandboxes?: number;
  /**
   * v849 — Sandbox-Mode pro Projekt.
   * - 'single' (default): ein Docker-Container mit Node-Image (Status quo)
   * - 'compose': docker compose stack — User's docker-compose.yml wird mit
   *   Sandbox-spezifischem override-file ausgeführt. Multi-Service (App + DB
   *   + Redis etc.). Erfordert mehr Host-RAM (Resource-Guard prüft pre-flight).
   *
   * Strict opt-in: Default 'single' damit ALLE bestehenden Projekte ihr
   * aktuelles Verhalten behalten.
   */
  sandboxMode?: 'single' | 'compose';
  /**
   * v849 — Compose-Volume-Strategie.
   * - false (default): Volumes scoped pro Sandbox, Discard löscht sie
   * - true: Volume project-scoped, überlebt Sandbox-Discard
   *
   * Default false damit Test/Migration-Sandboxes nicht produktion-mock
   * verseuchen. User aktiviert pro Projekt wenn Daten persistent sein müssen.
   */
  persistDbVolumes?: boolean;
  /**
   * v849 — Wann project_db_seeds beim Sandbox-Start angewendet werden:
   * - 'none': nie automatisch
   * - 'first-start-only' (default): nur beim ersten Start einer neuen Sandbox
   * - 'every-start': bei jedem Sandbox-Start (auch resume)
   */
  dbSeedStrategy?: 'none' | 'first-start-only' | 'every-start';
}

export interface ProjectSessionSummary {
  whatWasDone?: string;
  keyDecisions?: Array<{ choice: string; rationale?: string }>;
  filesTouched?: string[];
  openItems?: Array<{ title: string; priority?: OpenItemPriority; description?: string; linkedIncidentId?: string }>;
  status?: 'success' | 'failed' | 'partial';
  nextCheckInDays?: number;
}

export interface ProjectSession {
  id: string;
  projectId: string;
  sessionType: ProjectSessionType;
  sourceId?: string;
  summary?: ProjectSessionSummary;
  startedAt: string;
  endedAt?: string;
  /** v812 — 'applied' (klassisch, sofort im Projekt) | 'pending' (Sandbox, ungemerged) | 'merged' | 'discarded' */
  mergeState?: 'applied' | 'pending' | 'merged' | 'discarded';
  /** v812 — verknüpft Sandbox-Runs mit ihrer Sandbox (für Merge/Discard-Cleanup) */
  sandboxId?: string;
}

export interface ProjectOpenItem {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  description?: string;
  priority: OpenItemPriority;
  status: OpenItemStatus;
  dueAt?: string;
  createdAt: string;
  resolvedAt?: string;
  /** ITSM-Incident-ID, falls dieses Open-Item ein bestehender Incident ist (Cross-Link). */
  linkedIncidentId?: string;
  /** ITSM-Change-ID, falls dieses Open-Item ein bestehender Change ist. */
  linkedChangeId?: string;
  /** v641 — wenn ≠ null wurde der Item auto-erkannt-als-erledigt (z.B. "project_agent_session:<id>"). */
  autoResolvedBy?: string;
  /** v641 — Konfidenz des LLM-Auto-Resolvers (0..1). */
  autoResolvedConfidence?: number;
  /** v663a — Roadmap-Milestone (frei: 'v2.0', 'Beta', 'Q3-2026'). Items mit Milestone = Roadmap-Items. */
  roadmapMilestone?: string;
  /** v663a — Sortierung innerhalb des Milestones (0 = oben) */
  roadmapOrder?: number;
  /** v663a — Geschätzte Aufwandsstunden (für Burndown/Planung) */
  estimatedHours?: number;
  /** v671 — Spiegel-Link zu einem Todo. Wenn gesetzt: Todo-Eintrag in todos-Tabelle, Status-Sync. */
  linkedTodoId?: string;
}

export interface ProjectDecision {
  id: string;
  projectId: string;
  sessionId?: string;
  title: string;
  choice: string;
  rationale?: string;
  alternativesConsidered?: string;
  createdAt: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'project';
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function parseSummary(raw: unknown): ProjectSessionSummary | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try { return JSON.parse(raw) as ProjectSessionSummary; } catch { return undefined; }
}

function rowToProject(row: Record<string, unknown>): Project {
  let conventions: ProjectConventions | undefined;
  if (row.conventions) {
    try { conventions = JSON.parse(row.conventions as string); } catch { /* skip */ }
  }
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? undefined,
    cwd: (row.cwd as string | null) ?? undefined,
    repoUrl: (row.repo_url as string | null) ?? undefined,
    defaultBranch: (row.default_branch as string | null) ?? undefined,
    status: (row.status as ProjectStatus) ?? 'active',
    healthMode: (row.health_mode as ProjectHealthMode) ?? 'full',
    tags: parseTags(row.tags),
    createdAt: row.created_at as string,
    lastActiveAt: row.last_active_at as string,
    nextCheckAt: (row.next_check_at as string | null) ?? undefined,
    conventions,
    storageType: (row.storage_type as ProjectStorageType | null) ?? 'local',
    shareId: (row.share_id as string | null) ?? undefined,
    nodeId: (row.node_id as string | null) ?? undefined,
    lockedByNodeId: (row.locked_by_node_id as string | null) ?? undefined,
    lockedUntil: (row.locked_until as string | null) ?? undefined,
    defaultEnvStage: (row.default_env_stage as string | null) ?? undefined,
    defaultDbSeedId: (row.default_db_seed_id as string | null) ?? undefined,
    maxConcurrentSandboxes: (row.max_concurrent_sandboxes as number | null) ?? undefined,
    // v849 — Compose-Stack fields
    sandboxMode: ((row.sandbox_mode as string | null) ?? 'single') as 'single' | 'compose',
    persistDbVolumes: Boolean(row.persist_db_volumes),
    dbSeedStrategy: ((row.db_seed_strategy as string | null) ?? 'first-start-only') as 'none' | 'first-start-only' | 'every-start',
  };
}

function rowToSession(row: Record<string, unknown>): ProjectSession {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionType: row.session_type as ProjectSessionType,
    sourceId: (row.source_id as string | null) ?? undefined,
    summary: parseSummary(row.summary_json),
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? undefined,
    mergeState: ((row.merge_state as string | null) ?? 'applied') as ProjectSession['mergeState'],
    sandboxId: (row.sandbox_id as string | null) ?? undefined,
  };
}

function rowToOpenItem(row: Record<string, unknown>): ProjectOpenItem {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: (row.session_id as string | null) ?? undefined,
    title: row.title as string,
    description: (row.description as string | null) ?? undefined,
    priority: (row.priority as OpenItemPriority) ?? 'normal',
    status: (row.status as OpenItemStatus) ?? 'open',
    dueAt: (row.due_at as string | null) ?? undefined,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? undefined,
    linkedIncidentId: (row.linked_incident_id as string | null) ?? undefined,
    linkedChangeId: (row.linked_change_id as string | null) ?? undefined,
    autoResolvedBy: (row.auto_resolved_by as string | null) ?? undefined,
    autoResolvedConfidence: row.auto_resolved_confidence != null ? Number(row.auto_resolved_confidence) : undefined,
    roadmapMilestone: (row.roadmap_milestone as string | null) ?? undefined,
    roadmapOrder: row.roadmap_order != null ? Number(row.roadmap_order) : undefined,
    estimatedHours: row.estimated_hours != null ? Number(row.estimated_hours) : undefined,
    // v671 — Spiegel-Link zu Todo
    linkedTodoId: (row.linked_todo_id as string | null) ?? undefined,
  };
}

function rowToDecision(row: Record<string, unknown>): ProjectDecision {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: (row.session_id as string | null) ?? undefined,
    title: row.title as string,
    choice: row.choice as string,
    rationale: (row.rationale as string | null) ?? undefined,
    alternativesConsidered: (row.alternatives_considered as string | null) ?? undefined,
    createdAt: row.created_at as string,
  };
}

/**
 * Long-lived project containers and their attached sessions/open-items/decisions.
 * Sessions from project-agent / code-agent / delegate flows attach here so Alfred
 * retains awareness of completed/ongoing work across conversations.
 */
export class ProjectRepository {
  constructor(private readonly adapter: AsyncDbAdapter) {}

  // ── Projects ────────────────────────────────────────────────────────────

  async create(userId: string, input: { name: string; description?: string; cwd?: string; repoUrl?: string; tags?: string[]; status?: ProjectStatus; healthMode?: ProjectHealthMode }): Promise<Project> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const slug = await this.uniqueSlug(userId, input.name);
    await this.adapter.execute(
      `INSERT INTO projects (id, user_id, name, slug, description, cwd, repo_url, status, health_mode, tags, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, input.name, slug, input.description ?? null, input.cwd ?? null, input.repoUrl ?? null,
        input.status ?? 'active', input.healthMode ?? 'full', JSON.stringify(input.tags ?? []), now, now,
      ],
    );
    return (await this.getById(userId, id))!;
  }

  private async uniqueSlug(userId: string, name: string): Promise<string> {
    const base = slugify(name);
    let slug = base;
    let i = 1;
    while (true) {
      const row = await this.adapter.queryOne(
        `SELECT 1 FROM projects WHERE user_id = ? AND slug = ?`, [userId, slug],
      ) as Record<string, unknown> | undefined;
      if (!row) return slug;
      i += 1;
      slug = `${base}-${i}`;
      if (i > 200) return `${base}-${randomUUID().slice(0, 8)}`;
    }
  }

  async getById(userId: string, id: string): Promise<Project | null> {
    let row = await this.adapter.queryOne(
      `SELECT * FROM projects WHERE id = ? AND user_id = ?`, [id, userId],
    ) as Record<string, unknown> | undefined;
    if (!row && id.length >= 6 && id.length <= 12 && /^[0-9a-f]+$/i.test(id)) {
      row = await this.adapter.queryOne(
        `SELECT * FROM projects WHERE id LIKE ? AND user_id = ?`, [id + '%', userId],
      ) as Record<string, unknown> | undefined;
    }
    return row ? rowToProject(row) : null;
  }

  /**
   * v667 — Lookup ohne Owner-Filter. Wird von der Pipeline benötigt um bei einem
   * Project-Chat den echten Project-Owner zu finden, damit Memory/KG-Loading mit
   * der richtigen Identität läuft (siehe message-pipeline.ts → Fix C).
   * NICHT für End-User-Endpoints verwenden — die müssen weiterhin getById() nutzen.
   */
  async getByIdAnyOwner(id: string): Promise<Project | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM projects WHERE id = ?`, [id],
    ) as Record<string, unknown> | undefined;
    return row ? rowToProject(row) : null;
  }

  async getBySlug(userId: string, slug: string): Promise<Project | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM projects WHERE user_id = ? AND slug = ?`, [userId, slug],
    ) as Record<string, unknown> | undefined;
    return row ? rowToProject(row) : null;
  }

  async findByCwd(userId: string, cwd: string): Promise<Project | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM projects WHERE user_id = ? AND cwd = ? AND status != 'archived' ORDER BY last_active_at DESC LIMIT 1`,
      [userId, cwd],
    ) as Record<string, unknown> | undefined;
    return row ? rowToProject(row) : null;
  }

  /**
   * v856 — Lookup ohne Owner-Filter via cwd. Wird vom ProjectAgent verifyTaskAccess
   * benötigt um die Eigentümer-User-ID einer Session anhand der cwd zu ermitteln,
   * ohne den ausführenden Caller zu kennen.
   * NICHT für End-User-Endpoints verwenden — die müssen weiterhin findByCwd() mit
   * explizitem userId-Filter nutzen.
   */
  async findByCwdAnyOwner(cwd: string): Promise<Project | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM projects WHERE cwd = ? AND status != 'archived' ORDER BY last_active_at DESC LIMIT 1`,
      [cwd],
    ) as Record<string, unknown> | undefined;
    return row ? rowToProject(row) : null;
  }

  async list(userId: string, filters?: { status?: ProjectStatus; limit?: number }): Promise<Project[]> {
    let sql = `SELECT * FROM projects WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    sql += ` ORDER BY last_active_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(rowToProject);
  }

  async update(userId: string, id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'cwd' | 'repoUrl' | 'defaultBranch' | 'status' | 'healthMode' | 'tags' | 'nextCheckAt' | 'conventions' | 'storageType' | 'shareId' | 'nodeId' | 'maxConcurrentSandboxes' | 'sandboxMode' | 'persistDbVolumes' | 'dbSeedStrategy'>>): Promise<Project | null> {
    const existing = await this.getById(userId, id);
    if (!existing) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?'); params.push(patch.name);
      const newSlug = await this.uniqueSlug(userId, patch.name);
      sets.push('slug = ?'); params.push(newSlug);
    }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (patch.cwd !== undefined) { sets.push('cwd = ?'); params.push(patch.cwd); }
    if (patch.repoUrl !== undefined) { sets.push('repo_url = ?'); params.push(patch.repoUrl); }
    if (patch.defaultBranch !== undefined) { sets.push('default_branch = ?'); params.push(patch.defaultBranch); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.healthMode !== undefined) { sets.push('health_mode = ?'); params.push(patch.healthMode); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(patch.tags)); }
    if (patch.nextCheckAt !== undefined) { sets.push('next_check_at = ?'); params.push(patch.nextCheckAt); }
    // v663a — Conventions als JSON
    if (patch.conventions !== undefined) {
      sets.push('conventions = ?');
      params.push(patch.conventions ? JSON.stringify(patch.conventions) : null);
    }
    // v665a — Storage-Felder
    if (patch.storageType !== undefined) { sets.push('storage_type = ?'); params.push(patch.storageType); }
    if (patch.shareId !== undefined) { sets.push('share_id = ?'); params.push(patch.shareId); }
    if (patch.nodeId !== undefined) { sets.push('node_id = ?'); params.push(patch.nodeId); }
    // v755 — Per-Project-Quota
    if (patch.maxConcurrentSandboxes !== undefined) { sets.push('max_concurrent_sandboxes = ?'); params.push(patch.maxConcurrentSandboxes ?? null); }
    // v849 — Compose-Stack fields
    if (patch.sandboxMode !== undefined) { sets.push('sandbox_mode = ?'); params.push(patch.sandboxMode); }
    if (patch.persistDbVolumes !== undefined) { sets.push('persist_db_volumes = ?'); params.push(patch.persistDbVolumes ? 1 : 0); }
    if (patch.dbSeedStrategy !== undefined) { sets.push('db_seed_strategy = ?'); params.push(patch.dbSeedStrategy); }
    if (sets.length === 0) return existing;
    params.push(existing.id);
    await this.adapter.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getById(userId, existing.id);
  }

  async touch(projectId: string): Promise<void> {
    await this.adapter.execute(
      `UPDATE projects SET last_active_at = ? WHERE id = ?`,
      [new Date().toISOString(), projectId],
    );
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const existing = await this.getById(userId, id);
    if (!existing) return false;
    const result = await this.adapter.execute(`DELETE FROM projects WHERE id = ?`, [existing.id]);
    return result.changes > 0;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async createSession(projectId: string, input: { sessionType: ProjectSessionType; sourceId?: string; summary?: ProjectSessionSummary; startedAt?: string; endedAt?: string; mergeState?: ProjectSession['mergeState']; sandboxId?: string }): Promise<ProjectSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const mergeState = input.mergeState ?? 'applied';
    await this.adapter.execute(
      `INSERT INTO project_sessions (id, project_id, session_type, source_id, summary_json, started_at, ended_at, merge_state, sandbox_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, projectId, input.sessionType, input.sourceId ?? null,
        input.summary ? JSON.stringify(input.summary) : null,
        input.startedAt ?? now, input.endedAt ?? null,
        mergeState, input.sandboxId ?? null,
      ],
    );
    return {
      id, projectId, sessionType: input.sessionType, sourceId: input.sourceId,
      summary: input.summary, startedAt: input.startedAt ?? now, endedAt: input.endedAt,
      mergeState, sandboxId: input.sandboxId,
    };
  }

  /**
   * v812 — Beim Merge: alle pending Sandbox-Sessions als 'merged' bestätigen.
   * Liefert die betroffenen Session-IDs (für nachgelagerte OpenItemMatcher-Auslösung).
   */
  async markSessionsMergedBySandbox(sandboxId: string): Promise<ProjectSession[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_sessions WHERE sandbox_id = ? AND merge_state = 'pending'`,
      [sandboxId],
    ) as Record<string, unknown>[];
    if (rows.length > 0) {
      await this.adapter.execute(
        `UPDATE project_sessions SET merge_state = 'merged' WHERE sandbox_id = ? AND merge_state = 'pending'`,
        [sandboxId],
      );
    }
    return rows.map(rowToSession);
  }

  /**
   * v812 — Beim Discard: pending Sandbox-Sessions als 'discarded' markieren (bleiben
   * für Arbeitszeit-Statistik erhalten) UND deren tentativ angelegte Open-Items +
   * Decisions löschen (die Arbeit wurde nicht angewendet → keine Projekt-Historie).
   * Liefert {sessions, openItems, decisions} Counts.
   */
  async discardSandboxSessionArtifacts(sandboxId: string): Promise<{ sessions: number; openItems: number; decisions: number }> {
    const sessions = await this.adapter.query(
      `SELECT id FROM project_sessions WHERE sandbox_id = ? AND merge_state = 'pending'`,
      [sandboxId],
    ) as Array<{ id: string }>;
    let openItems = 0;
    let decisions = 0;
    for (const s of sessions) {
      const oi = await this.adapter.execute(`DELETE FROM project_open_items WHERE session_id = ?`, [s.id]);
      const dec = await this.adapter.execute(`DELETE FROM project_decisions WHERE session_id = ?`, [s.id]);
      openItems += oi.changes ?? 0;
      decisions += dec.changes ?? 0;
    }
    if (sessions.length > 0) {
      await this.adapter.execute(
        `UPDATE project_sessions SET merge_state = 'discarded' WHERE sandbox_id = ? AND merge_state = 'pending'`,
        [sandboxId],
      );
    }
    return { sessions: sessions.length, openItems, decisions };
  }

  async updateSessionSummary(sessionId: string, summary: ProjectSessionSummary, endedAt?: string): Promise<void> {
    await this.adapter.execute(
      `UPDATE project_sessions SET summary_json = ?, ended_at = COALESCE(?, ended_at, ?) WHERE id = ?`,
      [JSON.stringify(summary), endedAt ?? null, new Date().toISOString(), sessionId],
    );
  }

  async findSessionBySource(sessionType: ProjectSessionType, sourceId: string): Promise<ProjectSession | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_sessions WHERE session_type = ? AND source_id = ? ORDER BY started_at DESC LIMIT 1`,
      [sessionType, sourceId],
    ) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  async listSessions(projectId: string, limit = 50): Promise<ProjectSession[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`,
      [projectId, limit],
    ) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  /**
   * v658 — Work-Stats: Aggregation der Arbeitszeit pro Projekt.
   *  - Gesamt: Anzahl + Sekunden über alle Sessions
   *  - byType: project_agent / code_agent / brainstorming / delegate
   *  - byAgent: claude-code / codex / etc. (LEFT JOIN auf project_agent_sessions)
   *
   * Für laufende Sessions (ended_at NULL) wird now() als endedAt genommen damit
   * der User die Live-Zeit aktiv laufender Agents sieht.
   */
  async getWorkStats(projectId: string): Promise<{
    total: { count: number; totalSeconds: number; runningCount: number; failedCount: number; discardedCount: number; discardedSeconds: number };
    byType: Array<{ sessionType: string; count: number; totalSeconds: number; completedCount: number; failedCount: number }>;
    byAgent: Array<{ agent: string; count: number; totalSeconds: number }>;
  }> {
    // v668 — summary_json enthält status (success/failed/partial). Wir extrahieren das
    // damit "abgebrochene" Sessions separat zählbar sind. Die Duration kommt aus
    // (ended_at - started_at) — beide jetzt korrekt gesetzt (v668 Fix in finishSession).
    const sessionRows = await this.adapter.query(
      `SELECT id, session_type, source_id, started_at, ended_at, summary_json, merge_state
       FROM project_sessions WHERE project_id = ?`,
      [projectId],
    ) as Array<{ id: string; session_type: string; source_id: string | null; started_at: string; ended_at: string | null; summary_json: string | null; merge_state: string | null }>;

    // Map source_id → agent_name aus project_agent_sessions (alle in einem Roundtrip, dann lookup)
    const agentNameByTaskId = new Map<string, string>();
    try {
      const agentRows = await this.adapter.query(
        `SELECT task_id, agent_name FROM project_agent_sessions`,
      ) as Array<{ task_id: string; agent_name: string }>;
      for (const r of agentRows) agentNameByTaskId.set(r.task_id, r.agent_name);
    } catch { /* table may not exist in test contexts */ }

    let totalSeconds = 0;
    let runningCount = 0;
    let failedCount = 0;
    // v812 — verworfene (discarded) Sandbox-Runs zählen weiter mit (die Zeit fiel an),
    // werden aber separat ausgewiesen damit die UI sie badgen/filtern kann.
    let discardedCount = 0;
    let discardedSeconds = 0;
    const byTypeMap = new Map<string, { count: number; seconds: number; completed: number; failed: number }>();
    const byAgentMap = new Map<string, { count: number; seconds: number }>();

    for (const s of sessionRows) {
      const start = new Date(s.started_at).getTime();
      const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
      const sec = Math.max(0, Math.floor((end - start) / 1000));
      totalSeconds += sec;
      if (!s.ended_at) runningCount++;
      if (s.merge_state === 'discarded') { discardedCount++; discardedSeconds += sec; }

      // v668 — failed/cancelled-Status aus summary_json extrahieren (best-effort)
      let isFailed = false;
      if (s.summary_json) {
        try {
          const parsed = JSON.parse(s.summary_json) as { status?: string };
          if (parsed.status === 'failed' || parsed.status === 'cancelled') isFailed = true;
        } catch { /* ignore parse errors */ }
      }
      if (isFailed) failedCount++;

      const t = byTypeMap.get(s.session_type) ?? { count: 0, seconds: 0, completed: 0, failed: 0 };
      t.count++;
      t.seconds += sec;
      if (s.ended_at) t.completed++;
      if (isFailed) t.failed++;
      byTypeMap.set(s.session_type, t);

      if (s.source_id) {
        const agent = agentNameByTaskId.get(s.source_id);
        if (agent) {
          const a = byAgentMap.get(agent) ?? { count: 0, seconds: 0 };
          a.count++;
          a.seconds += sec;
          byAgentMap.set(agent, a);
        }
      }
    }

    return {
      total: { count: sessionRows.length, totalSeconds, runningCount, failedCount, discardedCount, discardedSeconds },
      byType: [...byTypeMap.entries()]
        .map(([sessionType, v]) => ({ sessionType, count: v.count, totalSeconds: v.seconds, completedCount: v.completed, failedCount: v.failed }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds),
      byAgent: [...byAgentMap.entries()]
        .map(([agent, v]) => ({ agent, count: v.count, totalSeconds: v.seconds }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds),
    };
  }

  // ── Open Items ──────────────────────────────────────────────────────────

  async addOpenItem(projectId: string, input: { title: string; description?: string; priority?: OpenItemPriority; dueAt?: string; sessionId?: string; linkedIncidentId?: string; linkedChangeId?: string }): Promise<ProjectOpenItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_open_items (id, project_id, session_id, title, description, priority, status, due_at, created_at, linked_incident_id, linked_change_id)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [
        id, projectId, input.sessionId ?? null, input.title, input.description ?? null,
        input.priority ?? 'normal', input.dueAt ?? null, now,
        input.linkedIncidentId ?? null, input.linkedChangeId ?? null,
      ],
    );
    return {
      id, projectId, sessionId: input.sessionId, title: input.title, description: input.description,
      priority: input.priority ?? 'normal', status: 'open', dueAt: input.dueAt, createdAt: now,
      linkedIncidentId: input.linkedIncidentId, linkedChangeId: input.linkedChangeId,
    };
  }

  /** Find an open-item by its ID (for cascading resolves from ITSM side). */
  async getOpenItemById(itemId: string): Promise<ProjectOpenItem | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_open_items WHERE id = ?`, [itemId],
    ) as Record<string, unknown> | undefined;
    return row ? rowToOpenItem(row) : null;
  }

  /** Find all open-items linked to a given ITSM-incident (for reverse-cascading from ITSM-resolution). */
  async findOpenItemsByLinkedIncident(incidentId: string): Promise<ProjectOpenItem[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_open_items WHERE linked_incident_id = ? AND status = 'open'`,
      [incidentId],
    ) as Record<string, unknown>[];
    return rows.map(rowToOpenItem);
  }

  async listOpenItems(userId: string, filters?: { projectId?: string; status?: OpenItemStatus; priority?: OpenItemPriority; limit?: number }): Promise<ProjectOpenItem[]> {
    let sql = `
      SELECT oi.* FROM project_open_items oi
      INNER JOIN projects p ON p.id = oi.project_id
      WHERE p.user_id = ?
    `;
    const params: unknown[] = [userId];
    if (filters?.projectId) { sql += ` AND oi.project_id = ?`; params.push(filters.projectId); }
    if (filters?.status) { sql += ` AND oi.status = ?`; params.push(filters.status); }
    if (filters?.priority) { sql += ` AND oi.priority = ?`; params.push(filters.priority); }
    sql += ` ORDER BY oi.created_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(rowToOpenItem);
  }

  async updateOpenItemStatus(id: string, status: OpenItemStatus): Promise<boolean> {
    const now = new Date().toISOString();
    const resolved = (status === 'done' || status === 'cancelled') ? now : null;
    const result = await this.adapter.execute(
      `UPDATE project_open_items SET status = ?, resolved_at = ? WHERE id = ?`,
      [status, resolved, id],
    );
    return result.changes > 0;
  }

  /** v671 — Titel + Beschreibung eines Open-Items aktualisieren (für Cross-Sync mit Todo). */
  async updateOpenItemFields(id: string, patch: { title?: string; description?: string | null }): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (sets.length === 0) return false;
    params.push(id);
    const result = await this.adapter.execute(
      `UPDATE project_open_items SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
    return result.changes > 0;
  }

  /** v671 — Spiegel-Link explizit setzen oder entfernen (linked_todo_id). */
  async setOpenItemTodoLink(id: string, linkedTodoId: string | null): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE project_open_items SET linked_todo_id = ? WHERE id = ?`,
      [linkedTodoId, id],
    );
    return result.changes > 0;
  }

  /** v671 — Lookup Open-Item per linked_todo_id. */
  async findOpenItemByLinkedTodo(todoId: string): Promise<ProjectOpenItem | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_open_items WHERE linked_todo_id = ?`,
      [todoId],
    ) as Record<string, unknown> | undefined;
    return row ? rowToOpenItem(row) : null;
  }

  /** v671 — Get Open-Item by ID (raw, no user filter — caller muss berechtigen). */
  async getOpenItemByIdRaw(id: string): Promise<ProjectOpenItem | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_open_items WHERE id = ?`, [id],
    ) as Record<string, unknown> | undefined;
    return row ? rowToOpenItem(row) : null;
  }

  /**
   * v641 — Markiert ein OpenItem als done und attributiert die automatische Quelle
   * (z.B. "project_agent_session:<id>"). Wenn `confidence < 0.6` bleibt der Status
   * auf `open` aber `auto_resolved_*` werden trotzdem gefüllt — UI kann das anzeigen
   * als "möglicherweise erledigt, bitte prüfen".
   */
  async autoResolveOpenItem(id: string, source: string, confidence: number, markDone = true): Promise<boolean> {
    const now = new Date().toISOString();
    if (markDone && confidence >= 0.6) {
      const result = await this.adapter.execute(
        `UPDATE project_open_items SET status = 'done', resolved_at = ?, auto_resolved_by = ?, auto_resolved_confidence = ? WHERE id = ?`,
        [now, source, confidence, id],
      );
      return result.changes > 0;
    }
    const result = await this.adapter.execute(
      `UPDATE project_open_items SET auto_resolved_by = ?, auto_resolved_confidence = ? WHERE id = ?`,
      [source, confidence, id],
    );
    return result.changes > 0;
  }

  /**
   * v705 — Markiert Open-Items als "wird gerade vom Agent bearbeitet" (status='in_progress'
   * + auto_resolved_by-Marker mit Session-Verweis). Wird beim explizite Trigger
   * (`implementMilestone`, `workOnOpenItems`) aufgerufen damit der Agent-Lauf nicht
   * orphaned läuft wenn der LLM-Matcher die Items am Ende nicht zuordnen kann.
   */
  async markItemsWorkingOnSession(itemIds: string[], taskId: string): Promise<number> {
    if (itemIds.length === 0) return 0;
    const placeholders = itemIds.map(() => '?').join(',');
    const result = await this.adapter.execute(
      `UPDATE project_open_items
       SET status = 'in_progress', auto_resolved_by = ?, auto_resolved_confidence = NULL
       WHERE id IN (${placeholders}) AND status IN ('open', 'in_progress')`,
      [`implementing:${taskId}`, ...itemIds],
    );
    return result.changes ?? 0;
  }

  /**
   * v705 — Findet Items die unter `implementing:<taskId>`-Marker stehen.
   * Wird vom Completion-Callback verwendet um die Items aufzulösen oder zurückzusetzen.
   */
  async findItemsWorkingOnSession(taskId: string): Promise<ProjectOpenItem[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_open_items WHERE auto_resolved_by = ?`,
      [`implementing:${taskId}`],
    ) as Record<string, unknown>[];
    return rows.map(rowToOpenItem);
  }

  /**
   * v705 — Resolved alle Items die zur Session gehören (Success-Pfad).
   * Setzt status=done + resolved_at + auto_resolved_by="implemented:<taskId>" + confidence.
   */
  async resolveItemsForSession(taskId: string, confidence = 0.8): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      `UPDATE project_open_items
       SET status = 'done', resolved_at = ?, auto_resolved_by = ?, auto_resolved_confidence = ?
       WHERE auto_resolved_by = ? AND status IN ('open', 'in_progress')`,
      [now, `implemented:${taskId}`, confidence, `implementing:${taskId}`],
    );
    return result.changes ?? 0;
  }

  /**
   * v705 — Setzt Items zurück auf 'open' (Failure-Pfad).
   */
  async revertItemsForSession(taskId: string): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE project_open_items
       SET status = 'open', auto_resolved_by = NULL, auto_resolved_confidence = NULL
       WHERE auto_resolved_by = ? AND status = 'in_progress'`,
      [`implementing:${taskId}`],
    );
    return result.changes ?? 0;
  }

  /** Helper: alle nicht-erledigten Items eines Projekts holen für den Matcher. */
  async listOpenItemsForProject(projectId: string, statuses: OpenItemStatus[] = ['open', 'in_progress']): Promise<ProjectOpenItem[]> {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = await this.adapter.query(
      `SELECT * FROM project_open_items WHERE project_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`,
      [projectId, ...statuses],
    ) as Record<string, unknown>[];
    return rows.map(rowToOpenItem);
  }

  /**
   * v663a — Roadmap-Items eines Projekts (Open-Items mit roadmap_milestone gesetzt),
   * gruppiert nach Milestone, innerhalb sortiert nach roadmap_order.
   */
  async listRoadmap(projectId: string): Promise<Map<string, ProjectOpenItem[]>> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_open_items
       WHERE project_id = ? AND roadmap_milestone IS NOT NULL AND roadmap_milestone <> ''
       ORDER BY roadmap_milestone ASC, COALESCE(roadmap_order, 9999) ASC, created_at ASC`,
      [projectId],
    ) as Record<string, unknown>[];
    const items = rows.map(rowToOpenItem);
    const grouped = new Map<string, ProjectOpenItem[]>();
    for (const it of items) {
      const ms = it.roadmapMilestone ?? '__no_milestone__';
      const arr = grouped.get(ms) ?? [];
      arr.push(it);
      grouped.set(ms, arr);
    }
    return grouped;
  }

  /** v663a — Roadmap-Felder eines Open-Items setzen (Milestone-Zuweisung, Order, Aufwand). */
  async updateOpenItemRoadmap(id: string, patch: { milestone?: string | null; order?: number | null; estimatedHours?: number | null }): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.milestone !== undefined) { sets.push('roadmap_milestone = ?'); params.push(patch.milestone); }
    if (patch.order !== undefined) { sets.push('roadmap_order = ?'); params.push(patch.order); }
    if (patch.estimatedHours !== undefined) { sets.push('estimated_hours = ?'); params.push(patch.estimatedHours); }
    if (sets.length === 0) return false;
    params.push(id);
    const r = await this.adapter.execute(`UPDATE project_open_items SET ${sets.join(', ')} WHERE id = ?`, params);
    return r.changes > 0;
  }

  /** v663a — Alle open + in_progress Items eines bestimmten Milestones für die Implement-Action. */
  async listMilestoneItems(projectId: string, milestone: string): Promise<ProjectOpenItem[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_open_items
       WHERE project_id = ? AND roadmap_milestone = ? AND status IN ('open', 'in_progress')
       ORDER BY COALESCE(roadmap_order, 9999) ASC, created_at ASC`,
      [projectId, milestone],
    ) as Record<string, unknown>[];
    return rows.map(rowToOpenItem);
  }

  // ── Decisions ───────────────────────────────────────────────────────────

  async addDecision(projectId: string, input: { title: string; choice: string; rationale?: string; alternativesConsidered?: string; sessionId?: string }): Promise<ProjectDecision> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_decisions (id, project_id, session_id, title, choice, rationale, alternatives_considered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, input.sessionId ?? null, input.title, input.choice, input.rationale ?? null, input.alternativesConsidered ?? null, now],
    );
    return {
      id, projectId, sessionId: input.sessionId, title: input.title, choice: input.choice,
      rationale: input.rationale, alternativesConsidered: input.alternativesConsidered, createdAt: now,
    };
  }

  async listDecisions(projectId: string, limit = 50): Promise<ProjectDecision[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      [projectId, limit],
    ) as Record<string, unknown>[];
    return rows.map(rowToDecision);
  }

  // ── Health Log ──────────────────────────────────────────────────────────

  async recordHealth(projectId: string, input: { probe: HealthProbe; status: HealthStatus; details?: string; durationMs?: number }): Promise<ProjectHealthEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_health_log (id, project_id, probe, status, details, duration_ms, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, input.probe, input.status, input.details ?? null, input.durationMs ?? 0, now],
    );
    return {
      id, projectId, probe: input.probe, status: input.status,
      details: input.details, durationMs: input.durationMs ?? 0, checkedAt: now,
    };
  }

  async getLatestHealth(projectId: string, probe: HealthProbe): Promise<ProjectHealthEntry | null> {
    const row = await this.adapter.queryOne(
      `SELECT * FROM project_health_log WHERE project_id = ? AND probe = ? ORDER BY checked_at DESC LIMIT 1`,
      [projectId, probe],
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      probe: row.probe as HealthProbe,
      status: row.status as HealthStatus,
      details: (row.details as string | null) ?? undefined,
      durationMs: Number(row.duration_ms ?? 0),
      checkedAt: row.checked_at as string,
    };
  }

  async listHealthLog(projectId: string, limit = 100): Promise<ProjectHealthEntry[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM project_health_log WHERE project_id = ? ORDER BY checked_at DESC LIMIT ?`,
      [projectId, limit],
    ) as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id as string,
      projectId: row.project_id as string,
      probe: row.probe as HealthProbe,
      status: row.status as HealthStatus,
      details: (row.details as string | null) ?? undefined,
      durationMs: Number(row.duration_ms ?? 0),
      checkedAt: row.checked_at as string,
    }));
  }

  /** Get the most recent entry per probe — used for the dashboard summary. */
  async getCurrentHealthSummary(projectId: string): Promise<Partial<Record<HealthProbe, ProjectHealthEntry>>> {
    const out: Partial<Record<HealthProbe, ProjectHealthEntry>> = {};
    for (const probe of ['git', 'build', 'deps', 'http'] as HealthProbe[]) {
      const latest = await this.getLatestHealth(projectId, probe);
      if (latest) out[probe] = latest;
    }
    return out;
  }

  // ── v665a — Project-Lock (Cluster-Awareness) ─────────────────────────────

  /**
   * Atomarer Lock-Acquire. Erfolg wenn locked_by_node_id NULL ODER bereits eigener Lock
   * ODER stale (locked_until < now). Liefert {acquired, holderNodeId, holderUntil}.
   *
   * Wichtig für shared Projekte: verhindert dass mehrere Cluster-Nodes parallel
   * project_agent auf demselben cwd starten und sich die git-Working-Tree-Locks streiten.
   */
  async tryLock(projectId: string, nodeId: string, ttlMinutes = 180): Promise<{ acquired: boolean; holderNodeId?: string; holderUntil?: string }> {
    const now = new Date().toISOString();
    const newUntil = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    // UPDATE only if free OR same node OR stale
    const res = await this.adapter.execute(
      `UPDATE projects
         SET locked_by_node_id = ?, locked_until = ?
       WHERE id = ?
         AND (locked_by_node_id IS NULL OR locked_by_node_id = ? OR locked_until IS NULL OR locked_until < ?)`,
      [nodeId, newUntil, projectId, nodeId, now],
    );
    if (res.changes > 0) return { acquired: true };
    // Lock konnte nicht acquired werden — hole aktuellen Holder
    const row = await this.adapter.queryOne(
      `SELECT locked_by_node_id, locked_until FROM projects WHERE id = ?`, [projectId],
    ) as { locked_by_node_id: string | null; locked_until: string | null } | undefined;
    return {
      acquired: false,
      holderNodeId: row?.locked_by_node_id ?? undefined,
      holderUntil: row?.locked_until ?? undefined,
    };
  }

  /** Lock-Heartbeat: TTL verlängert sich. Schreibt nur wenn Caller noch Holder ist. */
  async refreshLock(projectId: string, nodeId: string, ttlMinutes = 180): Promise<boolean> {
    const newUntil = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const res = await this.adapter.execute(
      `UPDATE projects SET locked_until = ? WHERE id = ? AND locked_by_node_id = ?`,
      [newUntil, projectId, nodeId],
    );
    return res.changes > 0;
  }

  /** Lock freigeben — nur wenn Caller Holder ist. Idempotent. */
  async releaseLock(projectId: string, nodeId: string): Promise<boolean> {
    const res = await this.adapter.execute(
      `UPDATE projects SET locked_by_node_id = NULL, locked_until = NULL
       WHERE id = ? AND locked_by_node_id = ?`,
      [projectId, nodeId],
    );
    return res.changes > 0;
  }

  /** Cleanup für Stale-Locks (Crash der Holder-Node ohne Release). */
  async sweepStaleLocks(): Promise<number> {
    const now = new Date().toISOString();
    const res = await this.adapter.execute(
      `UPDATE projects SET locked_by_node_id = NULL, locked_until = NULL
       WHERE locked_until IS NOT NULL AND locked_until < ?`,
      [now],
    );
    return res.changes;
  }
}
