import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Releases, vergleicheVersion, signiere, pruefeSignatur, sha256Datei } from '../geraete/releases.js';

// v1258 — Satelliten-Autoupdate: Versionsvergleich, Signatur, Ablage.
describe('vergleicheVersion', () => {
  it('vergleicht Jarvis-Versionen numerisch', () => {
    expect(vergleicheVersion('0.19.0-jarvis.1258', '0.19.0-jarvis.1257')).toBe(1);
    expect(vergleicheVersion('0.19.0-jarvis.1258', '0.19.0-jarvis.1258')).toBe(0);
    expect(vergleicheVersion('0.19.0-jarvis.999', '0.19.0-jarvis.1000')).toBe(-1);
    expect(vergleicheVersion('0.20.0', '0.19.0-jarvis.1258')).toBe(1);
  });
});

describe('Releases', () => {
  it('erzeugt Schlüssel, signiert Prüfsummen, legt aktuell.json ab und merkt sie sich', async () => {
    const basis = mkdtempSync(path.join(os.tmpdir(), 'alfred-rel-'));
    const ordner = path.join(basis, 'releases');
    const logger = { info: vi.fn(), warn: vi.fn() } as never;
    const r = new Releases(ordner, logger);
    expect(r.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(existsSync(path.join(basis, 'release-key.json'))).toBe(true);
    // Tarball „von Hand" ablegen (npm pack braucht ein echtes Paket)
    writeFileSync(path.join(ordner, '0.19.0-jarvis.1258.tgz'), Buffer.from('tarball-inhalt'));
    const info = await r.sichereAktuell('0.19.0-jarvis.1258', basis);
    expect(info?.sha256).toBe(sha256Datei(path.join(ordner, '0.19.0-jarvis.1258.tgz')));
    expect(pruefeSignatur(info!.sha256, info!.signatur, r.publicKey)).toBe(true);
    expect(pruefeSignatur(info!.sha256, info!.signatur, new Releases(mkdtempSync(path.join(os.tmpdir(), 'alfred-rel2-')), logger).publicKey)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(ordner, 'aktuell.json'), 'utf8')).version).toBe('0.19.0-jarvis.1258');
    // zweite Instanz lädt denselben Schlüssel und die Info
    const r2 = new Releases(ordner, logger);
    expect(r2.publicKey).toBe(r.publicKey);
    expect(r2.info()?.version).toBe('0.19.0-jarvis.1258');
    expect(() => signiere('abc', 'kaputt')).toThrow();
  });
});
