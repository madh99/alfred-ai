import { describe, it, expect } from 'vitest';
import { isSelfInstallPath } from './self-healing.js';

/**
 * v862 — Self-Target-Detection.
 * Vorfall 10.06.2026: claude-code lief mit cwd=/usr/lib/node_modules/@madh-io/alfred-ai
 * und patchte bundle/index.js live. isSelfInstallPath ist die Erkennung für den
 * Redirect (project_agent) und den Hard-Guard (agent-executor).
 *
 * Hinweis: Pfade hier existieren im Test-Env nicht — realpathSync fällt auf
 * path.resolve zurück, die Pattern-Matches funktionieren trotzdem.
 */

describe('v862 isSelfInstallPath', () => {
  it('erkennt die globale npm-Installation (Linux)', () => {
    expect(isSelfInstallPath('/usr/lib/node_modules/@madh-io/alfred-ai')).toBe(true);
    expect(isSelfInstallPath('/usr/lib/node_modules/@madh-io/alfred-ai/bundle')).toBe(true);
    expect(isSelfInstallPath('/usr/lib/node_modules/@madh-io/alfred-ai/test')).toBe(true);
  });

  it('erkennt alternative npm-Prefixe', () => {
    expect(isSelfInstallPath('/usr/local/lib/node_modules/@madh-io/alfred-ai')).toBe(true);
    expect(isSelfInstallPath('/opt/nvm/versions/node/v20.0.0/lib/node_modules/@madh-io/alfred-ai/bundle')).toBe(true);
  });

  it('erkennt das Daten-Verzeichnis wenn übergeben', () => {
    expect(isSelfInstallPath('/root/alfred/data', '/root/alfred/data')).toBe(true);
    expect(isSelfInstallPath('/root/alfred/data/logs', '/root/alfred/data')).toBe(true);
  });

  it('lässt normale Projekt-cwds durch', () => {
    expect(isSelfInstallPath('/home/madh/projects/alpbyte-games')).toBe(false);
    expect(isSelfInstallPath('/root/alfred-src')).toBe(false);     // der Self-Heal-Checkout selbst!
    expect(isSelfInstallPath('/home/madh/uboot-cc')).toBe(false);
  });

  it('lässt fremde node_modules durch (nur @madh-io/alfred-ai zählt)', () => {
    expect(isSelfInstallPath('/home/madh/projects/alpbyte-games/node_modules/react')).toBe(false);
  });

  it('ist case-insensitiv und Windows-Pfad-tolerant', () => {
    expect(isSelfInstallPath('C:\\Program Files\\nodejs\\node_modules\\@madh-io\\alfred-ai')).toBe(true);
  });

  it('leerer/undefined cwd ist kein Self-Target', () => {
    expect(isSelfInstallPath('')).toBe(false);
  });
});
