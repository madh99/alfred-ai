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
  /** v993 — Verknüpfung zur Story (Redaktionsleitung). */
  storyId?: string;
  createdAt: string;
  updatedAt: string;
}

/** v989 — eingesammelter Kommentar zu einem veröffentlichten Post. */
export interface SocialComment {
  id: string;
  userId: string;
  channelId: string;
  itemId?: string;
  externalCommentId: string;
  externalPostId?: string;
  author?: string;
  text: string;
  remoteCreatedAt?: string;
  status: 'new' | 'replied' | 'ignored';
  replyText?: string;
  repliedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** v993 — Redaktionsleitung: die STORY ist die Planungs-Einheit, Kanäle bekommen Zuweisungen. */
export interface Story {
  id: string;
  userId: string;
  /** Familien-Schlüssel (project:<id> oder family:<name>). */
  family: string;
  kind: 'news' | 'vorschau' | 'recap' | 'termin' | 'evergreen';
  title: string;
  summary?: string;
  importance: number;
  terminBis?: string;
  source: 'studio' | 'event' | 'manual';
  status: 'active' | 'done' | 'dropped';
  createdAt: string;
  updatedAt: string;
}

export interface StoryAssignment {
  id: string;
  storyId: string;
  channelId: string;
  role: 'lead' | 'follow';
  offsetHours: number;
  itemId?: string;
  createdAt: string;
}

/** v1005 — Basis-Bild in der Bild-Bibliothek (Wiederverwendung nach Cooldown). */
export interface MediaAsset {
  id: string;
  userId: string;
  channelId?: string;
  family?: string;
  path: string;
  motif: string;
  style?: string;
  format?: string;
  lastUsedAt: string;
  useCount: number;
  /** v1072 — womit das Bild erzeugt wurde (z.B. gpt-image-1, gemini-3.1-flash-image). */
  model?: string;
  /** v1039 — letzte Nutzung JE KANAL (channelId → ISO): der Reuse-Cooldown gilt pro Kanal, nicht global. */
  channelUses?: Record<string, string>;
  /** v1014 — von der Wiederverwendung ausgeschlossen (UI: „Sperren"). */
  blocked: boolean;
  /** v1038 — Stamm-Bild: bevorzugter Wiederverwendungs-Pool mit kurzer Karenz (UI: „Pinnen"). */
  pinned: boolean;
  createdAt: string;
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

/** v1039 — channel_uses-Spalte (JSON: channelId → ISO-Zeitstempel) defensiv parsen. */
function parseChannelUses(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return Object.keys(out).length > 0 ? out : undefined;
    }
  } catch { /* kaputtes JSON = wie keine Kanal-Daten */ }
  return undefined;
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
    /** v993 — Verknüpfung zur Story (Redaktionsleitung). */
    storyId?: string;
  }): Promise<ContentItem> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO content_items (id, channel_id, user_id, status, title, body, media, hashtags,
        scheduled_at, source, story_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, channelId, userId, opts.status ?? 'draft', opts.title ?? null, opts.body ?? '',
       JSON.stringify(opts.media ?? []), JSON.stringify(opts.hashtags ?? []),
       opts.scheduledAt ?? null, opts.source ?? 'manual', opts.storyId ?? null, now, now],
    );
    return (await this.getItem(userId, id))!;
  }

  async getItem(userId: string, id: string): Promise<ContentItem | null> {
    const row = await this.db.queryOne(`SELECT * FROM content_items WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapItem(row) : null;
  }

  // ── v993 — Stories (Redaktionsleitung) ────────────────────────────────

  async createStory(userId: string, input: {
    family: string; kind: Story['kind']; title: string; summary?: string;
    importance?: number; terminBis?: string; source?: Story['source'];
  }): Promise<Story> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO stories (id, user_id, family, kind, title, summary, importance, termin_bis, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, userId, input.family, input.kind, input.title.slice(0, 300), input.summary?.slice(0, 1000) ?? null,
        input.importance ?? 0.5, input.terminBis ?? null, input.source ?? 'studio', now, now],
    );
    return { id, userId, family: input.family, kind: input.kind, title: input.title.slice(0, 300), summary: input.summary, importance: input.importance ?? 0.5, terminBis: input.terminBis, source: input.source ?? 'studio', status: 'active', createdAt: now, updatedAt: now };
  }

  async listStories(userId: string, opts?: { family?: string; status?: Story['status']; sinceDays?: number; limit?: number }): Promise<Story[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts?.family) { where.push('family = ?'); params.push(opts.family); }
    if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts?.sinceDays) { where.push('created_at >= ?'); params.push(new Date(Date.now() - opts.sinceDays * 24 * 3_600_000).toISOString()); }
    params.push(opts?.limit ?? 100);
    const rows = await this.db.query(`SELECT * FROM stories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id), userId: String(r.user_id), family: String(r.family),
      kind: String(r.kind) as Story['kind'], title: String(r.title),
      summary: r.summary ? String(r.summary) : undefined,
      importance: Number(r.importance ?? 0.5),
      terminBis: r.termin_bis ? String(r.termin_bis) : undefined,
      source: String(r.source) as Story['source'], status: String(r.status) as Story['status'],
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    }));
  }

  async setStoryStatus(userId: string, id: string, status: Story['status']): Promise<void> {
    await this.db.execute(`UPDATE stories SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [status, new Date().toISOString(), id, userId]);
  }

  async createAssignment(input: { storyId: string; channelId: string; role: StoryAssignment['role']; offsetHours?: number; itemId?: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO story_assignments (id, story_id, channel_id, role, offset_hours, item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), input.storyId, input.channelId, input.role, input.offsetHours ?? 0, input.itemId ?? null, new Date().toISOString()],
    );
  }

  // ── v1005 — Bild-Bibliothek (Basis-Bilder zur Wiederverwendung) ──

  async createMediaAsset(userId: string, input: {
    channelId?: string; family?: string; path: string; motif: string; style?: string; format?: string; model?: string;
  }): Promise<MediaAsset> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const channelUses = input.channelId ? { [input.channelId]: now } : undefined;
    await this.db.execute(
      `INSERT INTO social_media_assets (id, user_id, channel_id, family, path, motif, style, format, model, last_used_at, use_count, channel_uses, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, userId, input.channelId ?? null, input.family ?? null, input.path, input.motif.slice(0, 500),
        input.style?.slice(0, 300) ?? null, input.format ?? null, input.model ?? null, now, channelUses ? JSON.stringify(channelUses) : null, now],
    );
    return { id, userId, channelId: input.channelId, family: input.family, path: input.path, motif: input.motif.slice(0, 500), style: input.style, format: input.format, model: input.model, lastUsedAt: now, useCount: 1, channelUses, blocked: false, pinned: false, createdAt: now };
  }

  async listMediaAssets(userId: string, opts?: { family?: string; channelId?: string; limit?: number }): Promise<MediaAsset[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts?.family) { where.push('family = ?'); params.push(opts.family); }
    if (opts?.channelId) { where.push('channel_id = ?'); params.push(opts.channelId); }
    params.push(opts?.limit ?? 200);
    const rows = await this.db.query(`SELECT * FROM social_media_assets WHERE ${where.join(' AND ')} ORDER BY last_used_at ASC LIMIT ?`, params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id), userId: String(r.user_id),
      channelId: r.channel_id ? String(r.channel_id) : undefined,
      family: r.family ? String(r.family) : undefined,
      path: String(r.path), motif: String(r.motif),
      style: r.style ? String(r.style) : undefined,
      format: r.format ? String(r.format) : undefined,
      model: r.model ? String(r.model) : undefined,
      lastUsedAt: String(r.last_used_at), useCount: Number(r.use_count ?? 1),
      channelUses: parseChannelUses(r.channel_uses),
      blocked: Number(r.blocked ?? 0) === 1, pinned: Number(r.pinned ?? 0) === 1, createdAt: String(r.created_at),
    }));
  }

  /** v1014 — Asset von der Wiederverwendung ausschließen (oder wieder freigeben). */
  async setMediaAssetBlocked(userId: string, id: string, blocked: boolean): Promise<void> {
    await this.db.execute(`UPDATE social_media_assets SET blocked = ? WHERE id = ? AND user_id = ?`,
      [blocked ? 1 : 0, id, userId]);
  }

  /** v1038 — Stamm-Bild markieren: bevorzugter Pool der Wiederverwendung (kurze Karenz statt Cooldown). */
  async setMediaAssetPinned(userId: string, id: string, pinned: boolean): Promise<void> {
    await this.db.execute('UPDATE social_media_assets SET pinned = ? WHERE id = ? AND user_id = ?',
      [pinned ? 1 : 0, id, userId]);
  }

  /** v1017 — Motiv-Beschreibung ändern (der Matching-Schlüssel für die Wiederverwendung). */
  async updateMediaAssetMotif(userId: string, id: string, motif: string): Promise<void> {
    await this.db.execute(`UPDATE social_media_assets SET motif = ? WHERE id = ? AND user_id = ?`,
      [motif.slice(0, 500), id, userId]);
  }

  async touchMediaAsset(userId: string, id: string, channelId?: string): Promise<void> {
    const now = new Date().toISOString();
    // v1039 — Nutzung auch je Kanal festhalten (Read-Modify-Write reicht: ein
    // verlorenes Update bedeutet höchstens eine etwas frühere Wiederverwendung).
    if (channelId) {
      const rows = await this.db.query(`SELECT channel_uses FROM social_media_assets WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown>[];
      const uses = parseChannelUses(rows[0]?.channel_uses) ?? {};
      uses[channelId] = now;
      await this.db.execute(`UPDATE social_media_assets SET last_used_at = ?, use_count = use_count + 1, channel_uses = ? WHERE id = ? AND user_id = ?`,
        [now, JSON.stringify(uses), id, userId]);
      return;
    }
    await this.db.execute(`UPDATE social_media_assets SET last_used_at = ?, use_count = use_count + 1 WHERE id = ? AND user_id = ?`,
      [now, id, userId]);
  }

  async deleteMediaAsset(userId: string, id: string): Promise<void> {
    await this.db.execute(`DELETE FROM social_media_assets WHERE id = ? AND user_id = ?`, [id, userId]);
  }

  async listAssignments(storyId: string): Promise<StoryAssignment[]> {
    const rows = await this.db.query(`SELECT * FROM story_assignments WHERE story_id = ? ORDER BY offset_hours`, [storyId]) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id), storyId: String(r.story_id), channelId: String(r.channel_id),
      role: String(r.role) as StoryAssignment['role'], offsetHours: Number(r.offset_hours ?? 0),
      itemId: r.item_id ? String(r.item_id) : undefined, createdAt: String(r.created_at),
    }));
  }

  // ── v989 — Kommentare ─────────────────────────────────────────────────

  /** Kommentar einsammeln; dedupliziert über (channel_id, external_comment_id). @returns true wenn NEU. */
  async upsertComment(input: {
    userId: string; channelId: string; itemId?: string;
    externalCommentId: string; externalPostId?: string;
    author?: string; text: string; remoteCreatedAt?: string;
  }): Promise<boolean> {
    const existing = await this.db.queryOne(
      `SELECT id FROM social_comments WHERE channel_id = ? AND external_comment_id = ?`,
      [input.channelId, input.externalCommentId],
    ) as { id?: string } | undefined;
    if (existing?.id) return false;
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO social_comments (id, user_id, channel_id, item_id, external_comment_id, external_post_id, author, text, remote_created_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
      [randomUUID(), input.userId, input.channelId, input.itemId ?? null, input.externalCommentId,
        input.externalPostId ?? null, input.author ?? null, input.text.slice(0, 2000), input.remoteCreatedAt ?? null, now, now],
    );
    return true;
  }

  async listComments(userId: string, opts?: { channelId?: string; status?: SocialComment['status']; limit?: number }): Promise<SocialComment[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts?.channelId) { where.push('channel_id = ?'); params.push(opts.channelId); }
    if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
    params.push(opts?.limit ?? 50);
    const rows = await this.db.query(
      `SELECT * FROM social_comments WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapComment(r));
  }

  async getComment(userId: string, id: string): Promise<SocialComment | null> {
    const row = await this.db.queryOne(
      `SELECT * FROM social_comments WHERE user_id = ? AND (id = ? OR external_comment_id = ?)`,
      [userId, id, id],
    ) as Record<string, unknown> | undefined;
    return row ? this.mapComment(row) : null;
  }

  async setCommentStatus(userId: string, id: string, status: SocialComment['status'], replyText?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE social_comments SET status = ?, reply_text = COALESCE(?, reply_text), replied_at = CASE WHEN ? = 'replied' THEN ? ELSE replied_at END, updated_at = ? WHERE user_id = ? AND id = ?`,
      [status, replyText ?? null, status, now, now, userId, id],
    );
  }

  private mapComment(r: Record<string, unknown>): SocialComment {
    return {
      id: String(r.id), userId: String(r.user_id), channelId: String(r.channel_id),
      itemId: r.item_id ? String(r.item_id) : undefined,
      externalCommentId: String(r.external_comment_id),
      externalPostId: r.external_post_id ? String(r.external_post_id) : undefined,
      author: r.author ? String(r.author) : undefined,
      text: String(r.text),
      remoteCreatedAt: r.remote_created_at ? String(r.remote_created_at) : undefined,
      status: String(r.status) as SocialComment['status'],
      replyText: r.reply_text ? String(r.reply_text) : undefined,
      repliedAt: r.replied_at ? String(r.replied_at) : undefined,
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  /** v990 — zählt Items, deren media-JSON den Datei-Namen referenziert (mediaDir-Cleanup). */
  async countItemsReferencingMedia(fileName: string): Promise<number> {
    const row = await this.db.queryOne(
      `SELECT COUNT(*) AS c FROM content_items WHERE media LIKE ?`,
      [`%${fileName}%`],
    ) as { c: number | string } | undefined;
    return row ? Number(row.c) : 0;
  }

  /**
   * v987 — Item LOKAL löschen (ohne Story-Sperre, anders als reject).
   * Published-Items sind bewusst ausgenommen: die gehen über delete_remote
   * bzw. bleiben als Dedup-Sperrliste erhalten.
   */
  async deleteItem(userId: string, id: string): Promise<boolean> {
    const r = await this.db.execute(
      `DELETE FROM content_items WHERE id = ? AND user_id = ? AND status != 'published'`,
      [id, userId],
    );
    return r.changes > 0;
  }

  async listItems(userId: string, opts?: {
    channelId?: string; status?: ContentStatus | ContentStatus[]; limit?: number;
    scheduledBefore?: string;
    /** v973 — Zeitfenster für Dedup-Sperrlisten (published/rejected der letzten N Tage). */
    updatedSince?: string;
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
    if (opts?.updatedSince) { where.push('updated_at >= ?'); params.push(opts.updatedSince); }
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

  /**
   * v959 — geplanten Termin verschieben, Status bleibt erhalten. Default nur
   * scheduled (Slot-Umplanung); v964: Umterminieren aus der UI darf auch
   * approved-Termine verschieben, ohne die Freigabe zu verlieren.
   */
  async reschedule(userId: string, id: string, scheduledAt: string, statuses: ContentStatus[] = ['scheduled']): Promise<boolean> {
    const placeholders = statuses.map(() => '?').join(', ');
    const r = await this.db.execute(
      `UPDATE content_items SET scheduled_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN (${placeholders})`,
      [scheduledAt, new Date().toISOString(), id, userId, ...statuses],
    );
    return (r.changes ?? 0) > 0;
  }

  /** v934 — Performance-/Meta-JSON mergen (z.B. Retry-Zähler der Publishing-Engine). */
  async mergePerformance(userId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const item = await this.getItem(userId, id);
    if (!item) return;
    const merged = { ...(item.performance ?? {}), ...patch };
    await this.db.execute(
      `UPDATE content_items SET performance = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(merged), new Date().toISOString(), id, userId],
    );
  }

  /** v936 — published-Posts seit Zeitpunkt (Monats-Limits, z.B. X-Free-Tier). */
  async countPublishedSince(channelId: string, sinceIso: string): Promise<number> {
    const row = await this.db.queryOne(
      `SELECT COUNT(*) AS c FROM content_items WHERE channel_id = ? AND status = 'published' AND published_at >= ?`,
      [channelId, sinceIso],
    ) as { c: number | string } | undefined;
    return row ? Number(row.c) : 0;
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

  /** v1045 — atomares Hochzählen (z.B. gen_image-Budget): value = value + 1 statt Read-Modify-Write. */
  async incrementMetric(channelId: string, opts: { date: string; kind: string; itemId?: string }): Promise<void> {
    const r = await this.db.execute(
      `UPDATE channel_metrics SET value = value + 1 WHERE channel_id = ? AND COALESCE(item_id, '') = ? AND date = ? AND kind = ?`,
      [channelId, opts.itemId ?? '', opts.date, opts.kind],
    );
    if (r.changes > 0) return;
    // Zeile fehlt noch — anlegen; ein Doppel-INSERT im Rennen zweier Nodes ist
    // unkritisch: die Budget-Leser SUMMIEREN über alle Zeilen des Schlüssels.
    await this.db.execute(
      `INSERT INTO channel_metrics (id, channel_id, item_id, date, kind, value, meta, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [randomUUID(), channelId, opts.itemId ?? null, opts.date, opts.kind, null, new Date().toISOString()],
    );
  }

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
      storyId: r.story_id ? String(r.story_id) : undefined,
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
