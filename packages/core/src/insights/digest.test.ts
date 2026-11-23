import { describe, it, expect } from 'vitest';
import { trenneDigest, digestText, DIGEST_KATEGORIEN } from './digest.js';

/**
 * v1937 — Schleife 2 Digest (Owner 23.11. nach Auswertung Block 26.10.): commvault 13 Vorschläge/12 verworfen, unifi 4/4.
 * Vorschläge dieser Kategorien werden gesammelt und einmal täglich gebündelt gemeldet — keine Einzel-Rückfragen mehr.
 */
const a = (skillName: string, description: string) => ({ skillName, description, skillParams: {} }) as never;

describe('v1937 Digest', () => {
  it('commvault und unifi gehen in den Digest, der Rest bleibt', () => {
    expect([...DIGEST_KATEGORIEN].sort()).toEqual(['commvault', 'unifi']);
    const r = trenneDigest([a('commvault', 'Commvault-Status erneut prüfen'), a('proxmox', 'VM prüfen'), a('unifi', 'Alerts lesen')]);
    expect(r.sofort.map((x: { skillName: string }) => x.skillName)).toEqual(['proxmox']);
    expect(r.digest.map((x: { skillName: string }) => x.skillName)).toEqual(['commvault', 'unifi']);
  });
  it('Text bündelt gleiche Vorschläge mit Anzahl, je Kategorie', () => {
    const t = digestText([
      { skill: 'commvault', beschreibung: 'Commvault-Status erneut prüfen', zeit: '2026-11-23T08:00:00Z' },
      { skill: 'commvault', beschreibung: 'Commvault-Status erneut prüfen.', zeit: '2026-11-23T12:00:00Z' },
      { skill: 'unifi', beschreibung: 'UniFi-Alerts lesen', zeit: '2026-11-23T09:00:00Z' },
    ]);
    expect(t).toContain('commvault');
    expect(t).toContain('2×');
    expect(t).toContain('UniFi-Alerts lesen');
  });
  it('leer → kein Text', () => {
    expect(digestText([])).toBe('');
  });
});
