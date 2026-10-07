import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { vergleicheVersion, sha256Datei } from './releases.js';

/**
 * v1266 — Gemeinsame Grundlage für Satelliten- und Alfred-Selbstupdate.
 *
 * Ablage: ~/.alfred/cli/<Version>/ (npm install --prefix, ohne das globale npm anzufassen) und
 * ~/.alfred/cli/aktuell.json {version, einstieg, zeit, bestaetigt, vorige, gescheitert}. Der global installierte
 * `alfred` ist der Starter: er führt die neueste bestätigte Version aus und wartet auf sie. Beendet sich der Prozess
 * mit Code 75, hat er gerade aktualisiert — der Starter startet die neue Version. Eine frische Version gilt zehn
 * Minuten als „auf Probe"; bestätigt sie sich (Satellit: Willkommen vom Server; Alfred: zwei Minuten Lebenszeichen),
 * bleibt sie, sonst fällt der Starter auf die vorige zurück. Stürzt die Probe ab, merkt der Starter das sofort.
 */
export const NEUSTART_CODE = 75;
export const PROBE_MINUTEN = 10;
export const PAKET_NAME = '@madh-io/alfred-ai';

export interface AktuellEintrag {
  version: string;
  einstieg: string;
  zeit: string;
  bestaetigt: boolean;
  vorige?: string;
  /** Starter hat den Absturz der Probe gesehen (v1266) */
  gescheitert?: boolean;
}

export function cliOrdner(): string { return path.join(os.homedir(), '.alfred', 'cli'); }
function aktuellPfad(ordner: string): string { return path.join(ordner, 'aktuell.json'); }

export function einstiegVon(ordner: string, version: string): string {
  return path.join(ordner, version, 'node_modules', '@madh-io', 'alfred-ai', 'bundle', 'index.js');
}

export function ladeAktuell(ordner = cliOrdner()): AktuellEintrag | undefined {
  try {
    const a = JSON.parse(readFileSync(aktuellPfad(ordner), 'utf8')) as AktuellEintrag;
    return a?.version && a?.einstieg && existsSync(a.einstieg) ? a : undefined;
  } catch { return undefined; }
}

export function speichereAktuell(a: AktuellEintrag, ordner = cliOrdner()): void {
  mkdirSync(ordner, { recursive: true });
  writeFileSync(aktuellPfad(ordner), JSON.stringify(a, null, 2));
}

/** Die laufende Version hat sich bewährt: bestätigen. Liefert true, wenn sich etwas geändert hat. */
export function bestaetigeAktuell(version: string, ordner = cliOrdner()): boolean {
  const a = ladeAktuell(ordner);
  if (a && a.version === version && !a.bestaetigt) { a.bestaetigt = true; delete a.gescheitert; speichereAktuell(a, ordner); return true; }
  return false;
}

/** Starter: die Probe ist abgestürzt — sofort auf die vorige zurück (v1266). */
export function markiereGescheitert(version: string, ordner = cliOrdner()): boolean {
  const a = ladeAktuell(ordner);
  if (a && a.version === version && !a.bestaetigt && !a.gescheitert) { a.gescheitert = true; speichereAktuell(a, ordner); return true; }
  return false;
}

/** Starter: gibt die Version zurück, die laufen soll — die neueste bestätigte oder eine frische auf Probe. */
export function startbareVersion(eigene: string, ordner = cliOrdner(), jetzt = Date.now()): AktuellEintrag | undefined {
  const a = ladeAktuell(ordner);
  if (!a || vergleicheVersion(a.version, eigene) <= 0) return undefined;
  if (a.bestaetigt) return a;
  const alterMin = (jetzt - Date.parse(a.zeit)) / 60_000;
  if (!a.gescheitert && alterMin <= PROBE_MINUTEN) return a;
  // Probe gescheitert: auf vorige zurück
  if (a.vorige) {
    const v = einstiegVon(ordner, a.vorige);
    if (existsSync(v) && vergleicheVersion(a.vorige, eigene) > 0) return { version: a.vorige, einstieg: v, zeit: a.zeit, bestaetigt: true };
  }
  return undefined;
}

/** Pass-Fenster (Vollpass :00/:30): kein Neustart zwischen :57–:02 und :27–:32. */
export function imPassFenster(d = new Date()): boolean {
  const m = d.getMinutes();
  return m >= 57 || m <= 2 || (m >= 27 && m <= 32);
}

/** Liest package.json aus einem npm-Tarball (tar -xOf; GNU/BSD tar und Windows 10+). Relativer Pfad mit cwd: GNU tar hielte „C:…" für einen Rechnernamen. */
export async function tarballInfo(tgz: string): Promise<{ name: string; version: string }> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile('tar', ['-xOf', path.basename(tgz), 'package/package.json'], { cwd: path.dirname(tgz), timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`tar: ${String(stderr).slice(0, 200) || err.message}`)) : resolve(String(stdout)));
  });
  const pkg = JSON.parse(out) as { name?: string; version?: string };
  if (!pkg.name || !pkg.version) throw new Error('package.json im Tarball unvollständig');
  return { name: pkg.name, version: pkg.version };
}

/**
 * Prüft einen Tarball: Name, Version neuer als die eigene, Prüfsumme gegen eine Begleitdatei `<tgz>.sha256`
 * (erste 64 Hex-Zeichen) oder eine erwartete Prüfsumme.
 */
export async function pruefeTarball(tgz: string, eigene: string, erwarteteSha?: string): Promise<{ version: string; sha256: string }> {
  if (!existsSync(tgz)) throw new Error(`Tarball fehlt: ${tgz}`);
  const info = await tarballInfo(tgz);
  if (info.name !== PAKET_NAME) throw new Error(`Falsches Paket im Tarball: ${info.name}`);
  if (vergleicheVersion(info.version, eigene) <= 0) throw new Error(`Version ${info.version} ist nicht neuer als ${eigene}`);
  const sha = await sha256Datei(tgz);
  let soll = erwarteteSha?.trim().toLowerCase();
  if (!soll && existsSync(`${tgz}.sha256`)) soll = /[0-9a-f]{64}/i.exec(readFileSync(`${tgz}.sha256`, 'utf8'))?.[0]?.toLowerCase();
  if (soll && soll !== sha) throw new Error('Prüfsumme des Tarballs stimmt nicht');
  return { version: info.version, sha256: sha };
}

/**
 * v1285 — npm finden, auch ohne PATH: launchd (macOS) und Dienste starten mit minimalem PATH, „spawn npm ENOENT"
 * (Realfall MacBook 07.10.: blieb auf 1265). Reihenfolge: neben der laufenden node-Binärdatei, dann PATH, dann die
 * üblichen Orte.
 */
export function npmBefehl(): string {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const kandidaten = [
    path.join(path.dirname(process.execPath), name),
    ...(process.platform === 'win32' ? [] : ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm', path.join(process.env.HOME ?? '', '.nvm/versions/node', process.version, 'bin/npm')]),
  ];
  for (const k of kandidaten) if (existsSync(k)) return k;
  return name; // PATH entscheidet
}

/** Installiert einen Tarball nach <ordner>/<version> (npm install --prefix) und liefert den Einstieg. */
export async function installiereTarball(tgz: string, version: string, ordner = cliOrdner()): Promise<string> {
  const ziel = path.join(ordner, version);
  mkdirSync(ziel, { recursive: true });
  const npm = npmBefehl();
  await new Promise<void>((resolve, reject) => {
    execFile(npm, ['install', '--prefix', ziel, '--no-audit', '--no-fund', '--omit=dev', '--silent', tgz], { timeout: 900_000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` } }, (err, _out, stderr) => err ? reject(new Error(`npm install (${npm}): ${String(stderr).slice(0, 300) || err.message}`)) : resolve());
  });
  const einstieg = einstiegVon(ordner, version);
  if (!existsSync(einstieg)) throw new Error(`Installation unvollständig: ${einstieg} fehlt`);
  return einstieg;
}

/** Startprobe: die installierte Version muss sich mit ihrer Versionsnummer melden. */
export async function startprobe(einstieg: string, version: string): Promise<void> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [einstieg, '--version'], { timeout: 60_000, windowsHide: true, env: { ...process.env, ALFRED_STARTER_VERSION: 'probe' } }, (err, stdout, stderr) => err ? reject(new Error(`Startprobe: ${String(stderr).slice(0, 300) || err.message}`)) : resolve(String(stdout)));
  });
  if (!out.includes(version)) throw new Error(`Startprobe meldet „${out.trim().slice(0, 80)}" statt ${version}`);
}

/** Entfernt installierte Versionen außer den genannten (aktuelle + vorige). Liefert die entfernten. */
export function raeumeVersionen(behalte: string[], ordner = cliOrdner()): string[] {
  const weg: string[] = [];
  let eintraege: string[];
  try { eintraege = readdirSync(ordner); } catch { return weg; }
  for (const e of eintraege) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(e) || behalte.includes(e)) continue;
    try { rmSync(path.join(ordner, e), { recursive: true, force: true }); weg.push(e); } catch { /* beim nächsten Mal */ }
  }
  return weg;
}
