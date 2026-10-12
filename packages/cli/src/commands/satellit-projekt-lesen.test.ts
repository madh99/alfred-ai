import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { projektLesen } from './satellit-auftrag.js';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
let gitDa = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitDa = false; }

// v1398 — Spec „Projekte sichtbar und fortsetzbar" P2: Bestand nur lesend
describe('projektLesen', () => {
  it('README, Paket-Skripte, Struktur ohne Abhängigkeiten und Auftragsdateien; ohne Git', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-lesen-'));
    for (const d of ['src/lib/tief', 'node_modules/x', 'docs']) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'angebote', description: 'Supermarkt', scripts: { test: 'node --test', start: 'node src/start.js' } }));
    writeFileSync(path.join(dir, 'docs', 'README.md'), '# Angebote\nSammelt Angebote.');
    writeFileSync(path.join(dir, 'src', 'start.js'), '');
    writeFileSync(path.join(dir, 'src', 'lib', 'tief', 'zu-tief.js'), '');
    writeFileSync(path.join(dir, 'AUFTRAG-1.md'), '');
    writeFileSync(path.join(dir, '.env'), 'GEHEIM=1');
    const b = projektLesen(dir, 'git-gibt-es-nicht-xyz');
    expect(b.readme).toContain('Sammelt Angebote');
    expect(b.paket).toBe('name: angebote\nbeschreibung: Supermarkt\nnpm run test: node --test\nnpm run start: node src/start.js');
    expect(b.baum).toEqual(['docs/', 'docs/README.md', 'package.json', 'src/', 'src/lib/', 'src/start.js']);
    expect(b.git).toBe(false);
    expect(b.commits).toEqual([]);
  });
  it.skipIf(!gitDa)('letzte Commits mit Dateien', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-lesen2-'));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'user.email', 't@t');
    writeFileSync(path.join(dir, 'a.js'), '1');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'Stand vor Alfred');
    writeFileSync(path.join(dir, 'b.js'), '2');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'Etappe 1: b ergänzt');
    const b = projektLesen(dir);
    expect(b.git).toBe(true);
    expect(b.commits.map(c => [c.message, c.files])).toEqual([['Etappe 1: b ergänzt', ['b.js']], ['Stand vor Alfred', ['a.js']]]);
    expect(b.commits[0]!.sha).toMatch(/^[0-9a-f]{7,}$/);
  });
});
