import { describe, it, expect } from 'vitest';
import { auftragMeldung } from '../geraete/auftrag-meldung.js';
import type { GeraetEreignis } from '@alfred/types';

// v1404 — Frage zum Projekt: die Antwort selbst ist die Meldung (statt Auftragsbericht)
describe('Ende-Meldung einer Frage', () => {
  const e = (o: Partial<GeraetEreignis>) => ({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', titel: 'Frage: Woher kommen die Hofer-Angebote?', projekt: '/home/madh/game', text: 'Aus src/quellen/hofer.js, Zeile 12 ff.', kosten: 0.12, ...o }) as GeraetEreignis;
  it('Antwort mit Kopf, Projekt und Text; kein „Geänderte Dateien"', () => {
    const m = auftragMeldung('Ubuntu-VM', e({}));
    expect(m.split('\n')[0]).toBe('❓ Woher kommen die Hofer-Angebote? — Antwort von Claude Code auf Ubuntu-VM (0,12 $):');
    expect(m).toContain('Aus src/quellen/hofer.js, Zeile 12 ff.');
    expect(m).not.toMatch(/Dateien/);
  });
  it('Fehler und Bau-Aufträge', () => {
    expect(auftragMeldung('Ubuntu-VM', e({ status: 'fehler', fehler: 'Budget', text: '' }))).toMatch(/keine Antwort .*\n.*\nFehler: Budget/);
    expect(auftragMeldung('Ubuntu-VM', e({ titel: 'Etappe 1: Gerüst' }))).toMatch(/^Claude-Code-Auftrag „Etappe 1: Gerüst"/);
  });
});
