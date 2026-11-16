import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { pruefeSchema, abdruck } from './schema.js';
import { kanonisch } from '../dokumente/beweis.js';
import { testVorlage } from './testvorlage.fixture.js';

type Roh = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fehlerVon = (aendern: (r: Roh) => void): string => { const r = testVorlage() as Roh; aendern(r); return pruefeSchema(r).fehler.join('\n'); };

describe('pruefeSchema', () => {
  it('gültige Vorlage', () => {
    const r = pruefeSchema(testVorlage());
    expect(r.fehler).toEqual([]);
    expect(r.vorlage?.key).toBe('test_lab');
    expect(r.vorlage?.changes).toHaveLength(2);
  });
  it('kein Objekt', () => {
    expect(pruefeSchema(null).fehler.length).toBeGreaterThan(0);
    expect(pruefeSchema([]).fehler.length).toBeGreaterThan(0);
    expect(pruefeSchema('x').vorlage).toBeUndefined();
  });
  it('Kopfdaten', () => {
    expect(fehlerVon(r => { r.schema = 2; })).toMatch(/schema/);
    expect(fehlerVon(r => { r.key = 'Ab'; })).toMatch(/key/);
    expect(fehlerVon(r => { r.key = 'ab'; })).toMatch(/key/);
    expect(fehlerVon(r => { r.titel = ''; })).toMatch(/titel/);
    expect(fehlerVon(r => { delete r.zweck; })).toMatch(/zweck/);
    expect(fehlerVon(r => { r.dokumentart = 'roman'; })).toMatch(/dokumentart/);
    expect(fehlerVon(r => { r.abbauVorlage = 'X y'; })).toMatch(/abbauVorlage/);
    expect(fehlerVon(r => { r.version = 3; })).toMatch(/unbekannt.*version/i);
  });
  it('Größe', () => {
    expect(fehlerVon(r => { r.zweck = 'x'.repeat(500_001); })).toMatch(/500000|500 000/);
  });
  it('Parameter', () => {
    expect(fehlerVon(r => { r.parameter[0].name = 'Vlan'; })).toMatch(/name/);
    expect(fehlerVon(r => { r.parameter[1].name = 'vlan'; })).toMatch(/doppelt/);
    // Final-Welle M3 — Parameter mit Geheimnis-Namen (Wert käme sonst als Klartext in die Eingabe) abgewiesen
    for (const n of ['passwort', 'admin_password', 'api_token', 'secret', 'pwd', 'kennwort']) expect(fehlerVon(r => { r.parameter[0].name = n; }), n).toMatch(/Geheimnis/);
    expect(fehlerVon(r => { r.parameter[0].name = 'vlan_pfad'; })).not.toMatch(/Geheimnis/);
    expect(fehlerVon(r => { r.parameter[0].typ = 'datum'; })).toMatch(/typ/);
    expect(fehlerVon(r => { r.parameter[0].pflicht = 'ja'; })).toMatch(/pflicht/);
    expect(fehlerVon(r => { r.parameter[0].grenzen = { regex: '(' }; })).toMatch(/regex/);
    expect(fehlerVon(r => { r.parameter[0].grenzen = { min: 'a' }; })).toMatch(/min/);
    expect(fehlerVon(r => { r.parameter[0].foo = 1; })).toMatch(/unbekannt.*foo/i);
    expect(fehlerVon(r => { r.parameter = Array.from({ length: 41 }, (_, i) => ({ name: `p${i}`, typ: 'zahl', pflicht: false, beschreibung: 'x' })); })).toMatch(/40/);
  });
  it('Ableitungen', () => {
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'erste_adresse', von: 'fehlt' }; })).toMatch(/von/);
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'erste_adresse', von: 'vlan' }; })).toMatch(/cidr/);
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'summe', von: 'netz' }; })).toMatch(/funktion/);
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'adresse', von: 'netz' }; })).toMatch(/n/);
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'praefix', von: 'netz' }; })).toMatch(/zahl/);
    expect(fehlerVon(r => { r.parameter[2].ableitung = { funktion: 'adresse', von: 'netz', n: 10 }; })).toBe('');
  });
  it('Annahmen', () => {
    expect(fehlerVon(r => { r.annahmen[0].pruefung = { typ: 'raten' }; })).toMatch(/pruefung/);
    expect(fehlerVon(r => { r.annahmen.push({ ...r.annahmen[0] }); })).toMatch(/doppelt/);
    expect(fehlerVon(r => { r.annahmen = Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, text: 't', pruefung: { typ: 'ping', ziel: '1.1.1.1' } })); })).toMatch(/20/);
  });
  it('Changes', () => {
    expect(fehlerVon(r => { r.changes = []; })).toMatch(/changes/);
    expect(fehlerVon(r => { r.changes[0].typ = 'standard'; })).toMatch(/typ/);
    expect(fehlerVon(r => { r.changes[0].risiko = 'egal'; })).toMatch(/risiko/);
    expect(fehlerVon(r => { r.changes[1].schluessel = 'aufbau'; })).toMatch(/doppelt/);
    expect(fehlerVon(r => { r.changes[1].abhaengigVon = ['gibtsnicht']; })).toMatch(/gibtsnicht/);
    expect(fehlerVon(r => { r.changes[0].abhaengigVon = ['abbau']; })).toMatch(/Kreis/);
    expect(fehlerVon(r => { r.changes[0].schritte = []; })).toMatch(/schritte/);
    expect(fehlerVon(r => { r.changes[0].schritte[0].kapitel = 3; })).toMatch(/kapitel/);
    expect(fehlerVon(r => { r.changes[0].ausfallMinuten = -1; })).toMatch(/ausfallMinuten/);
    expect(fehlerVon(r => { r.changes = Array.from({ length: 31 }, (_, i) => ({ ...r.changes[0], schluessel: `c${i}` })); })).toMatch(/30/);
  });
});

describe('abdruck', () => {
  it('sha256 über die kanonische Form, stabil bei Schlüsselreihenfolge', () => {
    const v = pruefeSchema(testVorlage()).vorlage!;
    const umgedreht = Object.fromEntries(Object.entries(v).reverse()) as typeof v;
    expect(abdruck(umgedreht)).toBe(abdruck(v));
    expect(abdruck(v)).toBe(createHash('sha256').update(kanonisch(v), 'utf8').digest('hex'));
    expect(abdruck({ ...v, titel: 'anders' })).not.toBe(abdruck(v));
  });
});

describe('Fix-Runde 1 — Schema', () => {
  it('I3: gefährliche Regex beim Speichern abgewiesen', () => {
    for (const rx of ['^(a+)+$', '(a*)*', '(x{2,})+', '^(a|aa)+$', '(a)\\1', '(?=a)a', '(?<!b)a', '(?<n>a)\\k<n>', 'a'.repeat(201)])
      expect(fehlerVon(r => { r.parameter[4].grenzen = { regex: rx }; }), rx).toMatch(/regex/);
    for (const rx of ['^lab[0-9]+$', '^(srv|cli)[0-9]{2}$', '^(?:ab)+$', '^[a-z+*]+$', '^\\(a+\\)+$'])
      expect(fehlerVon(r => { r.parameter[4].grenzen = { regex: rx }; }), rx).toBe('');
  });
  it('I3: laenge höchstens 200', () => {
    expect(fehlerVon(r => { r.parameter[4].grenzen = { laenge: 201 }; })).toMatch(/laenge/);
  });
  it('Schlüssel „annahmen“ ist reserviert', () => {
    expect(fehlerVon(r => { r.changes[1].schluessel = 'annahmen'; r.changes[1].abhaengigVon = ['aufbau']; })).toMatch(/reserviert/);
  });
});

describe('Task 6 — zweck stilllegung je Change', () => {
  it('zweck „stilllegung“ wird angenommen, jeder andere Wert abgewiesen', () => {
    expect(fehlerVon(r => { r.changes[1].zweck = 'stilllegung'; })).toBe('');
    for (const z of ['migration', '', 'Stilllegung', 1, true])
      expect(fehlerVon(r => { r.changes[1].zweck = z; }), String(z)).toMatch(/zweck/);
  });
});
