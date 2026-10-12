import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { gitAnlegen } from './satellit-auftrag.js';

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
  it('ohne Git: weiter ohne Repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-git3-'));
    expect(gitAnlegen(dir, 'git-gibt-es-nicht-xyz')).toBe('ohne-git');
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
  });
});
