import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnhangAblage, verweiseAus } from '../anhang-ablage.js';

// v1347 — Owner 10.10. 23:40: Foto verschwand nach erneutem Öffnen des Hauptgesprächs (messages kannte nur Text).
describe('AnhangAblage', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anhaenge-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('legt ab und liest zurück (Name, Typ, Gespräch)', () => {
    const a = new AnhangAblage(dir);
    const v = a.lege([{ fileName: 'foto-macbook.jpg', mimeType: 'image/jpeg', data: Buffer.from([1, 2, 3]) }], 'telegram:5060785419');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ name: 'foto-macbook.jpg', mime: 'image/jpeg', groesse: 3 });
    const l = a.lies(v[0].id)!;
    expect([...l.daten]).toEqual([1, 2, 3]);
    expect(l.gespraech).toBe('telegram:5060785419');
    expect(a.vorhanden(v[0].id)).toBe(true);
  });

  it('ungültige Kennungen (Pfad-Tricks) liefern nichts', () => {
    const a = new AnhangAblage(dir);
    expect(a.lies('../../etc/passwd')).toBeUndefined();
    expect(a.vorhanden('..')).toBe(false);
  });

  it('Dateiname wird auf den Basisnamen gekürzt, leere Anhänge übersprungen', () => {
    const a = new AnhangAblage(dir);
    const v = a.lege([{ fileName: '../../x.png', mimeType: 'image/png', data: Buffer.from([9]) }, { fileName: 'leer.txt', mimeType: 'text/plain', data: Buffer.alloc(0) }], 'api:sitzung:g1');
    expect(v.map(x => x.name)).toEqual(['x.png']);
  });

  it('aufraeumen entfernt nur Anhänge älter als die Frist', () => {
    const a = new AnhangAblage(dir);
    const [alt] = a.lege([{ fileName: 'alt.jpg', mimeType: 'image/jpeg', data: Buffer.from([1]) }], 'x');
    const [neu] = a.lege([{ fileName: 'neu.jpg', mimeType: 'image/jpeg', data: Buffer.from([2]) }], 'x');
    const jetzt = Date.parse('2026-11-20T12:00:00Z');
    fs.utimesSync(path.join(dir, alt.id), new Date(jetzt - 31 * 86_400_000), new Date(jetzt - 31 * 86_400_000));
    fs.utimesSync(path.join(dir, neu.id), new Date(jetzt - 29 * 86_400_000), new Date(jetzt - 29 * 86_400_000));
    expect(a.aufraeumen(30, jetzt)).toBe(1);
    expect(a.vorhanden(alt.id)).toBe(false);
    expect(fs.existsSync(path.join(dir, `${alt.id}.json`))).toBe(false);
    expect(a.vorhanden(neu.id)).toBe(true);
  });

  it('verweiseAus: JSON der Spalte, fehlerhafte Einträge fallen weg', () => {
    expect(verweiseAus(undefined)).toEqual([]);
    expect(verweiseAus('kaputt')).toEqual([]);
    const id = 'a'.repeat(32);
    expect(verweiseAus(JSON.stringify([{ id, name: 'f.jpg', mime: 'image/jpeg', groesse: 1 }, { id: '../x' }]))).toHaveLength(1);
  });
});
