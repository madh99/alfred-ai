import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gitAnlegen, protokollAuftragDatei, protokollSchreiben, protokollAusschluss } from './satellit-auftrag.js';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
let gitDa = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitDa = false; }

function projekt(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-prot-'));
  gitAnlegen(dir);
  writeFileSync(path.join(dir, 'a.txt'), '1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'start');
  return dir;
}

describe('v1425 — Protokoll eines Projektlaufs im Projekt', () => {
  it.skipIf(!gitDa)('an: Auftrag im Laufordner, alte AUFTRAG-Dateien verschoben, Bericht als eigener Commit nur des Ordners', () => {
    const dir = projekt();
    writeFileSync(path.join(dir, 'AUFTRAG-20261013001742-0g72.md'), '# alt\n');
    writeFileSync(path.join(dir, 'b.txt'), 'nicht committen\n'); git(dir, 'add', 'b.txt'); // fremde Änderung im Index bleibt
    const auftrag = protokollAuftragDatei(dir, { lauf: 'sat-12345678', nr: 2, an: true });
    expect(auftrag).toBe(path.join(dir, '.alfred', 'laeufe', 'sat-12345678', 'etappe-2-auftrag.md'));
    expect(existsSync(path.join(dir, 'AUFTRAG-20261013001742-0g72.md'))).toBe(false);
    expect(existsSync(path.join(dir, '.alfred', 'laeufe', 'frueher', 'AUFTRAG-20261013001742-0g72.md'))).toBe(true);
    writeFileSync(auftrag, '# Auftrag\n');
    const r = protokollSchreiben(dir, { lauf: 'sat-12345678', nr: 2, an: true, bericht: '# Etappe 2\napi_key=geheim123\n', nachricht: 'docs(alfred): Protokoll Etappe 2/3 (sat-12345678)' });
    expect(r.pfad).toBe('.alfred/laeufe/sat-12345678/etappe-2-bericht.md');
    expect(r.commit).toBeTruthy();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('docs(alfred): Protokoll Etappe 2/3 (sat-12345678)');
    const imCommit = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    expect(imCommit).toContain('.alfred/laeufe/sat-12345678/etappe-2-auftrag.md');
    expect(imCommit).toContain('.alfred/laeufe/sat-12345678/etappe-2-bericht.md');
    expect(imCommit).not.toContain('b.txt');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('b.txt');
    expect(readFileSync(path.join(dir, r.pfad), 'utf8')).not.toContain('geheim123');
  });

  it.skipIf(!gitDa)('aus: lokal, von git ausgeschlossen, kein Commit; wieder an → Ausschluss weg', () => {
    const dir = projekt();
    protokollAuftragDatei(dir, { lauf: 'sat-aaaa', nr: 1, an: false });
    const r = protokollSchreiben(dir, { lauf: 'sat-aaaa', nr: 1, an: false, bericht: '# B\n', nachricht: 'x' });
    expect(r.commit).toBeUndefined();
    expect(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.alfred/laeufe/');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    protokollAusschluss(dir, true);
    expect(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.alfred/laeufe/');
  });

  it.skipIf(!gitDa)('Fix-Versuch und zweiter Auftrag derselben Etappe überschreiben nichts', () => {
    const dir = projekt();
    const a = protokollAuftragDatei(dir, { lauf: 'sat-b', nr: 1, an: true }); writeFileSync(a, 'x');
    expect(path.basename(protokollAuftragDatei(dir, { lauf: 'sat-b', nr: 1, fix: 1, an: true }))).toBe('etappe-1-fix1-auftrag.md');
    expect(path.basename(protokollAuftragDatei(dir, { lauf: 'sat-b', nr: 1, an: true }))).toBe('etappe-1-auftrag-2.md');
  });
});

describe('v1426 — Status ohne beobachtetes Prozessende', () => {
  it('erfolgreiche result-Zeile → fertig, sonst fehler', async () => {
    const { statusAusProtokoll } = await import('./satellit-auftrag.js');
    expect(statusAusProtokoll('{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n')).toBe('fertig');
    expect(statusAusProtokoll('{"type":"assistant"}\n')).toBe('fehler');
    expect(statusAusProtokoll('')).toBe('fehler');
  });
});

describe('v1426 — Changelog seit Auftragsstart geändert?', () => {
  it('erkennt CHANGELOG.md (Groß/Klein egal) nach Zeitstempel, ohne Datei false', async () => {
    const { changelogGeaendert } = await import('./satellit-auftrag.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-cl-'));
    const start = Date.now() - 1000;
    expect(changelogGeaendert(dir, start)).toBe(false);
    writeFileSync(path.join(dir, 'changelog.md'), '# x\n');
    expect(changelogGeaendert(dir, start)).toBe(true);
    expect(changelogGeaendert(dir, Date.now() + 60_000)).toBe(false);
  });
});
