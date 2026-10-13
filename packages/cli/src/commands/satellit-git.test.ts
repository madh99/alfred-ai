import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pruefeRepoUrl, ohneZugang, gitUmgebung, schwaerzeGit, gitHolen, gitPush, paramsFuerLog, type GitAusfuehren } from './satellit-git.js';

describe('v1434 B13 Git-Teil am Satelliten', () => {
  it('Repo-Adressen: https und git@ ja, Zugangsdaten/lokal/Optionen nein', () => {
    expect(pruefeRepoUrl('http://git.lokalkraft.at/madh/alfred-ai.git')).toEqual({ ok: true, url: 'http://git.lokalkraft.at/madh/alfred-ai.git' });
    expect(pruefeRepoUrl('git@github.com:madh99/alfred-ai.git').ok).toBe(true);
    expect(pruefeRepoUrl('https://oauth2:geheim@git.example/x.git')).toMatchObject({ ok: false });
    expect(pruefeRepoUrl('file:///etc/passwd').ok).toBe(false);
    expect(pruefeRepoUrl('--upload-pack=touch /tmp/x').ok).toBe(false);
    expect(pruefeRepoUrl('ext::sh -c touch% /tmp/x').ok).toBe(false);
    expect(ohneZugang('https://oauth2:abc@host/x.git')).toBe('https://host/x.git');
  });

  it('Token nur als Kopfzeile in der Umgebung; Ausgabe und Log ohne Token', () => {
    const e = gitUmgebung('tok123');
    expect(e.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(e.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('oauth2:tok123').toString('base64')}`);
    expect(gitUmgebung().GIT_CONFIG_COUNT).toBeUndefined();
    expect(schwaerzeGit(`fatal: https://oauth2:tok123@host/x tok123 ${Buffer.from('oauth2:tok123').toString('base64')}`, 'tok123')).toBe('fatal: https://***@host/x *** ***');
    expect(paramsFuerLog({ url: 'https://h/x.git', token: 'tok123' })).toBe('{"url":"https://h/x.git","token":"***"}');
  });

  it('holen und pushen gegen ein lokales Repo (git echt); Token erscheint nie in Befehlszeile oder Konfig', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'b13-'));
    const g = (args: string[], cwd?: string) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    const quelle = path.join(tmp, 'quelle');
    g(['init', '-q', '-b', 'main', quelle]);
    writeFileSync(path.join(quelle, 'README.md'), '# x\n');
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], quelle); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], quelle);
    const bare = path.join(tmp, 'bare.git');
    g(['clone', '-q', '--bare', quelle, bare]);
    // file:// ist für Owner-Adressen gesperrt — für den Test die Prüfung umgehen: lokaler Ausführer, der die Adresse ersetzt
    const aufrufe: string[][] = [];
    const echt: GitAusfuehren = async (args, cwd, env) => {
      aufrufe.push(args);
      const a = args[0] === 'clone' ? ['clone', '--', bare, args[3]!] : args;
      const r = spawnSync('git', a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
      return { status: r.status, ausgabe: `${r.stdout}${r.stderr}` };
    };
    const ziel = path.join(tmp, 'geraet', 'projekt');
    const h = await gitHolen('https://git.example/gruppe/projekt.git', ziel, 'tok123', echt);
    expect(h).toMatchObject({ ok: true, branch: 'main' });
    expect(aufrufe.flat().join(' ')).not.toContain('tok123');
    expect(readFileSync(path.join(ziel, '.git', 'config'), 'utf8')).not.toContain('tok123');
    writeFileSync(path.join(ziel, 'neu.txt'), 'etappe\n');
    g(['add', '.'], ziel); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Etappe 1: neu'], ziel);
    const p = await gitPush(ziel, 'tok123', echt);
    expect(p).toMatchObject({ ok: true, branch: 'main' });
    expect(g(['log', '--oneline', '-1', 'main'], bare).stdout).toContain('Etappe 1: neu');
    expect((await gitHolen('https://git.example/gruppe/projekt.git', ziel, undefined, echt))).toMatchObject({ ok: false, fehler: expect.stringContaining('nicht leer') });
  });
});
