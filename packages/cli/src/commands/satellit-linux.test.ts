import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { linuxTaste, parseLeerlauf, linuxSitzungsUmgebung, LINUX_ZIELE } from './satellit-bedienen-linux.js';
import { xdgBenutzerVerzeichnisse, linuxStandardVerzeichnisse, repariereStandardFreigaben } from './satellit-verzeichnisse.js';

describe('linuxTaste (v1339, ydotool-Tastennamen)', () => {
  it('strg+s → ctrl+s, alt+f4, shift+tab, win+e → super+e', () => {
    expect(linuxTaste('strg+s')).toEqual({ art: 'taste', keys: 'ctrl+s' });
    expect(linuxTaste('Alt+F4')).toEqual({ art: 'taste', keys: 'alt+f4' });
    expect(linuxTaste('umschalt+tab')).toEqual({ art: 'taste', keys: 'shift+tab' });
    expect(linuxTaste('win+e')).toEqual({ art: 'taste', keys: 'super+e' });
    expect(linuxTaste('strg+alt+t')).toEqual({ art: 'taste', keys: 'ctrl+alt+t' });
    expect(linuxTaste('enter')).toEqual({ art: 'taste', keys: 'enter' });
    expect(linuxTaste('Bild ab')).toEqual({ art: 'taste', keys: 'pagedown' });
  });
  it('Zeichen gehen über die Zwischenablage (Layout egal): *, +, /, „mal", „gleich"', () => {
    expect(linuxTaste('*')).toEqual({ art: 'text', text: '*' });
    expect(linuxTaste('plus')).toEqual({ art: 'text', text: '+' });
    expect(() => linuxTaste('strg++')).toThrow(/Unbekannte Taste/); // Zeichen mit Modifikator: layoutabhängig, nicht über uinput
  });
  it('lehnt zwei Tasten und unbekannte Namen ab', () => {
    expect(() => linuxTaste('a+b')).toThrow(/Nur eine Taste/);
    expect(() => linuxTaste('strg')).toThrow(/Taste fehlt/);
    expect(() => linuxTaste('kaffee')).toThrow(/Unbekannte Taste/);
  });
});

describe('Leerlauf und Sitzungsumgebung (v1339)', () => {
  it('parst „t 129011" zu 129011 ms, sonst NaN', () => {
    expect(parseLeerlauf('t 129011\n')).toBe(129011);
    expect(Number.isNaN(parseLeerlauf('Call failed: Access denied'))).toBe(true);
  });
  it('ergänzt D-Bus, Wayland und XDG_RUNTIME_DIR nur, wenn sie fehlen', () => {
    const e = linuxSitzungsUmgebung({ PATH: '/usr/bin' }, 1000);
    expect(e.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
    expect(e.WAYLAND_DISPLAY).toBe('wayland-0');
    expect(e.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    const f = linuxSitzungsUmgebung({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/7' }, 1000);
    expect(f.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/x');
    expect(f.WAYLAND_DISPLAY).toBe('wayland-1');
    expect(f.XDG_RUNTIME_DIR).toBe('/run/user/7');
  });
  it('die festen Ziele haben Nummern 1 und 2 (Fenster, Terminal)', () => {
    expect(LINUX_ZIELE.map(z => z.nr)).toEqual([1, 2]);
    expect(LINUX_ZIELE[1].id).toBe('terminal');
  });
});

describe('XDG-Benutzerverzeichnisse und Freigabe-Reparatur (v1339)', () => {
  const inhalt = [
    '# Dies ist eine Konfiguration',
    'XDG_DESKTOP_DIR="$HOME/Schreibtisch"',
    'XDG_DOWNLOAD_DIR="$HOME/Downloads"',
    'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
    'XDG_MUSIC_DIR="$HOME"',
    '',
  ].join('\n');
  it('liest die Ordner aus user-dirs.dirs, $HOME allein zählt nicht', () => {
    const x = xdgBenutzerVerzeichnisse('/home/madh', inhalt);
    expect(x).toEqual({ DESKTOP: '/home/madh/Schreibtisch', DOWNLOAD: '/home/madh/Downloads', DOCUMENTS: '/home/madh/Dokumente' });
  });
  it('ohne Datei bleiben die englischen Namen', () => {
    const s = linuxStandardVerzeichnisse('/nicht/vorhanden/home');
    expect(s.map(p => p.replace(/\\/g, '/'))).toEqual(['/nicht/vorhanden/home/Documents', '/nicht/vorhanden/home/Downloads', '/nicht/vorhanden/home/Desktop']);
  });
  it('ersetzt fehlende Standardeinträge durch existierende XDG-Ordner, lässt eigene Freigaben in Ruhe', () => {
    const home = '/home/madh';
    const j = (p: string) => p.replace(/\\/g, '/');
    const frei = [`${home}/Documents`, `${home}/Downloads`, `${home}/Desktop`, '/srv/projekt'].map(p => p.split('/').join(path.sep));
    const xdg = [`${home}/Dokumente`, `${home}/Downloads`, `${home}/Schreibtisch`].map(p => p.split('/').join(path.sep));
    const existiert = (p: string) => /Dokumente|Downloads|Schreibtisch|projekt/.test(j(p));
    const ersetzt = repariereStandardFreigaben(frei, home, xdg, existiert);
    expect(ersetzt.map(e => j(e.neu))).toEqual([`${home}/Dokumente`, `${home}/Schreibtisch`]);
    expect(frei.map(j)).toEqual([`${home}/Dokumente`, `${home}/Downloads`, `${home}/Schreibtisch`, '/srv/projekt']);
    // zweiter Lauf: nichts mehr zu tun
    expect(repariereStandardFreigaben(frei, home, xdg, existiert)).toEqual([]);
  });
  it('tut nichts, wenn der englische Ordner existiert oder der XDG-Ordner fehlt', () => {
    const home = '/home/x';
    const frei = [`${home}/Documents`];
    expect(repariereStandardFreigaben(frei, home, [`${home}/Dokumente`, `${home}/Downloads`, `${home}/Desktop`], () => true)).toEqual([]);
    expect(repariereStandardFreigaben(frei, home, [`${home}/Dokumente`, `${home}/Downloads`, `${home}/Desktop`], () => false)).toEqual([]);
    expect(frei).toEqual([`${home}/Documents`]);
  });
});
