import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
    const e = gitUmgebung('tok123', 'https://git.lokalkraft.at/madh/x.git');
    const cfg = Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));
    expect(cfg['http.https://git.lokalkraft.at/.extraHeader']).toBe(`Authorization: Basic ${Buffer.from('oauth2:tok123').toString('base64')}`);
    expect(cfg['http.extraHeader']).toBeUndefined(); // nie für alle Hosts
    expect(cfg).toMatchObject({ 'http.followRedirects': 'false', 'credential.helper': '' });
    expect(cfg['core.hooksPath']).toContain('alfred-keine-git-hooks');
    expect(JSON.stringify(gitUmgebung('tok123', 'git@host:x.git'))).not.toContain(Buffer.from('oauth2:tok123').toString('base64')); // ssh: kein Token
    expect(JSON.stringify(gitUmgebung())).not.toContain('extraHeader');
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
    // Push-Ausführer: nur der eigentliche push geht ans Bare-Repo (die Adressprüfung läuft gegen das echte origin)
    const echtPush: GitAusfuehren = async (args, cwd, env) => {
      const a = args[0] === 'push' ? ['push', bare, args[3]!] : args; // ohne --no-verify: die Hook-Sperre über core.hooksPath muss allein halten
      const r = spawnSync('git', a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
      return { status: r.status, ausgabe: `${r.stdout}${r.stderr}` };
    };
    const ziel = path.join(tmp, 'geraet', 'projekt');
    const h = await gitHolen('https://git.example/gruppe/projekt.git', ziel, 'tok123', echt);
    expect(h).toMatchObject({ ok: true, branch: 'main' });
    expect(aufrufe.flat().join(' ')).not.toContain('tok123');
    expect(readFileSync(path.join(ziel, '.git', 'config'), 'utf8')).not.toContain('tok123');
    g(['remote', 'set-url', 'origin', 'https://git.example/gruppe/projekt.git'], ziel);
    writeFileSync(path.join(ziel, 'neu.txt'), 'etappe\n');
    g(['add', '.'], ziel); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Etappe 1: neu'], ziel);
    // v1435 — origin umgebogen (z. B. durch Claude Code im Projekt): weder Token noch Code verlassen das Gerät
    g(['remote', 'set-url', 'origin', 'https://boese.example/raub.git'], ziel);
    expect(await gitPush(ziel, 'tok123', 'https://git.example/gruppe/projekt.git', echt)).toMatchObject({ ok: false, fehler: expect.stringContaining('nicht das Repo des Projekts') });
    g(['remote', 'set-url', 'origin', 'https://git.example/gruppe/projekt.git'], ziel);
    g(['remote', 'set-url', '--push', 'origin', 'https://boese.example/raub.git'], ziel);
    expect((await gitPush(ziel, 'tok123', 'https://git.example/gruppe/projekt.git', echt)).ok).toBe(false); // eigene pushurl zählt
    g(['config', '--unset', 'remote.origin.pushurl'], ziel);
    g(['config', 'url.https://boese.example/.insteadOf', 'https://git.example/'], ziel);
    expect((await gitPush(ziel, 'tok123', 'https://git.example/gruppe/projekt.git', echt)).ok).toBe(false); // insteadOf zählt
    g(['config', '--unset', 'url.https://boese.example/.insteadOf'], ziel);
    expect((await gitPush(ziel, 'tok123', undefined, echt)).ok).toBe(false);
    // passend: der Test-Ausführer leitet den Push auf das lokale Bare-Repo um; Hooks aus dem Projekt laufen nicht
    writeFileSync(path.join(ziel, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho HOOK > hook-lief\n', { mode: 0o755 });
    const p = await gitPush(ziel, 'tok123', 'https://git.example/gruppe/projekt.git', echtPush);
    expect(p).toMatchObject({ ok: true, branch: 'main' });
    expect(existsSync(path.join(ziel, 'hook-lief'))).toBe(false);
    expect(g(['log', '--oneline', '-1', 'main'], bare).stdout).toContain('Etappe 1: neu');
    expect((await gitHolen('https://git.example/gruppe/projekt.git', ziel, undefined, echt))).toMatchObject({ ok: false, fehler: expect.stringContaining('nicht leer') });
  });
});
