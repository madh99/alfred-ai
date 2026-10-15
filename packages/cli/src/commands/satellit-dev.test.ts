import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startErkennen, startAngabePruefen, devStarten, devStoppen, devStand, prozessLebt, portBelegt } from './satellit-dev.js';

// v1460 — dev am Gerät: Erkennung (ohne Modell) und echter Start/Neustart/Stopp eines kleinen Servers
const neu = () => mkdtempSync(path.join(os.tmpdir(), 'alfred-dev-'));
const freierPort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

describe('v1460 Start erkennen', () => {
  it('wie Angebots-Radar: npm start, Port aus dem Code, Prüfadresse aus dem Server', () => {
    const d = neu();
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node --env-file-if-exists=.env src/start.js', test: 'node --test' } }));
    mkdirSync(path.join(d, 'src'));
    writeFileSync(path.join(d, 'src', 'start.js'), "const port = Number(process.env.PORT) || 3000;\nserver.listen(port);");
    writeFileSync(path.join(d, 'src', 'server.js'), "const GESUNDHEIT_PFAD = '/api/gesundheit';\nhttp.createServer();");
    writeFileSync(path.join(d, '.env'), 'PORT=9999\nGEHEIM=x'); // .env wird nie gelesen
    const e = startErkennen(d);
    expect(e).toMatchObject({ gefunden: true, quelle: 'erkannt', angabe: { dienst: true, start: 'npm start', port: 3000, pruefung: '/api/gesundheit' } });
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
    const r1 = await devStarten(d, a, 20_000);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.url).toMatch(new RegExp(`^http://[\\d.]+:${port}$`));
    expect((await devStand(d))).toMatchObject({ laeuft: true, antwortet: true });
    const r2 = await devStarten(d, a, 20_000);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.pid).not.toBe(r1.pid);
    expect(prozessLebt(r1.pid)).toBe(false);
    expect((await devStoppen(d)).ok).toBe(true);
    expect(prozessLebt(r2.pid)).toBe(false);
    expect(await portBelegt(port)).toBe(false);
    expect(readFileSync(path.join(d, '.alfred', 'dev.log'), 'utf8')).toContain('Alfred startet: node server.js');
  }, 60_000);

  it('fremder Prozess auf dem Port wird nie beendet; Startfehler mit Protokoll', async () => {
    const d = neu();
    const port = await freierPort();
    const s = http.createServer((_q, r) => r.end('fremd')); fremd.push(s);
    await new Promise<void>(r => s.listen(port, '127.0.0.1', () => r()));
    const r = await devStarten(d, { dienst: true, start: 'node server.js', port }, 5000);
    expect(r).toMatchObject({ ok: false, fehler: expect.stringContaining(`Port ${port} ist belegt`) });
    expect(s.listening).toBe(true);
    const k = await devStarten(neu(), { dienst: true, start: 'node gibt-es-nicht.js', port: await freierPort() }, 10_000);
    expect(k).toMatchObject({ ok: false, fehler: 'Prozess hat sich beendet' });
    expect(k.ok ? '' : k.log).toMatch(/gibt-es-nicht|Cannot find/);
  }, 60_000);
});
