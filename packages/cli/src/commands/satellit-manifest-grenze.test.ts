import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v1493 — Realfall 13.10. (v1416) und 17.10.: der Windows-Satellit mit Office-Aktionen lag über der Manifest-Grenze des Servers
// und wurde still abgewiesen. Alle Aktionen, die baueManifest auf irgendeinem Gerät melden kann, müssen darunter bleiben.
const hier = path.dirname(fileURLToPath(import.meta.url));

describe('Manifest-Grenze', () => {
  it('alle möglichen Aktionen passen unter MANIFEST_MAX_AKTIONEN (mit Luft)', () => {
    const quelle = readFileSync(path.join(hier, 'satellit.ts'), 'utf8');
    const start = quelle.indexOf('export function baueManifest(');
    const ende = quelle.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(0);
    const namen = new Set([...quelle.slice(start, ende).matchAll(/\{ name: '([a-z_]+)'/g)].map(m => m[1]));
    const protokoll = readFileSync(path.join(hier, '../../../core/src/geraete/protokoll.ts'), 'utf8');
    const grenze = Number(/export const MANIFEST_MAX_AKTIONEN = (\d+);/.exec(protokoll)?.[1]);
    expect(namen.size).toBeGreaterThan(50);
    expect(grenze).toBeGreaterThan(0);
    // Luft von 10: neue Aktionen fallen hier auf, nicht erst am Gerät
    expect(namen.size + 10, `${namen.size} mögliche Aktionen, Grenze ${grenze}`).toBeLessThanOrEqual(grenze);
  });
});
