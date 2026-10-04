import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Jarvis Schicht 0 — Lint gegen Schein-Vollständigkeit: Ein Job-Register, in
 * dem nur ein Teil der Jobs steht, suggeriert Sicherheit. Dieser Ratchet
 * verhindert, dass NEUE rohe Timer in alfred.ts entstehen — neue periodische
 * Arbeit gehört ins Register (lebenszeichen/job-register.ts). Die Basislinie
 * wird nur bewusst gesenkt, wenn ein weiterer Alt-Timer migriert wurde.
 */
const BASISLINIE_SET_INTERVAL = 19; // v1161: 27→24 (3 Nachtjobs); v1165: →19 (ITSM 23:00, KG-Fragen, Ziel-Extraktion, Insight-Sweep, Wochen-Analyse)

describe('Timer-Lint (Jarvis Schicht 0)', () => {
  it('keine neuen rohen setInterval-Timer in alfred.ts — periodische Arbeit gehört ins Job-Register', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const quelle = readFileSync(join(here, '..', 'alfred.ts'), 'utf8');
    const anzahl = (quelle.match(/\bsetInterval\(/g) ?? []).length;
    expect(anzahl, `setInterval-Aufrufe in alfred.ts: ${anzahl} > Basislinie ${BASISLINIE_SET_INTERVAL}. Neuen Timer als Job registrieren statt roh anlegen.`).toBeLessThanOrEqual(BASISLINIE_SET_INTERVAL);
  });

  it('die bekannte Falle „Stunden-Timer mit Minuten-Fenster" kommt nicht wieder vor', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const quelle = readFileSync(join(here, '..', 'alfred.ts'), 'utf8');
    // Muster: getMinutes() < N … }, 60 * 60_000) innerhalb von 40 Zeilen
    const zeilen = quelle.split('\n');
    const treffer: number[] = [];
    zeilen.forEach((z, i) => {
      if (/getMinutes\(\)\s*<\s*\d+/.test(z)) {
        const fenster = zeilen.slice(i, i + 40).join('\n');
        if (/\},\s*60\s*\*\s*60_000\)/.test(fenster)) treffer.push(i + 1);
      }
    });
    expect(treffer, `Stunden-Timer mit Minuten-Fenster in alfred.ts Zeilen ${treffer.join(', ')} (Realfall v1158)`).toEqual([]);
  });
});
