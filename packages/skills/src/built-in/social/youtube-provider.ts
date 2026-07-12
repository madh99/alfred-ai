import { readFile } from 'node:fs/promises';
import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, type ProviderCapabilities, type PublishResult } from './social-provider.js';

/**
 * v936 — YouTube-Provider: Upload via Data API v3 (resumable), Thumbnail,
 * Analytics (views/likes/comments je Video), Löschen.
 *
 * Secrets (project_environments, Stage 'social'):
 *   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
 * (Refresh-Token einmalig per OAuth2-Consent für den eigenen Account holen —
 *  Scope https://www.googleapis.com/auth/youtube.upload + youtube.readonly)
 *
 * channel.config: { privacy_status?: 'public'|'unlisted'|'private' (Default unlisted),
 *                   category_id?: string (Default '17' Sport) }
 *
 * Item-Konvention (Content-Studio v935): title = Video-Titel, body = Script
 * mit optionalem '---'-Trenner — der Teil NACH '---' wird die
 * YouTube-Beschreibung; ohne Trenner die ersten 4900 Zeichen des Bodys.
 * media: genau ein video (lokaler Pfad) + optional ein image (Thumbnail).
 */
export class YouTubeProvider extends SocialProvider {
  readonly platform = 'youtube';

  capabilities(): ProviderCapabilities {
    return { text: false, image: true, video: true, maxTextLength: 5000, supportsDelete: true, supportsMetrics: true, supportsAudience: true };
  }

  /** v1019 — Kanalwachstum: Abonnenten via channels.list (mine=true). */
  override async fetchAudience(_channel: import('@alfred/storage').SocialChannel, secrets: Record<string, string>): Promise<{ followers: number } | null> {
    try {
      const token = await this.accessToken(secrets);
      const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({})) as { items?: Array<{ statistics?: { subscriberCount?: string } }> };
      const count = Number(data.items?.[0]?.statistics?.subscriberCount);
      return res.ok && Number.isFinite(count) ? { followers: count } : null;
    } catch { return null; }
  }

  private async accessToken(secrets: Record<string, string>): Promise<string> {
    const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = secrets;
    if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
      throw new Error('YouTube-Secrets fehlen (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN in ENV-Stage social)');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET,
        refresh_token: YT_REFRESH_TOKEN, grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await res.json() as { access_token?: string; error_description?: string };
    if (!data.access_token) throw new Error(`YouTube-OAuth: ${data.error_description ?? `HTTP ${res.status}`}`);
    return data.access_token;
  }

  /**
   * v1109 — Beschreibung als CTA-Fläche (der einzige klickbare Ort auf
   * YouTube): Zeile 1 = Artikel-Link mit UTM (above the fold, kommt als
   * performance.trafficUrl aus dem Traffic-CTA), dann der Text (Teil nach
   * '---' — Studio-Konvention — oder Body), dann der konfigurierbare
   * Standard-Footer (config.yt_description_footer: Website/Tippspiel/
   * Tauschbörse, Links klickbar), zum Schluss bis zu 5 Hashtags (die ersten
   * 3 erscheinen über dem Video-Titel).
   */
  static description(item: ContentItem, channel?: Pick<SocialChannel, 'config'>): string {
    const parts = item.body.split(/\n-{3,}\n/);
    const text = (parts.length > 1 ? parts.slice(1).join('\n') : item.body).trim();
    const url = typeof item.performance?.trafficUrl === 'string' ? item.performance.trafficUrl : undefined;
    const label = typeof item.performance?.trafficLabel === 'string' && item.performance.trafficLabel.trim()
      ? item.performance.trafficLabel.trim() : '👉 Ganzer Artikel:';
    const head = url ? `${label} ${url}` : '';
    const footerRaw = channel?.config.yt_description_footer;
    const footer = typeof footerRaw === 'string' && footerRaw.trim() ? footerRaw.trim() : '';
    const tags = (item.hashtags ?? []).slice(0, 5)
      .map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    return [head, text, footer, tags].filter(Boolean).join('\n\n').slice(0, 4900);
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const video = item.media.find(m => m.type === 'video');
    if (!video) throw new Error('Kein Video am Item — Datei per attach_media anhängen (User-Video) oder Video-Pipeline (v938) nutzen.');
    if (video.pathOrUrl.startsWith('http')) throw new Error('YouTube-Upload braucht eine lokale Videodatei (URL-Import nicht unterstützt).');

    const token = await this.accessToken(secrets);
    const bytes = await readFile(video.pathOrUrl);

    // Resumable Upload: 1) Session anlegen → Location, 2) Bytes PUT
    const metadata = {
      snippet: {
        title: (item.title ?? 'Video').slice(0, 100),
        description: YouTubeProvider.description(item, channel),
        tags: item.hashtags.map(h => h.replace(/^#/, '')).slice(0, 30),
        categoryId: typeof channel.config.category_id === 'string' ? channel.config.category_id : '17',
      },
      status: {
        privacyStatus: typeof channel.config.privacy_status === 'string' ? channel.config.privacy_status : 'unlisted',
        selfDeclaredMadeForKids: false,
      },
    };
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': String(bytes.byteLength),
      },
      body: JSON.stringify(metadata),
    });
    if (!init.ok) throw new Error(`YouTube-Upload-Init HTTP ${init.status}: ${(await init.text()).slice(0, 200)}`);
    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('YouTube-Upload: keine Session-URL erhalten');

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/*', 'Content-Length': String(bytes.byteLength) },
      body: bytes,
    });
    if (!upload.ok) throw new Error(`YouTube-Upload HTTP ${upload.status}: ${(await upload.text()).slice(0, 200)}`);
    const uploaded = await upload.json() as { id?: string };
    if (!uploaded.id) throw new Error('YouTube-Upload: keine Video-ID in der Antwort');

    // Thumbnail best-effort (generiertes Bild oder User-Bild am Item)
    const thumb = item.media.find(m => m.type === 'image');
    if (thumb && !thumb.pathOrUrl.startsWith('http')) {
      try {
        const thumbBytes = await readFile(thumb.pathOrUrl);
        await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${uploaded.id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
          body: thumbBytes,
        });
      } catch { /* Thumbnail optional */ }
    }

    return { externalId: uploaded.id, url: `https://www.youtube.com/watch?v=${uploaded.id}` };
  }

  async validateAuth(_channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = await this.accessToken(secrets);
      const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { items?: Array<{ snippet?: { title?: string } }> };
      const title = data.items?.[0]?.snippet?.title;
      return res.ok && title ? { ok: true, detail: title } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  override async deletePost(externalId: string, _channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const token = await this.accessToken(secrets);
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(externalId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      return res.status === 204;
    } catch { return false; }
  }

  override async fetchMetrics(
    items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    if (items.length === 0) return [];
    const token = await this.accessToken(secrets);
    const ids = items.map(i => i.externalId).join(',');
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(ids)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { items?: Array<{ id: string; statistics?: Record<string, string> }> };
    const byExternal = new Map(items.map(i => [i.externalId, i.id]));
    const out: Array<{ itemId: string; kind: string; value: number }> = [];
    for (const v of data.items ?? []) {
      const itemId = byExternal.get(v.id);
      if (!itemId || !v.statistics) continue;
      for (const [key, kind] of [['viewCount', 'views'], ['likeCount', 'likes'], ['commentCount', 'comments']] as const) {
        const raw = v.statistics[key];
        if (raw !== undefined) out.push({ itemId, kind, value: Number(raw) });
      }
    }
    return out;
  }
}
