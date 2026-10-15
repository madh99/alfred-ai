import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gitAnlegen, protokollSchreiben, protokollAuftragDatei, auftraegeVerschiebungCommitten, identitaetUmgebung, laufendeAuftraege } from './satellit-auftrag.js';

const g = (dir: string, args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const status = (dir: string) => g(dir, ['status', '--porcelain']).stdout.trim();

describe('v1448 Git-Haushalt der Geräte-Projekte', () => {
  it('.gitignore aus gitAnlegen kommt mit dem ersten Etappenprotokoll ins Repo (Protokoll an)', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'v1448a-'));
    expect(gitAnlegen(d)).toBe('angelegt');
    expect(g(d, ['log', '--oneline']).status).not.toBe(0); // weiterhin kein eigener Anlege-Commit (v1397)
    const r = protokollSchreiben(d, { lauf: 'sat-1', nr: 1, an: true, bericht: '# Bericht', nachricht: 'docs(alfred): Protokoll Etappe 1/1 (sat-1)' });
    expect(r.commit).toBeTruthy();
    expect(g(d, ['ls-files', '.gitignore']).stdout.trim()).toBe('.gitignore');
    expect(status(d)).toBe('');
  });

  it('Protokoll aus: nur .gitignore wird gesichert, der Bericht bleibt lokal', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'v1448b-'));
    gitAnlegen(d);
    const r = protokollSchreiben(d, { lauf: 'sat-1', nr: 1, an: false, bericht: '# Bericht', nachricht: 'x' });
    expect(r.hinweis).toContain('nur lokal');
    expect(g(d, ['log', '--format=%s']).stdout.trim()).toBe('chore(alfred): .gitignore (Abhängigkeiten und Geheimnisse ausschließen)');
    expect(g(d, ['ls-files', '.alfred']).stdout.trim()).toBe('');
  });

  it('verschobene AUFTRAG-*.md werden committet (an: als Verschiebung; aus: nur entfernt) — auch als Altfall', () => {
    for (const an of [true, false]) {
      const d = mkdtempSync(path.join(os.tmpdir(), 'v1448c-'));
      gitAnlegen(d);
      writeFileSync(path.join(d, 'AUFTRAG-20261012-a.md'), 'alt');
      writeFileSync(path.join(d, 'code.js'), 'x');
      g(d, ['add', '-A']); g(d, ['commit', '-qm', 'Etappe 1: Start']);
      writeFileSync(path.join(d, 'code.js'), 'geändert vom Owner'); // fremde Änderung bleibt unangetastet
      protokollAuftragDatei(d, { lauf: 'sat-2', nr: 1, an });
      expect(existsSync(path.join(d, '.alfred', 'laeufe', 'frueher', 'AUFTRAG-20261012-a.md'))).toBe(true);
      const log = g(d, ['log', '-1', '--name-status', '--format=%s']).stdout;
      expect(log).toContain('chore(alfred): 1 frühere Auftragsdatei(en) nach .alfred/laeufe/frueher verschoben');
      expect(log).toContain('AUFTRAG-20261012-a.md');
      expect(status(d)).toContain('code.js'); // nicht mitcommittet
      expect(status(d)).not.toContain('AUFTRAG-');
      expect(auftraegeVerschiebungCommitten(d, an)).toBe(0); // nichts mehr offen
    }
  });
});

// v1456 — Realfall 15.10.: Repo ohne Git-Identität, Etappenprotokoll blieb gestaget („Identität des Autors unbekannt“)
describe('v1456 Protokoll-Commit ohne Git-Identität', () => {
  it('committet als Alfred, ohne die Konfiguration des Repos zu ändern', () => {
    const vorher = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const d = mkdtempSync(path.join(os.tmpdir(), 'alfred-ohne-id-'));
      expect(g(d, ['init', '-q']).status).toBe(0);
      expect(identitaetUmgebung(d)).toMatchObject({ GIT_AUTHOR_NAME: 'Alfred' });
      const r = protokollSchreiben(d, { lauf: 'sat-x', nr: 1, an: true, bericht: '# B', nachricht: 'docs(alfred): Protokoll' });
      expect(r.commit).toMatch(/^[0-9a-f]{7,}$/);
      expect(g(d, ['log', '--format=%an']).stdout.trim()).toBe('Alfred');
      expect(g(d, ['config', '--local', 'user.email']).stdout.trim()).toBe('');
      g(d, ['config', 'user.email', 'owner@example']);
      expect(identitaetUmgebung(d)).toEqual({});
    } finally {
      if (vorher.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = vorher.g;
      if (vorher.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = vorher.s;
    }
  });
});

// v1459 — Update-Sperre: nur Aufträge mit lebendem Prozess zählen
describe('v1459 laufende Aufträge', () => {
  it('zählt Status läuft mit lebendem Prozess, nicht tote oder fertige', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-home-'));
    const o = path.join(home, '.alfred', 'auftraege');
    const lege = (id: string, m: Record<string, unknown>) => { mkdirSync(path.join(o, id), { recursive: true }); writeFileSync(path.join(o, id, 'meta.json'), JSON.stringify({ id, titel: 't', projekt: '/p', start: new Date().toISOString(), ...m })); };
    expect(laufendeAuftraege(home)).toBe(0);
    lege('a1', { status: 'laeuft', pid: process.pid });
    lege('a2', { status: 'laeuft', pid: 999_999_9 });
    lege('a3', { status: 'fertig', pid: process.pid });
    expect(laufendeAuftraege(home)).toBe(1);
  });
});
