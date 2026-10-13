import { describe, it, expect } from 'vitest';
import { zielPruefen, zielText, zielName, nachkontrolle, DeployFreigaben, zielBestaetigt } from './deploy-ziel.js';

describe('v1437 B14 Deploy-Ziel', () => {
  it('prüft Eingaben; auto_dev nur in dev; Teiländerung behält den Rest', () => {
    const z = zielPruefen({ host: '192.168.1.96', user: 'ubuntu', process_manager: 'docker-compose', app_port: 3003, stufe: 'dev', auto_dev: true });
    expect(z).toMatchObject({ ok: true, ziel: { host: '192.168.1.96', user: 'ubuntu', prozess: 'docker-compose', appPort: 3003, stufe: 'dev', autoDev: true } });
    expect(zielPruefen({ host: 'x; rm -rf /' })).toMatchObject({ ok: false });
    expect(zielPruefen({ host: 'h', stufe: 'prod', auto_dev: true })).toMatchObject({ ok: false, fehler: expect.stringContaining('nur für die Stufe dev') });
    expect(zielPruefen({ host: 'h', app_port: 70000 }).ok).toBe(false);
    expect(zielPruefen({ host: 'h', process_manager: 'kubernetes' }).ok).toBe(false);
    const teil = zielPruefen({ app_port: 8080 }, z.ok ? z.ziel : undefined);
    expect(teil).toMatchObject({ ok: true, ziel: { host: '192.168.1.96', appPort: 8080, autoDev: true } });
    expect(zielText(z.ok ? z.ziel : ({} as never))).toBe('dev · ubuntu@192.168.1.96 · docker-compose · Port 3003 · automatisch nach grüner Abnahme');
    expect(zielName({ host: 'h', prozess: 'pm2', stufe: 'dev' }, '/home/madh/claudecode/Angebots Radar Ö')).toBe('angebots-radar-o');
  });

  it('Nachkontrolle: grün nur wenn Dienst läuft, HTTP antwortet und keine Fehlerzeilen (Zeitfilter); pm2-Logs nur Hinweis', () => {
    expect(nachkontrolle({ prozess: 'systemd', deployOk: true, status: 'Active: active (running) since …', appPort: 80, httpOk: true, logs: 'Started.\nlistening on 80' })).toMatchObject({ ok: true, gruende: [] });
    const rot = nachkontrolle({ prozess: 'docker-compose', deployOk: true, status: 'app  Restarting (1) 5 seconds ago', appPort: 3003, httpOk: false, logs: 'Error: Cannot find module "x"\nok' });
    expect(rot.ok).toBe(false);
    expect(rot.gruende).toEqual(['Dienst läuft nicht (docker-compose)', 'keine HTTP-Antwort auf Port 3003 (≈90 s gewartet)', '1 Fehlerzeile(n) in den Logs seit dem Deploy']);
    const pm2 = nachkontrolle({ prozess: 'pm2', deployOk: true, status: '│ status │ online │', logs: 'TypeError: alt' });
    expect(pm2.ok).toBe(true);
    expect(pm2.hinweise.join(' ')).toContain('pm2-Logs');
    expect(nachkontrolle({ prozess: 'pm2', deployOk: false, deployFehler: 'Git-Operation fehlgeschlagen' })).toMatchObject({ ok: false, gruende: ['Deploy fehlgeschlagen: Git-Operation fehlgeschlagen'] });
    expect(nachkontrolle({ prozess: 'systemd', deployOk: true, status: 'Active: active (running)', logs: 'build finished with 0 errors' }).ok).toBe(true);
  });

  it('Freigaben: genau einmal, nur für Projekt und Art, laufen ab', () => {
    let jetzt = 0;
    const f = new DeployFreigaben(() => jetzt);
    const n = f.stelle('p1', 'rollback', 'abc1234');
    expect(f.loese(n, 'p2', 'rollback')).toBeUndefined(); // falsches Projekt verbraucht die Kennung
    const m = f.stelle('p1', 'rollback', 'abc1234');
    expect(f.loese(m, 'p1', 'rollback')).toEqual({ commit: 'abc1234' });
    expect(f.loese(m, 'p1', 'rollback')).toBeUndefined();
    const d = f.stelle('p1', 'deploy', undefined, 1000);
    jetzt = 2000;
    expect(f.loese(d, 'p1', 'deploy')).toBeUndefined();
    expect(f.loese('deploy-geraten', 'p1', 'deploy')).toBeUndefined();
    // v1438 — 128 Bit aus dem CSPRNG; vorgeschlagenes Ziel reist mit der Kennung, gespeichert wird erst danach
    const z = f.stelle('p1', 'ziel', undefined, 1000, { host: 'h', prozess: 'pm2', stufe: 'dev', autoDev: true });
    expect(z).toMatch(/^ziel-[0-9a-f]{32}$/);
    expect(f.loese(z, 'p1', 'deploy')).toBeUndefined(); // falsche Art
    const z2 = f.stelle('p1', 'ziel', undefined, 1000, { host: 'h', prozess: 'pm2', stufe: 'dev' });
    expect(f.loese(z2, 'p1', 'ziel')).toEqual({ ziel: { host: 'h', prozess: 'pm2', stufe: 'dev' } });
    expect(zielBestaetigt({ host: 'h', bestaetigt: true })).toBe(true);
    expect(zielBestaetigt({ host: 'h', bestaetigt: 'true' })).toBe(false);
    expect(zielBestaetigt(undefined)).toBe(false);
    // die Prüfung übernimmt den Merker nie aus der Eingabe
    expect(zielPruefen({ host: 'h', bestaetigt: true })).toMatchObject({ ok: true, ziel: expect.not.objectContaining({ bestaetigt: true }) });
  });
});

import { forgeTokenFuer, tokenHinweis, aufHttps } from './deploy-ziel.js';
describe('v1439 Token-Rückfall', () => {
  const forge = { gitlab: { token: 'gl', baseUrl: 'http://git.lokalkraft.at' }, github: { token: 'gh' } };
  it('nur für den eigenen Host des Tokens', () => {
    // v1442 — nie über http; https auf dem Forge-Host ja (auch wenn die Konfig noch http nennt)
    expect(forgeTokenFuer('http://git.lokalkraft.at/madh/x.git', forge)).toBeUndefined();
    expect(forgeTokenFuer('https://git.lokalkraft.at/madh/x.git', forge)).toEqual({ token: 'gl', quelle: 'gitlab' });
    expect(forgeTokenFuer('https://GIT.lokalkraft.at/madh/x', forge)?.quelle).toBe('gitlab');
    expect(aufHttps('http://git.lokalkraft.at/madh/x', forge)).toBe('https://git.lokalkraft.at/madh/x');
    expect(aufHttps('http://anderer.example/x', forge)).toBe('http://anderer.example/x');
    expect(aufHttps('git@git.lokalkraft.at:madh/x.git', forge)).toBe('git@git.lokalkraft.at:madh/x.git');
    expect(forgeTokenFuer('https://git.lokalkraft.at.boese.example/x.git', forge)).toBeUndefined();
    expect(forgeTokenFuer('https://boese.example/git.lokalkraft.at/x.git', forge)).toBeUndefined();
    expect(forgeTokenFuer('https://github.com/madh99/alfred-ai.git', forge)).toEqual({ token: 'gh', quelle: 'github' });
    expect(forgeTokenFuer('git@git.lokalkraft.at:madh/x.git', forge)).toBeUndefined();
    expect(forgeTokenFuer('https://git.lokalkraft.at/x.git', {})).toBeUndefined();
    // v1441 — Schema muss passen
    expect(forgeTokenFuer('http://git.example/x.git', { gitlab: { token: 'gl', baseUrl: 'https://git.example' } })).toBeUndefined();
    expect(forgeTokenFuer('https://git.example/x.git', { gitlab: { token: 'gl', baseUrl: 'https://git.example' } })?.quelle).toBe('gitlab');
    expect(forgeTokenFuer('http://github.com/x/y.git', forge)).toBeUndefined();
    expect(tokenHinweis('gitlab', 'http://git.lokalkraft.at/x.git')).toContain('Konto-Token (Zugriff auf alle deine Repos)');
    expect(tokenHinweis('gitlab', 'http://git.lokalkraft.at/x.git')).toContain('unverschlüsselt');
    expect(tokenHinweis('projekt', 'https://h/x.git')).toBe('Token: Projekt-Token (Projektumgebung).');
  });
});

import { stufenAus, stufenSpeicher, naechsteStufe, STUFEN } from './deploy-ziel.js';
describe('v1443 B15 Stufen', () => {
  it('liest das Einzel-Ziel von v1437/v1438 als seine Stufe; speichert und liest je Stufe', () => {
    const alt = stufenAus({ host: 'h1', prozess: 'pm2', stufe: 'dev', autoDev: true, bestaetigt: true, letzter: { zeit: 'z', ok: true, text: 't', nachher: 'abc1234' } });
    expect(alt.dev).toMatchObject({ bestaetigt: true, ziel: { host: 'h1', prozess: 'pm2', stufe: 'dev', autoDev: true }, letzter: { nachher: 'abc1234' } });
    const st = { ...alt, test: { ziel: { host: 'h2', prozess: 'docker-compose' as const, stufe: 'test' as const, appPort: 3003 }, bestaetigt: false } };
    const roh = stufenSpeicher(st);
    const neu = stufenAus(roh);
    expect(Object.keys(neu)).toEqual(['dev', 'test']);
    expect(neu.test).toMatchObject({ bestaetigt: false, ziel: { host: 'h2', prozess: 'docker-compose', appPort: 3003, stufe: 'test' } });
    expect(neu.dev?.letzter?.nachher).toBe('abc1234');
    // ein ungültiger Eintrag (z. B. manipulierter Host) fällt weg
    expect(stufenAus({ stufen: { prod: { host: 'x; rm -rf /', prozess: 'pm2' } } }).prod).toBeUndefined();
    // auto_dev in test/prod wird nie gelesen
    expect(stufenAus({ stufen: { prod: { host: 'h', prozess: 'pm2', autoDev: true } } }).prod).toBeUndefined();
    expect(STUFEN.map(naechsteStufe)).toEqual(['test', 'prod', undefined]);
  });

  it('Freigabe trägt Stufe und Commit (Hochstufen)', () => {
    const f = new DeployFreigaben();
    const n = f.stelle('p1', 'deploy', 'abc1234', 1000, undefined, 'test');
    expect(f.loese(n, 'p1', 'deploy')).toEqual({ commit: 'abc1234', stufe: 'test' });
  });
});

import { gitlabRepoAnlegen, repoPfad } from './deploy-ziel.js';
describe('v1444 Repo anlegen', () => {
  it('Pfad aus dem Namen; privat, nur https, vorhandener Pfad wird nie überschrieben', async () => {
    expect(repoPfad('Angebots-Radar Österreich')).toBe('angebots-radar-osterreich');
    const aufrufe: Array<{ url: string; body: Record<string, unknown>; token: string }> = [];
    const ok = (async (url: string, o: RequestInit) => { aufrufe.push({ url, body: JSON.parse(String(o.body)), token: String((o.headers as Record<string, string>)['PRIVATE-TOKEN']) }); return new Response(JSON.stringify({ http_url_to_repo: 'https://git.lokalkraft.at/madh/probe.git', path_with_namespace: 'madh/probe' }), { status: 201 }); }) as unknown as typeof fetch;
    expect(await gitlabRepoAnlegen('https://git.lokalkraft.at', 'tok', 'Probe', ok)).toEqual({ ok: true, url: 'https://git.lokalkraft.at/madh/probe.git', pfad: 'madh/probe' });
    expect(aufrufe[0]).toEqual({ url: 'https://git.lokalkraft.at/api/v4/projects', body: { name: 'Probe', path: 'probe', visibility: 'private', initialize_with_readme: false }, token: 'tok' });
    const belegt = (async () => new Response(JSON.stringify({ message: { path: ['has already been taken'] } }), { status: 400 })) as unknown as typeof fetch;
    expect(await gitlabRepoAnlegen('https://git.lokalkraft.at', 'tok', 'Probe', belegt)).toMatchObject({ ok: false, fehler: expect.stringContaining('gibt es „probe“ schon') });
    expect(await gitlabRepoAnlegen('http://git.lokalkraft.at', 'tok', 'Probe', ok)).toMatchObject({ ok: false, fehler: 'GitLab nur über https' });
  });
});
