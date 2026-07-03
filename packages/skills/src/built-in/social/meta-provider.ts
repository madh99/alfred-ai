import type { SocialChannel, ContentItem, ContentMedia } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';
import { parsePublicMediaConfig, publishPublicMedia } from './public-media.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
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
    };
  }

  private token(secrets: Record<string, string>): string {
    const t = this.platform === 'threads'
      ? (secrets.THREADS_ACCESS_TOKEN ?? secrets.META_ACCESS_TOKEN)
      : secrets.META_ACCESS_TOKEN;
    if (!t) throw new Error(`Meta-Token fehlt (META_ACCESS_TOKEN in ENV-Stage social)`);
    return t;
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
    const text = composePostText(item, caps.maxTextLength);
    const image = await this.ensurePublicUrl(item.media.find(m => m.type === 'image'), item, channel, secrets);
    const video = await this.ensurePublicUrl(item.media.find(m => m.type === 'video'), item, channel, secrets);

    if (this.platform === 'instagram') {
      // Container-Flow: media → (Status-Poll bei Video) → media_publish
      if (!image && !video) throw new Error('Instagram braucht ein Bild oder Video (öffentliche URL).');
      const containerParams: Record<string, string> = { access_token: token, caption: text };
      if (video) { containerParams.media_type = 'REELS'; containerParams.video_url = video.pathOrUrl; }
      else if (image) { containerParams.image_url = image.pathOrUrl; }
      const container = await this.graphPost(`${GRAPH}/${target}/media`, containerParams);
      const creationId = String(container.id ?? '');
      if (!creationId) throw new Error('Instagram: kein Container erstellt');
      if (video) await this.waitForContainer(creationId, token);
      const published = await this.graphPost(`${GRAPH}/${target}/media_publish`, { access_token: token, creation_id: creationId });
      const mediaId = String(published.id ?? '');
      return { externalId: mediaId, url: await this.igPermalink(mediaId, token) };
    }

    if (this.platform === 'facebook') {
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

  private async waitForContainer(creationId: string, token: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const res = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({})) as { status_code?: string };
      if (data.status_code === 'FINISHED') return;
      if (data.status_code === 'ERROR') throw new Error('Instagram: Video-Verarbeitung fehlgeschlagen');
    }
    throw new Error('Instagram: Video-Verarbeitung Timeout (60s)');
  }

  private async igPermalink(mediaId: string, token: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      const data = await res.json() as { permalink?: string };
      return data.permalink;
    } catch { return undefined; }
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = this.token(secrets);
      const target = this.targetId(channel);
      const base = this.platform === 'threads' ? THREADS : GRAPH;
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

  override async fetchMetrics(
    items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    const token = this.token(secrets);
    const base = this.platform === 'threads' ? THREADS : GRAPH;
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
