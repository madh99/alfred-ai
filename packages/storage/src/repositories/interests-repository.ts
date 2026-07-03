import type { AsyncDbAdapter } from '../db-adapter.js';
import { randomUUID, createHash } from 'node:crypto';

export type TopicStatus = 'active' | 'paused' | 'archived';
export type TopicOrigin = 'auto' | 'manual';
export type TopicSourceKind = 'rss' | 'web_search';

export interface InterestTopic {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  status: TopicStatus;
  origin: TopicOrigin;
  /** Ab dieser Dringlichkeit meldet der Digest-Builder aktiv (v930); default 'high'. */
  notifyThreshold: string;
  createdAt: string;
  lastActivityAt?: string;
}

export interface TopicSource {
  id: string;
  topicId: string;
  kind: TopicSourceKind;
  /** rss: { url }, web_search: { query } */
  config: Record<string, unknown>;
  addedBy: 'auto' | 'manual';
  enabled: boolean;
  lastCheckedAt?: string;
  createdAt: string;
}

export interface TopicItem {
  id: string;
  topicId: string;
  title: string;
  url?: string;
  summary?: string;
  sourceKind: string;
  publishedAt?: string;
  importance?: number;
  createdAt: string;
}

export interface TopicDigest {
  topicId: string;
  summary: string;
  itemsSinceUpdate: number;
  updatedAt: string;
}

/** Stabiler Dedup-Hash: URL wenn vorhanden, sonst normalisierter Titel. */
export function topicItemDedupeHash(item: { url?: string; title: string }): string {
  const basis = item.url && item.url.trim().length > 0
    ? item.url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
    : item.title.toLowerCase().replace(/[^a-zä-ü0-9]+/gi, ' ').trim();
  return createHash('sha1').update(basis).digest('hex');
}

/** v929 — Interessen-Radar: Themen, Quellen, gesammelte Items, Dossiers. */
export class InterestsRepository {
  constructor(private readonly db: AsyncDbAdapter) {}

  // ── Topics ────────────────────────────────────────────────────────────

  async createTopic(userId: string, opts: {
    name: string; keywords?: string[]; origin?: TopicOrigin; notifyThreshold?: string;
  }): Promise<InterestTopic> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO interest_topics (id, user_id, name, keywords, status, origin, notify_threshold, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [id, userId, opts.name, JSON.stringify(opts.keywords ?? []), opts.origin ?? 'manual', opts.notifyThreshold ?? 'high', now],
    );
    return { id, userId, name: opts.name, keywords: opts.keywords ?? [], status: 'active', origin: opts.origin ?? 'manual', notifyThreshold: opts.notifyThreshold ?? 'high', createdAt: now };
  }

  async listTopics(userId: string, status?: TopicStatus | TopicStatus[]): Promise<InterestTopic[]> {
    const statuses = status ? (Array.isArray(status) ? status : [status]) : undefined;
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (statuses && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const rows = await this.db.query(
      `SELECT * FROM interest_topics WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapTopic(r));
  }

  async getTopicById(userId: string, id: string): Promise<InterestTopic | null> {
    const row = await this.db.queryOne(`SELECT * FROM interest_topics WHERE id = ? AND user_id = ?`, [id, userId]) as Record<string, unknown> | undefined;
    return row ? this.mapTopic(row) : null;
  }

  /**
   * v952 — Exakter Namens-Match (case-insensitive, getrimmt). Für den
   * Duplikat-Check beim ANLEGEN — die Fuzzy-Suche unten ist dafür zu locker
   * (Realfall: „Panini-Sammelalbum WM 2026" matchte via Keyword „Panini"
   * fälschlich auf „FussballCC News" → Anlegen verweigert).
   */
  async findTopicByNameExact(userId: string, name: string): Promise<InterestTopic | null> {
    const topics = await this.listTopics(userId);
    const q = name.toLowerCase().trim();
    return topics.find(t => t.name.toLowerCase().trim() === q) ?? null;
  }

  /** Fuzzy-Suche nach Name (exakt → enthält → Keyword als GANZES WORT) — für Lookups (briefing, link). */
  async findTopicByName(userId: string, name: string): Promise<InterestTopic | null> {
    const topics = await this.listTopics(userId);
    const q = name.toLowerCase().trim();
    const exact = topics.find(t => t.name.toLowerCase() === q);
    if (exact) return exact;
    const contains = topics.find(t => t.name.toLowerCase().includes(q) || q.includes(t.name.toLowerCase()));
    if (contains) return contains;
    // v952 — Keyword nur als ganzes Wort und ≥4 Zeichen (vorher: rohes includes —
    // kurze Keywords grabschten sich fremde Anfragen)
    return topics.find(t => t.keywords.some(k => {
      const kw = k.toLowerCase().trim();
      if (kw.length < 4) return kw === q;
      if (kw === q) return true;
      return new RegExp(`(^|[^a-zä-ü0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zä-ü0-9]|$)`, 'i').test(q);
    })) ?? null;
  }

  async updateTopic(userId: string, id: string, patch: {
    name?: string; keywords?: string[]; status?: TopicStatus; notifyThreshold?: string;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.keywords !== undefined) { sets.push('keywords = ?'); params.push(JSON.stringify(patch.keywords)); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.notifyThreshold !== undefined) { sets.push('notify_threshold = ?'); params.push(patch.notifyThreshold); }
    if (sets.length === 0) return;
    params.push(id, userId);
    await this.db.execute(`UPDATE interest_topics SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  }

  async touchActivity(topicId: string): Promise<void> {
    await this.db.execute(`UPDATE interest_topics SET last_activity_at = ? WHERE id = ?`, [new Date().toISOString(), topicId]);
  }

  /** Alle aktiven Topics ALLER User — für den Collector-Rundlauf. */
  async listAllActiveTopics(): Promise<InterestTopic[]> {
    const rows = await this.db.query(`SELECT * FROM interest_topics WHERE status = 'active'`, []) as Record<string, unknown>[];
    return rows.map(r => this.mapTopic(r));
  }

  // ── Sources ───────────────────────────────────────────────────────────

  async addSource(topicId: string, opts: {
    kind: TopicSourceKind; config: Record<string, unknown>; addedBy?: 'auto' | 'manual';
  }): Promise<TopicSource> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO topic_sources (id, topic_id, kind, config, added_by, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, topicId, opts.kind, JSON.stringify(opts.config), opts.addedBy ?? 'manual', now],
    );
    return { id, topicId, kind: opts.kind, config: opts.config, addedBy: opts.addedBy ?? 'manual', enabled: true, createdAt: now };
  }

  async listSources(topicId: string, onlyEnabled = false): Promise<TopicSource[]> {
    const rows = await this.db.query(
      `SELECT * FROM topic_sources WHERE topic_id = ?${onlyEnabled ? ' AND enabled = 1' : ''} ORDER BY created_at`,
      [topicId],
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapSource(r));
  }

  async removeSource(topicId: string, sourceId: string): Promise<boolean> {
    const r = await this.db.execute(`DELETE FROM topic_sources WHERE id = ? AND topic_id = ?`, [sourceId, topicId]);
    return (r.changes ?? 0) > 0;
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    await this.db.execute(`UPDATE topic_sources SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, sourceId]);
  }

  /** v940 — Quellen-Config aktualisieren (z.B. Strike-Zähler der Quellen-Pflege). */
  async updateSourceConfig(sourceId: string, config: Record<string, unknown>): Promise<void> {
    await this.db.execute(`UPDATE topic_sources SET config = ? WHERE id = ?`, [JSON.stringify(config), sourceId]);
  }

  async markSourceChecked(sourceId: string): Promise<void> {
    await this.db.execute(`UPDATE topic_sources SET last_checked_at = ? WHERE id = ?`, [new Date().toISOString(), sourceId]);
  }

  // ── Items ─────────────────────────────────────────────────────────────

  /** Legt ein Item an; Duplikat (gleicher dedupe_hash je Topic) → inserted:false. */
  async insertItem(topicId: string, item: {
    title: string; url?: string; summary?: string; sourceKind: string; publishedAt?: string; importance?: number;
  }): Promise<{ inserted: boolean; id: string }> {
    const hash = topicItemDedupeHash(item);
    const existing = await this.db.queryOne(
      `SELECT id FROM topic_items WHERE topic_id = ? AND dedupe_hash = ?`,
      [topicId, hash],
    ) as { id: string } | undefined;
    if (existing) return { inserted: false, id: existing.id };
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO topic_items (id, topic_id, title, url, summary, source_kind, published_at, importance, dedupe_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, topicId, item.title.slice(0, 300), item.url ?? null, item.summary?.slice(0, 2000) ?? null,
       item.sourceKind, item.publishedAt ?? null, item.importance ?? null, hash, new Date().toISOString()],
    );
    return { inserted: true, id };
  }

  async listItems(topicId: string, opts?: { limit?: number; sinceIso?: string }): Promise<TopicItem[]> {
    const where = ['topic_id = ?'];
    const params: unknown[] = [topicId];
    if (opts?.sinceIso) { where.push('created_at >= ?'); params.push(opts.sinceIso); }
    params.push(opts?.limit ?? 30);
    const rows = await this.db.query(
      `SELECT * FROM topic_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    ) as Record<string, unknown>[];
    return rows.map(r => this.mapItem(r));
  }

  async countItemsSince(topicId: string, sinceIso: string): Promise<number> {
    const row = await this.db.queryOne(
      `SELECT COUNT(*) AS c FROM topic_items WHERE topic_id = ? AND created_at >= ?`,
      [topicId, sinceIso],
    ) as { c: number | string } | undefined;
    return row ? Number(row.c) : 0;
  }

  // ── Digest ────────────────────────────────────────────────────────────

  async getDigest(topicId: string): Promise<TopicDigest | null> {
    const row = await this.db.queryOne(`SELECT * FROM topic_digests WHERE topic_id = ?`, [topicId]) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      topicId: String(row.topic_id),
      summary: String(row.summary),
      itemsSinceUpdate: Number(row.items_since_update ?? 0),
      updatedAt: String(row.updated_at),
    };
  }

  async upsertDigest(topicId: string, summary: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.queryOne(`SELECT topic_id FROM topic_digests WHERE topic_id = ?`, [topicId]);
    if (existing) {
      await this.db.execute(`UPDATE topic_digests SET summary = ?, items_since_update = 0, updated_at = ? WHERE topic_id = ?`, [summary, now, topicId]);
    } else {
      await this.db.execute(`INSERT INTO topic_digests (topic_id, summary, items_since_update, updated_at) VALUES (?, ?, 0, ?)`, [topicId, summary, now]);
    }
  }

  // ── Mapping ───────────────────────────────────────────────────────────

  private mapTopic(r: Record<string, unknown>): InterestTopic {
    let keywords: string[] = [];
    try { const p = JSON.parse(String(r.keywords ?? '[]')); if (Array.isArray(p)) keywords = p.map(String); } catch { /* leer */ }
    return {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), keywords,
      status: String(r.status) as TopicStatus, origin: String(r.origin) as TopicOrigin,
      notifyThreshold: String(r.notify_threshold ?? 'high'),
      createdAt: String(r.created_at),
      lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : undefined,
    };
  }

  private mapSource(r: Record<string, unknown>): TopicSource {
    let config: Record<string, unknown> = {};
    try { const p = JSON.parse(String(r.config ?? '{}')); if (p && typeof p === 'object') config = p; } catch { /* leer */ }
    return {
      id: String(r.id), topicId: String(r.topic_id), kind: String(r.kind) as TopicSourceKind, config,
      addedBy: (r.added_by === 'auto' ? 'auto' : 'manual'),
      enabled: r.enabled === 1 || r.enabled === true,
      lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : undefined,
      createdAt: String(r.created_at),
    };
  }

  private mapItem(r: Record<string, unknown>): TopicItem {
    return {
      id: String(r.id), topicId: String(r.topic_id), title: String(r.title),
      url: r.url ? String(r.url) : undefined,
      summary: r.summary ? String(r.summary) : undefined,
      sourceKind: String(r.source_kind),
      publishedAt: r.published_at ? String(r.published_at) : undefined,
      importance: r.importance !== null && r.importance !== undefined ? Number(r.importance) : undefined,
      createdAt: String(r.created_at),
    };
  }
}
