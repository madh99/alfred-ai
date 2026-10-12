import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { AuftragHerkunft } from '../geraete/auftrag-herkunft.js';

// v1383 (R1) — Zuordnung Auftrag → Sitzung übersteht den Neustart des Gehirns
describe('AuftragHerkunft', () => {
  const h = { chatId: 'sitzung:abc', platform: 'api', userId: 'u1' };

  it('übersteht einen Neustart (neue Instanz auf derselben Datei) und wird nur einmal geliefert', () => {
    const datei = path.join(mkdtempSync(path.join(os.tmpdir(), 'herkunft-')), 'a.json');
    new AuftragHerkunft(datei).merke('g1', 'a1', h);
    const nachNeustart = new AuftragHerkunft(datei);
    expect(nachNeustart.nimm('g2', 'a1')).toBeUndefined(); // anderes Gerät
    expect(nachNeustart.nimm('g1', 'a1')).toEqual(h);
    expect(new AuftragHerkunft(datei).nimm('g1', 'a1')).toBeUndefined();
  });

  it('verwirft Einträge älter als 7 Tage und kaputte Dateien', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'herkunft-'));
    const datei = path.join(dir, 'a.json');
    const jetzt = 1_800_000_000_000;
    writeFileSync(datei, JSON.stringify({ 'g1:alt': { ...h, seit: jetzt - 8 * 86_400_000 }, 'g1:neu': { ...h, seit: jetzt - 86_400_000 } }));
    const s = new AuftragHerkunft(datei, () => jetzt);
    expect(s.nimm('g1', 'alt')).toBeUndefined();
    expect(s.nimm('g1', 'neu')).toEqual(h);
    const kaputt = path.join(dir, 'k.json');
    writeFileSync(kaputt, '{nicht json');
    expect(new AuftragHerkunft(kaputt).nimm('g1', 'x')).toBeUndefined();
  });

  it('ohne Datei nur im Speicher', () => {
    const s = new AuftragHerkunft();
    s.merke('g', 'a', h);
    expect(s.nimm('g', 'a')).toEqual(h);
  });
});
