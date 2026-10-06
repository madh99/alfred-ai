import { describe, it, expect } from 'vitest';
import { selfModifyUeberspringen } from './agent-conventions-skill.js';

// v1209 — Realfall 06.10.2026: drei identische Opus-Läufe je Projekt in einer Nacht
// (Scan byte-gleich, keine neuen Lessons) nach drei Neustarts.
describe('selfModifyUeberspringen', () => {
  it('überspringt nur, wenn Scan unverändert UND nichts zu integrieren ist', () => {
    expect(selfModifyUeberspringen({ scanHash: 'a', letzterScanHash: 'a', offeneLessons: 0, healthVorschlaege: 0 })).toMatch(/unverändert/);
    expect(selfModifyUeberspringen({ scanHash: 'a', letzterScanHash: 'b', offeneLessons: 0, healthVorschlaege: 0 })).toBeNull();
    expect(selfModifyUeberspringen({ scanHash: 'a', letzterScanHash: 'a', offeneLessons: 1, healthVorschlaege: 0 })).toBeNull();
    expect(selfModifyUeberspringen({ scanHash: 'a', letzterScanHash: 'a', offeneLessons: 0, healthVorschlaege: 2 })).toBeNull();
    expect(selfModifyUeberspringen({ scanHash: 'a', letzterScanHash: undefined, offeneLessons: 0, healthVorschlaege: 0 })).toBeNull();
  });
});
