import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * v1531 (Owner 20.10.: „1 und 2 gemeinsam wie empfohlen umsetzen“) — Satelliten-Sicherheit Punkt 2: Befehle signieren.
 * Der Server signiert jede Nachricht, die auf dem Gerät etwas auslöst (Aktionen, Beobachter-Regeln), mit einem eigenen
 * Ed25519-Schlüssel — getrennt vom TLS- und vom Release-Schlüssel. Mitsigniert werden Ziel-Gerät (`an`), Zeit und ID:
 * ein mitgeschnittener Befehl lässt sich weder an ein anderes Gerät umleiten noch später wiederholen.
 * Punkt 1 (Pinning) nutzt `spkiHex` — dasselbe Format wie die Handy-App (lib/spki.dart: SHA-256 der SPKI, hex).
 */
export const SIGNIERTE_TYPEN = ['aktion', 'beobachten'] as const;
/** Erlaubte Abweichung der Uhrzeit zwischen Server und Gerät */
export const BEFEHL_ZEIT_TOLERANZ_MS = 10 * 60_000;

/** JSON mit sortierten Schlüsseln (rekursiv) — beide Seiten rechnen über denselben Text. */
export function kanonisch(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : kanonisch(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
}

export interface BefehlsSchluessel { privat: KeyObject; oeffentlichPem: string }

/** Schlüssel laden oder beim ersten Start erzeugen (PKCS#8, nur für den Dienst lesbar). .93 braucht dieselbe Datei. */
export function ladeOderErzeugeBefehlsSchluessel(datei: string): BefehlsSchluessel {
  if (existsSync(datei)) {
    const privat = createPrivateKey(readFileSync(datei, 'utf8'));
    return { privat, oeffentlichPem: createPublicKey(privat).export({ type: 'spki', format: 'pem' }).toString() };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(path.dirname(datei), { recursive: true });
  writeFileSync(datei, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  return { privat: privateKey, oeffentlichPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** Nachricht (mit id und zeit) für das Gerät `an` signieren. Rundreise über JSON, damit genau das signiert wird, was ankommt. */
export function signiereBefehl<T extends Record<string, unknown>>(n: T, an: string, s: BefehlsSchluessel): T & { an: string; sig: string } {
  const rein = JSON.parse(JSON.stringify({ ...n, an })) as Record<string, unknown>;
  delete rein.sig;
  const sig = sign(null, Buffer.from(kanonisch(rein), 'utf8'), s.privat).toString('base64');
  return { ...(rein as T), an, sig };
}

export type BefehlPruefung = 'ok' | 'fehlt' | 'ungueltig' | 'fremd' | 'alt' | 'doppelt' | 'kein_schluessel';

/** Gerätseitige Prüfung. `gesehen` merkt IDs (gegen Wiederholung); wird hier gepflegt. */
export function pruefeBefehl(n: Record<string, unknown>, o: { schluesselPem?: string; geraetId: string; jetzt?: number; gesehen: Map<string, number> }): BefehlPruefung {
  if (!o.schluesselPem) return 'kein_schluessel';
  const sig = n.sig;
  if (typeof sig !== 'string' || !sig) return 'fehlt';
  const rest: Record<string, unknown> = { ...n };
  delete rest.sig;
  let gueltig = false;
  try { gueltig = verify(null, Buffer.from(kanonisch(rest), 'utf8'), createPublicKey(o.schluesselPem), Buffer.from(sig, 'base64')); } catch { gueltig = false; }
  if (!gueltig) return 'ungueltig';
  if (n.an !== o.geraetId) return 'fremd';
  const jetzt = o.jetzt ?? Date.now();
  const zeit = Date.parse(String(n.zeit ?? ''));
  if (!Number.isFinite(zeit) || Math.abs(jetzt - zeit) > BEFEHL_ZEIT_TOLERANZ_MS) return 'alt';
  const id = String(n.id ?? '');
  if (!id || o.gesehen.has(id)) return 'doppelt';
  o.gesehen.set(id, jetzt);
  for (const [k, t] of o.gesehen) { if (jetzt - t > 2 * BEFEHL_ZEIT_TOLERANZ_MS) o.gesehen.delete(k); else break; }
  return 'ok';
}

/** SHA-256 des SubjectPublicKeyInfo eines Zertifikats (DER), hex — wie lib/spki.dart der App. */
export function spkiHex(zertifikatDer: Buffer): string {
  const spki = new X509Certificate(zertifikatDer).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}
