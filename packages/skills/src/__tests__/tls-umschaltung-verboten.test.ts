import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// v1385 — NODE_TLS_REJECT_UNAUTHORIZED prozessweit zu setzen schaltet die Zertifikatsprüfung für ALLE parallelen Anfragen ab
// (Telegram, Modell-Anbieter, E-Mail) und hinterlässt bei überlappenden Aufrufen die '0' dauerhaft. Ausnahmen nur über tlsFetch.
const PAKETE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function dateien(dir: string, aus: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist' || n === '__tests__' || n === 'bundle') continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) dateien(p, aus);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) aus.push(p);
  }
  return aus;
}

describe('keine prozessweite TLS-Umschaltung', () => {
  it('kein Quelltext setzt NODE_TLS_REJECT_UNAUTHORIZED', () => {
    const treffer = readdirSync(PAKETE).map(p => path.join(PAKETE, p, 'src')).filter(d => { try { return statSync(d).isDirectory(); } catch { return false; } })
      .flatMap(d => dateien(d))
      .filter(f => /(?:\.NODE_TLS_REJECT_UNAUTHORIZED|\[['"]NODE_TLS_REJECT_UNAUTHORIZED['"]\])\s*=(?!=)|delete\s+process\.env\.NODE_TLS_REJECT_UNAUTHORIZED/.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(PAKETE, f));
    expect(treffer).toEqual([]);
  });
});
