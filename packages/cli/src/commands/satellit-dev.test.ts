import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startErkennen, pruefBefehleErkennen, startAngabePruefen, devStarten, devStoppen, devStand, prozessLebt, portBelegt, registerPfad, autostartPruefen, testBereitstellen } from './satellit-dev.js';

// v1460 — dev am Gerät: Erkennung (ohne Modell) und echter Start/Neustart/Stopp eines kleinen Servers
const neu = () => mkdtempSync(path.join(os.tmpdir(), 'alfred-dev-'));
const HOME = mkdtempSync(path.join(os.tmpdir(), 'alfred-home-')); // v1462 — Register nie im echten Home
const freierPort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

describe('v1485 Prüfbefehle vorschlagen', () => {
  it('wie Heizölpreis: typecheck, lint, test; next build nie, Watch nie', () => {
    const d = neu();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev -p 3010', build: 'next build', lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', 'test:watch': 'vitest' } }));
    writeFileSync(path.join(d, 'package-lock.json'), '{}');
    const e = pruefBefehleErkennen(d);
    expect(e.befehle).toEqual(['npm run typecheck', 'npm run lint', 'npm test']);
    expect(e.quelle).toBe('package.json');
    expect(e.hinweise.join(' ')).toMatch(/next build/);
  });
  it('pnpm; build nur ohne typecheck/test; npm-Platzhalter und Watch-Test nie', () => {
    const d = neu();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'echo "Error: no test specified" && exit 1' } }));
    writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
    expect(pruefBefehleErkennen(d).befehle).toEqual(['pnpm run build']);
    const w = neu();
    writeFileSync(path.join(w, 'package.json'), JSON.stringify({ scripts: { test: 'jest --watch' } }));
    expect(pruefBefehleErkennen(w).befehle).toEqual([]);
  });
  it('Cargo, Go, pytest; leerer Ordner: nichts', () => {
    const c = neu(); writeFileSync(path.join(c, 'Cargo.toml'), '[package]');
    expect(pruefBefehleErkennen(c).befehle).toEqual(['cargo build', 'cargo test']);
    const g = neu(); writeFileSync(path.join(g, 'go.mod'), 'module x');
    expect(pruefBefehleErkennen(g).befehle).toEqual(['go vet ./...', 'go test ./...']);
    const p = neu(); writeFileSync(path.join(p, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(pruefBefehleErkennen(p).befehle[0]).toMatch(/-m pytest -q$/);
    expect(pruefBefehleErkennen(neu()).befehle).toEqual([]);
  });
});

describe('v1460 Start erkennen', () => {
  it('wie Angebots-Radar: npm start, Port aus dem Code, Prüfadresse aus dem Server', () => {
    const d = neu();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node --env-file-if-exists=.env src/start.js', test: 'node --test', 'browser:einrichten': 'node scripts/browser-einrichten.js' } }));
    mkdirSync(path.join(d, 'src'));
    writeFileSync(path.join(d, 'src', 'start.js'), "const port = Number(process.env.PORT) || 3000;\nserver.listen(port);");
    writeFileSync(path.join(d, 'src', 'server.js'), "const GESUNDHEIT_PFAD = '/api/gesundheit';\nhttp.createServer();");
    writeFileSync(path.join(d, '.env'), 'PORT=9999\nGEHEIM=x'); // .env wird nie gelesen
    const e = startErkennen(d);
    expect(e).toMatchObject({ gefunden: true, quelle: 'erkannt', angabe: { dienst: true, start: 'npm start', port: 3000, pruefung: '/api/gesundheit', einrichten: ['npm run browser:einrichten'] } });
  });
  it('Startdatei geht vor; ohne start-Skript kein Dienst; nichts → nicht gefunden', () => {
    const d = neu();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node a.js' } }));
    writeFileSync(path.join(d, '.alfred-start.json'), JSON.stringify({ dienst: true, start: 'node server.js', port: 8080, pruefung: '/ok' }));
    expect(startErkennen(d)).toMatchObject({ quelle: 'datei', angabe: { start: 'node server.js', port: 8080, pruefung: '/ok' } });
    const b = neu();
    writeFileSync(path.join(b, 'package.json'), JSON.stringify({ name: 'lib', scripts: { test: 'vitest' } }));
    expect(startErkennen(b)).toMatchObject({ gefunden: true, angabe: { dienst: false } });
    expect(startErkennen(neu()).gefunden).toBe(false);
  });
  it('Angaben prüfen: kein Zeilenumbruch, gültiger Port, Prüfadresse ab /', () => {
    expect(startAngabePruefen({ start: 'npm start', port: 3000, pruefung: '/x' })).toEqual({ dienst: true, start: 'npm start', port: 3000, pruefung: '/x' });
    expect(startAngabePruefen({ start: 'npm start\nrm -rf /' })).toBeUndefined();
    expect(startAngabePruefen({ start: 'npm start', port: 70000 })).toBeUndefined();
    expect(startAngabePruefen({ start: 'npm start', pruefung: 'http://evil' })).toEqual({ dienst: true, start: 'npm start' });
    expect(startAngabePruefen({ dienst: false })).toEqual({ dienst: false });
    expect(startAngabePruefen({ start: 'npm start', einrichten: ['npm run a', ''] })).toEqual({ dienst: true, start: 'npm start', einrichten: ['npm run a'] });
    expect(startAngabePruefen({ start: 'npm start', einrichten: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBeUndefined();
  });
});

describe('v1460 dev starten, neu starten, stoppen', () => {
  const fremd: http.Server[] = [];
  afterAll(() => { for (const s of fremd) s.close(); });

  it('startet, antwortet, Neustart ersetzt die Instanz, Stopp beendet', async () => {
    const d = neu();
    const port = await freierPort();
    writeFileSync(path.join(d, 'server.js'), "require('http').createServer((q, r) => { r.statusCode = q.url === '/ok' ? 200 : 404; r.end('ok'); }).listen(Number(process.env.PORT));");
    const a = { dienst: true, start: 'node server.js', port, pruefung: '/ok' };
    const r1 = await devStarten(d, a, 20_000, HOME);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.url).toMatch(new RegExp(`^http://[\\d.]+:${port}$`));
    expect((await devStand(d))).toMatchObject({ laeuft: true, antwortet: true });
    const r2 = await devStarten(d, a, 20_000, HOME);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.pid).not.toBe(r1.pid);
    // v1504 — unter Last (volle Testreihe) endet ein Prozess unter Windows nicht sofort: bis zu 5 s warten statt einmal nachsehen
    const bisFalsch = async (f: () => boolean | Promise<boolean>): Promise<boolean> => { for (let i = 0; i < 50; i++) { if (!(await f())) return false; await new Promise(r => setTimeout(r, 100)); } return true; };
    expect(await bisFalsch(() => prozessLebt(r1.pid))).toBe(false);
    expect((await devStoppen(d, HOME)).ok).toBe(true);
    expect(await bisFalsch(() => prozessLebt(r2.pid))).toBe(false);
    expect(await bisFalsch(() => portBelegt(port))).toBe(false);
    expect(readFileSync(path.join(d, '.alfred', 'dev.log'), 'utf8')).toContain('Alfred startet: node server.js');
  }, 60_000);

  it('fremder Prozess auf dem Port wird nie beendet; Startfehler mit Protokoll', async () => {
    const d = neu();
    const port = await freierPort();
    const s = http.createServer((_q, r) => r.end('fremd')); fremd.push(s);
    await new Promise<void>(r => s.listen(port, '127.0.0.1', () => r()));
    const r = await devStarten(d, { dienst: true, start: 'node server.js', port }, 5000, HOME);
    expect(r).toMatchObject({ ok: false, fehler: expect.stringContaining(`Port ${port} ist belegt`) });
    expect(s.listening).toBe(true);
    const k = await devStarten(neu(), { dienst: true, start: 'node gibt-es-nicht.js', port: await freierPort() }, 10_000, HOME);
    expect(k).toMatchObject({ ok: false, fehler: 'Prozess hat sich beendet' });
    expect(k.ok ? '' : k.log).toMatch(/gibt-es-nicht|Cannot find/);
  }, 60_000);
});

describe('v1462 Autostart und test am Gerät', () => {
  it('Register: Start trägt ein, tote Instanz wird wieder gestartet (höchstens 3×/h), Stopp trägt aus', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'alfred-home-'));
    const d = neu(); const port = await freierPort();
    writeFileSync(path.join(d, 'server.js'), "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT));");
    const r = await devStarten(d, { dienst: true, start: 'node server.js', port }, 20_000, home);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(JSON.parse(readFileSync(registerPfad(home), 'utf8'))).toEqual([{ dir: path.resolve(d), start: 'node server.js', port }]);
    expect(await autostartPruefen(() => undefined, home)).toBe(0); // läuft: nichts zu tun
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(r.pid), '/T', '/F']); else process.kill(-r.pid, 'SIGTERM'); // „Absturz“: ganze Gruppe weg
    for (let i = 0; i < 40 && await portBelegt(port); i++) await new Promise(x => setTimeout(x, 250));
    const zeilen: string[] = [];
    expect(await autostartPruefen(z => zeilen.push(z), home)).toBe(1);
    expect(zeilen[0]).toMatch(/läuft/);
    expect((await devStand(d)).laeuft).toBe(true);
    const t = Date.now();
    expect(await autostartPruefen(() => undefined, home, t + 1)).toBe(0); // läuft wieder
    expect((await devStoppen(d, home)).ok).toBe(true);
    expect(JSON.parse(readFileSync(registerPfad(home), 'utf8'))).toEqual([]);
  }, 90_000);

  it('test-Ordner: worktree auf dem Zweig, aktualisiert ohne Netz, .env nur aus der Umgebung test, Ordner im Projekt verboten', async () => {
    const projekt = neu();
    const g = (a: string[], cwd = projekt) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']); g(['config', 'user.name', 't']); g(['config', 'user.email', 't@t']);
    writeFileSync(path.join(projekt, 'a.txt'), 'eins'); writeFileSync(path.join(projekt, '.env'), 'GEHEIM=dev'); writeFileSync(path.join(projekt, '.gitignore'), '.env\n');
    g(['add', '.']); g(['commit', '-q', '-m', 'A']);
    const ordner = path.join(path.dirname(projekt), `${path.basename(projekt)}-test`);
    const r1 = await testBereitstellen(projekt, ordner, 'main', 'MODUS=test\n');
    expect(r1).toMatchObject({ ok: true, neu: true, installiert: false });
    expect(readFileSync(path.join(ordner, 'a.txt'), 'utf8')).toBe('eins');
    expect(readFileSync(path.join(ordner, '.env'), 'utf8')).toBe('MODUS=test\n');
    writeFileSync(path.join(projekt, 'a.txt'), 'zwei');
    writeFileSync(path.join(projekt, 'einr.js'), "require('fs').appendFileSync('einr.txt', 'x');"); writeFileSync(path.join(projekt, 'fehl.js'), 'process.exit(3);');
    g(['add', '.']); g(['commit', '-q', '-m', 'B']);
    const r2 = await testBereitstellen(projekt, ordner, 'main', undefined, ['node einr.js']);
    expect(r2).toMatchObject({ ok: true, neu: false, text: expect.stringContaining('eingerichtet') });
    expect(readFileSync(path.join(ordner, 'einr.txt'), 'utf8')).toBe('x');
    expect((await testBereitstellen(projekt, ordner, 'main', undefined, ['node einr.js'])).ok).toBe(true);
    expect(readFileSync(path.join(ordner, 'einr.txt'), 'utf8')).toBe('x'); // unverändert: nicht erneut
    expect(await testBereitstellen(projekt, ordner, 'main', undefined, ['node fehl.js'])).toMatchObject({ ok: false, fehler: expect.stringContaining('Einrichtung') });
    expect(readFileSync(path.join(ordner, 'a.txt'), 'utf8')).toBe('zwei');
    expect(readFileSync(path.join(ordner, '.env'), 'utf8')).toBe('MODUS=test\n'); // ohne neue Umgebung bleibt die alte
    expect((await testBereitstellen(projekt, path.join(projekt, 'test'), 'main')).ok).toBe(false);
    expect((await testBereitstellen(projekt, ordner, 'gibt-es-nicht')).ok).toBe(false);
    expect((await testBereitstellen(projekt, ordner, '../x')).ok).toBe(false);
    // v1463 — Realfall 15.10.: Start im worktree (.git ist dort eine Datei) brach mit ENOTDIR ab
    writeFileSync(path.join(projekt, 'server.js'), "require('http').createServer((q, r) => r.end('test')).listen(Number(process.env.PORT));"); g(['add', 'server.js']); g(['commit', '-q', '-m', 'S']);
    expect((await testBereitstellen(projekt, ordner, 'main')).ok).toBe(true);
    const port = await freierPort();
    const st = await devStarten(ordner, { dienst: true, start: 'node server.js', port }, 20_000, HOME);
    expect(st.ok).toBe(true);
    expect((await devStoppen(ordner, HOME)).ok).toBe(true);
    const fremd = neu(); writeFileSync(path.join(fremd, 'x'), '1');
    expect(await testBereitstellen(projekt, fremd, 'main')).toMatchObject({ ok: false, fehler: expect.stringContaining('kein test-Ordner von Alfred') });
    expect(existsSync(path.join(projekt, '.env')) && readFileSync(path.join(projekt, '.env'), 'utf8')).toBe('GEHEIM=dev');
  }, 60_000);
});
