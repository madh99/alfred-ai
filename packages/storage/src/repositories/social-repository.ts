import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID } from 'node:crypto';

export type ChannelMode = 'suggest' | 'approve' | 'autonomous';
export type ChannelPublishMode = 'api' | 'prepare';
export type ChannelStatus = 'active' | 'paused' | 'archived';
export type ContentStatus = 'idea' | 'draft' | 'scheduled' | 'approved' | 'publishing' | 'published' | 'failed' | 'rejected';

export interface SocialChannel {
  id: string;
  userId: string;
  projectId?: string;
  platform: string; // 'telegram_channel' | 'rest' | 'youtube' | 'instagram' | …
  name: string;
  handle?: string;
  mode: ChannelMode;
  publishMode: ChannelPublishMode;
  planningHorizonDays: number;
  postingSlots: string[];
  persona?: string;
  blacklist: string[];
  maxPostsPerDay: number;
  /** v933 — Erstpost-Sperre: Anzahl Freigaben ohne Korrektur in Folge. */
  approvedStreak: number;
  status: ChannelStatus;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ContentMedia {
  type: 'image' | 'video' | 'audio';
  source: 'generated' | 'user' | 'external';
  pathOrUrl: string;
  caption?: string;
}

export interface ContentItem {
  id: string;
  channelId: string;
  userId: string;
  status: ContentStatus;
  title?: string;
  body: string;
  media: ContentMedia[];
  hashtags: string[];
  scheduledAt?: string;
  publishedAt?: string;
  externalId?: string;
  externalUrl?: string;
  error?: string;
  performance?: Record<string, unknown>;
  source: 'manual' | 'studio' | 'detector';
  createdAt: string;
  updatedAt: string;
}

/** Erlaubte Pipeline-Übergänge — alles andere ist ein Programmierfehler. */
const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  idea: ['draft', 'rejected'],
  draft: ['scheduled', 'approved', 'rejected'],
  scheduled: ['approved', 'rejected', 'draft'],
  approved: ['publishing', 'published', 'rejected', 'scheduled'],
  publishing: ['published', 'failed'],
  failed: ['approved', 'publishing', 'rejected'],
  published: [],
  rejected: ['draft'],
};

export function isValidTransition(from: ContentStatus, to: ContentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** v933 — Social-Media-Betrieb: Kanäle, Content-Pipeline, Performance-Metriken. */
export class SocialRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  // ── Channels ──────────────────────────────────────────────────────────

  async createChannel(userId: string, opts: {
    platform: string; name: string; handle?: string; projectId?: string;
    mode?: ChannelMode; publishMode?: ChannelPublishMode;
    planningHorizonDays?: number; postingSlots?: string[]; persona?: string;
    blacklist?: string[]; maxPostsPerDay?: number; config?: Record<string, unknown>;
  }): Promise<SocialChannel> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO social_channels (id, user_id, project_id, platform, name, handle, mode, publish_mode,
        planning_horizon_days, posting_slots, persona, blacklist, max_posts_per_day, approved_streak,
        status, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
      [id, userId, opts.projectId ?? null, opts.platform, opts.name, opts.handle ?? null,
       opts.mode ?? 'suggest', opts.publishMode ?? 'prepare',
       opts.planningHorizonDays ?? 14, JSON.stringify(opts.postingSlots ?? []),
       opts.persona ?? null, JSON.stringify(opts.blacklist ?? []),
       opts.maxPostsPerDay ?? 3, JSON.stringify(opts.config ?? {}), now, now],
    );
    return (await this.getChannel(userId, id))!;
  }

  async getChannel(userId: string, id: string): Promise<SocialChannel | null> {
    const row = await this.db.queryOne(`SELECT * FROM social_channels WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapChannel(row) : null;
  }

  async findChannelByName(userId: string, q: string): Promise<SocialChannel | null> {
    const channels = await this.listChannels(userId);
    const lower = q.toLowerCase().trim();
    return channels.find(c => c.name.toLowerCase() === lower)
      ?? channels.find(c => c.name.toLowerCase().includes(lower) || (c.handle ?? '').toLowerCase().includes(lower) || c.platform === lower)
      ?? null;
  }

  async listChannels(userId: string, status?: ChannelStatus): Promise<SocialChannel[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (status) { where.push('status = ?'); params.push(status); }
    const rows = await this.db.query(`SELECT * FROM social_channels WHERE ${where.join(' AND ')} ORDER BY created_at`, params) as Record<string, unknown>[];
    return rows.map(r => this.mapChannel(r));
  }

  /** Alle aktiven Kanäle ALLER User — für die Publishing-Engine (v934). */
  async listAllActiveChannels(): Promise<SocialChannel[]> {
    const rows = await this.db.query(`SELECT * FROM social_channels WHERE status = 'active'`, []) as Record<string, unknown>[];
    return rows.map(r => this.mapChannel(r));
  }

  async updateChannel(userId: string, id: string, patch: Partial<Pick<SocialChannel,
    'name' | 'handle' | 'mode' | 'publishMode' | 'planningHorizonDays' | 'postingSlots'
    | 'persona' | 'blacklist' | 'maxPostsPerDay' | 'status' | 'config' | 'approvedStreak'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: Array<[keyof typeof patch, string, (v: unknown) => unknown]> = [
      ['name', 'name', v => v], ['handle', 'handle', v => v], ['mode', 'mode', v => v],
      ['publishMode', 'publish_mode', v => v], ['planningHorizonDays', 'planning_horizon_days', v => v],
      ['postingSlots', 'posting_slots', v => JSON.stringify(v)], ['persona', 'persona', v => v],
      ['blacklist', 'blacklist', v => JSON.stringify(v)], ['maxPostsPerDay', 'max_posts_per_day', v => v],
      ['status', 'status', v => v], ['config', 'config', v => JSON.stringify(v)],
      ['approvedStreak', 'approved_streak', v => v],
    ];
    for (const [key, col, tx] of map) {
      if (patch[key] !== undefined) { sets.push(`${col} = ?`); params.push(tx(patch[key])); }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id, userId);
    await this.db.execute(`UPDATE social_channels SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }

  /** Not-Aus: pausiert alle aktiven Kanäle des Users. @returns Anzahl. */
  async pauseAll(userId: string): Promise<number> {
    const r = await this.db.execute(
      `UPDATE social_channels SET status = 'paused', updated_at = ? WHERE user_id = ? AND status = 'active'`,
      [new Date().toISOString(), userId],
    );
    return r.changes ?? 0;
  }

  // ── Content-Pipeline ──────────────────────────────────────────────────

  async createItem(userId: string, channelId: string, opts: {
    status?: Extract<ContentStatus, 'idea' | 'draft'>;
    title?: string; body?: string; media?: ContentMedia[]; hashtags?: string[];
    scheduledAt?: string; source?: 'manual' | 'studio' | 'detector';
  }): Promise<ContentItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO content_items (id, channel_id, user_id, status, title, body, media, hashtags,
        scheduled_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, channelId, userId, opts.status ?? 'draft', opts.title ?? null, opts.body ?? '',
       JSON.stringify(opts.media ?? []), JSON.stringify(opts.hashtags ?? []),
       opts.scheduledAt ?? null, opts.source ?? 'manual', now, now],
    );
    return (await this.getItem(userId, id))!;
  }

  async getItem(userId: string, id: string): Promise<ContentItem | null> {
    const row = await this.db.queryOne(`SELECT * FROM content_items WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapItem(row) : null;
  }

  async listItems(userId: string, opts?: {
    channelId?: string; status?: ContentStatus | ContentStatus[]; limit?: number;
    scheduledBefore?: string;
  }): Promise<ContentItem[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts?.channelId) { where.push('channel_id = ?'); params.push(opts.channelId); }
    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (opts?.scheduledBefore) { where.push('scheduled_at IS NOT NULL AND scheduled_at <= ?'); params.push(opts.scheduledBefore); }
    params.push(opts?.limit ?? 100);
    const rows = await this.db.query(
      `SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at) LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapItem(r));
  }

  /**
   * Status-Übergang mit Pipeline-Validierung. Ungültiger Übergang → Error
   * (Programmierfehler sichtbar machen statt still falsche Zustände schreiben).
   */
  async transition(userId: string, id: string, to: ContentStatus, extra?: {
    scheduledAt?: string; publishedAt?: string; externalId?: string; externalUrl?: string; error?: string | null;
  }): Promise<ContentItem> {
    const item = await this.getItem(userId, id);
    if (!item) throw new Error(`Content-Item ${id} nicht gefunden`);
    if (!isValidTransition(item.status, to)) {
      throw new Error(`Ungültiger Status-Übergang ${item.status} → ${to} (Item ${id})`);
    }
    const sets = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [to, new Date().toISOString()];
    if (extra?.scheduledAt !== undefined) { sets.push('scheduled_at = ?'); params.push(extra.scheduledAt); }
    if (extra?.publishedAt !== undefined) { sets.push('published_at = ?'); params.push(extra.publishedAt); }
    if (extra?.externalId !== undefined) { sets.push('external_id = ?'); params.push(extra.externalId); }
    if (extra?.externalUrl !== undefined) { sets.push('external_url = ?'); params.push(extra.externalUrl); }
    if (extra?.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }
    params.push(id, userId);
    await this.db.execute(`UPDATE content_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
    return (await this.getItem(userId, id))!;
  }

  async updateItemContent(userId: string, id: string, patch: {
    title?: string; body?: string; media?: ContentMedia[]; hashtags?: string[];
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.body !== undefined) { sets.push('body = ?'); params.push(patch.body); }
    if (patch.media !== undefined) { sets.push('media = ?'); params.push(JSON.stringify(patch.media)); }
    if (patch.hashtags !== undefined) { sets.push('hashtags = ?'); params.push(JSON.stringify(patch.hashtags)); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id, userId);
    await this.db.execute(`UPDATE content_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }

  /** Tages-Limit-Check (Leitplanke 2): published-Posts eines Kanals am Tag (UTC). */
  async countPublishedToday(channelId: string, dayIso?: string): Promise<number> {
    const day = (dayIso ?? new Date().toISOString()).slice(0, 10);
    const row = await this.db.queryOne(
      `SELECT COUNT(*) AS c FROM content_items WHERE channel_id = ? AND status = 'published' AND published_at >= ? AND published_at < ?`,
      [channelId, `${day}T00:00:00`, `${day}T23:59:59.999Z`],
    ) as { c: number | string } | undefined;
    return row ? Number(row.c) : 0;
  }

  // ── Metrics ───────────────────────────────────────────────────────────

  async upsertMetric(channelId: string, opts: {
    itemId?: string; date: string; kind: string; value: number; meta?: Record<string, unknown>;
  }): Promise<void> {
    const existing = await this.db.queryOne(
      `SELECT id FROM channel_metrics WHERE channel_id = ? AND COALESCE(item_id, '') = ? AND date = ? AND kind = ?`,
      [channelId, opts.itemId ?? '', opts.date, opts.kind],
    ) as { id: string } | undefined;
    if (existing) {
      await this.db.execute(`UPDATE channel_metrics SET value = ?, meta = ? WHERE id = ?`,
        [opts.value, opts.meta ? JSON.stringify(opts.meta) : null, existing.id]);
      return;
    }
    await this.db.execute(
      `INSERT INTO channel_metrics (id, channel_id, item_id, date, kind, value, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), channelId, opts.itemId ?? null, opts.date, opts.kind, opts.value,
       opts.meta ? JSON.stringify(opts.meta) : null, new Date().toISOString()],
    );
  }

  async listMetrics(channelId: string, opts?: { kind?: string; sinceDate?: string; limit?: number }): Promise<Array<{
    itemId?: string; date: string; kind: string; value: number; meta?: Record<string, unknown>;
  }>> {
    const where = ['channel_id = ?'];
    const params: unknown[] = [channelId];
    if (opts?.kind) { where.push('kind = ?'); params.push(opts.kind); }
    if (opts?.sinceDate) { where.push('date >= ?'); params.push(opts.sinceDate); }
    params.push(opts?.limit ?? 200);
    const rows = await this.db.query(
      `SELECT * FROM channel_metrics WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => ({
      itemId: r.item_id ? String(r.item_id) : undefined,
      date: String(r.date), kind: String(r.kind), value: Number(r.value),
      meta: r.meta ? safeJson(String(r.meta)) as Record<string, unknown> : undefined,
    }));
  }

  // ── Mapping ───────────────────────────────────────────────────────────

  private mapChannel(r: Record<string, unknown>): SocialChannel {
    return {
      id: String(r.id), userId: String(r.user_id),
      projectId: r.project_id ? String(r.project_id) : undefined,
      platform: String(r.platform), name: String(r.name),
      handle: r.handle ? String(r.handle) : undefined,
      mode: String(r.mode) as ChannelMode,
      publishMode: String(r.publish_mode) as ChannelPublishMode,
      planningHorizonDays: Number(r.planning_horizon_days ?? 14),
      postingSlots: safeJsonArray(String(r.posting_slots ?? '[]')),
      persona: r.persona ? String(r.persona) : undefined,
      blacklist: safeJsonArray(String(r.blacklist ?? '[]')),
      maxPostsPerDay: Number(r.max_posts_per_day ?? 3),
      approvedStreak: Number(r.approved_streak ?? 0),
      status: String(r.status) as ChannelStatus,
      config: (safeJson(String(r.config ?? '{}')) as Record<string, unknown>) ?? {},
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  private mapItem(r: Record<string, unknown>): ContentItem {
    return {
      id: String(r.id), channelId: String(r.channel_id), userId: String(r.user_id),
      status: String(r.status) as ContentStatus,
      title: r.title ? String(r.title) : undefined,
      body: String(r.body ?? ''),
      media: (safeJson(String(r.media ?? '[]')) as ContentMedia[]) ?? [],
      hashtags: safeJsonArray(String(r.hashtags ?? '[]')),
      scheduledAt: r.scheduled_at ? String(r.scheduled_at) : undefined,
      publishedAt: r.published_at ? String(r.published_at) : undefined,
      externalId: r.external_id ? String(r.external_id) : undefined,
      externalUrl: r.external_url ? String(r.external_url) : undefined,
      error: r.error ? String(r.error) : undefined,
      performance: r.performance ? safeJson(String(r.performance)) as Record<string, unknown> : undefined,
      source: (r.source === 'studio' || r.source === 'detector' ? r.source : 'manual'),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

function safeJsonArray(s: string): string[] {
  const p = safeJson(s);
  return Array.isArray(p) ? p.map(String) : [];
}
