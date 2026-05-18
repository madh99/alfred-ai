import { randomUUID } from 'node:crypto';
import type { AsyncDbAdapter } from '../db-adapter.js';

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'maintenance' | 'archived';
export type ProjectHealthMode = 'full' | 'minimal' | 'off';
export type ProjectSessionType = 'project_agent' | 'code_agent' | 'delegate' | 'chat';
export type OpenItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type OpenItemPriority = 'low' | 'normal' | 'high';

export interface Project {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description?: string;
  cwd?: string;
  repoUrl?: string;
  status: ProjectStatus;
  healthMode: ProjectHealthMode;
  tags: string[];
  createdAt: string;
  lastActiveAt: string;
  nextCheckAt?: string;
}

export interface ProjectSessionSummary {
  whatWasDone?: string;
  keyDecisions?: Array<{ choice: string; rationale?: string }>;
  filesTouched?: string[];
  openItems?: Array<{ title: string; priority?: OpenItemPriority; description?: string }>;
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
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? undefined,
    cwd: (row.cwd as string | null) ?? undefined,
    repoUrl: (row.repo_url as string | null) ?? undefined,
    status: (row.status as ProjectStatus) ?? 'active',
    healthMode: (row.health_mode as ProjectHealthMode) ?? 'full',
    tags: parseTags(row.tags),
    createdAt: row.created_at as string,
    lastActiveAt: row.last_active_at as string,
    nextCheckAt: (row.next_check_at as string | null) ?? undefined,
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

  async list(userId: string, filters?: { status?: ProjectStatus; limit?: number }): Promise<Project[]> {
    let sql = `SELECT * FROM projects WHERE user_id = ?`;
    const params: unknown[] = [userId];
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status); }
    sql += ` ORDER BY last_active_at DESC LIMIT ?`;
    params.push(filters?.limit ?? 100);
    const rows = await this.adapter.query(sql, params) as Record<string, unknown>[];
    return rows.map(rowToProject);
  }

  async update(userId: string, id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'cwd' | 'repoUrl' | 'status' | 'healthMode' | 'tags' | 'nextCheckAt'>>): Promise<Project | null> {
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
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.healthMode !== undefined) { sets.push('health_mode = ?'); params.push(patch.healthMode); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(patch.tags)); }
    if (patch.nextCheckAt !== undefined) { sets.push('next_check_at = ?'); params.push(patch.nextCheckAt); }
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

  async createSession(projectId: string, input: { sessionType: ProjectSessionType; sourceId?: string; summary?: ProjectSessionSummary; startedAt?: string; endedAt?: string }): Promise<ProjectSession> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_sessions (id, project_id, session_type, source_id, summary_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, projectId, input.sessionType, input.sourceId ?? null,
        input.summary ? JSON.stringify(input.summary) : null,
        input.startedAt ?? now, input.endedAt ?? null,
      ],
    );
    return {
      id, projectId, sessionType: input.sessionType, sourceId: input.sourceId,
      summary: input.summary, startedAt: input.startedAt ?? now, endedAt: input.endedAt,
    };
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

  // ── Open Items ──────────────────────────────────────────────────────────

  async addOpenItem(projectId: string, input: { title: string; description?: string; priority?: OpenItemPriority; dueAt?: string; sessionId?: string }): Promise<ProjectOpenItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.adapter.execute(
      `INSERT INTO project_open_items (id, project_id, session_id, title, description, priority, status, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [id, projectId, input.sessionId ?? null, input.title, input.description ?? null, input.priority ?? 'normal', input.dueAt ?? null, now],
    );
    return {
      id, projectId, sessionId: input.sessionId, title: input.title, description: input.description,
      priority: input.priority ?? 'normal', status: 'open', dueAt: input.dueAt, createdAt: now,
    };
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
}
