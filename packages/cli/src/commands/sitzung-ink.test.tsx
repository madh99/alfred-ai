import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { InkOberflaeche } from './sitzung-ink.js';
import type { Taste } from './sitzung-oberflaeche.js';

/** Falsches Terminal: stdin mit Rohmodus (Ink liest über 'readable'), stdout sammelt Rahmen. */
function terminal() {
  const stdin = new Readable({ read() { /* push von außen */ } }) as Readable & { isTTY: boolean; setRawMode: (b: boolean) => void; ref: () => void; unref: () => void };
  stdin.isTTY = true; stdin.setRawMode = () => undefined; stdin.ref = () => undefined; stdin.unref = () => undefined;
  let ausgabe = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { ausgabe += String(chunk); cb(); } }) as Writable & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = 100; stdout.rows = 30; stdout.isTTY = true;
  return { stdin, stdout, ausgabe: () => ausgabe, tippe: (s: string) => { stdin.push(s); } };
}
const warte = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Ink-Oberfläche der Sitzung (v1303)', () => {
  it('zeigt Status, Verlauf, laufende Antwort und nimmt Eingabe und Tasten an', async () => {
    const t = terminal();
    const ui = new InkOberflaeche({ geraet: 'PC-test', version: '1303', server: 'https://x', satellit: 'angehängt über IPC', verbunden: true, offen: 2, modus: 'bereit', stimme: false, hoeren: false }, { stdin: t.stdin as unknown as NodeJS.ReadStream, stdout: t.stdout as unknown as NodeJS.WriteStream, debug: true });
    const eingaben: string[] = []; const tasten: Taste[] = [];
    ui.aufEingabe(z => eingaben.push(z)); ui.aufTaste(x => tasten.push(x));
    ui.start();
    ui.drucke('Hallo Verlauf');
    ui.antwortDelta('Erstes '); ui.antwortDelta('Stück');
    ui.fluechtig('… denkt');
    await warte(150);
    const rahmen = t.ausgabe(); // debug-Modus: jeder Rahmen vollständig auf stdout
    expect(rahmen).toContain('PC-test 1303');
    expect(rahmen).toContain('Satellit: angehängt über IPC ●');
    expect(rahmen).toContain('Bestätigungen: 2');
    expect(rahmen).toContain('Hallo Verlauf');
    expect(rahmen).toContain('Erstes Stück');
    expect(rahmen).toContain('… denkt');
    // Tippen + Enter → Eingabe
    t.tippe('h'); t.tippe('i'); await warte(50); t.tippe('\r'); await warte(100);
    expect(eingaben).toEqual(['hi']);
    // Strg+T, Strg+L, Alt+J (ESC-Präfix), Strg+Q
    // einzeln mit Pausen: ein Readable fasst schnelle Pushes zu einem Stück zusammen, Ink liest je 'readable' eine Sequenz
    for (const taste of ['', '', 'j', '']) { t.tippe(taste); await warte(30); }
    await warte(100);
    expect(tasten).toEqual(['strg+t', 'lage', 'ja', 'ende']);
    ui.antwortEnde(undefined, ['📎 datei.txt']);
    ui.status({ offen: 0, modus: 'antwort' });
    await warte(100);
    const r2 = t.ausgabe();
    expect(r2).toContain('Bestätigungen: 0');
    expect(r2).toContain('… antwortet');
    ui.schliessen();
    expect(t.ausgabe()).toContain('Erstes Stück');
  });
});
