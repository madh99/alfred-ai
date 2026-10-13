import { describe, it, expect } from 'vitest';
import { regelPruefen, geraetNutzlast, trefferText, aufgabeText, waechterBefunde, type RegelLike } from '../regeln.js';

const GERAETE = [{ id: 'g1', name: 'PC-madh' }, { id: 'g2', name: 'Ubuntu-VM' }];

describe('v1429 R4a Beobachter-Regeln', () => {
  it('prüft Eingaben: Gerät, Pfad, Ereignisse, Wirkung, Auftrag, Projekt', () => {
    const r = regelPruefen({ geraet: 'pc-madh', pfad: 'C:\\Users\\madh\\Downloads', muster: '*.pdf', ereignisse: 'neu, geändert', wirkung: 'vorgang', name: 'Rechnungen' }, GERAETE);
    expect(r).toMatchObject({ ok: true, regel: { geraetId: 'g1', name: 'Rechnungen', filter: { pfad: 'C:\\Users\\madh\\Downloads', muster: '*.pdf', ereignisse: ['neu', 'geaendert'] }, wirkung: 'vorgang', aktiv: true } });
    expect(regelPruefen({ geraet: 'x', pfad: '/a' }, GERAETE)).toMatchObject({ ok: false });
    expect(regelPruefen({ geraet: 'g2', pfad: 'relativ' }, GERAETE)).toMatchObject({ ok: false });
    expect(regelPruefen({ geraet: 'g2', pfad: '/a', wirkung: 'aufgabe' }, GERAETE)).toMatchObject({ ok: false });
    expect(regelPruefen({ geraet: 'g2', pfad: '/a', wirkung: 'projekt', auftrag: 'x', projekt: 'fehlt' }, GERAETE, [{ id: 'p1', name: 'Game' }])).toMatchObject({ ok: false });
    expect(regelPruefen({ geraet: 'g2', pfad: '/a', wirkung: 'projekt', auftrag: 'neu bauen', projekt: 'game' }, GERAETE, [{ id: 'p1', name: 'Game' }])).toMatchObject({ ok: true, regel: { projektId: 'p1' } });
    expect(regelPruefen({ geraet: 'g2', quelle: 'outlook', pfad: '/a' }, GERAETE)).toMatchObject({ ok: false });
    expect((regelPruefen({ geraet: 'g2', pfad: '/home/madh/Downloads' }, GERAETE) as { regel: { name: string } }).regel.name).toBe('Dateien in Downloads');
  });

  const regel: RegelLike = { id: 'r1', geraetId: 'g1', geraet: 'PC-madh', name: 'Rechnungen', quelle: 'ordner', filter: { pfad: 'C:\\Users\\madh\\Downloads', muster: '*.pdf', ereignisse: ['neu'] }, wirkung: 'hinweis', aktiv: true };

  it('Nutzlast nur aktive Regeln', () => {
    expect(geraetNutzlast([regel, { ...regel, id: 'r2', aktiv: false }])).toEqual([{ id: 'r1', quelle: 'ordner', pfad: 'C:\\Users\\madh\\Downloads', muster: '*.pdf', ereignisse: ['neu'] }]);
  });

  it('Texte nur mit Kopfdaten', () => {
    const t = { regel: 'r1', quelle: 'ordner', art: 'neu', schluessel: 'k', zeit: '', kopf: { name: 'rechnung.pdf', relativ: 'rechnung.pdf', groesse: 245663 } };
    expect(trefferText(regel, t)).toBe('Neue Datei auf PC-madh: rechnung.pdf (240 KB) in C:\\Users\\madh\\Downloads — Regel „Rechnungen"');
    expect(aufgabeText(regel, t, 'geraet_pc_madh')).toContain('C:\\Users\\madh\\Downloads/rechnung.pdf');
    expect(trefferText(regel, { ...t, art: 'sammel', kopf: { anzahl: 12 } })).toContain('12 weitere');
  });

  it('Wächter: gestört, fehlt, Satellit zu alt — offline und veraltete Sinne nicht', () => {
    const jetzt = Date.parse('2026-10-13T20:00:00Z');
    const frisch = '2026-10-13T19:59:00Z';
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: frisch, beobachter: [{ regel: 'r1', zustand: 'gestoert', grund: 'Ordner fehlt' }] }], jetzt)[0]!.titel).toContain('gestört: Ordner fehlt');
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: frisch, beobachter: [] }], jetzt)[0]!.titel).toContain('läuft nicht');
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: frisch }], jetzt)[0]!.titel).toContain('Update nötig');
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: false }], jetzt)).toEqual([]);
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: '2026-10-13T19:00:00Z', beobachter: [] }], jetzt)).toEqual([]);
    expect(waechterBefunde([regel], [{ id: 'g1', name: 'PC-madh', online: true, sinneZeit: frisch, beobachter: [{ regel: 'r1', zustand: 'laeuft' }] }], jetzt)).toEqual([]);
  });
});
