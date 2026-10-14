import { describe, it, expect } from 'vitest';
import { istPruefAuftrag, standRahmen, standAus, laufVollstaendig, STAND_ANFANG, STAND_ENDE } from './stand.js';

describe('v1449 Prüfaufträge mit eigenem Stand', () => {
  it('erkennt Prüfaufträge', () => {
    expect(istPruefAuftrag('Prüfe täglich live Willhaben-Angebote … neue Treffer und Preisänderungen hervorheben')).toBe(true);
    expect(istPruefAuftrag('Schick mir jeden Morgen das Wetter')).toBe(false);
    expect(istPruefAuftrag('Wetter', 'A: 1')).toBe(true);
  });

  it('Rahmen enthält Stand und feste Vorgaben', () => {
    const r = standRahmen('Mac-Angebote', '789898944 mini 2400 EUR online', '2026-10-14T07:00:24Z');
    expect(r).toContain('Letzter Stand (vom 14.10., 09:00)');
    expect(r).toContain('789898944 mini 2400 EUR online');
    expect(r).toContain('„In einer Suche nicht gefunden“ ist NICHT „weg“');
    expect(r).toContain('Jeder Eintrag ist mit seinem Link anklickbar'); // v1450
    expect(r).toContain('Link/Adresse');
    expect(r).toContain(STAND_ANFANG);
    expect(standRahmen('X', '')).toContain('noch keiner');
  });

  it('trennt Bericht und Stand (letzter Block), auch in Codeblock', () => {
    const t = `## Bericht\nPreis gesenkt bei 789898944 (2450 → 2400).\n\n\`\`\`\n${STAND_ANFANG}\n789898944 | 2400 | online\n${STAND_ENDE}\n\`\`\``;
    const r = standAus(t);
    expect(r.stand).toBe('789898944 | 2400 | online');
    expect(r.bericht).toBe('## Bericht\nPreis gesenkt bei 789898944 (2450 → 2400).');
    expect(standAus('nur Text')).toEqual({ bericht: 'nur Text' });
  });

  it('Vollständigkeit: „Notiz gespeichert“ ohne Bericht/Stand ist unvollständig', () => {
    expect(laufVollstaendig(standAus('Die Notiz mit dem Prüfstand ist gespeichert. Keine Käufe und keine Verkäuferkontakte.'))).toEqual({ ok: false, fehlt: ['Bericht', 'neuer Stand'] });
    const voll = `${'Änderungen: … '.repeat(20)}\n${STAND_ANFANG}\nA | 1\n${STAND_ENDE}`;
    expect(laufVollstaendig(standAus(voll)).ok).toBe(true);
  });
});
