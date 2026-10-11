import { describe, it, expect } from 'vitest';
import { arbeitsMelder, type ArbeitsEreignis } from '../geraete/arbeits-melder.js';

// v1354 — „Alfred arbeitet" für Anfragen aus anderen Kanälen auf den Geräten des Owners
function aufbau() {
  const raus: ArbeitsEreignis[] = [];
  let t = 0;
  const geplant: Array<{ fn: () => void; um: number; weg?: boolean }> = [];
  const m = arbeitsMelder({ arbeit: 'a1', faden: null, von: { platform: 'telegram', chatId: '42' } }, (e) => raus.push(e), {
    abstandMs: 2000, jetzt: () => t,
    spaeter: (fn, ms) => { const g = { fn, um: t + ms }; geplant.push(g); return g; },
    abbrechenSpaeter: (h) => { (h as { weg?: boolean }).weg = true; },
  });
  const vergeht = (ms: number) => { t += ms; for (const g of geplant) if (!g.weg && g.um <= t) { g.weg = true; g.fn(); } };
  return { m, raus, vergeht };
}

describe('arbeitsMelder', () => {
  it('start mit Frage, Status gedrosselt, verpasster Status wird nachgereicht, ende genau einmal', () => {
    const { m, raus, vergeht } = aufbau();
    m.start('Wie ist das Wetter?');
    m.status({ kind: 'thinking', text: 'Alfred denkt nach…' });
    vergeht(500);
    m.status({ kind: 'tool_call', text: 'Wetter abfragen' });
    m.status({ kind: 'delta', text: 'Heute ' }); // Antwort-Stückchen: nie
    vergeht(400);
    m.status({ kind: 'tool_call', text: 'Kalender lesen' }); // überschreibt den wartenden
    expect(raus.map(e => e.text ?? e.phase)).toEqual(['start', 'Alfred denkt nach…']);
    vergeht(1200); // Sperrzeit vorbei → neuester wartender Text
    expect(raus.map(e => e.text ?? e.phase)).toEqual(['start', 'Alfred denkt nach…', 'Kalender lesen']);
    m.status('Kalender lesen'); // gleicher Text: nichts
    m.ende(); m.ende();
    m.status('zu spät');
    expect(raus.map(e => e.phase)).toEqual(['start', 'status', 'status', 'ende']);
    expect(raus[0]).toMatchObject({ arbeit: 'a1', faden: null, von: { platform: 'telegram', chatId: '42' }, frage: 'Wie ist das Wetter?' });
  });

  it('ende verwirft einen noch wartenden Status', () => {
    const { m, raus, vergeht } = aufbau();
    m.status('eins');
    m.status('zwei');
    m.ende();
    vergeht(5000);
    expect(raus.map(e => e.text ?? e.phase)).toEqual(['eins', 'ende']);
  });

  it('Fehler beim Melden stören die Anfrage nicht', () => {
    const m = arbeitsMelder({ arbeit: 'x', faden: 'f', von: { platform: 'api', chatId: 'c' } }, () => { throw new Error('Gerät weg'); });
    expect(() => { m.start('q'); m.status('s'); m.ende(); }).not.toThrow();
  });
});
