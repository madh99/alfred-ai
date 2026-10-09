import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseErgebnis, auftragPrompt, neueAuftragId, claudePfad, ladeMeta, auftraege, auftragStand } from './satellit-auftrag.js';

describe('Aufträge an Claude Code (v1342)', () => {
  it('parseErgebnis liest die JSON-Zeile von claude -p --output-format json', () => {
    const log = ['[W1009] irgendeine Warnung', '{"type":"result","subtype":"success","is_error":false,"result":"Projekt angelegt: package.json, index.js","total_cost_usd":0.0421,"duration_ms":83210,"session_id":"abc"}'].join('\n');
    const e = parseErgebnis(log);
    expect(e.text).toBe('Projekt angelegt: package.json, index.js');
    expect(e.kosten).toBeCloseTo(0.0421);
    expect(e.dauerMs).toBe(83210);
    expect(e.sitzung).toBe('abc');
    expect(e.fehler).toBeUndefined();
  });
  it('parseErgebnis erkennt Fehlerergebnisse und Protokolle ohne JSON', () => {
    expect(parseErgebnis('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"zu viele Runden"}').fehler).toBe('zu viele Runden');
    const ohne = parseErgebnis('claude: command not found\n');
    expect(ohne.fehler).toContain('command not found');
    expect(parseErgebnis('').fehler).toBe('keine Ausgabe');
  });
  it('auftragPrompt verweist auf die Spezifikationsdatei und das Projektverzeichnis', () => {
    const p = auftragPrompt('/srv/p/AUFTRAG-1.md', '/srv/p');
    expect(p).toContain('/srv/p/AUFTRAG-1.md');
    expect(p).toContain('im Verzeichnis /srv/p');
    expect(p).toContain('nur innerhalb dieses Verzeichnisses');
  });
  it('neueAuftragId ist zeitlich sortierbar', () => {
    const a = neueAuftragId(new Date('2026-10-10T00:10:00Z')); const b = neueAuftragId(new Date('2026-10-10T00:11:00Z'));
    expect(a < b).toBe(true);
    expect(a).toMatch(/^20261010001000-[a-z0-9]{4}$/);
  });
  it('claudePfad findet claude im PATH oder unter ~/.local/bin, sonst undefined', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-auftrag-'));
    expect(claudePfad({ PATH: home }, home)).toBeUndefined();
    const bin = path.join(home, '.local', 'bin'); mkdirSync(bin, { recursive: true });
    const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(path.join(bin, name), '');
    expect(claudePfad({ PATH: '' }, home)).toBe(path.join(bin, name));
  });
  it('ladeMeta/auftraege/auftragStand: unbekannte Kennung, leerer Ordner, Stand eines beendeten Auftrags', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-auftrag2-'));
    expect(ladeMeta('gibtsnicht', home)).toBeUndefined();
    expect(auftraege(home)).toEqual([]);
    expect(() => auftragStand('gibtsnicht', home)).toThrow(/unbekannt/);
    const id = '20261010001000-test';
    mkdirSync(path.join(home, '.alfred', 'auftraege', id), { recursive: true });
    writeFileSync(path.join(home, '.alfred', 'auftraege', id, 'meta.json'), JSON.stringify({ id, titel: 'T', projekt: '/p', start: '2026-10-10T00:10:00.000Z', ende: '2026-10-10T00:12:00.000Z', exit: 0, status: 'fertig', befehl: 'claude', auftragDatei: '/p/AUFTRAG.md' }));
    writeFileSync(path.join(home, '.alfred', 'auftraege', id, 'log.txt'), 'Zeile 1\nZeile 2\n');
    const s = auftragStand(id, home);
    expect(s.laeuft).toBe(false);
    expect(s.dauerS).toBe(120);
    expect(s.letzteZeilen).toBe('Zeile 1\nZeile 2');
    expect(auftraege(home).map(m => m.id)).toEqual([id]);
  });
});
