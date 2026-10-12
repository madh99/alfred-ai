import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { argumenteFuer, fragePrompt, auftragStarten, NUR_LESEN_GESPERRT } from './satellit-auftrag.js';

// v1404 — Frage zum Projekt: Claude Code nur lesend (Nachweis VM 13.10. 00:02)
describe('Frage zum Projekt', () => {
  it('Argumente: Plan-Modus und gesperrte Schreib-/Shell-Werkzeuge; Bau-Aufträge unverändert', () => {
    const f = argumenteFuer({ prompt: 'P', nurLesen: true, maxKostenUsd: 0.5 });
    expect(f).toEqual(['-p', 'P', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--disallowedTools', 'Edit Write MultiEdit NotebookEdit Bash', '--setting-sources', 'project,local', '--strict-mcp-config', '--max-budget-usd', '0.5']);
    expect(NUR_LESEN_GESPERRT.split(' ')).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    const b = argumenteFuer({ prompt: 'P', nurLesen: false });
    expect(b).toEqual(['-p', 'P', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--setting-sources', 'project,local', '--strict-mcp-config']);
  });
  it('Prompt: Frage, Verzeichnis, nichts ändern, keine Geheimnisse', () => {
    const p = fragePrompt('  Woher kommen die Hofer-Angebote? ', '/home/madh/game');
    expect(p).toContain('/home/madh/game');
    expect(p).toContain('ändere aber nichts');
    expect(p).toContain('Geheimnisse');
    expect(p.endsWith('Frage: Woher kommen die Hofer-Angebote?')).toBe(true);
  });
  it('Start: keine Datei im Projekt, kein Git, Frage im Auftragsordner; fehlendes Verzeichnis wird nicht angelegt', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-frage-home-'));
    const projekt = mkdtempSync(path.join(os.tmpdir(), 'alfred-frage-projekt-'));
    writeFileSync(path.join(projekt, 'a.js'), '1');
    const m = auftragStarten({ projekt, auftrag: 'Was macht a.js?', titel: 'Frage: Was macht a.js?', nurLesen: true, maxKostenUsd: 0.5, home, claude: process.execPath });
    expect(readdirSync(projekt)).toEqual(['a.js']);
    expect(m.auftragDatei).toBe(path.join(home, '.alfred', 'auftraege', m.id, 'FRAGE.md'));
    expect(readFileSync(m.auftragDatei, 'utf8')).toContain('Was macht a.js?');
    expect(m.befehl).toContain('--permission-mode plan --disallowedTools');
    expect(m.gitAngelegt).toBeUndefined();
    const fehlt = path.join(projekt, 'gibt-es-nicht');
    expect(() => auftragStarten({ projekt: fehlt, auftrag: 'x', nurLesen: true, home, claude: process.execPath })).toThrow(/fehlt/);
    expect(existsSync(fehlt)).toBe(false);
  });
});
