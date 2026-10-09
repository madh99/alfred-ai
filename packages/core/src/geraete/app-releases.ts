import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, createReadStream, type ReadStream } from 'node:fs';
import type { Logger } from 'pino';
import { vergleicheVersion, sha256Datei } from './releases.js';

/**
 * v1322 — Phase 4 M6: der Server verteilt auch die Desktop-App. Ablage `data/app-releases/<plattform>/`:
 *   windows  Alfred-<Version>-setup.exe   (Inno Setup, Authenticode)
 *   macos    Alfred-<Version>.dmg         (Developer ID, notarisiert)
 *   linux    alfred_<Version>_amd64.deb
 * Daneben optional `<Datei>.sha256` (sonst wird die Prüfsumme beim ersten Zugriff berechnet und gemerkt).
 * Neueste Version je Plattform nach `vergleicheVersion`. Die Signatur ist hier die des Betriebssystems
 * (Authenticode/Notarisierung); zusätzlich Prüfsumme über HTTPS.
 */
export type AppPlattform = 'windows' | 'macos' | 'linux';
export interface AppReleaseInfo { plattform: AppPlattform; version: string; datei: string; sha256: string; groesse: number; zeit: string }

const MUSTER: Record<AppPlattform, RegExp> = {
  windows: /^Alfred-(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)-setup\.exe$/,
  macos: /^Alfred-(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\.dmg$/,
  linux: /^alfred_(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)_amd64\.deb$/,
};

export function istAppPlattform(s: unknown): s is AppPlattform { return s === 'windows' || s === 'macos' || s === 'linux'; }

/** Rein: aus Dateinamen die neueste Version je Plattform bestimmen. */
export function neuesteAppDatei(plattform: AppPlattform, dateien: string[]): { datei: string; version: string } | undefined {
  let beste: { datei: string; version: string } | undefined;
  for (const d of dateien) {
    const m = MUSTER[plattform].exec(d);
    if (!m) continue;
    if (!beste || vergleicheVersion(m[1], beste.version) > 0) beste = { datei: d, version: m[1] };
  }
  return beste;
}

export class AppReleases {
  private readonly shaCache = new Map<string, { mtimeMs: number; sha256: string }>();

  constructor(private readonly ordner: string, private readonly logger: Logger) {
    for (const p of ['windows', 'macos', 'linux'] as AppPlattform[]) { try { mkdirSync(path.join(ordner, p), { recursive: true }); } catch { /* */ } }
  }

  info(plattform: AppPlattform): AppReleaseInfo | undefined {
    const dir = path.join(this.ordner, plattform);
    let dateien: string[]; try { dateien = readdirSync(dir); } catch { return undefined; }
    const n = neuesteAppDatei(plattform, dateien);
    if (!n) return undefined;
    const pfad = path.join(dir, n.datei);
    const st = statSync(pfad);
    const sidecar = `${pfad}.sha256`;
    let sha256 = '';
    if (existsSync(sidecar)) sha256 = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      const c = this.shaCache.get(pfad);
      if (c && c.mtimeMs === st.mtimeMs) sha256 = c.sha256;
      else { sha256 = sha256Datei(pfad); this.shaCache.set(pfad, { mtimeMs: st.mtimeMs, sha256 }); this.logger.info({ plattform, datei: n.datei }, 'v1322 App-Release: Prüfsumme berechnet'); }
    }
    return { plattform, version: n.version, datei: n.datei, sha256: sha256.toLowerCase(), groesse: st.size, zeit: st.mtime.toISOString() };
  }

  stream(plattform: AppPlattform, datei: string): ReadStream | undefined {
    if (!MUSTER[plattform].test(datei)) return undefined; // nur bekannte Namen, keine Pfade
    const p = path.join(this.ordner, plattform, datei);
    return existsSync(p) ? createReadStream(p) : undefined;
  }
}
