/**
 * Phase 5 H2 (Spec Geräte §20.5 Punkt 4) — APNs-Sender: HTTP/2 an Apple, Token-Anmeldung per JWT (ES256) aus dem .p8-Schlüssel.
 * Nur Node-eigenes http2/crypto, keine neue Abhängigkeit. Das JWT gilt bei Apple bis 60 min; es wird 50 min wiederverwendet.
 * Der Schlüssel liegt nur auf dem Server (data/geheim, Rechte 600) und erscheint nie im Log.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';

export type ApnsUmgebung = 'sandbox' | 'production';

export interface ApnsNutzlast {
  titel: string;
  text: string;
  /** Gesprächsfaden: gruppiert die Mitteilungen auf dem iPhone (thread-id) und öffnet beim Antippen den Faden */
  faden?: string;
  /** eigener Schlüssel `alfred` — die App öffnet damit die richtige Stelle */
  art: 'bestaetigung' | 'hinweis' | 'antwort' | 'zwischenablage';
  /** iOS-Dringlichkeit: `time-sensitive` dringt durch einen Fokus (nur Dringendes), `passive` ohne Ton */
  stufe?: 'passive' | 'active' | 'time-sensitive';
  id?: string;
}

export interface ApnsErgebnis { ok: boolean; status: number; grund?: string; dauerMs: number; tokenUngueltig: boolean }

/** Ein Aufruf an Apple; austauschbar für Tests. */
export type ApnsTransport = (z: { host: string; pfad: string; kopf: Record<string, string>; koerper: string }) => Promise<{ status: number; koerper: string }>;

export const APNS_HOST: Record<ApnsUmgebung, string> = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const JWT_GUELTIG_MS = 50 * 60_000;
/** Spec §20.5 Punkt 4: Grund höchstens 120 Zeichen, keine Werte und keine Namen aus dem Inhalt. */
export const PUSH_TEXT_MAX = 120;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT für die APNs-Token-Anmeldung (ES256, Signatur im JOSE-Format r||s). */
export function apnsJwt(schluesselPem: string, keyId: string, teamId: string, jetztSek = Math.floor(Date.now() / 1000)): string {
  const kopf = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const inhalt = b64url(JSON.stringify({ iss: teamId, iat: jetztSek }));
  const sig = crypto.sign('sha256', Buffer.from(`${kopf}.${inhalt}`), { key: schluesselPem, dsaEncoding: 'ieee-p1363' });
  return `${kopf}.${inhalt}.${b64url(sig)}`;
}

/** APNs-Nutzlast: Titel, kurzer Text, Faden als thread-id, eigener Schlüssel `alfred`. */
export function apnsKoerper(n: ApnsNutzlast): string {
  const kurz = (t: string, max: number) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
  return JSON.stringify({
    aps: { alert: { title: kurz(n.titel, 60), body: kurz(n.text, PUSH_TEXT_MAX) }, ...(n.stufe === 'passive' ? {} : { sound: 'default' }), 'interruption-level': n.stufe ?? 'active', ...(n.faden ? { 'thread-id': n.faden } : {}) },
    alfred: { art: n.art, ...(n.id ? { id: n.id } : {}), ...(n.faden ? { faden: n.faden } : {}) },
  });
}

/** Standard-Transport: eine HTTP/2-Sitzung je Host, wiederverwendet; bricht sie ab, öffnet der nächste Aufruf eine neue. */
export function http2Transport(): ApnsTransport {
  const sitzungen = new Map<string, http2.ClientHttp2Session>();
  const sitzung = (host: string) => {
    const s = sitzungen.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    const neu = http2.connect(host);
    neu.on('error', () => sitzungen.delete(host));
    neu.on('close', () => sitzungen.delete(host));
    neu.unref();
    sitzungen.set(host, neu);
    return neu;
  };
  return ({ host, pfad, kopf, koerper }) => new Promise((resolve, reject) => {
    const anfrage = sitzung(host).request({ ':method': 'POST', ':path': pfad, ...kopf, 'content-type': 'application/json' });
    let status = 0; const teile: Buffer[] = [];
    anfrage.setTimeout(15_000, () => anfrage.close(http2.constants.NGHTTP2_CANCEL));
    anfrage.on('response', (h) => { status = Number(h[':status'] ?? 0); });
    anfrage.on('data', (d: Buffer) => teile.push(d));
    anfrage.on('end', () => resolve({ status, koerper: Buffer.concat(teile).toString('utf8') }));
    anfrage.on('error', reject);
    anfrage.end(koerper);
  });
}

export class ApnsSender {
  private jwt?: { wert: string; seit: number };
  private schluessel?: string;

  constructor(private readonly opts: { schluesselPfad: string; keyId: string; teamId: string; bundleId: string; transport?: ApnsTransport; now?: () => number }) {}

  private jetzt(): number { return this.opts.now?.() ?? Date.now(); }

  private anmeldung(): string {
    if (this.jwt && this.jetzt() - this.jwt.seit < JWT_GUELTIG_MS) return this.jwt.wert;
    this.schluessel ??= fs.readFileSync(this.opts.schluesselPfad, 'utf8');
    this.jwt = { wert: apnsJwt(this.schluessel, this.opts.keyId, this.opts.teamId, Math.floor(this.jetzt() / 1000)), seit: this.jetzt() };
    return this.jwt.wert;
  }

  async sende(token: string, umgebung: ApnsUmgebung, n: ApnsNutzlast): Promise<ApnsErgebnis> {
    const start = this.jetzt();
    const transport = this.opts.transport ?? (this.standard ??= http2Transport());
    try {
      const r = await transport({
        host: APNS_HOST[umgebung], pfad: `/3/device/${encodeURIComponent(token)}`, koerper: apnsKoerper(n),
        kopf: { authorization: `bearer ${this.anmeldung()}`, 'apns-topic': this.opts.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10' },
      });
      let grund: string | undefined;
      if (r.status !== 200) { try { grund = (JSON.parse(r.koerper) as { reason?: string }).reason; } catch { grund = r.koerper.slice(0, 80) || undefined; } }
      // 403 ExpiredProviderToken: neues JWT beim nächsten Versand
      if (grund === 'ExpiredProviderToken') this.jwt = undefined;
      return { ok: r.status === 200, status: r.status, grund, dauerMs: this.jetzt() - start, tokenUngueltig: r.status === 410 || grund === 'Unregistered' };
    } catch (err) {
      return { ok: false, status: 0, grund: (err as Error).message.slice(0, 120), dauerMs: this.jetzt() - start, tokenUngueltig: false };
    }
  }

  private standard?: ApnsTransport;
}
