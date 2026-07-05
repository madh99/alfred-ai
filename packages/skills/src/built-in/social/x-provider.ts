import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';

/**
 * v936 — X/Twitter-Provider (API v2, Free-Tier-tauglich: ~500 Posts/Monat).
 *
 * Secrets (ENV-Stage 'social'): X_ACCESS_TOKEN (OAuth2-User-Token mit
 * tweet.write; Refresh via X_REFRESH_TOKEN + X_CLIENT_ID optional).
 *
 * Monats-Budget: am Kanal `config.max_posts_per_month` setzen (z.B. 450) —
 * der social-Skill erzwingt das generisch VOR jedem Publish (v936-Leitplanke).
 * Nur Text (Medien-Upload braucht v1.1-API — bewusst außen vor; Bild-Posts
 * über den prepare-Modus).
 */
export class XProvider extends SocialProvider {
  readonly platform = 'x';

  capabilities(): ProviderCapabilities {
    return { text: true, image: false, video: false, maxTextLength: 280, supportsDelete: true, supportsMetrics: true };
  }

  private async token(secrets: Record<string, string>): Promise<string> {
    if (secrets.X_REFRESH_TOKEN && secrets.X_CLIENT_ID) {
      const res = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: secrets.X_REFRESH_TOKEN, client_id: secrets.X_CLIENT_ID,
        }).toString(),
      });
      const data = await res.json().catch(() => ({})) as { access_token?: string };
      if (data.access_token) return data.access_token;
    }
    if (!secrets.X_ACCESS_TOKEN) throw new Error('X-Secrets fehlen (X_ACCESS_TOKEN in ENV-Stage social)');
    return secrets.X_ACCESS_TOKEN;
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const token = await this.token(secrets);
    const res = await fetch('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: composePostText(item, 280, channel) }),
    });
    const data = await res.json().catch(() => ({})) as { data?: { id: string }; detail?: string; title?: string };
    if (!res.ok || !data.data?.id) throw new Error(`X: ${data.detail ?? data.title ?? `HTTP ${res.status}`}`);
    return { externalId: data.data.id, url: `https://x.com/i/status/${data.data.id}` };
  }

  async validateAuth(_channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = await this.token(secrets);
      const res = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({})) as { data?: { username?: string } };
      return res.ok ? { ok: true, detail: data.data?.username } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  override async deletePost(externalId: string, _channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const token = await this.token(secrets);
      const res = await fetch(`https://api.x.com/2/tweets/${encodeURIComponent(externalId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({})) as { data?: { deleted?: boolean } };
      return data.data?.deleted === true;
    } catch { return false; }
  }

  override async fetchMetrics(
    items: Array<{ id: string; externalId: string }>,
    _channel: SocialChannel,
    secrets: Record<string, string>,
  ): Promise<Array<{ itemId: string; kind: string; value: number }>> {
    if (items.length === 0) return [];
    const token = await this.token(secrets);
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
