import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';
import { loadSharp } from './image-overlay.js';

/** v1018 — Bluesky-Blob-Limit für Bilder (Server lehnt >2.000.000 Bytes ab); mit Puffer. */
const MAX_IMAGE_BYTES = 1_900_000;

/**
 * v1018 — Bild fürs Bluesky-Limit vorbereiten: über 1,9 MB wird per sharp
 * verkleinert (max. 1600px Kante) und als JPEG (q82) neu kodiert — die
 * high-quality-PNGs des Studios liegen sonst über dem 2-MB-Limit
 * (Realfall: 2,3 MB → „blob too big"). Ohne sharp und zu groß → null
 * (dann lieber Post ohne Bild als gar kein Post).
 */
export async function prepareBlueskyImage(bytes: Buffer): Promise<{ bytes: Buffer; mime: string } | null> {
  if (bytes.length <= MAX_IMAGE_BYTES) return { bytes, mime: 'image/png' };
  try {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const out: Buffer = await (sharp as unknown as (i: Buffer) => {
      resize(o: Record<string, unknown>): { jpeg(o: Record<string, unknown>): { toBuffer(): Promise<Buffer> } };
    })(bytes).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return out.length <= MAX_IMAGE_BYTES ? { bytes: out, mime: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

/**
 * v1013 — Bluesky-Provider (AT Protocol): postet über die XRPC-API.
 * channel.config: { handle: 'name.bsky.social', service?: 'https://bsky.social' }
 * Secrets: { BLUESKY_APP_PASSWORD } — App-Passwort aus den Bluesky-Einstellungen
 * (NIE das Konto-Passwort). Bilder werden DIREKT hochgeladen (uploadBlob) —
 * kein public_media nötig; Links im Text sind über Facets klickbar.
 */
export class BlueskyProvider extends SocialProvider {
  readonly platform = 'bluesky';

  capabilities(): ProviderCapabilities {
    return { text: true, image: true, video: false, maxTextLength: 300, supportsDelete: true, supportsMetrics: false, supportsAudience: true };
  }

  /** v1019 — Kanalwachstum: Follower via öffentlichem AppView (kein Login nötig). */
  override async fetchAudience(channel: SocialChannel, _secrets: Record<string, string>): Promise<{ followers: number } | null> {
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(this.handle(channel))}`);
      const data = await res.json().catch(() => ({})) as { followersCount?: number };
      return res.ok && typeof data.followersCount === 'number' ? { followers: data.followersCount } : null;
    } catch { return null; }
  }

  private service(channel: SocialChannel): string {
    const s = typeof channel.config.service === 'string' && channel.config.service.trim() ? channel.config.service.trim() : 'https://bsky.social';
    return s.replace(/\/+$/, '');
  }

  private handle(channel: SocialChannel): string {
    const h = channel.config.handle;
    if (typeof h !== 'string' || !h.trim()) throw new Error('channel.config.handle fehlt (z.B. "fussballcc.bsky.social")');
    return h.trim().replace(/^@/, '');
  }

  private async createSession(channel: SocialChannel, secrets: Record<string, string>): Promise<{ accessJwt: string; did: string; handle: string }> {
    const password = secrets.BLUESKY_APP_PASSWORD;
    if (!password) throw new Error('BLUESKY_APP_PASSWORD fehlt (App-Passwort, ENV-Stage des Kanals)');
    const res = await fetch(`${this.service(channel)}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: this.handle(channel), password }),
    });
    const data = await res.json().catch(() => ({})) as { accessJwt?: string; did?: string; handle?: string; message?: string };
    if (!res.ok || !data.accessJwt || !data.did) {
      throw new Error(`Bluesky-Login fehlgeschlagen: ${data.message ?? `HTTP ${res.status}`}`);
    }
    return { accessJwt: data.accessJwt, did: data.did, handle: data.handle ?? this.handle(channel) };
  }

  /** Link-Facets (klickbare URLs) — Byte-Offsets in UTF-8, wie das AT Protocol sie verlangt. */
  static linkFacets(text: string): Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: string; uri: string }> }> {
    const facets: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: string; uri: string }> }> = [];
    const re = /https?:\/\/[^\s)\]}>"']+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const url = m[0].replace(/[.,;:!?]+$/, ''); // Satzzeichen am Ende gehören nicht zur URL
      const byteStart = Buffer.byteLength(text.slice(0, m.index), 'utf8');
      const byteEnd = byteStart + Buffer.byteLength(url, 'utf8');
      facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] });
    }
    return facets;
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const session = await this.createSession(channel, secrets);
    const service = this.service(channel);
    const text = composePostText(item, 300, channel);

    // Bilder direkt hochladen (max. 4 laut Protokoll)
    const images: Array<{ image: unknown; alt: string }> = [];
    for (const media of item.media.filter(m => m.type === 'image').slice(0, 4)) {
      let bytes: Buffer;
      if (media.pathOrUrl.startsWith('http')) {
        const res = await fetch(media.pathOrUrl);
        if (!res.ok) continue;
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        const { readFile } = await import('node:fs/promises');
        bytes = await readFile(media.pathOrUrl);
      }
      // v1018 — Bluesky-Limit: >1,9 MB verkleinern (sonst „blob too big")
      const prepared = await prepareBlueskyImage(bytes);
      if (!prepared) continue; // Bild nicht limitierbar → Post ohne dieses Bild
      const up = await fetch(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': prepared.mime },
        body: new Uint8Array(prepared.bytes),
      });
      const upData = await up.json().catch(() => ({})) as { blob?: unknown; message?: string };
      if (!up.ok || !upData.blob) throw new Error(`Bluesky: Bild-Upload fehlgeschlagen (${upData.message ?? `HTTP ${up.status}`})`);
      images.push({ image: upData.blob, alt: item.title ?? '' });
    }

    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };
    const facets = BlueskyProvider.linkFacets(text);
    if (facets.length > 0) record.facets = facets;
    if (images.length > 0) record.embed = { $type: 'app.bsky.embed.images', images };

    const res = await fetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    });
    const data = await res.json().catch(() => ({})) as { uri?: string; message?: string };
    if (!res.ok || !data.uri) throw new Error(`Bluesky: ${data.message ?? `HTTP ${res.status}`}`);
    const rkey = data.uri.split('/').pop() ?? '';
    return { externalId: rkey, url: `https://bsky.app/profile/${session.handle}/post/${rkey}` };
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const session = await this.createSession(channel, secrets);
      return { ok: true, detail: session.handle };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async deletePost(externalId: string, channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const session = await this.createSession(channel, secrets);
      const res = await fetch(`${this.service(channel)}/xrpc/com.atproto.repo.deleteRecord`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', rkey: externalId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
