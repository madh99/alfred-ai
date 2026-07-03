import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolvePath } from './rest-provider.js';

/**
 * v969 — Public-Media-Host je Kanal: Plattformen wie Instagram laden Medien
 * NICHT hoch, sondern holen sie per öffentlicher http-URL ab. Lokal generierte
 * Bilder brauchen daher einen konfigurierbaren Ablageort — als KANAL-Eigenschaft
 * (channel.config.public_media), nicht als System-Annahme: die fussball.cc-
 * Familie nutzt ihre Medienbibliothek, ein anderes Projekt seine eigene, ein
 * Kanal ohne Website einen S3-kompatiblen Cloud-Bucket (nur ausgehend — das
 * LAN bleibt zu).
 *
 * rest:  { provider: 'rest', base_url, path?, file_field?, url_field?,
 *          auth_header?, auth_prefix?, insecure_tls? }
 *        Multipart-Upload (Mechanik wie media_upload v953), öffentliche URL
 *        aus der Antwort (url_field, Dot-Pfad, Default 'data.url'); relative
 *        URLs werden mit base_url absolut gemacht. Secret: API_TOKEN.
 * s3:    { provider: 's3', endpoint, bucket, region?, key_prefix?,
 *          public_base_url? }
 *        SigV4-PUT (path-style), öffentliche URL public_base_url/key bzw.
 *        endpoint/bucket/key. Secrets: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
 */

export interface PublicMediaRestConfig {
  provider: 'rest';
  base_url: string;
  path?: string;
  file_field?: string;
  url_field?: string;
  auth_header?: string;
  auth_prefix?: string;
  insecure_tls?: boolean;
}

export interface PublicMediaS3Config {
  provider: 's3';
  endpoint: string;
  bucket: string;
  region?: string;
  key_prefix?: string;
  public_base_url?: string;
}

export type PublicMediaConfig = PublicMediaRestConfig | PublicMediaS3Config;

/** Tolerantes Parsen aus channel.config.public_media (LLM-befüllt). */
export function parsePublicMediaConfig(raw: unknown): PublicMediaConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.provider === 'rest' && typeof c.base_url === 'string' && c.base_url) return c as unknown as PublicMediaRestConfig;
  if (c.provider === 's3' && typeof c.endpoint === 'string' && c.endpoint && typeof c.bucket === 'string' && c.bucket) return c as unknown as PublicMediaS3Config;
  return null;
}

function mimeFor(fileName: string): string {
  return fileName.endsWith('.webp') ? 'image/webp'
    : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg'
    : fileName.endsWith('.mp4') ? 'video/mp4' : 'image/png';
}

async function loadLocal(localPath: string): Promise<{ bytes: Buffer; fileName: string }> {
  const bytes = await readFile(localPath);
  const fileName = (localPath.split(/[\\/]/).pop() ?? 'media.png').replace(/[^\w.-]/g, '_');
  return { bytes, fileName };
}

async function uploadRest(cfg: PublicMediaRestConfig, localPath: string, secrets: Record<string, string>, altText?: string): Promise<string> {
  const { bytes, fileName } = await loadLocal(localPath);
  const base = cfg.base_url.replace(/\/+$/, '');
  const path = cfg.path ?? '/api/integrations/media';
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const form = new FormData();
  form.append(cfg.file_field ?? 'file', new Blob([new Uint8Array(bytes)], { type: mimeFor(fileName) }), fileName);
  if (altText) form.append('altText', altText.slice(0, 300));

  const headers: Record<string, string> = {};
  if (secrets.API_TOKEN) headers[cfg.auth_header ?? 'Authorization'] = `${cfg.auth_prefix ?? 'Bearer '}${secrets.API_TOKEN}`;

  // self-signed Certs (interne Deploys) — gleiche Mechanik wie rest-provider
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (cfg.insecure_tls === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: form });
  } finally {
    if (cfg.insecure_tls === true) {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`public_media-Upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  const raw = resolvePath(data, cfg.url_field ?? 'data.url') ?? resolvePath(data, 'url');
  if (typeof raw !== 'string' || !raw) throw new Error('public_media-Upload: keine URL in der Antwort (url_field prüfen)');
  return raw.startsWith('http') ? raw : `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

/** Minimaler AWS-SigV4-Signer für S3-PUT (path-style, single chunk) — spart die SDK-Dependency. */
async function uploadS3(cfg: PublicMediaS3Config, localPath: string, secrets: Record<string, string>): Promise<string> {
  const accessKey = secrets.S3_ACCESS_KEY_ID;
  const secretKey = secrets.S3_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) throw new Error('public_media (s3): S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY fehlen (ENV-Stage social)');

  const { bytes, fileName } = await loadLocal(localPath);
  const region = cfg.region ?? 'auto';
  const prefix = (cfg.key_prefix ?? 'social/').replace(/^\/+/, '');
  const key = `${prefix}${prefix.length > 0 && !prefix.endsWith('/') ? '/' : ''}${fileName}`;
  const endpoint = cfg.endpoint.replace(/\/+$/, '');
  const host = new URL(endpoint).host;
  const canonicalUri = `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(bytes).digest('hex');
  const contentType = mimeFor(fileName);

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const res = await fetch(`${endpoint}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`public_media (s3) HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const publicBase = (cfg.public_base_url ?? `${endpoint}/${cfg.bucket}`).replace(/\/+$/, '');
  return `${publicBase}/${key}`;
}

/**
 * Lokale Mediendatei über den konfigurierten Host veröffentlichen.
 * @returns öffentliche http-URL, unter der die Plattform das Medium abholen kann.
 */
export async function publishPublicMedia(
  cfg: PublicMediaConfig, localPath: string, secrets: Record<string, string>, altText?: string,
): Promise<string> {
  return cfg.provider === 'rest' ? uploadRest(cfg, localPath, secrets, altText) : uploadS3(cfg, localPath, secrets);
}
