import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { gitAnlegen, gitUebernehmen, offeneAenderungen, projektLesen } from './satellit-auftrag.js';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
let gitDa = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitDa = false; }

describe('v1396 — neue Projektverzeichnisse als Git-Repository', () => {
  it.skipIf(!gitDa)('legt Repository mit .gitignore an, Identität vorhanden', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git-'));
    expect(gitAnlegen(dir)).toBe('angelegt');
    expect(git(dir, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    const ignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('.env');
    expect(git(dir, 'config', 'user.email')).not.toBe('');
  });
  it.skipIf(!gitDa)('kein verschachteltes Repository in einem bestehenden Projekt', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git2-'));
    git(dir, 'init', '-q');
    const unter = path.join(dir, 'modul'); mkdirSync(unter);
    expect(gitAnlegen(unter)).toBe('schon-repository');
    expect(existsSync(path.join(unter, '.git'))).toBe(false);
    expect(existsSync(path.join(unter, '.gitignore'))).toBe(false);
  });
  it.skipIf(!gitDa)('v1397 bestehendes Verzeichnis: Ausgangs-Commit ohne Abhängigkeiten, Geheimnisse und große Dateien', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git4-'));
    mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log(1)\n');
    writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), 'x');
    writeFileSync(path.join(dir, '.env'), 'GEHEIM=1');
    writeFileSync(path.join(dir, '.env.example'), 'GEHEIM=');
    writeFileSync(path.join(dir, 'gross.bin'), 'x'.repeat(500));
    writeFileSync(path.join(dir, '.gitignore'), 'dist/\n.env\n');
    const r = gitUebernehmen(dir, 'git', 100);
    expect(r.status).toBe('angelegt');
    expect(r.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.grosse).toEqual(['gross.bin']);
    expect(git(dir, 'log', '--format=%s')).toBe('Stand vor Alfred');
    const drin = git(dir, 'ls-files').split('\n').sort();
    expect(drin).toEqual(['.env.example', '.gitignore', 'src/a.js']);
    const ignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore.startsWith('dist/\n.env\n')).toBe(true); // Owner-Zeilen bleiben
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('/gross.bin');
    expect(ignore.match(/^\.env$/gm)).toHaveLength(1); // nicht doppelt
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
  it.skipIf(!gitDa)('v1397 schon ein Repository oder leeres Verzeichnis: kein Commit', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git5-'));
    git(dir, 'init', '-q');
    expect(gitUebernehmen(dir)).toEqual({ status: 'schon-repository', grosse: [] });
    const leer = mkdtempSync(path.join(os.tmpdir(), 'alfred-git6-'));
    const r = gitUebernehmen(leer);
    expect(r.status).toBe('angelegt');
    expect(r.commit).toMatch(/^[0-9a-f]{7,}$/); // nur die .gitignore
    expect(git(leer, 'ls-files')).toBe('.gitignore');
  });
  it('ohne Git: weiter ohne Repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git3-'));
    expect(gitAnlegen(dir, 'git-gibt-es-nicht-xyz')).toBe('ohne-git');
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
  });
});

describe('v1453 — vorgefundene, nicht eingecheckte Änderungen', () => {
  it('liest porcelain -z: führendes Leerzeichen, Umbenennung, Alfreds eigene Dateien ausgenommen', () => {
    const roh = [' D docs/SPAR-ANFRAGE.md', ' M daten/cache.json', '?? daten/merkliste.json', 'R  neu.md', 'alt.md', '?? .alfred/laeufe/x.md', ' D AUFTRAG-2026-ab.md', 'A  src/a.js', ''].join('\0');
    expect(offeneAenderungen(roh)).toEqual(['docs/SPAR-ANFRAGE.md (gelöscht)', 'daten/cache.json (geändert)', 'daten/merkliste.json (neu, nicht eingecheckt)', 'neu.md (umbenannt)', 'src/a.js (hinzugefügt)']);
    expect(offeneAenderungen('')).toEqual([]);
    expect(offeneAenderungen(['?? a', '?? b', '?? c', ''].join('\0'), 2)).toEqual(['a (neu, nicht eingecheckt)', 'b (neu, nicht eingecheckt)', '… und 1 weitere']);
  });
  it.skipIf(!gitDa)('projektLesen meldet sie aus einem echten Repository (leer, wenn sauber)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-offen-'));
    git(dir, 'init', '-q');
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'docs', 'a.md'), 'a');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    expect(projektLesen(dir).offen).toBeUndefined();
    rmSync(path.join(dir, 'docs', 'a.md'));
    writeFileSync(path.join(dir, 'neu.txt'), 'n');
    expect(projektLesen(dir).offen).toEqual(['docs/a.md (gelöscht)', 'neu.txt (neu, nicht eingecheckt)']);
  });
});
