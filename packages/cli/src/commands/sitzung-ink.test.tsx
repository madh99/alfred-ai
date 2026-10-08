import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { InkOberflaeche, markdownZeile, eingabeTaste, alterText } from './sitzung-ink.js';
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
    // einzeln mit Pausen: ein Readable fasst schnelle Pushes zu einem Stück zusammen, Ink liest je 'readable' eine Sequenz
    for (const taste of ['', '', 'j', '']) { t.tippe(taste); await warte(30); }
    await warte(100);
    expect(tasten).toEqual(['strg+t', 'lage', 'ja', 'ende']);
    ui.antwortEnde(undefined, ['📎 datei.txt']);
    ui.status({ offen: 0, modus: 'antwort' });
    await warte(100);
    const r2 = t.ausgabe();
    expect(r2).toContain('Bestätigungen: 0');
    expect(r2).toContain('antwortet');
    ui.schliessen();
    expect(t.ausgabe()).toContain('Erstes Stück');
  });

  it('v1305: Cursor-Eingabe, Verlauf ↑, Einfügen, Alt+Enter, Bestätigungsfeld, Markdown', async () => {
    const t = terminal();
    const ui = new InkOberflaeche({ geraet: 'PC', version: '1305', server: 'https://x', satellit: 'aus', offen: 0, modus: 'bereit', stimme: false, hoeren: false }, { stdin: t.stdin as unknown as NodeJS.ReadStream, stdout: t.stdout as unknown as NodeJS.WriteStream, debug: true });
    const eingaben: string[] = [];
    ui.aufEingabe(z => eingaben.push(z));
    ui.start();
    // „ab", Cursor links, „x" → „axb"; Enter
    for (const k of ['a', 'b', '[D', 'x']) { t.tippe(k); await warte(25); }
    await warte(60);
    expect(t.ausgabe()).toContain('Du: ax');
    t.tippe('\r'); await warte(80);
    expect(eingaben).toEqual(['axb']);
    // ↑ holt „axb" zurück, Esc leert
    t.tippe('[A'); await warte(60);
    expect(t.ausgabe().split('Du: axb').length).toBeGreaterThan(1);
    t.tippe(''); await warte(40);
    // Einfügen (bracketed paste) und Alt+Enter → mehrzeilig
    t.tippe('[200~eins zwei[201~'); await warte(60);
    t.tippe('\r'); await warte(40); t.tippe('drei'); await warte(40); t.tippe('\r'); await warte(80);
    expect(eingaben[1]).toBe('eins zwei\ndrei');
    // Bestätigungsfeld + Markdown
    ui.status({ offen: 2, offenListe: [{ id: 'a', text: 'Erste Frage', seit: new Date(Date.now() - 120_000).toISOString() }, { id: 'b', text: 'Zweite Frage', quelle: 'geraet', seit: new Date().toISOString() }] });
    ui.drucke('Alfred: Das ist **wichtig** und `code`\n- Punkt eins\n## Titel');
    await warte(120);
    const r = t.ausgabe();
    expect(r).toContain('Offene Bestätigungen (2)');
    expect(r).toContain('[1] Erste Frage');
    expect(r).toContain('vor 2 min');
    expect(r).toContain('[2] (Gerät) Zweite Frage');
    expect(r).toContain('Das ist wichtig und code');
    expect(r).toContain('• Punkt eins');
    expect(r).not.toContain('**wichtig**');
    ui.schliessen();
  });

  it('markdownZeile, eingabeTaste, alterText — rein', () => {
    expect(markdownZeile('a **b** `c` d')).toEqual({ art: 'text', stuecke: [{ text: 'a ' }, { text: 'b', fett: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' d' }] });
    expect(markdownZeile('1. eins').art).toBe('punkt');
    expect(markdownZeile('### Kopf')).toEqual({ art: 'ueberschrift', stuecke: [{ text: 'Kopf', fett: true }] });
    let e = { text: 'hallo welt', cursor: 10 };
    e = eingabeTaste(e, '', { ctrl: true }); // nichts
    e = eingabeTaste(e, 'w', { ctrl: true }); expect(e).toEqual({ text: 'hallo ', cursor: 6 });
    e = eingabeTaste(e, '', { home: true }); expect(e.cursor).toBe(0);
    e = eingabeTaste(e, 'X', {}); expect(e).toEqual({ text: 'Xhallo ', cursor: 1 });
    e = eingabeTaste(e, '', { backspace: true }); expect(e).toEqual({ text: 'hallo ', cursor: 0 });
    e = eingabeTaste(e, 'e', { ctrl: true }); expect(e.cursor).toBe(6);
    e = eingabeTaste(e, 'u', { ctrl: true }); expect(e).toEqual({ text: '', cursor: 0 });
    expect(alterText(new Date(Date.now() - 5000).toISOString())).toBe('vor 5 s');
    expect(alterText(new Date(Date.now() - 7200_000).toISOString())).toBe('vor 2 h');
    expect(alterText(undefined)).toBe('');
  });
});
