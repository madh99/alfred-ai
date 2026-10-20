import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { einstellungen, wendeAn, trenneBefehl, einstellungenText, aktiveAblageOrdner } from './satellit-einstellungen.js';
import { mkdtempSync } from 'node:fs';
import type { GeraetKonfig } from './pair.js';

const konfig = (): GeraetKonfig => ({ server: 'https://s:3420', geraetId: 'abcdef12-3456', token: 't', name: 'PC', freigegebeneVerzeichnisse: [os.tmpdir()], erlaubteProgramme: [] });

describe('Satelliten-Einstellungen (v1309)', () => {
  it('listet die Felder mit Werten', () => {
    const l = einstellungen(konfig(), { version: '1309', dienst: 'läuft' });
    expect(l.map(e => e.schluessel)).toEqual(['geraet', 'server', 'freigabe', 'fenster-sperre', 'foto-sperre', 'wort', 'sinne-fenster', 'oberflaeche', 'vertrauen', 'ablage', 'beobachter', 'sudo-sperre']); // v1409 sudo-sperre, v1411 vertrauen, v1429 beobachter, v1529 ablage
    expect(l[2]!.eintraege).toEqual([`${os.tmpdir()} (schreiben)`]);
    expect(l[5]!.wert).toBe('Alfred');
    expect(l[7]!.wert).toBe('ink');
    expect(einstellungenText(l)).toContain('Freigaben: 1 Verzeichnisse');
  });

  it('freigabe: lesen/schreiben/keins, nur vorhandene Verzeichnisse, keine Doppel', () => {
    const k = konfig();
    const d = path.join(os.tmpdir());
    expect(wendeAn(k, 'freigabe', `${d} lesen`).ok).toBe(true);
    expect(k.freigegebeneVerzeichnisse).toEqual([]);
    expect(k.nurLesen).toEqual([path.resolve(d)]);
    expect(wendeAn(k, 'freigabe', `${d} schreiben`).ok).toBe(true);
    expect(k.nurLesen).toEqual([]);
    expect(k.freigegebeneVerzeichnisse).toEqual([path.resolve(d)]);
    expect(wendeAn(k, 'freigabe', `${d} keins`).text).toContain('entfernt');
    expect(k.freigegebeneVerzeichnisse).toEqual([]);
    expect(wendeAn(k, 'freigabe', path.join(d, 'gibt-es-nicht-' + Date.now()) + ' lesen').ok).toBe(false);
    expect(wendeAn(k, 'freigabe', 'x').ok).toBe(false);
  });

  it('fenster-sperre / foto-sperre: + und -, leer = Standard bzw. keine', () => {
    const k = konfig();
    expect(wendeAn(k, 'fenster-sperre', '+ Steuer').text).toBe('Gesperrte Fenster: Steuer');
    expect(wendeAn(k, 'fenster-sperre', '+ steuer').text).toBe('Gesperrte Fenster: Steuer'); // kein Doppel
    expect(wendeAn(k, 'fenster-sperre', '- Steuer').text).toBe('Gesperrte Fenster: Standardliste');
    expect(k.gesperrteFenster).toBeUndefined();
    expect(wendeAn(k, 'foto-sperre', '+ Passwort').ok).toBe(true);
    expect(k.fotoSperre).toEqual(['Passwort']);
    expect(wendeAn(k, 'foto-sperre', 'Passwort').ok).toBe(false);
  });

  it('wort, sinne-fenster, oberflaeche, unbekannt', () => {
    const k = konfig();
    expect(wendeAn(k, 'wort', 'Jarvis').ok).toBe(true); expect(k.aktivierungswort).toBe('Jarvis');
    expect(wendeAn(k, 'wort', 'zwei wörter').ok).toBe(false);
    expect(wendeAn(k, 'sinne-fenster', 'aus').ok).toBe(true); expect(k.sinneOhneFenster).toBe(true);
    expect(wendeAn(k, 'oberflaeche', 'einfach').ok).toBe(true); expect(k.sitzungEinfach).toBe(true);
    expect(wendeAn(k, 'oberflaeche', 'ink').ok).toBe(true); expect(k.sitzungEinfach).toBe(false);
    expect(wendeAn(k, 'quatsch', '').text).toContain('Unbekannt: quatsch');
    expect(trenneBefehl('freigabe C:\\x y schreiben')).toEqual({ befehl: 'freigabe', arg: 'C:\\x y schreiben' });
    expect(trenneBefehl('wort')).toEqual({ befehl: 'wort', arg: '' });
  });
});

describe('v1429 Beobachter-Veto', () => {
  it('beobachter an|aus setzt das lokale Veto', async () => {
    const { wendeAn } = await import('./satellit-einstellungen.js');
    const k = { beobachterAus: undefined } as unknown as Parameters<typeof wendeAn>[0];
    expect(wendeAn(k, 'beobachter', 'aus').ok).toBe(true);
    expect((k as { beobachterAus?: boolean }).beobachterAus).toBe(true);
    expect(wendeAn(k, 'beobachter', 'an').ok).toBe(true);
    expect((k as { beobachterAus?: boolean }).beobachterAus).toBe(false);
    expect(wendeAn(k, 'beobachter', 'vielleicht').ok).toBe(false);
  });

  it('v1529 ablage: Standard Downloads, hinzufügen nur mit Schreibrecht, entfernen; Sinne nur vorhandene Ordner', () => {
    const k = konfig();
    expect(einstellungen(k, { version: '1529', dienst: '' }).find(e => e.schluessel === 'ablage')!.wert).toBe('Standard (Downloads)');
    const d = mkdtempSync(path.join(os.tmpdir(), 'ablage-'));
    expect(wendeAn(k, 'ablage', `+ ${d}`).ok).toBe(true);
    expect(k.ablageOrdner).toContain(path.resolve(d));
    expect(k.ablageOrdner).toContain(path.resolve(path.join(os.homedir(), 'Downloads'))); // zusätzlich, Standard bleibt
    expect(aktiveAblageOrdner(k)).toContain(path.resolve(d)); // in tmpdir = Schreibfreigabe
    expect(wendeAn(k, 'ablage', `- ${path.join(os.homedir(), 'Downloads')}`).ok).toBe(true);
    expect(k.ablageOrdner).toEqual([path.resolve(d)]); // „andere“ statt Standard
    const ohne = { ...konfig(), freigegebeneVerzeichnisse: [] };
    expect(wendeAn(ohne, 'ablage', `+ ${d}`).ok).toBe(false); // kein Schreibrecht
    expect(wendeAn(k, 'ablage', 'quatsch').ok).toBe(false);
  });
});
