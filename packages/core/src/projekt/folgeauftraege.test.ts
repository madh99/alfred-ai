import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolgeAuftraege, pfadSchluessel } from './folgeauftraege.js';

describe('v1512 Folgeaufträge', () => {
  const basis = { geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/home/madh/claudecode/finanz-backend', befehle: [], input: {} };

  it('Schlüssel: gleiches Verzeichnis trotz Schrägstrich am Ende; Windows ohne Groß/Klein; anderes Gerät = andere Reihe', () => {
    expect(pfadSchluessel('g1', '/a/b/')).toBe(pfadSchluessel('g1', '/a/b'));
    expect(pfadSchluessel('g1', 'C:\\Dev\\X')).toBe(pfadSchluessel('g1', 'c:\\dev\\x\\'));
    expect(pfadSchluessel('g1', '/a/b')).not.toBe(pfadSchluessel('g2', '/a/b'));
    expect(pfadSchluessel('g1', '/a/B')).not.toBe(pfadSchluessel('g1', '/a/b')); // Linux unterscheidet
  });

  it('einreihen, Reihenfolge, verschieben, entfernen, nächster; verschiedene Verzeichnisse getrennt', () => {
    const f = new FolgeAuftraege();
    const a = f.einreihen({ ...basis, ziel: 'A' });
    const b = f.einreihen({ ...basis, projekt: basis.projekt + '/', ziel: 'B' });
    f.einreihen({ ...basis, projekt: '/home/madh/claudecode/game', ziel: 'anderes Projekt' });
    expect([a.position, b.position]).toEqual([1, 2]);
    expect(f.reihe('g1', basis.projekt).map(x => x.ziel)).toEqual(['A', 'B']);
    expect(f.verschiebe(b.eintrag.id, -1)).toBe(true);
    expect(f.verschiebe(b.eintrag.id, -1)).toBe(false);
    expect(f.reihe('g1', basis.projekt).map(x => x.ziel)).toEqual(['B', 'A']);
    expect(f.verzeichnisse()).toHaveLength(2);
    expect(f.naechster('g1', basis.projekt)?.ziel).toBe('B');
    expect(f.entferne(a.eintrag.id)?.ziel).toBe('A');
    expect(f.reihe('g1', basis.projekt)).toEqual([]);
    expect(f.verzeichnisse()).toHaveLength(1);
  });

  it('übersteht Neustart (Datei) und „vorne“ setzt zurück an die Spitze', () => {
    const datei = join(mkdtempSync(join(tmpdir(), 'folge-')), 'f.json');
    const f = new FolgeAuftraege(datei);
    f.einreihen({ ...basis, ziel: 'A' }); f.einreihen({ ...basis, ziel: 'B' });
    const g = new FolgeAuftraege(datei);
    const n = g.naechster('g1', basis.projekt)!;
    g.vorne(n);
    expect(new FolgeAuftraege(datei).reihe('g1', basis.projekt).map(x => x.ziel)).toEqual(['A', 'B']);
  });
});
