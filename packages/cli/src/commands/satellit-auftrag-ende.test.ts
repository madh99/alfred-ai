import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { geaenderteDateien, endeEreignis, offeneEndmeldungen, markiereGemeldet, ladeMeta, type AuftragMeta } from './satellit-auftrag.js';

// v1382 (R1) — Ende eines Auftrags ans Gehirn melden, auch nach Trennung oder Neustart des Satelliten
const ALT = new Date('2026-01-01T00:00:00Z');

function projekt(): { dir: string; start: number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r1-projekt-'));
  for (const d of ['src', 'node_modules/x', '.git']) mkdirSync(path.join(dir, d), { recursive: true });
  writeFileSync(path.join(dir, 'alt.txt'), 'alt'); utimesSync(path.join(dir, 'alt.txt'), ALT, ALT);
  const start = Date.now() - 1000;
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'neu');
  writeFileSync(path.join(dir, 'package.json'), '{}');
  writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '');
  writeFileSync(path.join(dir, '.git', 'HEAD'), '');
  writeFileSync(path.join(dir, 'AUFTRAG-1.md'), '# A');
  return { dir, start };
}

function auftrag(home: string, m: Partial<AuftragMeta> & { id: string; projekt: string }, log: string): void {
  const o = path.join(home, '.alfred', 'auftraege', m.id);
  mkdirSync(o, { recursive: true });
  writeFileSync(path.join(o, 'meta.json'), JSON.stringify({ titel: 'T', start: new Date().toISOString(), status: 'laeuft', befehl: 'claude', auftragDatei: path.join(m.projekt, 'AUFTRAG-1.md'), ...m }));
  writeFileSync(path.join(o, 'log.txt'), log);
}

const OK = '{"type":"result","subtype":"success","is_error":false,"result":"fertig gebaut","total_cost_usd":0.12,"duration_ms":5000}';

describe('Auftragsende (v1382)', () => {
  it('geänderte Dateien seit dem Start, ohne Abhängigkeiten, .git und die Auftragsdatei', () => {
    const { dir, start } = projekt();
    const r = geaenderteDateien(dir, start, { ohne: [path.join(dir, 'AUFTRAG-1.md')] });
    expect(r.dateien).toEqual(['package.json', 'src/index.ts']);
    expect(r.anzahl).toBe(2);
    expect(geaenderteDateien(dir, start, { max: 1 }).dateien).toHaveLength(1);
  });

  it('Ereignis trägt Status, Kosten, Dauer und Dateien; Text gekürzt', () => {
    const { dir } = projekt();
    const m: AuftragMeta = { id: 'a1', titel: 'Test', projekt: dir, start: new Date(Date.now() - 125_000).toISOString(), ende: new Date().toISOString(), status: 'fertig', befehl: 'claude', auftragDatei: path.join(dir, 'AUFTRAG-1.md') };
    const e = endeEreignis(m, { text: 'x'.repeat(5000), kosten: 0.5 });
    expect(e).toMatchObject({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', kosten: 0.5, dauerS: 125, dateienAnzahl: 2 });
    expect(String(e.text)).toHaveLength(3000);
  });

  it('offene Endmeldungen: beendete ungemeldete, toter Prozess aus dem Protokoll; gemeldete und laufende nicht', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'r1-home-'));
    const { dir } = projekt();
    auftrag(home, { id: '1-fertig', projekt: dir, status: 'fertig', ende: new Date().toISOString() }, OK);
    auftrag(home, { id: '2-tot', projekt: dir, status: 'laeuft', pid: 999_999_99 }, OK);
    auftrag(home, { id: '3-gemeldet', projekt: dir, status: 'fertig', gemeldet: new Date().toISOString() }, OK);
    auftrag(home, { id: '4-laeuft', projekt: dir, status: 'laeuft', pid: process.pid }, '');
    auftrag(home, { id: '5-alt', projekt: dir, status: 'fertig', start: new Date(Date.now() - 8 * 86_400_000).toISOString() }, OK);
    const o = offeneEndmeldungen(home);
    expect(o.map(x => x.meta.id)).toEqual(['1-fertig', '2-tot']);
    expect(o[1]!.meta.status).toBe('fertig');
    expect(o[1]!.ergebnis.text).toBe('fertig gebaut');
    markiereGemeldet('1-fertig', home);
    expect(ladeMeta('1-fertig', home)?.gemeldet).toBeTruthy();
    expect(offeneEndmeldungen(home).map(x => x.meta.id)).toEqual(['2-tot']);
  });
});

// v1394 — Aufrufargumente von Claude Code: ohne Benutzereinstellungen, Budget nur auf Wunsch
import { auftragStarten } from './satellit-auftrag.js';
import { chmodSync, readFileSync as rf } from 'node:fs';
describe('Claude-Code-Aufruf', () => {
  it('setting-sources project,local; max-budget-usd nur mit Vorgabe; fehlendes Verzeichnis wird angelegt', async () => {
    if (process.platform === 'win32') return; // Shell-Stub nur unter Unix
    const home = mkdtempSync(path.join(os.tmpdir(), 'r1-arg-'));
    const stub = path.join(home, 'claude');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\n" "$@" > "$(dirname "$0")/args.txt"\n');
    chmodSync(stub, 0o755);
    const proj = path.join(home, 'neu', 'projekt');
    await new Promise<void>(res => auftragStarten({ projekt: proj, auftrag: 'x', home, claude: stub, maxKostenUsd: 1.5, beiEnde: () => res() }));
    const a = rf(path.join(home, 'args.txt'), 'utf8').split('\n');
    expect(a).toContain('--setting-sources');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('1.5');
    await new Promise<void>(res => auftragStarten({ projekt: proj, auftrag: 'y', home, claude: stub, beiEnde: () => res() }));
    expect(rf(path.join(home, 'args.txt'), 'utf8')).not.toContain('--max-budget-usd');
  });
});
