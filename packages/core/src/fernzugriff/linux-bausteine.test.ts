import { describe, it, expect } from 'vitest';
import { registriereLinuxBaustein, linuxBausteinSkript, linuxBausteinBekannt } from './linux-bausteine.js';

// I8e — Register der Linux-Bausteine: nur registrierte Erzeuger, jeder Schlüssel einmal, nach erster Verwendung eingefroren
registriereLinuxBaustein<{ db: string }>('probe.anlegen', p => { if (!/^\w+$/.test(p.db)) throw new Error('ungültiger Name'); return `echo anlegen ${p.db}\n`; });

describe('Linux-Baustein-Register', () => {
  it('doppelte Registrierung und ungültige Schlüssel werden abgewiesen', () => {
    expect(() => registriereLinuxBaustein('probe.anlegen', () => 'echo x')).toThrow(/schon registriert/);
    expect(() => registriereLinuxBaustein('Probe Anlegen', () => 'echo x')).toThrow(/ungültiger Schlüssel/);
    expect(linuxBausteinBekannt('probe.anlegen')).toBe(true);
  });
  it('Skripttext stammt nur aus dem Erzeuger; unbekannte Schlüssel und Parameterfehler → Fehler', () => {
    expect(linuxBausteinSkript('probe.anlegen', { db: 'kunden' })).toBe('echo anlegen kunden\n');
    expect(() => linuxBausteinSkript('probe.fremd', {})).toThrow(/Unbekannter Linux-Baustein/);
    expect(() => linuxBausteinSkript('probe.anlegen', { db: 'x; rm -rf /' })).toThrow(/ungültiger Name/);
  });
  it('nach der ersten Verwendung ist das Register eingefroren', () => {
    expect(() => registriereLinuxBaustein('probe.spaet', () => 'echo spaet')).toThrow(/eingefroren/);
    expect(linuxBausteinBekannt('probe.spaet')).toBe(false);
  });
});
