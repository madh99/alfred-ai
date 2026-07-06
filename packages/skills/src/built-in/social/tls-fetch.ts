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
  Agent: new (opts: { connect: { rejectUnauthorized: boolean } }) => unknown;
}

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
  return undici.fetch(url, { ...init, dispatcher: insecureDispatcher });
}
