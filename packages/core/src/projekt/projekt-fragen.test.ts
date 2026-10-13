import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjektFragen, FrageWarten, projektWissen, quelleZeile, SITZUNG_MAX_MS } from './projekt-fragen.js';

describe('v1432 ProjektFragen', () => {
  it('Folgefrage nur in junger Sitzung ohne Lauf seither', () => {
    let jetzt = 1_000_000;
    const f = new ProjektFragen(undefined, () => jetzt);
    expect(f.sitzungFuer('p')).toBeUndefined();
    f.merke('p', { frage: 'wo?', antwort: 'in a.ts', sitzung: 's1', fortgesetzt: false });
    expect(f.sitzungFuer('p')).toBe('s1');
    expect(f.sitzungFuer('p', jetzt - 1)).toBe('s1');
    expect(f.sitzungFuer('p', jetzt + 1)).toBeUndefined(); // Lauf hat seither am Code gearbeitet
    jetzt += SITZUNG_MAX_MS + 1;
    expect(f.sitzungFuer('p')).toBeUndefined(); // älter als 24 h
  });

  it('fortgesetzte Sitzung behält ihren Beginn, neue Sitzung beginnt neu', () => {
    let jetzt = 0;
    const f = new ProjektFragen(undefined, () => jetzt);
    f.merke('p', { frage: 'a', antwort: 'x', sitzung: 's1', fortgesetzt: false });
    jetzt = SITZUNG_MAX_MS - 10;
    f.merke('p', { frage: 'b', antwort: 'y', sitzung: 's2', fortgesetzt: true });
    expect(f.sitzungFuer('p')).toBe('s2');
    jetzt = SITZUNG_MAX_MS + 10;
    expect(f.sitzungFuer('p')).toBeUndefined();
    f.merke('p', { frage: 'c', antwort: 'z', sitzung: 's3', fortgesetzt: false });
    expect(f.sitzungFuer('p')).toBe('s3');
    f.vergissSitzung('p');
    expect(f.sitzungFuer('p')).toBeUndefined();
  });

  it('merkt höchstens 5 Antworten und übersteht einen Neustart', () => {
    const datei = path.join(mkdtempSync(path.join(tmpdir(), 'pf-')), 'f.json');
    const f = new ProjektFragen(datei);
    for (let i = 0; i < 7; i++) f.merke('p', { frage: `f${i}`, antwort: `a${i}`, fortgesetzt: false });
    const g = new ProjektFragen(datei);
    expect(g.antworten('p').map(a => a.frage)).toEqual(['f2', 'f3', 'f4', 'f5', 'f6']);
    expect(JSON.parse(readFileSync(datei, 'utf8')).p.antworten).toHaveLength(5);
  });
});

describe('v1432 FrageWarten', () => {
  it('Ende-Ereignis erfüllt das Warten genau einmal', async () => {
    const w = new FrageWarten<{ text: string }>();
    expect(w.erfuelle('x', { text: 'niemand wartet' })).toBe(false);
    const p = w.warte('a1', 5_000);
    expect(w.erfuelle('a1', { text: 'antwort' })).toBe(true);
    await expect(p).resolves.toEqual({ text: 'antwort' });
    expect(w.erfuelle('a1', { text: 'zweimal' })).toBe(false);
  });

  it('Zeitüberschreitung liefert undefined, danach ist das Ereignis frei', async () => {
    const w = new FrageWarten<string>();
    await expect(w.warte('a2', 5)).resolves.toBeUndefined();
    expect(w.erfuelle('a2', 'spät')).toBe(false);
  });
});

describe('v1432 projektWissen', () => {
  it('Etappenberichte, Commits und frühere Antworten', () => {
    const t = projektWissen([
      { id: 'sat-1', ziel: 'Angebote sammeln', status: 'fertig', start: 1, aktualisiert: 2, erledigt: [
        { nr: 1, etappe: 'Scraper', ok: true, zusammenfassung: 'Billa und Spar über JSON-API', dateien: ['src/billa.ts', 'src/spar.ts'], commit: { sha: 'abc1234def', titel: 'feat: Scraper' } },
      ] },
      { id: 'sat-0', ziel: 'leer', status: 'abgebrochen', start: 0, aktualisiert: 0, erledigt: [] },
    ], [{ zeit: 3, frage: 'Woher kommen die Daten?', antwort: 'Aus src/billa.ts Zeile 12' }])!;
    expect(t).toContain('Lauf sat-1 (fertig');
    expect(t).toContain('Etappe 1 ✅ Scraper — Commit abc1234 „feat: Scraper“ — Dateien: src/billa.ts, src/spar.ts');
    expect(t).toContain('Bericht: Billa und Spar über JSON-API');
    expect(t).toContain('Antwort: Aus src/billa.ts Zeile 12');
    expect(t).not.toContain('sat-0');
  });

  it('ohne Daten nichts; Länge begrenzt', () => {
    expect(projektWissen([], [])).toBeUndefined();
    const lang = projektWissen([], [{ zeit: 0, frage: 'f', antwort: 'x'.repeat(5000) }], 300)!;
    expect(lang.length).toBeLessThanOrEqual(300);
  });

  it('Quellenzeile', () => {
    expect(quelleZeile('Ubuntu-VM', 0.4, true)).toBe('Quelle: Claude Code auf Ubuntu-VM, nur lesend, 0,40 $, Folgefrage in derselben Sitzung');
    expect(quelleZeile('PC')).toBe('Quelle: Claude Code auf PC, nur lesend');
  });
});
