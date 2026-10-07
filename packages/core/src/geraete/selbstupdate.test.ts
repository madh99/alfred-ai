import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { Logger } from 'pino';
import { Selbstupdate } from './selbstupdate.js';
import { einstiegVon, ladeAktuell, speichereAktuell } from './aktualisierung.js';
import { sha256Datei } from './releases.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger;
let wurzel: string; let eingang: string; let cli: string;
beforeEach(() => {
  wurzel = mkdtempSync(path.join(os.tmpdir(), 'alfred-su-'));
  eingang = path.join(wurzel, 'updates'); cli = path.join(wurzel, 'cli');
  mkdirSync(eingang); mkdirSync(cli);
});
afterEach(() => { rmSync(wurzel, { recursive: true, force: true }); });

function tarball(version: string, mitSha = true, name = '@madh-io/alfred-ai'): string {
  const paket = path.join(wurzel, 'package');
  mkdirSync(paket, { recursive: true });
  writeFileSync(path.join(paket, 'package.json'), JSON.stringify({ name, version }));
  const tgz = path.join(eingang, `${version}.tgz`);
  execFileSync('tar', ['-czf', path.join('updates', path.basename(tgz)), 'package'], { cwd: wurzel });
  rmSync(paket, { recursive: true, force: true });
  if (mitSha) writeFileSync(`${tgz}.sha256`, sha256Datei(tgz));
  return tgz;
}

function fakeInstaller() {
  return vi.fn(async (_tgz: string, version: string, ordner: string) => {
    const e = einstiegVon(ordner, version);
    mkdirSync(path.dirname(e), { recursive: true });
    writeFileSync(e, '// bundle');
    return e;
  });
}

const warte = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Selbstupdate', () => {
  it('Übersicht und Kandidat aus dem Eingang: neueste neuere Version, Prüfsummen-Hinweis', async () => {
    tarball('0.19.0-jarvis.1260'); tarball('0.19.0-jarvis.1270'); tarball('0.19.0-jarvis.1268', false); tarball('1.0.0', true, '@fremd/x');
    const su = new Selbstupdate({ eigeneVersion: '0.19.0-jarvis.1265', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde: async () => undefined, neustart: () => undefined });
    const u = await su.uebersicht();
    expect(u.eingang.map(e => e.version)).toEqual(['0.19.0-jarvis.1270', '0.19.0-jarvis.1268', '0.19.0-jarvis.1260']);
    expect(u.eingang[0]?.neuer).toBe(true);
    expect(u.eingang[2]?.neuer).toBe(false);
    const k = await su.kandidat({ art: 'datei' });
    expect(k.version).toBe('0.19.0-jarvis.1270');
    expect(k.beschreibung).toContain('mit Prüfsumme');
    expect((await su.kandidat({ art: 'datei', version: '0.19.0-jarvis.1268' })).beschreibung).toContain('ohne Begleit-Prüfsumme');
    await expect(su.kandidat({ art: 'datei', version: '0.19.0-jarvis.1260' })).rejects.toThrow(/nicht neuer/);
    await expect(su.kandidat({ art: 'datei', version: '0.19.0-jarvis.1299' })).rejects.toThrow(/keine 0.19.0-jarvis.1299/);
  });

  it('Freigabe ist einmalig und an die Version gebunden', () => {
    const su = new Selbstupdate({ eigeneVersion: '1.0.0', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde: async () => undefined, neustart: () => undefined });
    const n = su.erzeugeFreigabe('1.0.1', { art: 'datei', pfad: '1.0.1.tgz' });
    expect(su.verbraucheFreigabe(n, '1.0.2')).toBeUndefined();
    expect(su.verbraucheFreigabe(n, '1.0.1')).toEqual({ art: 'datei', pfad: '1.0.1.tgz' });
    expect(su.verbraucheFreigabe(n, '1.0.1')).toBeUndefined();
    expect(su.verbraucheFreigabe(undefined, '1.0.1')).toBeUndefined();
  });

  it('Ablauf: prüfen, installieren, Probe, auf Ruhe warten, melden, Neustart mit frischem Zeitstempel', async () => {
    tarball('0.19.0-jarvis.1270');
    const melde = vi.fn(async (_t: string) => undefined);
    const neustart = vi.fn();
    const installiere = fakeInstaller();
    const probe = vi.fn(async (_t: string) => undefined);
    let vorhaben = 1; let minute = 58;
    const su = new Selbstupdate({
      eigeneVersion: '0.19.0-jarvis.1265', eingangOrdner: eingang, cliOrdner: cli, logger,
      ruhe: () => ({ vorhaben, hoeren: 0 }), melde, neustart, installiere, probe,
      jetzt: () => new Date(2026, 9, 7, 12, minute), warteMs: 20,
    });
    const lauf = su.starte({ art: 'datei', pfad: '0.19.0-jarvis.1270.tgz' }, '0.19.0-jarvis.1270');
    expect(lauf.phase).toBe('pruefen');
    expect(() => su.starte({ art: 'datei' }, '0.19.0-jarvis.1271')).toThrow(/läuft schon/);
    await vi.waitFor(() => expect(su.status()?.phase).toBe('warten'));
    expect(installiere).toHaveBeenCalledWith(expect.stringContaining('1270.tgz'), '0.19.0-jarvis.1270', cli);
    expect(probe).toHaveBeenCalled();
    expect(melde).toHaveBeenCalledTimes(1);
    expect(String(melde.mock.calls[0]?.[0])).toContain('installiert und geprüft');
    const installiertUm = ladeAktuell(cli)!;
    expect(installiertUm.version).toBe('0.19.0-jarvis.1270');
    expect(installiertUm.bestaetigt).toBe(false);
    await warte(60);
    expect(neustart).not.toHaveBeenCalled();
    expect(su.status()?.hinweis).toBe('Pass-Fenster');
    minute = 10; // Fenster vorbei, aber Vorhaben läuft
    await warte(60);
    expect(neustart).not.toHaveBeenCalled();
    expect(su.status()?.hinweis).toBe('1 Vorhaben, 0 Hör-Sitzung');
    vorhaben = 0;
    await vi.waitFor(() => expect(neustart).toHaveBeenCalled());
    expect(su.status()?.phase).toBe('neustart');
    expect(melde).toHaveBeenCalledTimes(2);
    expect(String(melde.mock.calls[1]?.[0])).toContain('Neustart auf 0.19.0-jarvis.1270');
    expect(Date.parse(ladeAktuell(cli)!.zeit)).toBeGreaterThanOrEqual(Date.parse(installiertUm.zeit));
  });

  it('nach Höchstwartezeit startet er trotz Vorhaben neu, nie im Pass-Fenster', async () => {
    tarball('0.19.0-jarvis.1270');
    const neustart = vi.fn(); const melde = vi.fn(async (_t: string) => undefined);
    const su = new Selbstupdate({
      eigeneVersion: '0.19.0-jarvis.1265', eingangOrdner: eingang, cliOrdner: cli, logger,
      ruhe: () => ({ vorhaben: 2, hoeren: 1 }), melde, neustart, installiere: fakeInstaller(), probe: async () => undefined,
      jetzt: () => new Date(2026, 9, 7, 12, 10), warteMs: 10, maxWartenMs: 30,
    });
    su.starte({ art: 'datei' }, '0.19.0-jarvis.1270');
    await vi.waitFor(() => expect(neustart).toHaveBeenCalled());
    expect(su.status()?.hinweis).toMatch(/trotz 2 Vorhaben\/1 Hör-Sitzung/);
  });

  it('Fehler (falsche Prüfsumme) → Phase fehler, Meldung, kein Neustart, kein aktuell.json', async () => {
    const tgz = tarball('0.19.0-jarvis.1270');
    writeFileSync(`${tgz}.sha256`, 'f'.repeat(64));
    const neustart = vi.fn(); const melde = vi.fn(async (_t: string) => undefined); const installiere = fakeInstaller();
    const su = new Selbstupdate({ eigeneVersion: '0.19.0-jarvis.1265', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde, neustart, installiere, probe: async () => undefined, warteMs: 10 });
    su.starte({ art: 'datei' }, '0.19.0-jarvis.1270');
    await vi.waitFor(() => expect(su.status()?.phase).toBe('fehler'));
    expect(su.status()?.hinweis).toMatch(/Prüfsumme/);
    expect(installiere).not.toHaveBeenCalled();
    expect(neustart).not.toHaveBeenCalled();
    expect(ladeAktuell(cli)).toBeUndefined();
    await vi.waitFor(() => expect(melde).toHaveBeenCalled());
    expect(String(melde.mock.calls[0]?.[0])).toContain('abgebrochen');
    // danach darf ein neuer Lauf starten
    writeFileSync(`${tgz}.sha256`, sha256Datei(tgz));
    expect(() => su.starte({ art: 'datei' }, '0.19.0-jarvis.1270')).not.toThrow();
    await vi.waitFor(() => expect(neustart).toHaveBeenCalled()); // Lauf zu Ende, bevor afterEach aufräumt
  });

  it('nachStart: frische Version bestätigt sich nach der Frist und räumt alte Versionen', async () => {
    const e70 = einstiegVon(cli, '0.19.0-jarvis.1270'); mkdirSync(path.dirname(e70), { recursive: true }); writeFileSync(e70, '');
    const e60 = einstiegVon(cli, '0.19.0-jarvis.1260'); mkdirSync(path.dirname(e60), { recursive: true }); writeFileSync(e60, '');
    const e50 = einstiegVon(cli, '0.19.0-jarvis.1250'); mkdirSync(path.dirname(e50), { recursive: true }); writeFileSync(e50, '');
    speichereAktuell({ version: '0.19.0-jarvis.1270', einstieg: e70, zeit: new Date().toISOString(), bestaetigt: false, vorige: '0.19.0-jarvis.1260' }, cli);
    const melde = vi.fn(async (_t: string) => undefined);
    const su = new Selbstupdate({ eigeneVersion: '0.19.0-jarvis.1270', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde, neustart: () => undefined, bestaetigungMs: 20 });
    su.nachStart();
    expect(ladeAktuell(cli)?.bestaetigt).toBe(false);
    await vi.waitFor(() => expect(ladeAktuell(cli)?.bestaetigt).toBe(true));
    expect(melde).toHaveBeenCalledTimes(1);
    expect(String(melde.mock.calls[0]?.[0])).toContain('bestätigt');
    expect(ladeAktuell(cli)?.vorige).toBe('0.19.0-jarvis.1260');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(cli, '0.19.0-jarvis.1260'))).toBe(true);
    expect(existsSync(path.join(cli, '0.19.0-jarvis.1250'))).toBe(false);
  });

  it('nachStart: die vorige Version läuft nach gescheiterter Probe wieder → meldet und übernimmt den Eintrag', async () => {
    const e70 = einstiegVon(cli, '0.19.0-jarvis.1270'); mkdirSync(path.dirname(e70), { recursive: true }); writeFileSync(e70, '');
    speichereAktuell({ version: '0.19.0-jarvis.1270', einstieg: e70, zeit: new Date().toISOString(), bestaetigt: false, gescheitert: true }, cli);
    const melde = vi.fn(async (_t: string) => undefined);
    const su = new Selbstupdate({ eigeneVersion: '0.19.0-jarvis.1265', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde, neustart: () => undefined });
    su.nachStart();
    expect(melde).toHaveBeenCalledTimes(1);
    expect(String(melde.mock.calls[0]?.[0])).toMatch(/gescheitert.*läuft wieder 0.19.0-jarvis.1265/);
    const a = ladeAktuell(cli);
    expect(a?.version).toBe('0.19.0-jarvis.1265');
    expect(a?.bestaetigt).toBe(true);
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(cli, '0.19.0-jarvis.1270'))).toBe(false);
  });

  it('nachStart: bestätigte eigene Version → nichts zu tun', () => {
    const e = einstiegVon(cli, '1.0.1'); mkdirSync(path.dirname(e), { recursive: true }); writeFileSync(e, '');
    speichereAktuell({ version: '1.0.1', einstieg: e, zeit: new Date().toISOString(), bestaetigt: true }, cli);
    const melde = vi.fn(async (_t: string) => undefined);
    new Selbstupdate({ eigeneVersion: '1.0.1', eingangOrdner: eingang, cliOrdner: cli, logger, ruhe: () => ({ vorhaben: 0, hoeren: 0 }), melde, neustart: () => undefined }).nachStart();
    expect(melde).not.toHaveBeenCalled();
  });
});
