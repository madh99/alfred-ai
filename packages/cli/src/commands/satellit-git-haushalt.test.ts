import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { gitAnlegen, protokollSchreiben, protokollAuftragDatei, auftraegeVerschiebungCommitten } from './satellit-auftrag.js';

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
