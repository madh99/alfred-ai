import { describe, it, expect } from 'vitest';
import { geraetDevAus, angabeGleich, angabeText, vorschlagText, START_REGEL } from './geraet-dev.js';

// v1460 — dev je Projekt: am Gerät oder eigener Host
describe('v1460 dev am Gerät', () => {
  it('Standard: am Gerät; mit eingetragenem dev-Host bleibt es beim Host; gespeicherte Wahl gilt', () => {
    expect(geraetDevAus(undefined, false)).toEqual({ art: 'geraet' });
    expect(geraetDevAus({ stufen: {} }, true)).toEqual({ art: 'host' });
    expect(geraetDevAus({ geraetDev: { art: 'geraet', aktiv: true } }, true)).toMatchObject({ art: 'geraet', aktiv: true });
  });
  it('Angaben vergleichen und beschreiben; Vorschlag nennt Herkunft und bisherige Angabe', () => {
    const a = { dienst: true, start: 'npm start', port: 3000, pruefung: '/api/gesundheit' };
    expect(angabeGleich(a, { ...a })).toBe(true);
    expect(angabeGleich(a, { ...a, port: 3001 })).toBe(false);
    expect(angabeText({ dienst: false })).toMatch(/kein Dienst/);
    const t = vorschlagText({ name: 'Angebots-Radar', geraet: 'Ubuntu-VM', pfad: '/x', angabe: a, quelle: 'erkannt', hinweise: ['Port 3000 aus src/start.js'], geaendert: { dienst: true, start: 'node a.js' } });
    expect(t).toContain('Start `npm start`, Port 3000, Prüfadresse /api/gesundheit');
    expect(t).toContain('Port 3000 aus src/start.js');
    expect(t).toContain('Bisher: Start `node a.js`');
    expect(t).toMatch(/fremde Prozesse nie/);
    expect(START_REGEL).toContain('.alfred-start.json');
  });
  it('v1462 test-Vorschlag und .env aus der Umgebung test', async () => {
    const { testVorschlag, envText } = await import('./geraet-dev.js');
    expect(testVorschlag('/home/madh/claudecode/game/', 3000)).toEqual({ ordner: '/home/madh/claudecode/game-test', port: 4000 });
    expect(testVorschlag('/x', 65000)).toEqual({ ordner: '/x-test', port: 65001 });
    expect(testVorschlag('/x')).toEqual({ ordner: '/x-test' });
    expect(envText({ MODUS: 'test', SATZ: 'a b', 'kaputt-name': 'x', PFAD: 'c:\\x' })).toBe('MODUS=test\nSATZ="a b"\nPFAD="c:\\\\x"\n');
  });
});
