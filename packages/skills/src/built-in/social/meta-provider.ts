import type { SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult, type FetchedComment } from './social-provider.js';
import { parsePublicMediaConfig, publishPublicMedia } from './public-media.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const IG_GRAPH = 'https://graph.instagram.com/v21.0';
const THREADS = 'https://graph.threads.net/v1.0';

/**
 * v936 — Meta-Provider: Instagram (Container-Flow), Facebook-Pages und Threads
 * über die Graph-API. Eine Klasse, drei Registrierungen (platform-Parameter).
 *
 * Secrets (ENV-Stage 'social'): META_ACCESS_TOKEN (long-lived Page-/User-Token;
 * Threads: eigenes THREADS_ACCESS_TOKEN möglich, Fallback META_ACCESS_TOKEN).
 * channel.config: instagram → { ig_user_id }, facebook → { page_id },
 * threads → { threads_user_id }.
 *
 * Solange die Meta-App-Review läuft, den Kanal einfach mit publish_mode
 * 'prepare' fahren — dieselben Items werden dann fertig aufbereitet.
 */
export class MetaProvider extends SocialProvider {
  constructor(readonly platform: 'instagram' | 'facebook' | 'threads') {
    super();
  }

  capabilities(): ProviderCapabilities {
    return {
      text: this.platform !== 'instagram', // IG braucht immer ein Medium
      image: true,
      video: this.platform !== 'threads',
      maxTextLength: this.platform === 'threads' ? 500 : 2200,
      supportsDelete: this.platform === 'facebook',
      supportsMetrics: true,
      // v989 — Kommentare lesen/beantworten (FB-Pages + IG; Threads-API kann es nicht)
      supportsComments: this.platform !== 'threads',
      // v1007 — Stories (media_type STORIES) gibt es nur auf Instagram
      supportsStories: this.platform === 'instagram',
      // v1019 — Follower-Stand (IG followers_count, FB followers_count; Threads-API kann es nicht verlässlich)
      supportsAudience: this.platform !== 'threads',
    };
  }

  /** v1019 — Kanalwachstum: followers_count der IG-/FB-Identität. */
  override async fetchAudience(channel: SocialChannel, secrets: Record<string, string>): Promise<{ followers: number } | null> {
    try {
      if (this.platform === 'threads') return null;
      const token = this.token(secrets);
      const target = this.targetId(channel);
      const base = this.graphBase(secrets);
      const res = await fetch(`${base}/${target}?fields=followers_count&access_token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({})) as { followers_count?: number };
      return res.ok && typeof data.followers_count === 'number' ? { followers: data.followers_count } : null;
    } catch { return null; }
  }

  private token(secrets: Record<string, string>): string {
    const t = this.platform === 'threads'
      ? (secrets.THREADS_ACCESS_TOKEN ?? secrets.META_ACCESS_TOKEN)
      : secrets.META_ACCESS_TOKEN;
    if (!t) throw new Error(`Meta-Token fehlt (META_ACCESS_TOKEN in ENV-Stage social)`);
    return t;
  }

  /**
   * v970 — Meta hat ZWEI Instagram-APIs: „mit Facebook-Anmeldung" (Page-Token
   * `EAA…` → graph.facebook.com) und „mit Instagram-Anmeldung" (Token `IG…` →
   * graph.instagram.com). Realfall 04.07.: User-App war der neue IG-Login-Typ,
   * der Provider sprach nur graph.facebook.com → „Cannot parse access token".
   * Erkennung am Token-Präfix — kein Config-Schalter nötig.
   */
  private graphBase(secrets: Record<string, string>): string {
    if (this.platform === 'threads') return THREADS;
    if (this.platform === 'instagram' && secrets.META_ACCESS_TOKEN?.startsWith('IG')) return IG_GRAPH;
    return GRAPH;
  }

  private targetId(channel: SocialChannel): string {
    const key = this.platform === 'instagram' ? 'ig_user_id' : this.platform === 'facebook' ? 'page_id' : 'threads_user_id';
    const v = channel.config[key];
    if (typeof v !== 'string' || !v) throw new Error(`channel.config.${key} fehlt`);
    return v;
  }

  private async graphPost(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const err = (data.error as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`;
      throw new Error(`${this.platform}: ${String(err)}`);
    }
    return data;
  }

  /**
   * v969 — Meta holt Medien per öffentlicher http-URL ab. Lokale Dateien
   * (generierte Bilder) werden vorher über den Public-Media-Host des Kanals
   * (channel.config.public_media: Projekt-Medienbibliothek ODER S3-Bucket)
   * veröffentlicht; ohne Host gibt es einen verständlichen Fehler statt
   * eines stillen Posts ohne Bild.
   */
  private async ensurePublicUrl(
    media: ContentMedia | undefined, item: ContentItem, channel: SocialChannel, secrets: Record<string, string>,
  ): Promise<ContentMedia | undefined> {
    if (!media || media.pathOrUrl.startsWith('http')) return media;
    const cfg = parsePublicMediaConfig(channel.config.public_media);
    if (!cfg) {
      throw new Error(`${this.platform}: Medium ist eine lokale Datei — die Plattform braucht eine öffentliche URL. `
        + `channel.config.public_media konfigurieren (Medien-Ablageort: Projekt-Medienbibliothek oder S3-Bucket) oder publish_mode 'prepare' nutzen.`);
    }
    const url = await publishPublicMedia(cfg, media.pathOrUrl, secrets, item.title ?? undefined);
    return { ...media, pathOrUrl: url };
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const token = this.token(secrets);
    const target = this.targetId(channel);
    const caps = this.capabilities();
    const text = composePostText(item, caps.maxTextLength, channel);
    // v988 — ALLE Bilder veröffentlichen (Instagram-Karussell), nicht nur das erste
    const images: ContentMedia[] = [];
    for (const m of item.media.filter(m => m.type === 'image')) {
      const pub = await this.ensurePublicUrl(m, item, channel, secrets);
      if (pub) images.push(pub);
    }
    const image = images[0];
    const video = await this.ensurePublicUrl(item.media.find(m => m.type === 'video'), item, channel, secrets);

    if (this.platform === 'instagram') {
      // Container-Flow: media → (Status-Poll bei Video) → media_publish
      if (!image && !video) throw new Error('Instagram braucht ein Bild oder Video (öffentliche URL).');
      const base = this.graphBase(secrets);
      let creationId: string;
      if (!video && images.length >= 2) {
        // v988 — Karussell: je Bild ein Child-Container, dann CAROUSEL-Container
        const children: string[] = [];
        for (const img of images.slice(0, 10)) {
          const child = await this.graphPost(`${base}/${target}/media`, {
            access_token: token, image_url: img.pathOrUrl, is_carousel_item: 'true',
          });
          const childId = String(child.id ?? '');
          if (!childId) throw new Error('Instagram: Karussell-Child-Container fehlgeschlagen');
          children.push(childId);
        }
        const container = await this.graphPost(`${base}/${target}/media`, {
          access_token: token, media_type: 'CAROUSEL', children: children.join(','), caption: text,
        });
        creationId = String(container.id ?? '');
      } else {
        const containerParams: Record<string, string> = { access_token: token, caption: text };
        if (video) { containerParams.media_type = 'REELS'; containerParams.video_url = video.pathOrUrl; }
        else if (image) { containerParams.image_url = image.pathOrUrl; }
        const container = await this.graphPost(`${base}/${target}/media`, containerParams);
        creationId = String(container.id ?? '');
        // v1057 — Video-Transcoding braucht bei IG oft 1-5 min: 300s statt der
        // 60s-Defaults (Realfall 08.07.: 41s-Reel scheiterte inkl. Retry am
        // Poll, das 30s-Reel derselben Charge ging durch). Bild-Container
        // behalten ihre kurzen Polls.
        if (creationId && video) await this.waitForContainer(creationId, token, base, { tries: 60, delayMs: 5_000 });
      }
      if (!creationId) throw new Error('Instagram: kein Container erstellt');
      // v997 — auch Bild-/Karussell-Container erst FINISHED abwarten: Meta lädt
      // das Bild asynchron von der public_media-URL; media_publish direkt nach
      // dem Create scheiterte bei größeren Bildern mit „Media ID is not
      // available" (Realfall 05.07.: 3 Posts, 1,4-MB-PNGs).
      if (!video) await this.waitForContainer(creationId, token, base, { tries: 10, delayMs: 3_000 });
      const published = await this.publishContainer(base, target, token, creationId);
      const mediaId = String(published.id ?? '');
      return { externalId: mediaId, url: await this.igPermalink(mediaId, token, base) };
    }

    if (this.platform === 'facebook') {
      // v988 — Video-Posts: Graph zieht das Video per file_url (öffentliche
      // URL via public_media — wie Bilder); vorher endete ein Video-Item
      // als reiner Text-Post.
      if (video) {
        const r = await this.graphPost(`${GRAPH}/${target}/videos`, { access_token: token, file_url: video.pathOrUrl, description: text });
        const id = String(r.id ?? '');
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }
      // v1022 — mehrere Bilder als Album: erst unveröffentlichte Fotos anlegen,
      // dann EIN Feed-Post mit attached_media (vorher ging nur images[0] raus)
      if (images.length >= 2) {
        const mediaIds: string[] = [];
        for (const img of images.slice(0, 10)) {
          const r = await this.graphPost(`${GRAPH}/${target}/photos`, { access_token: token, url: img.pathOrUrl, published: 'false' });
          const id = String(r.id ?? '');
          if (id) mediaIds.push(id);
        }
        if (mediaIds.length >= 2) {
          const params: Record<string, string> = { access_token: token, message: text };
          mediaIds.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
          const r = await this.graphPost(`${GRAPH}/${target}/feed`, params);
          const id = String(r.id ?? '');
          return { externalId: id, url: `https://www.facebook.com/${id}` };
        }
      }
      if (image) {
        const r = await this.graphPost(`${GRAPH}/${target}/photos`, { access_token: token, url: image.pathOrUrl, caption: text });
        const id = String(r.post_id ?? r.id ?? '');
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }
      const r = await this.graphPost(`${GRAPH}/${target}/feed`, { access_token: token, message: text });
      const id = String(r.id ?? '');
      return { externalId: id, url: `https://www.facebook.com/${id}` };
    }

    // Threads: Container → publish
    const tParams: Record<string, string> = { access_token: token, text };
    if (image) { tParams.media_type = 'IMAGE'; tParams.image_url = image.pathOrUrl; }
    else { tParams.media_type = 'TEXT'; }
    const container = await this.graphPost(`${THREADS}/${target}/threads`, tParams);
    const creationId = String(container.id ?? '');
    const published = await this.graphPost(`${THREADS}/${target}/threads_publish`, { access_token: token, creation_id: creationId });
    return { externalId: String(published.id ?? creationId) };
  }

  /**
   * v1007 — Instagram-Story veröffentlichen (media_type STORIES): Container
   * mit öffentlicher Bild-URL → Status-Poll → media_publish. Stories haben
   * per API keine Caption — der CTA steht als Overlay im Bild.
   */
  async publishStory(imageUrl: string, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    if (this.platform !== 'instagram') throw new Error(`${this.platform}: Stories werden nur auf Instagram unterstützt`);
    const token = this.token(secrets);
    const target = this.targetId(channel);
    const base = this.graphBase(secrets);
    const container = await this.graphPost(`${base}/${target}/media`, {
      access_token: token, media_type: 'STORIES', image_url: imageUrl,
    });
    const creationId = String(container.id ?? '');
    if (!creationId) throw new Error('Instagram: kein Story-Container erstellt');
    await this.waitForContainer(creationId, token, base, { tries: 10, delayMs: 3_000 });
    const published = await this.publishContainer(base, target, token, creationId);
    const mediaId = String(published.id ?? '');
    return { externalId: mediaId, url: await this.igPermalink(mediaId, token, base) };
  }

  private async waitForContainer(
    creationId: string, token: string, base: string = GRAPH,
    opts?: { tries?: number; delayMs?: number },
  ): Promise<void> {
    const tries = opts?.tries ?? 12;
    const delayMs = opts?.delayMs ?? 5_000;
    for (let i = 0; i < tries; i++) {
      // v997 — erst prüfen, dann schlafen: Bild-Container sind oft sofort fertig
      const res = await fetch(`${base}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({})) as { status_code?: string };
      if (data.status_code === 'FINISHED') return;
      if (data.status_code === 'ERROR') throw new Error('Instagram: Medien-Verarbeitung fehlgeschlagen (Container ERROR)');
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(`Instagram: Medien-Verarbeitung Timeout (${Math.round(tries * delayMs / 1000)}s)`);
  }

  /** v997 — media_publish mit Retry: „Media ID is not available" heißt nur „noch nicht fertig geladen". */
  private async publishContainer(base: string, target: string, token: string, creationId: string): Promise<Record<string, unknown>> {
    let lastErr: Error | undefined;
    for (let i = 0; i < 3; i++) {
      try {
        return await this.graphPost(`${base}/${target}/media_publish`, { access_token: token, creation_id: creationId });
      } catch (err) {
        lastErr = err as Error;
        if (!/media id is not available/i.test(lastErr.message)) throw lastErr;
        await new Promise(r => setTimeout(r, 5_000));
      }
    }
    throw lastErr ?? new Error('Instagram: media_publish fehlgeschlagen');
  }

  private async igPermalink(mediaId: string, token: string, base: string = GRAPH): Promise<string | undefined> {
    try {
      const res = await fetch(`${base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      const data = await res.json() as { permalink?: string };
      return data.permalink;
    } catch { return undefined; }
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = this.token(secrets);
      const target = this.targetId(channel);
      const base = this.graphBase(secrets);
      const field = this.platform === 'facebook' ? 'name' : 'username';
      const res = await fetch(`${base}/${target}?fields=${field}&access_token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      return res.ok
        ? { ok: true, detail: String(data[field] ?? target) }
        : { ok: false, detail: String((data.error as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`) };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  override async deletePost(externalId: string, _channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    if (this.platform !== 'facebook') return false; // IG/Threads-API können nicht löschen
    try {
      const res = await fetch(`${GRAPH}/${externalId}?access_token=${encodeURIComponent(this.token(secrets))}`, { method: 'DELETE' });
      return res.ok;
    } catch { return false; }
  }

  /**
   * v989 — Kommentare je Post einsammeln (FB: /post/comments mit from;
   * IG: /media/comments mit username). Eigene Antworten der Seite/des
   * Accounts werden übersprungen (FB: from.id == page_id; IG: username ==
   * config.ig_username, falls gesetzt).
   */
  override async fetchComments(
    items: Array<{ id: string; externalId: string }>,
    channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<FetchedComment[]> {
    if (this.platform === 'threads') return [];
    const token = this.token(secrets);
    const base = this.graphBase(secrets);
    const target = this.targetId(channel);
    const ownIgName = typeof channel.config.ig_username === 'string' ? channel.config.ig_username.toLowerCase() : '';
    const fields = this.platform === 'facebook'
      ? 'id,message,from{id,name},created_time'
      : 'id,text,username,timestamp';
    const out: FetchedComment[] = [];
    for (const item of items.slice(0, 25)) {
      try {
        const res = await fetch(`${base}/${item.externalId}/comments?fields=${fields}&limit=50&access_token=${encodeURIComponent(token)}`);
        if (!res.ok) continue;
        const data = await res.json() as { data?: Array<Record<string, any>> };
        for (const c of data.data ?? []) {
          const text = String(c.message ?? c.text ?? '').trim();
          if (!text || !c.id) continue;
          if (this.platform === 'facebook' && String(c.from?.id ?? '') === target) continue; // eigene Seiten-Antwort
          const author = String(c.from?.name ?? c.username ?? '');
          if (this.platform === 'instagram' && ownIgName && author.toLowerCase() === ownIgName) continue;
          out.push({
            itemId: item.id,
            externalCommentId: String(c.id),
            externalPostId: item.externalId,
            author: author || undefined,
            text,
            createdAt: c.created_time ?? c.timestamp ?? undefined,
          });
        }
      } catch { /* Einzelfehler überspringen */ }
    }
    return out;
  }

  /** v989 — Antwort auf einen Kommentar (FB: /comment/comments; IG: /comment/replies). */
  override async replyToComment(
    externalCommentId: string, text: string,
    channel: SocialChannel, secrets: Record<string, string>,
  ): Promise<boolean> {
    if (this.platform === 'threads') return false;
    const token = this.token(secrets);
    const base = this.graphBase(secrets);
    try {
      const path = this.platform === 'facebook' ? 'comments' : 'replies';
      await this.graphPost(`${base}/${externalCommentId}/${path}`, { access_token: token, message: text });
      return true;
    } catch {
      return false;
    }
  }

  override async fetchMetrics(
    items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    const token = this.token(secrets);
    const base = this.graphBase(secrets);
    const fields = this.platform === 'facebook'
      ? 'likes.summary(true),comments.summary(true),shares'
      : 'like_count,comments_count';
    const out: Array<{ itemId: string; kind: string; value: number }> = [];
    for (const item of items.slice(0, 25)) {
      try {
        const res = await fetch(`${base}/${item.externalId}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
        if (!res.ok) continue;
        const data = await res.json() as Record<string, any>;
        if (this.platform === 'facebook') {
          const likes = data.likes?.summary?.total_count;
          const comments = data.comments?.summary?.total_count;
          const shares = data.shares?.count;
          if (likes !== undefined) out.push({ itemId: item.id, kind: 'likes', value: Number(likes) });
          if (comments !== undefined) out.push({ itemId: item.id, kind: 'comments', value: Number(comments) });
          if (shares !== undefined) out.push({ itemId: item.id, kind: 'shares', value: Number(shares) });
        } else {
          if (data.like_count !== undefined) out.push({ itemId: item.id, kind: 'likes', value: Number(data.like_count) });
          if (data.comments_count !== undefined) out.push({ itemId: item.id, kind: 'comments', value: Number(data.comments_count) });
        }
      } catch { /* Einzelfehler überspringen */ }
    }
    return out;
  }
}
