import { createHmac, randomBytes } from 'node:crypto';
import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';

/**
 * v936 — X/Twitter-Provider (API v2, Free-Tier-tauglich: ~500 Posts/Monat).
 *
 * Secrets (ENV-Stage 'social'): X_ACCESS_TOKEN (OAuth2-User-Token mit
 * tweet.write; Refresh via X_REFRESH_TOKEN + X_CLIENT_ID — v1028: Rotation
 * wird persistiert, Access-Token gecacht).
 *
 * Monats-Budget: am Kanal `config.max_posts_per_month` setzen (z.B. 450) —
 * der social-Skill erzwingt das generisch VOR jedem Publish (v936-Leitplanke).
 *
 * v1029 — Bild-Posts über die v2-Media-Endpoints (POST /2/media/upload +
 * media_ids am Tweet, bis 4 Bilder à max. 5 MB). Braucht den OAuth2-Scope
 * `media.write` am User-Token! Upload ist best-effort: scheitert er, geht der
 * Post ohne Bild raus — dann auch OHNE KI-Kennzeichnung (Realfall 06.07.:
 * „Bild: KI-generiert" stand im Tweet, obwohl kein Bild mitging).
 */
export class XProvider extends SocialProvider {
  readonly platform = 'x';

  /**
   * v1028 — X ROTIERT Refresh-Tokens (jeder Refresh entwertet das alte und
   * liefert ein neues): ohne Persistieren klappt nur der ERSTE Refresh, danach
   * fällt der Kanal stumm aus. Der Kern injiziert den Secrets-Writer
   * (project_environments, gleiche Mechanik wie der IG-Token-Refresh v984).
   */
  private secretsWriter?: (channel: SocialChannel, patch: Record<string, string>) => Promise<void>;

  setSecretsWriter(fn: (channel: SocialChannel, patch: Record<string, string>) => Promise<void>): void {
    this.secretsWriter = fn;
  }

  /** v1028 — Access-Token-Cache (X-Tokens leben ~2h): refresht nicht pro Call, sondern pro Ablauf. */
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  capabilities(): ProviderCapabilities {
    return { text: true, image: true, video: false, maxTextLength: 280, supportsDelete: true, supportsMetrics: true, supportsAudience: true };
  }

  /**
   * v1030 — OAuth-1.0a-Signatur (HMAC-SHA1) für die v1.1-Media-API: der
   * OAuth2-Scope media.write wird von X für viele Accounts (noch) nicht
   * gewährt (Realfall 06.07.: Scope stillschweigend aus dem Grant entfernt) —
   * der klassische v1.1-Upload mit App-Keys funktioniert dagegen überall,
   * solange die App-Permission „Read and write" gesetzt ist. Bei multipart
   * gehen NUR die oauth_*-Parameter in die Signatur-Basis (kein Body).
   */
  private oauth1Header(method: string, url: string, secrets: Record<string, string>): string {
    const enc = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const oauth: Record<string, string> = {
      oauth_consumer_key: secrets.X_CONSUMER_KEY,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: secrets.X_OAUTH1_ACCESS_TOKEN,
      oauth_version: '1.0',
    };
    const paramString = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join('&');
    const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
    const signingKey = `${enc(secrets.X_CONSUMER_SECRET)}&${enc(secrets.X_OAUTH1_ACCESS_SECRET)}`;
    const signature = createHmac('sha1', signingKey).update(base).digest('base64');
    return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
  }

  private hasOauth1(secrets: Record<string, string>): boolean {
    return !!(secrets.X_CONSUMER_KEY && secrets.X_CONSUMER_SECRET && secrets.X_OAUTH1_ACCESS_TOKEN && secrets.X_OAUTH1_ACCESS_SECRET);
  }

  /**
   * v1029/v1030 — Bilder (max. 4, je ≤5 MB) hochladen und media_ids liefern.
   * Bevorzugt v1.1 (OAuth 1.0a, Secrets X_CONSUMER_KEY/X_CONSUMER_SECRET/
   * X_OAUTH1_ACCESS_TOKEN/X_OAUTH1_ACCESS_SECRET), sonst v2 (OAuth2-Scope
   * media.write). Best-effort je Bild: Fehler kosten NIE den Post — er geht
   * dann ohne (fehlende) Bilder raus.
   */
  private async uploadImages(item: ContentItem, token: string, secrets: Record<string, string>): Promise<string[]> {
    const ids: string[] = [];
    const useV11 = this.hasOauth1(secrets);
    for (const m of item.media.filter(x => x.type === 'image').slice(0, 4)) {
      try {
        let bytes: Buffer;
        if (m.pathOrUrl.startsWith('http')) {
          const r = await fetch(m.pathOrUrl, { signal: AbortSignal.timeout(20_000) });
          if (!r.ok) continue;
          bytes = Buffer.from(await r.arrayBuffer());
        } else {
          const { readFile } = await import('node:fs/promises');
          bytes = await readFile(m.pathOrUrl);
        }
        if (bytes.length > 5_000_000) continue; // X-Bild-Limit
        const mime = /\.jpe?g$/i.test(m.pathOrUrl) ? 'image/jpeg' : 'image/png';
        const form = new FormData();
        form.append('media', new Blob([new Uint8Array(bytes)], { type: mime }), mime === 'image/jpeg' ? 'bild.jpg' : 'bild.png');
        let id: string | number | undefined;
        let ok = false;
        if (useV11) {
          const url = 'https://upload.twitter.com/1.1/media/upload.json';
          const up = await fetch(url, { method: 'POST', headers: { Authorization: this.oauth1Header('POST', url, secrets) }, body: form });
          const data = await up.json().catch(() => ({})) as { media_id_string?: string; media_id?: number };
          id = data.media_id_string ?? data.media_id;
          ok = up.ok;
        } else {
          form.append('media_category', 'tweet_image');
          const up = await fetch('https://api.x.com/2/media/upload', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
          });
          const data = await up.json().catch(() => ({})) as { data?: { id?: string | number }; id?: string | number; media_id_string?: string };
          id = data.data?.id ?? data.id ?? data.media_id_string;
          ok = up.ok;
        }
        if (ok && id !== undefined && id !== null) ids.push(String(id));
      } catch { /* Bild best-effort */ }
    }
    return ids;
  }

  /** v1019 — Kanalwachstum: Follower via users/me (best-effort — Free-Tier ist knapp rate-limitiert). */
  override async fetchAudience(channel: SocialChannel, secrets: Record<string, string>): Promise<{ followers: number } | null> {
    try {
      const token = await this.token(secrets, channel);
      const res = await fetch('https://api.x.com/2/users/me?user.fields=public_metrics', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({})) as { data?: { public_metrics?: { followers_count?: number } } };
      const count = data.data?.public_metrics?.followers_count;
      return res.ok && typeof count === 'number' ? { followers: count } : null;
    } catch { return null; }
  }

  private async token(secrets: Record<string, string>, channel?: SocialChannel): Promise<string> {
    const cacheKey = secrets.X_CLIENT_ID ?? secrets.X_ACCESS_TOKEN ?? 'default';
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (secrets.X_REFRESH_TOKEN && secrets.X_CLIENT_ID) {
      const res = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: secrets.X_REFRESH_TOKEN, client_id: secrets.X_CLIENT_ID,
        }).toString(),
      });
      const data = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (data.access_token) {
        const ttlMs = Math.max(300, (data.expires_in ?? 7_200) - 300) * 1_000;
        this.tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ttlMs });
        // v1028 — rotiertes Refresh-Token SOFORT persistieren (sonst ist es
        // beim nächsten Ablauf des Access-Tokens bereits entwertet)
        if (typeof data.refresh_token === 'string' && data.refresh_token && data.refresh_token !== secrets.X_REFRESH_TOKEN) {
          secrets.X_REFRESH_TOKEN = data.refresh_token;
          if (channel && this.secretsWriter) {
            await this.secretsWriter(channel, { X_REFRESH_TOKEN: data.refresh_token }).catch(() => { /* best-effort — Cache trägt die nächsten ~2h */ });
          }
        }
        return data.access_token;
      }
    }
    if (!secrets.X_ACCESS_TOKEN) throw new Error('X-Secrets fehlen (X_ACCESS_TOKEN bzw. X_REFRESH_TOKEN+X_CLIENT_ID in ENV-Stage social)');
    return secrets.X_ACCESS_TOKEN;
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const token = await this.token(secrets, channel);
    // v1029 — Bilder zuerst hochladen; die KI-Kennzeichnung (composePostText/
    // aiDisclosure) gilt nur, wenn wirklich ein Bild MITGEHT — sonst würde
    // „Bild: KI-generiert" ohne Bild im Tweet stehen (Realfall 06.07.)
    const mediaIds = await this.uploadImages(item, token, secrets);
    const textItem = mediaIds.length > 0 ? item : { ...item, media: [] };
    const payload: Record<string, unknown> = { text: composePostText(textItem, 280, channel) };
    if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
    const res = await fetch('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({})) as { data?: { id: string }; detail?: string; title?: string };
    if (!res.ok || !data.data?.id) throw new Error(`X: ${data.detail ?? data.title ?? `HTTP ${res.status}`}`);
    return { externalId: data.data.id, url: `https://x.com/i/status/${data.data.id}` };
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = await this.token(secrets, channel);
      const res = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({})) as { data?: { username?: string } };
      return res.ok ? { ok: true, detail: data.data?.username } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  override async deletePost(externalId: string, channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const token = await this.token(secrets, channel);
      const res = await fetch(`https://api.x.com/2/tweets/${encodeURIComponent(externalId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({})) as { data?: { deleted?: boolean } };
      return data.data?.deleted === true;
    } catch { return false; }
  }

  override async fetchMetrics(
    items: Array<{ id: string; externalId: string }>,
    channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    if (items.length === 0) return [];
    const token = await this.token(secrets, channel);
    const ids = items.slice(0, 100).map(i => i.externalId).join(',');
    const res = await fetch(`https://api.x.com/2/tweets?ids=${encodeURIComponent(ids)}&tweet.fields=public_metrics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string; public_metrics?: Record<string, number> }> };
    const byExternal = new Map(items.map(i => [i.externalId, i.id]));
    const out: Array<{ itemId: string; kind: string; value: number }> = [];
    for (const t of data.data ?? []) {
      const itemId = byExternal.get(t.id);
      if (!itemId || !t.public_metrics) continue;
      for (const [key, kind] of [['impression_count', 'views'], ['like_count', 'likes'], ['reply_count', 'comments'], ['retweet_count', 'shares']] as const) {
        const v = t.public_metrics[key];
        if (v !== undefined) out.push({ itemId, kind, value: v });
      }
    }
    return out;
  }
}
