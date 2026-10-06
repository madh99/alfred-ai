import { describe, it, expect } from 'vitest';
import { erzeugePairingCode, erzeugeToken, hashToken, geraetSkillName, pruefeManifest, istPfadErlaubt, paramsKurz } from '../geraete/protokoll.js';

// v1224 — Geräte-Protokoll: reine Helfer (Spec docs/specs/2026-10-06-geraete-architektur.md).
describe('Pairing und Token', () => {
  it('Code hat 8 Ziffern, Token 64 Hex-Zeichen, Hash ist deterministisch und nicht das Token', () => {
    expect(erzeugePairingCode()).toMatch(/^\d{8}$/);
    const t = erzeugeToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
  it('Skill-Name aus Gerätenamen', () => {
    expect(geraetSkillName('Mein PC')).toBe('geraet_mein_pc');
    expect(geraetSkillName('MacBook Pro — Büro')).toBe('geraet_macbook_pro_buero');
    expect(geraetSkillName('!!!')).toBe('geraet_geraet');
  });
});

describe('pruefeManifest', () => {
  const gut = { protokoll: 1, plattform: 'windows', hostname: 'pc', satellitVersion: '1', aktionen: [{ name: 'oeffnen', beschreibung: 'öffnet', autonomie: 'bestaetigen' }, { name: 'liste', beschreibung: 'listet', autonomie: 'auto' }], sinne: ['leerlauf'] };
  it('akzeptiert ein gültiges Manifest und normalisiert', () => {
    const r = pruefeManifest(gut);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.manifest.aktionen).toHaveLength(2); expect(r.manifest.sinne).toEqual(['leerlauf']); }
  });
  it('lehnt falsche Version, Plattform, Aktionsnamen, doppelte Aktionen und Autonomie ab', () => {
    expect(pruefeManifest({ ...gut, protokoll: 2 })).toMatchObject({ ok: false });
    expect(pruefeManifest({ ...gut, plattform: 'amiga' })).toMatchObject({ ok: false });
    expect(pruefeManifest({ ...gut, aktionen: [{ name: 'Öffnen!', beschreibung: 'x', autonomie: 'auto' }] })).toMatchObject({ ok: false });
    expect(pruefeManifest({ ...gut, aktionen: [gut.aktionen[0], gut.aktionen[0]] })).toMatchObject({ ok: false });
    expect(pruefeManifest({ ...gut, aktionen: [{ name: 'shell', beschreibung: 'x', autonomie: 'immer' }] })).toMatchObject({ ok: false });
    expect(pruefeManifest(null)).toMatchObject({ ok: false });
  });
});

describe('istPfadErlaubt', () => {
  it('Windows: innerhalb ja, Traversal und fremde Laufwerke nein, Groß-/Kleinschreibung egal', () => {
    const frei = ['C:\\Users\\madh\\Documents', 'D:\\Projekte'];
    expect(istPfadErlaubt('C:\\Users\\madh\\Documents\\Rechnungen', frei, 'win32')).toBe(true);
    expect(istPfadErlaubt('c:\\users\\madh\\documents', frei, 'win32')).toBe(true);
    expect(istPfadErlaubt('C:\\Users\\madh\\Documents\\..\\Desktop\\geheim.txt', frei, 'win32')).toBe(false);
    expect(istPfadErlaubt('C:\\Users\\madh\\DocumentsX\\a', frei, 'win32')).toBe(false);
    expect(istPfadErlaubt('E:\\x', frei, 'win32')).toBe(false);
    expect(istPfadErlaubt('', frei, 'win32')).toBe(false);
    expect(istPfadErlaubt('C:\\Users\\madh\\Documents', [], 'win32')).toBe(false);
  });
});

describe('paramsKurz', () => {
  it('lässt action und confirmed weg, kürzt lange Werte', () => {
    expect(paramsKurz({ action: 'oeffnen', confirmed: true, path: 'C:\\x' })).toBe('path=C:\\x');
    expect(paramsKurz({ command: 'x'.repeat(100) }).length).toBeLessThan(100);
  });
});
