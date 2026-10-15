import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitZweig, gitAktualisieren, gitAusfuehren, type GitAusfuehren } from './satellit-git.js';

// v1455 — Merge-Request-Modus am Gerät, mit echtem git (GitLab = lokales Bare-Repo hinter der https-Adresse)
const g = (args: string[], cwd?: string) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const ADRESSE = 'https://git.example/madh/x.git';

function aufbau() {
  const t = mkdtempSync(path.join(os.tmpdir(), 'alfred-mr-'));
  const remote = path.join(t, 'remote.git'); const projekt = path.join(t, 'projekt'); const gitlab = path.join(t, 'gitlab');
  g(['init', '-q', '--bare', '-b', 'main', remote]);
  g(['clone', '-q', remote, projekt]);
  for (const d of [projekt]) { g(['config', 'user.name', 't'], d); g(['config', 'user.email', 't@t'], d); }
  writeFileSync(path.join(projekt, 'a.txt'), 'a'); g(['add', '.'], projekt); g(['commit', '-q', '-m', 'A'], projekt); g(['push', '-q', 'origin', 'main'], projekt);
  // Ausführung: https-Adresse → lokales Bare-Repo (alles andere echtes git)
  const ausf: GitAusfuehren = (args, cwd, env, ms) => gitAusfuehren(args.map(a => a === ADRESSE ? remote : a), cwd, env, ms);
  return { t, remote, projekt, gitlab, ausf };
}

describe('v1455 Zweig je Lauf und Holen nach dem Zusammenführen', () => {
  it('Zweig anlegen, nicht eingecheckte Änderungen bleiben; erneut = auschecken; ungültige Namen nein', async () => {
    const { projekt, ausf } = aufbau();
    writeFileSync(path.join(projekt, 'owner.txt'), 'nicht eingecheckt');
    expect(await gitZweig(projekt, 'alfred/sat-1', ausf)).toEqual({ ok: true, zweig: 'alfred/sat-1', vorher: 'main', neu: true });
    expect(g(['rev-parse', '--abbrev-ref', 'HEAD'], projekt)).toBe('alfred/sat-1');
    expect(existsSync(path.join(projekt, 'owner.txt'))).toBe(true);
    expect(await gitZweig(projekt, 'alfred/sat-1', ausf)).toMatchObject({ ok: true, neu: false });
    g(['checkout', '-q', 'main'], projekt);
    expect(await gitZweig(projekt, 'alfred/sat-1', ausf)).toMatchObject({ ok: true, neu: false, vorher: 'main' });
    expect((await gitZweig(projekt, 'main', ausf)).ok).toBe(false);
    expect((await gitZweig(projekt, 'alfred/../x', ausf)).ok).toBe(false);
  });

  it('nach dem Merge in „GitLab“: Zielzweig vorspulen und auschecken, eigene Dateien bleiben', async () => {
    const { remote, projekt, gitlab, ausf } = aufbau();
    await gitZweig(projekt, 'alfred/sat-1', ausf);
    writeFileSync(path.join(projekt, 'b.txt'), 'b'); g(['add', 'b.txt'], projekt); g(['commit', '-q', '-m', 'Etappe 1'], projekt);
    g(['push', '-q', 'origin', 'alfred/sat-1'], projekt);
    // GitLab führt zusammen (Merge-Commit auf main)
    g(['clone', '-q', remote, gitlab]); g(['config', 'user.name', 'gl'], gitlab); g(['config', 'user.email', 'gl@gl'], gitlab);
    g(['merge', '-q', '--no-ff', '-m', 'Merge !1', 'origin/alfred/sat-1'], gitlab); g(['push', '-q', 'origin', 'main'], gitlab);
    const mergeSha = g(['rev-parse', '--short', 'HEAD'], gitlab);
    writeFileSync(path.join(projekt, 'owner.txt'), 'bleibt');
    const r = await gitAktualisieren(projekt, undefined, ADRESSE, 'main', ausf);
    expect(r).toEqual({ ok: true, zweig: 'main', sha: mergeSha });
    expect(g(['rev-parse', '--abbrev-ref', 'HEAD'], projekt)).toBe('main');
    expect(existsSync(path.join(projekt, 'b.txt')) && existsSync(path.join(projekt, 'owner.txt'))).toBe(true);
    expect(spawnSync('git', ['config', '--local', '--get-regexp', 'http|extraheader'], { cwd: projekt, encoding: 'utf8' }).stdout.trim()).toBe(''); // kein Token/Kopf in der Projekt-Konfiguration
  });

  it('abweichender Zielzweig am Gerät: nur Vorspulen, sonst Fehler; fremde Adressen nein', async () => {
    const { remote, projekt, gitlab, ausf } = aufbau();
    g(['clone', '-q', remote, gitlab]); g(['config', 'user.name', 'gl'], gitlab); g(['config', 'user.email', 'gl@gl'], gitlab);
    writeFileSync(path.join(gitlab, 'c.txt'), 'c'); g(['add', '.'], gitlab); g(['commit', '-q', '-m', 'C'], gitlab); g(['push', '-q', 'origin', 'main'], gitlab);
    writeFileSync(path.join(projekt, 'd.txt'), 'd'); g(['add', '.'], projekt); g(['commit', '-q', '-m', 'D lokal'], projekt);
    expect(await gitAktualisieren(projekt, undefined, ADRESSE, 'main', ausf)).toMatchObject({ ok: false, fehler: expect.stringContaining('nur Vorspulen') });
    expect((await gitAktualisieren(projekt, undefined, 'file:///etc', 'main', ausf)).ok).toBe(false);
    expect((await gitAktualisieren(projekt, undefined, ADRESSE, '-x', ausf)).ok).toBe(false);
  });
});
