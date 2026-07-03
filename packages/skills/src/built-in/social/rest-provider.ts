import type { SocialChannel, ContentItem } from '@alfred/storage';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';

/**
 * v933 — Generic-REST-Provider: published an eine eigene Plattform-API
 * (z.B. fussball.cc — die sich Alfred per Code-Agent selbst gebaut hat).
 *
 * channel.config:
 *   base_url        z.B. https://192.168.1.96:3003
 *   publish_path    z.B. /api/posts (Default)
 *   auth_header     Header-Name (Default 'Authorization')
 *   auth_prefix     z.B. 'Bearer ' (Default)
 *   insecure_tls    true = self-signed Certs akzeptieren
 *   body_template   optional: JSON-Objekt mit {{title}}/{{body}}/{{hashtags}}/{{media}}-Platzhaltern
 *   id_field        Feld der Antwort mit der Post-ID (Default 'id'; v943: Dot-Pfad wie 'data.id')
 *   url_field       Feld der Antwort mit der Post-URL (optional; Dot-Pfad möglich)
 *   url_template    optional: baut die Post-URL aus Antwortfeldern, z.B.
 *                   'https://fussball.cc/news/{data.slug}' (v943; gewinnt über url_field)
 *
 * Secrets: { API_TOKEN } — wird als `${auth_prefix}${API_TOKEN}` gesendet.
 */

/** v943 — Dot-Pfad-Zugriff auf verschachtelte Antworten ({ ok, data: { id } }). */
export function resolvePath(obj: unknown, dotPath: string): unknown {
  let current: unknown = obj;
  for (const key of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
export class RestProvider extends SocialProvider {
  readonly platform = 'rest';

  capabilities(): ProviderCapabilities {
    return { text: true, image: true, video: true, supportsDelete: true, supportsMetrics: false };
  }

  private endpoint(channel: SocialChannel, path?: string): string {
    const base = typeof channel.config.base_url === 'string' ? channel.config.base_url.replace(/\/+$/, '') : '';
    if (!base) throw new Error('channel.config.base_url fehlt');
    const p = path ?? (typeof channel.config.publish_path === 'string' ? channel.config.publish_path : '/api/posts');
    return `${base}${p.startsWith('/') ? p : `/${p}`}`;
  }

  private headers(channel: SocialChannel, secrets: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = secrets.API_TOKEN;
    if (token) {
      const name = typeof channel.config.auth_header === 'string' ? channel.config.auth_header : 'Authorization';
      const prefix = typeof channel.config.auth_prefix === 'string' ? channel.config.auth_prefix : 'Bearer ';
      headers[name] = `${prefix}${token}`;
    }
    return headers;
  }

  private buildBody(item: ContentItem, channel: SocialChannel): Record<string, unknown> {
    const template = channel.config.body_template;
    if (template && typeof template === 'object') {
      const substitute = (v: unknown): unknown => {
        if (typeof v === 'string') {
          if (v === '{{media}}') return item.media;
          if (v === '{{hashtags}}') return item.hashtags;
          return v
            .replace(/\{\{title\}\}/g, item.title ?? '')
            .replace(/\{\{body\}\}/g, item.body)
            .replace(/\{\{text\}\}/g, composePostText(item));
        }
        if (Array.isArray(v)) return v.map(substitute);
        if (v && typeof v === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = substitute(val);
          return out;
        }
        return v;
      };
      return substitute(template) as Record<string, unknown>;
    }
    return {
      title: item.title ?? null,
      body: item.body,
      hashtags: item.hashtags,
      media: item.media.map(m => ({ type: m.type, url: m.pathOrUrl, caption: m.caption ?? null })),
    };
  }

  private async doFetch(url: string, init: RequestInit, channel: SocialChannel): Promise<Response> {
    // self-signed Certs (interne Deploys): Node erlaubt das nur prozessweit —
    // gezielt per Request via dispatcher wäre undici-Import; pragmatisch: Flag
    // pro Aufruf setzen und zurücksetzen.
    const insecure = channel.config.insecure_tls === true;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      return await fetch(url, init);
    } finally {
      if (insecure) {
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      }
    }
  }

  async publish(item: ContentItem, channel: SocialChannel, secrets: Record<string, string>): Promise<PublishResult> {
    const res = await this.doFetch(this.endpoint(channel), {
      method: 'POST',
      headers: this.headers(channel, secrets),
      body: JSON.stringify(this.buildBody(item, channel)),
    }, channel);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`REST-Publish HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const idField = typeof channel.config.id_field === 'string' ? channel.config.id_field : 'id';
    const urlField = typeof channel.config.url_field === 'string' ? channel.config.url_field : 'url';
    // v943 — Dot-Pfade für Antwort-Hüllen ({ ok, data: { id, slug } }) + Fallback
    // auf gängige Nester, damit Standard-Antworten ohne Config funktionieren
    const rawId = resolvePath(data, idField) ?? resolvePath(data, `data.${idField}`);
    const externalId = rawId !== undefined && rawId !== null ? String(rawId) : '';
    let url: string | undefined;
    const urlTemplate = channel.config.url_template;
    if (typeof urlTemplate === 'string' && urlTemplate.length > 0) {
      url = urlTemplate.replace(/\{([a-zA-Z0-9_.]+)\}/g, (m, p: string) => {
        const v = resolvePath(data, p);
        return v === undefined || v === null ? m : String(v);
      });
      if (url.includes('{')) url = undefined; // unaufgelöste Platzhalter → keine URL
    } else {
      const rawUrl = resolvePath(data, urlField) ?? resolvePath(data, `data.${urlField}`);
      url = typeof rawUrl === 'string' ? rawUrl : undefined;
    }
    return { externalId, url };
  }

  async validateAuth(channel: SocialChannel, secrets: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    try {
      const path = typeof channel.config.health_path === 'string' ? channel.config.health_path : '/';
      const res = await this.doFetch(this.endpoint(channel, path), {
        method: 'GET', headers: this.headers(channel, secrets),
      }, channel);
      return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async deletePost(externalId: string, channel: SocialChannel, secrets: Record<string, string>): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.endpoint(channel)}/${encodeURIComponent(externalId)}`, {
        method: 'DELETE', headers: this.headers(channel, secrets),
      }, channel);
      return res.ok;
    } catch {
      return false;
    }
  }
}
