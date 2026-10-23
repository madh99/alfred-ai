import { createRequire } from 'node:module';

/**
 * v1022 — TLS-tolerantes fetch für insecure_tls-Kanäle (self-signed Certs
 * interner Deploys). Vorher wurde NODE_TLS_REJECT_UNAUTHORIZED prozessweit
 * gesetzt und im finally zurückgestellt — mit zwei realen Defekten:
 * (a) während des await-Fensters lief JEDER parallele Request des Prozesses
 *     (Telegram-Publish, IG-Token-Refresh, …) ohne Zertifikatsprüfung;
 * (b) zwei überlappende Blöcke stellten beim Zurücksetzen die '0' des jeweils
 *     anderen wieder her — die TLS-Prüfung blieb bis zum Restart dauerhaft aus.
 * Jetzt: undici-fetch mit eigenem Dispatcher, rejectUnauthorized gilt NUR für
 * den einen Request. undici lazy via import/createRequire (Bundle-Muster).
 */

interface UndiciModule {
  // init bewusst als object: die Node-Typen fixieren dispatcher auf ihren
  // eigenen Dispatcher — wir reichen den undici-Agent opak durch
  fetch(url: string, init?: object): Promise<Response>;
  Agent: new (opts: { connect: { rejectUnauthorized: boolean } | ((o: ConnectOpts, cb: (err: Error | null, socket: unknown) => void) => void) }) => unknown;
  FormData: new () => { append(name: string, value: unknown, fileName?: string): void };
}

/**
 * v1025 — Node-globale FormData in undicis eigene umbauen: undici v7
 * brand-checkt den Request-Body und serialisiert fremde FormData-Instanzen
 * sonst als String "[object FormData]" mit text/plain (Realfall 06.07.:
 * fussball.cc Media-Upload HTTP 400 „Erwartet wird multipart/form-data"
 * direkt nach dem .1024-Deploy — Bild-Publishes standen).
 */
export async function toUndiciBody(u: UndiciModule, body: unknown): Promise<unknown> {
  if (typeof FormData === 'undefined' || !(body instanceof FormData) || body instanceof u.FormData) return body;
  const rebuilt = new u.FormData();
  for (const [key, value] of body as unknown as Iterable<[string, unknown]>) {
    if (typeof value === 'string') { rebuilt.append(key, value); continue; }
    // Blob/File-Inhalt bytefest umkopieren — das GLOBALE File akzeptiert
    // undicis FormData (duck-typed); undici v7 exportiert kein eigenes File mehr
    const blob = value as Blob & { name?: string };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    rebuilt.append(key, new File([bytes], blob.name ?? 'file', { type: blob.type || 'application/octet-stream' }));
  }
  return rebuilt;
}

interface ConnectOpts { hostname: string; host?: string; port: string | number; servername?: string }

let undiciPromise: Promise<UndiciModule | null> | undefined;
let insecureDispatcher: unknown;

async function loadUndici(): Promise<UndiciModule | null> {
  undiciPromise ??= (async () => {
    try {
      return await import('undici') as unknown as UndiciModule;
    } catch {
      try {
        const req = createRequire(import.meta.url);
        return req('undici') as UndiciModule;
      } catch {
        return null;
      }
    }
  })();
  return undiciPromise;
}

/**
 * fetch mit optional deaktivierter Zertifikatsprüfung — request-lokal.
 * insecure=false → normales globales fetch. Ohne undici wird sichtbar
 * geworfen statt still unsicher (prozessweit) zu laufen.
 */
export async function tlsFetch(url: string, init: RequestInit, insecure: boolean): Promise<Response> {
  if (!insecure) return fetch(url, init);
  const undici = await loadUndici();
  if (!undici) throw new Error('insecure_tls: undici nicht verfügbar — Zertifikatsprüfung kann nicht request-lokal deaktiviert werden');
  insecureDispatcher ??= new undici.Agent({ connect: { rejectUnauthorized: false } });
  const body = await toUndiciBody(undici, init.body);
  return undici.fetch(url, { ...init, body, dispatcher: insecureDispatcher });
}

/** Fingerabdrücke vergleichen: Doppelpunkte, Leerzeichen und Groß/Klein egal */
export const fingerabdruckGleich = (a: string | undefined, b: string | undefined) => !!a && !!b && a.replace(/[^0-9a-f]/gi, '').toUpperCase() === b.replace(/[^0-9a-f]/gi, '').toUpperCase();

const gepinnteDispatcher = new Map<string, unknown>();

/**
 * v1618 (Sicherheitsprüfung) — fetch mit Zertifikat-Pinning für selbst signierte Geräte-Zertifikate (z. B. MikroTik-REST).
 * Geprüft wird auf DERSELBEN TLS-Verbindung, die danach die Anfrage samt Zugangsdaten trägt: erst nach `secureConnect` und
 * passendem SHA-256-Fingerabdruck bekommt undici den Socket. Passt er nicht, wird die Verbindung geschlossen, bevor auch nur
 * ein Byte der Anfrage geschrieben ist. Kein separater Vorab-Test, kein Zwischenspeicher (TOCTOU).
 */
export async function pinnedFetch(url: string, init: RequestInit, fingerabdruck: string): Promise<Response> {
  const undici = await loadUndici();
  if (!undici) throw new Error('Zertifikat-Pinning: undici nicht verfügbar');
  const erwartet = fingerabdruck.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (erwartet.length !== 64) throw new Error('Zertifikat-Pinning: Fingerabdruck muss SHA-256 sein (64 Hex-Zeichen)');
  let d = gepinnteDispatcher.get(erwartet);
  if (!d) {
    const tls = await import('node:tls');
    const net = await import('node:net');
    d = new undici.Agent({
      connect: (o, cb) => {
        let fertig = false;
        const einmal = (err: Error | null, s: unknown) => { if (!fertig) { fertig = true; cb(err, s); } };
        const host = o.hostname;
        // rejectUnauthorized: false, weil das Zertifikat selbst signiert ist — die Echtheit belegt stattdessen der Fingerabdruck unten
        const socket = tls.connect({ host, port: Number(o.port) || 443, servername: net.isIP(host) ? undefined : (o.servername ?? host), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
        socket.once('secureConnect', () => {
          const ist = socket.getPeerCertificate()?.fingerprint256;
          if (fingerabdruckGleich(ist, erwartet)) return einmal(null, socket);
          socket.destroy();
          einmal(new Error(`Zertifikat von ${host} passt nicht zum hinterlegten Fingerabdruck (gesehen ${ist || 'keins'}) — Anfrage NICHT gesendet`), null);
        });
        socket.once('error', (e) => einmal(e, null));
      },
    });
    gepinnteDispatcher.set(erwartet, d);
  }
  const body = await toUndiciBody(undici, init.body);
  return undici.fetch(url, { ...init, body, dispatcher: d });
}
