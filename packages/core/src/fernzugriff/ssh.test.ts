import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schreibeKnownHosts, schluesselGeaendert } from './ssh.js';

// v1656 — Realfall 25.10.2026 01:52: dockerhost gesperrt, obwohl der Host-Schlüssel unverändert war
describe('v1656 known_hosts und Sperre', () => {
  it('nur ein tatsächlich anderer Schlüssel sperrt — ein fehlender Eintrag nicht', () => {
    expect(schluesselGeaendert('@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n')).toBe(true);
    expect(schluesselGeaendert('Host key for 192.168.1.211 has changed and you have requested strict checking.\nHost key verification failed.')).toBe(true);
    expect(schluesselGeaendert('No ED25519 host key is known for 192.168.1.211 and you have requested strict checking.\nHost key verification failed.')).toBe(false);
    expect(schluesselGeaendert('Permission denied (publickey).')).toBe(false);
  });

  it('gleichzeitiges Schreiben lässt die Datei nie leer und keine Reste zurück', async () => {
    const ordner = await mkdtemp(path.join(tmpdir(), 'kh-'));
    try {
      const datei = path.join(ordner, 'known_hosts_x');
      const inhalt = '192.168.1.211 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n';
      const leser = (async () => { let leer = 0; for (let i = 0; i < 200; i++) { try { if ((await readFile(datei, 'utf8')) === '') leer++; } catch { /* noch nicht da */ } } return leer; })();
      await Promise.all(Array.from({ length: 50 }, () => schreibeKnownHosts(datei, inhalt)));
      expect(await leser).toBe(0);
      expect(await readFile(datei, 'utf8')).toBe(inhalt);
      expect(await readdir(ordner)).toEqual(['known_hosts_x']);
    } finally { await rm(ordner, { recursive: true, force: true }); }
  });
});
