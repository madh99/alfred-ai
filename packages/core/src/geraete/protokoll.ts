/**
 * v1224 — Reine Helfer des Geräte-Protokolls: Pairing-Code, Token, Manifest-Prüfung,
 * Pfad-Freigabe. Testbar ohne Netz und Datenbank.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import type { GeraetManifest, GeraetPlattform } from '@alfred/types';

export const PAIRING_CODE_GUELTIG_MS = 5 * 60_000;
export const PULS_INTERVALL_MS = 30_000;
export const PULS_TIMEOUT_MS = 90_000;
export const AKTION_TIMEOUT_MS = 60_000;
export const SHELL_TIMEOUT_MS = 10 * 60_000;

const PLATTFORMEN: GeraetPlattform[] = ['windows', 'macos', 'linux', 'android', 'ios', 'raspberry'];
const AUTONOMIEN = new Set(['auto', 'bestaetigen', 'nie']);

export function erzeugePairingCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

export function erzeugeToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Skill-Name im Gehirn: `geraet_<name>` aus dem Gerätenamen (nur a–z, 0–9, _). */
export function geraetSkillName(name: string): string {
  const slug = name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return `geraet_${slug || 'geraet'}`;
}

export function pruefeManifest(m: unknown): { ok: true; manifest: GeraetManifest } | { ok: false; grund: string } {
  if (!m || typeof m !== 'object') return { ok: false, grund: 'Manifest fehlt' };
  const r = m as Record<string, unknown>;
  if (r.protokoll !== 1) return { ok: false, grund: 'Protokollversion nicht unterstützt' };
  if (!PLATTFORMEN.includes(r.plattform as GeraetPlattform)) return { ok: false, grund: 'Plattform unbekannt' };
  if (!Array.isArray(r.aktionen) || r.aktionen.length > 30) return { ok: false, grund: 'Aktionen fehlen oder zu viele' };
  const namen = new Set<string>();
  for (const a of r.aktionen as unknown[]) {
    const x = a as Record<string, unknown>;
    if (typeof x?.name !== 'string' || !/^[a-z_]{2,30}$/.test(x.name)) return { ok: false, grund: `Aktionsname ungültig: ${String(x?.name)}` };
    if (namen.has(x.name)) return { ok: false, grund: `Aktion doppelt: ${x.name}` };
    namen.add(x.name);
    if (!AUTONOMIEN.has(String(x.autonomie))) return { ok: false, grund: `Autonomie ungültig bei ${x.name}` };
    if (typeof x.beschreibung !== 'string' || x.beschreibung.length > 300) return { ok: false, grund: `Beschreibung fehlt bei ${x.name}` };
  }
  const sinne = Array.isArray(r.sinne) ? (r.sinne as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 20) : [];
  return {
    ok: true,
    manifest: {
      protokoll: 1, plattform: r.plattform as GeraetPlattform,
      hostname: typeof r.hostname === 'string' ? r.hostname.slice(0, 80) : '',
      satellitVersion: typeof r.satellitVersion === 'string' ? r.satellitVersion.slice(0, 40) : '',
      aktionen: (r.aktionen as GeraetManifest['aktionen']).map(a => ({ name: a.name, beschreibung: a.beschreibung, autonomie: a.autonomie, parameter: a.parameter })),
      sinne,
    },
  };
}

/**
 * Liegt ein Pfad innerhalb eines freigegebenen Verzeichnisses? Beide Seiten werden aufgelöst,
 * `..` und Symlink-Tricks im Text scheitern daran. Groß-/Kleinschreibung auf Windows egal.
 */
export function istPfadErlaubt(pfad: string, freigegeben: string[], plattform: NodeJS.Platform = process.platform): boolean {
  if (!pfad || freigegeben.length === 0) return false;
  const norm = (p: string) => { const r = path.resolve(p); return plattform === 'win32' ? r.toLowerCase() : r; };
  const ziel = norm(pfad);
  for (const f of freigegeben) {
    const basis = norm(f);
    if (ziel === basis || ziel.startsWith(basis.endsWith(path.sep) ? basis : basis + path.sep)) return true;
  }
  return false;
}

/** Kurzfassung der Parameter für Bestätigungsfragen und Protokoll. */
export function paramsKurz(params: Record<string, unknown>): string {
  const teile: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (k === 'action' || k === 'confirmed' || v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    teile.push(`${k}=${s.length > 80 ? s.slice(0, 77) + '…' : s}`);
  }
  return teile.join(' ');
}
