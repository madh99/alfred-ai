import { describe, it, expect } from 'vitest';
import { etappenBerichtText, etappenAuftrag, fixAuftrag, LAUFZEITDATEN_REGEL } from '../satellit-projekt-regeln.js';

const basis = { lauf: 'sat-383930d6', geraet: 'Ubuntu-VM', ziel: 'SPAR-Abruf reparieren', plan: ['Diagnose', 'Beheben', 'Prüfen'], zeit: '2026-10-13 09:48 UTC' };

describe('v1425 Etappenbericht fürs Projekt', () => {
  it('abgenommen: Kopf, Zusammenfassung, Dateien, Commit, Abnahme', () => {
    const t = etappenBerichtText({ ...basis, e: { nr: 2, etappe: 'Beheben', ok: true, geprueft: true, fixVersuche: 1, kostenUsd: 1.234, text: 'kurz', zusammenfassung: 'SPAR liefert echte Angebote.', dateien: ['src/quellen/spar.js', 'tests/spar.test.js'], dateienAnzahl: 4, commit: { sha: 'abc1234', titel: 'Etappe 2: SPAR' }, abnahme: { ok: true, protokoll: 'npm test: 124/124' }, dauerS: 540 } });
    expect(t).toContain('# Etappe 2/3: Beheben');
    expect(t).toContain('✅ abgenommen nach 1 Fix-Versuch(en)');
    expect(t).toContain('1.23 USD · Dauer 9 min');
    expect(t).toContain('abc1234 Etappe 2: SPAR');
    expect(t).toContain('SPAR liefert echte Angebote.');
    expect(t).toContain('- src/quellen/spar.js');
    expect(t).toContain('… und 2 weitere');
    expect(t).toContain('npm test: 124/124');
    expect(t).toContain('etappe-2-auftrag.md');
  });

  it('ungeprüft und rot', () => {
    expect(etappenBerichtText({ ...basis, e: { nr: 1, etappe: 'Diagnose', ok: true, geprueft: false, fixVersuche: 0, kostenUsd: 0.5, text: 'x' } })).toContain('⚠️ fertig, ohne automatische Abnahme');
    const rot = etappenBerichtText({ ...basis, e: { nr: 3, etappe: 'Prüfen', ok: false, geprueft: true, fixVersuche: 3, kostenUsd: 2, text: 'x', abnahme: { ok: false, protokoll: 'FAIL' } } });
    expect(rot).toContain('❌ nicht abgenommen (nach 3 Fix-Versuch(en))');
    expect(rot).toContain('Ergebnis: rot');
    expect(rot).toContain('(keiner erkannt)');
  });

  it('Etappenauftrag schützt den .alfred-Ordner', () => {
    expect(etappenAuftrag({ ziel: 'z', plan: ['a'], nr: 1, pruefBefehle: [] })).toContain('.alfred/ gehört Alfred');
    // v1452 — Laufzeitdaten nie ins Repository, in jeder Etappe und jedem Fix-Versuch
    expect(etappenAuftrag({ ziel: 'z', plan: ['a'], nr: 1, pruefBefehle: [] })).toContain(LAUFZEITDATEN_REGEL);
    expect(fixAuftrag({ ziel: 'z', nr: 1, etappe: 'a', versuch: 1, pruefprotokoll: 'p' })).toContain(LAUFZEITDATEN_REGEL);
    expect(LAUFZEITDATEN_REGEL).toMatch(/git rm --cached/);
  });
});
