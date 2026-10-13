import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { musterPasst, istTemporaer, Buendler, BeobachterVerwaltung, type Beobachtung } from './satellit-beobachter.js';

const warte = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('v1429 R4a — Beobachter am Satelliten', () => {
  it('Muster und temporäre Dateien', () => {
    expect(musterPasst('*.pdf, Rechnung*', 'Rechnung-Oktober.PDF')).toBe(true);
    expect(musterPasst('*.pdf', 'bild.png')).toBe(false);
    expect(musterPasst('', 'alles.txt')).toBe(true);
    expect(istTemporaer('~$bericht.docx')).toBe(true);
    expect(istTemporaer('film.mp4.crdownload')).toBe(true);
    expect(istTemporaer('rechnung.pdf')).toBe(false);
  });

  it('Bündeln und drosseln: Überlauf als Sammel-Ereignis', () => {
    const raus: Beobachtung[][] = [];
    const b = new Buendler((e) => raus.push(e), { maxProMinute: 3, jetzt: () => 1_000_000 });
    for (let i = 0; i < 5; i++) b.push({ regel: 'r1', quelle: 'ordner', art: 'neu', schluessel: `k${i}`, zeit: '', kopf: { name: `d${i}` } });
    b.leere(); b.stop();
    expect(raus).toHaveLength(1);
    expect(raus[0]!.filter(e => e.art === 'neu')).toHaveLength(3);
    expect(raus[0]!.find(e => e.art === 'sammel')?.kopf.anzahl).toBe(2);
  });

  it('neue Datei im freigegebenen Ordner wird gemeldet (stabil, mit Muster); Bestand und Fremdes nicht', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-beob-'));
    writeFileSync(path.join(dir, 'alt.pdf'), 'x');
    const raus: Beobachtung[] = [];
    const v = new BeobachterVerwaltung({ senden: (e) => raus.push(...e), erlaubt: (p) => p.startsWith(dir), veto: () => false, stabilMs: 120, intervallMs: 50 });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: dir, muster: '*.pdf', ereignisse: ['neu'] }]);
    expect(v.stand()[0]!.zustand).toBe('laeuft');
    await warte(100);
    writeFileSync(path.join(dir, 'rechnung.pdf'), 'inhalt');
    writeFileSync(path.join(dir, 'notiz.txt'), 'nicht gemeint');
    await warte(1200);
    v.stopAlle();
    expect(raus.map(r => r.kopf.name)).toEqual(['rechnung.pdf']);
    expect(raus[0]!.kopf).not.toHaveProperty('inhalt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('nicht freigegebener Ordner und lokales Veto', () => {
    const v = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => false, veto: () => false });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: '/geheim', ereignisse: ['neu'] }]);
    expect(v.stand()[0]).toMatchObject({ zustand: 'gestoert' });
    const aus = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => true });
    aus.setze([{ id: 'r2', quelle: 'ordner', pfad: os.tmpdir() }]);
    expect(aus.stand()[0]).toMatchObject({ zustand: 'aus', grund: 'am Gerät abgeschaltet' });
  });

  it('fehlender Ordner = gestört, nicht still', () => {
    const d = path.join(os.tmpdir(), `alfred-fehlt-${Date.now()}`);
    mkdirSync(d); rmSync(d, { recursive: true });
    const v = new BeobachterVerwaltung({ senden: () => undefined, erlaubt: () => true, veto: () => false });
    v.setze([{ id: 'r1', quelle: 'ordner', pfad: d }]);
    expect(v.stand()[0]).toMatchObject({ zustand: 'gestoert', grund: 'Ordner fehlt' });
  });
});
