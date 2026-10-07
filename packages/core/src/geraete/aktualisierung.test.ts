import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  imPassFenster, startbareVersion, speichereAktuell, ladeAktuell, bestaetigeAktuell, markiereGescheitert,
  einstiegVon, pruefeTarball, raeumeVersionen, tarballInfo,
} from './aktualisierung.js';
import { sha256Datei } from './releases.js';

let ordner: string;
beforeEach(() => { ordner = mkdtempSync(path.join(os.tmpdir(), 'alfred-akt-')); });
afterEach(() => { rmSync(ordner, { recursive: true, force: true }); });

function installiert(version: string): string {
  const e = einstiegVon(ordner, version);
  mkdirSync(path.dirname(e), { recursive: true });
  writeFileSync(e, '// bundle');
  return e;
}

describe('imPassFenster', () => {
  it('sperrt :57–:02 und :27–:32, sonst frei', () => {
    const um = (m: number) => new Date(2026, 9, 7, 12, m);
    for (const m of [57, 58, 59, 0, 1, 2, 27, 30, 32]) expect(imPassFenster(um(m))).toBe(true);
    for (const m of [3, 10, 26, 33, 45, 56]) expect(imPassFenster(um(m))).toBe(false);
  });
});

describe('startbareVersion', () => {
  it('nichts installiert → undefined', () => { expect(startbareVersion('1.0.0', ordner)).toBeUndefined(); });

  it('bestätigte neuere Version läuft; ältere wird ignoriert', () => {
    const e = installiert('1.0.5');
    speichereAktuell({ version: '1.0.5', einstieg: e, zeit: new Date().toISOString(), bestaetigt: true }, ordner);
    expect(startbareVersion('1.0.0', ordner)?.version).toBe('1.0.5');
    expect(startbareVersion('1.0.9', ordner)).toBeUndefined();
  });

  it('frische Probe läuft 10 Minuten, dann Rückfall auf die vorige', () => {
    installiert('1.0.5'); const e6 = installiert('1.0.6');
    const t0 = Date.now();
    speichereAktuell({ version: '1.0.6', einstieg: e6, zeit: new Date(t0).toISOString(), bestaetigt: false, vorige: '1.0.5' }, ordner);
    expect(startbareVersion('1.0.0', ordner, t0 + 5 * 60_000)?.version).toBe('1.0.6');
    const r = startbareVersion('1.0.0', ordner, t0 + 11 * 60_000);
    expect(r?.version).toBe('1.0.5');
    expect(r?.bestaetigt).toBe(true);
  });

  it('gescheiterte Probe fällt sofort zurück — ohne vorige auf den Starter', () => {
    const e6 = installiert('1.0.6');
    speichereAktuell({ version: '1.0.6', einstieg: e6, zeit: new Date().toISOString(), bestaetigt: false }, ordner);
    expect(markiereGescheitert('1.0.6', ordner)).toBe(true);
    expect(markiereGescheitert('1.0.6', ordner)).toBe(false);
    expect(startbareVersion('1.0.0', ordner)).toBeUndefined();
  });

  it('bestätigen löscht gescheitert und zählt nur einmal', () => {
    const e6 = installiert('1.0.6');
    speichereAktuell({ version: '1.0.6', einstieg: e6, zeit: new Date().toISOString(), bestaetigt: false, gescheitert: true }, ordner);
    expect(bestaetigeAktuell('1.0.6', ordner)).toBe(true);
    expect(bestaetigeAktuell('1.0.6', ordner)).toBe(false);
    const a = ladeAktuell(ordner);
    expect(a?.bestaetigt).toBe(true);
    expect(a?.gescheitert).toBeUndefined();
  });
});

describe('raeumeVersionen', () => {
  it('entfernt nur Versionsordner, die nicht behalten werden', () => {
    installiert('1.0.4'); installiert('1.0.5'); installiert('1.0.6');
    mkdirSync(path.join(ordner, 'notizen'));
    const weg = raeumeVersionen(['1.0.6', '1.0.5'], ordner);
    expect(weg).toEqual(['1.0.4']);
    expect(existsSync(path.join(ordner, '1.0.5'))).toBe(true);
    expect(existsSync(path.join(ordner, 'notizen'))).toBe(true);
  });
});

describe('pruefeTarball', () => {
  function tarball(name: string, version: string): string {
    const paket = path.join(ordner, 'package');
    mkdirSync(paket, { recursive: true });
    writeFileSync(path.join(paket, 'package.json'), JSON.stringify({ name, version }));
    const tgz = path.join(ordner, `${version}.tgz`);
    execFileSync('tar', ['-czf', path.basename(tgz), 'package'], { cwd: ordner });
    rmSync(paket, { recursive: true, force: true });
    return tgz;
  }

  it('liest Name und Version, prüft Paket, Neuheit und Begleit-Prüfsumme', async () => {
    const tgz = tarball('@madh-io/alfred-ai', '0.19.0-jarvis.1270');
    expect(await tarballInfo(tgz)).toEqual({ name: '@madh-io/alfred-ai', version: '0.19.0-jarvis.1270' });
    const sha = sha256Datei(tgz);
    writeFileSync(`${tgz}.sha256`, `${sha}  ${path.basename(tgz)}\n`);
    const p = await pruefeTarball(tgz, '0.19.0-jarvis.1265');
    expect(p.version).toBe('0.19.0-jarvis.1270');
    expect(p.sha256).toBe(sha);
    await expect(pruefeTarball(tgz, '0.19.0-jarvis.1270')).rejects.toThrow(/nicht neuer/);
    writeFileSync(`${tgz}.sha256`, 'a'.repeat(64));
    await expect(pruefeTarball(tgz, '0.19.0-jarvis.1265')).rejects.toThrow(/Prüfsumme/);
    await expect(pruefeTarball(tgz, '0.19.0-jarvis.1265', sha)).resolves.toBeTruthy();
  });

  it('lehnt fremde Pakete ab', async () => {
    const tgz = tarball('@fremd/paket', '9.9.9');
    await expect(pruefeTarball(tgz, '0.1.0')).rejects.toThrow(/Falsches Paket/);
  });
});
