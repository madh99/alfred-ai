import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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

// v1407 — Titel an einer Wortgrenze kürzen
import { kurzTitel } from './satellit-auftrag.js';
describe('kurzTitel', () => {
  it('kurz bleibt, lang wird an der Wortgrenze mit … gekürzt', () => {
    expect(kurzTitel('Woher kommen die Angebote?', 70)).toBe('Woher kommen die Angebote?');
    expect(kurzTitel('Welche Supermärkte unterstützt die App und in welcher Datei steht die Liste der Quellen genau?', 70)).toBe('Welche Supermärkte unterstützt die App und in welcher Datei steht…');
    expect(kurzTitel('Erste Zeile\nzweite', 70)).toBe('Erste Zeile');
    expect(kurzTitel('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

// v1409 R3b — sudo-Sperre optional (Gerät oder Projekt)
import { SUDO_GESPERRT } from './satellit-auftrag.js';
import { wendeAn } from './satellit-einstellungen.js';
describe('sudo-Sperre', () => {
  it('Bau-Auftrag mit Sperre bekommt die Regel; ohne Sperre nicht; Nur-Lesen bleibt strenger', () => {
    expect(argumenteFuer({ prompt: 'P', nurLesen: false, sudoSperre: true })).toEqual(expect.arrayContaining(['--disallowedTools', SUDO_GESPERRT]));
    expect(SUDO_GESPERRT).toBe('Bash(sudo:*)');
    expect(argumenteFuer({ prompt: 'P', nurLesen: false })).not.toContain('--disallowedTools');
    expect(argumenteFuer({ prompt: 'P', nurLesen: true, sudoSperre: true })).toContain(NUR_LESEN_GESPERRT);
  });
  it('lokale Einstellung sudo-sperre an|aus', () => {
    const k = { freigegebeneVerzeichnisse: [] } as never as Parameters<typeof wendeAn>[0];
    expect(wendeAn(k, 'sudo-sperre', 'an')).toEqual({ ok: true, text: 'sudo in Claude-Code-Aufträgen: gesperrt' });
    expect(k.sudoSperre).toBe(true);
    expect(wendeAn(k, 'sudo-sperre', 'aus').text).toMatch(/erlaubt/);
    expect(k.sudoSperre).toBe(false);
    expect(wendeAn(k, 'sudo-sperre', 'vielleicht').ok).toBe(false);
  });
});

// v1411 R3d — Vertrauensstufe lokal setzen
import { bisAus, aktivesVertrauen } from './satellit-einstellungen.js';
describe('Vertrauensstufe (lokal)', () => {
  const jetzt = new Date(2026, 9, 13, 10, 0, 0);
  it('Zeitangaben: 18:00, 4h, 2d, Datum; über 30 Tage oder vergangen nein', () => {
    expect(bisAus('18:00', jetzt)!.getHours()).toBe(18);
    expect(bisAus('09:00', jetzt)!.getDate()).toBe(14); // schon vorbei → morgen
    expect(bisAus('4h', jetzt)!.getTime() - jetzt.getTime()).toBe(4 * 3_600_000);
    expect(bisAus('2d', jetzt)!.getTime() - jetzt.getTime()).toBe(2 * 86_400_000);
    expect(bisAus('2026-10-20 18:00', jetzt)!.getDate()).toBe(20);
    expect(bisAus('31d', jetzt)).toBeUndefined();
    expect(bisAus('2026-10-01', jetzt)).toBeUndefined();
    expect(bisAus('morgen', jetzt)).toBeUndefined();
  });
  it('setzen nur in Ordnern mit Schreibrecht; entfernen; abgelaufene zählen nicht', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-vertrauen-'));
    const sub = path.join(dir, 'game'); mkdirSync(sub);
    const k = { freigegebeneVerzeichnisse: [dir] } as never as Parameters<typeof wendeAn>[0];
    expect(wendeAn(k, 'vertrauen', `${sub} bis 4h`).ok).toBe(true);
    expect(aktivesVertrauen(k).map(v => v.pfad)).toEqual([sub]);
    expect(wendeAn(k, 'vertrauen', `${os.homedir()} bis 4h`).text).toMatch(/Nur in einem Verzeichnis mit Schreibrecht/);
    expect(wendeAn(k, 'vertrauen', `${sub}`).ok).toBe(false);
    expect(wendeAn(k, 'vertrauen', `- ${sub}`).ok).toBe(true);
    expect(aktivesVertrauen(k)).toEqual([]);
    k.vertrauen = [{ pfad: sub, bis: new Date(Date.now() - 1000).toISOString() }];
    expect(aktivesVertrauen(k)).toEqual([]);
  });
});

// v1418 G2 — Schritte verlassen das Gerät nur geschwärzt
import { schwaerze } from './satellit-auftrag.js';
describe('schwaerze', () => {
  it('Tokens, Passwörter, Schlüssel und Zugangsdaten in URLs', () => {
    expect(schwaerze('▶ curl -H "Authorization: Bearer abc.def" https://x')).not.toContain('abc.def');
    expect(schwaerze('▶ API_KEY=sk-123 node a.js')).toBe('▶ API_KEY=*** node a.js');
    expect(schwaerze('▶ psql postgres://user:geheim@db/x')).toBe('▶ psql postgres://user:***@db/x');
    expect(schwaerze('▶ export PASSWORD="a b"')).toBe('▶ export PASSWORD=***');
    expect(schwaerze('✏️ schreibt src/a.js')).toBe('✏️ schreibt src/a.js');
  });
});

// v1432 — Folgefrage in derselben Claude-Code-Sitzung (nur lesend bleibt nur lesend)
describe('Folgefrage', () => {
  it('--resume nur mit gültiger Sitzungskennung, Plan-Modus und Sperren bleiben', () => {
    const a = argumenteFuer({ prompt: 'P', nurLesen: true, sitzung: '0f8e2c1a-1234-4abc-9def-001122334455' });
    expect(a.slice(5, 7)).toEqual(['--resume', '0f8e2c1a-1234-4abc-9def-001122334455']);
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--disallowedTools', NUR_LESEN_GESPERRT]));
    expect(argumenteFuer({ prompt: 'P', nurLesen: true, sitzung: '--dangerously-skip-permissions' })).not.toContain('--resume');
  });
});
