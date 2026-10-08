import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { IpcServer, verbindeIpc, zeilenLeser, ipcPfad, type IpcNachricht } from './satellit-ipc.js';

const warteKurz = (ms: number) => new Promise(r => setTimeout(r, ms));
const testPfad = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\alfred-ipc-test-${process.pid}-${Date.now()}`
  : path.join(os.tmpdir(), `alfred-ipc-test-${process.pid}-${Date.now()}.sock`);

describe('Satellit-IPC (v1302)', () => {
  it('zeilenLeser: JSON je Zeile, Teilstücke werden zusammengesetzt, Müll übersprungen', () => {
    const got: IpcNachricht[] = [];
    const lies = zeilenLeser(n => got.push(n));
    lies('{"typ":"befehl","befe');
    lies('hl":"status"}\nkaputt\n{"typ":"ereignis","zeit":"t","art":"hinweis","text":"x"}\n');
    expect(got.map(n => n.typ)).toEqual(['befehl', 'ereignis']);
  });

  it('ipcPfad ist benutzerbezogen', () => {
    expect(ipcPfad()).toMatch(process.platform === 'win32' ? /^\\\\\.\\pipe\\alfred-satellit-/ : /\.alfred[\\/]satellit\.sock$/);
  });

  it('Server schickt Status beim Verbinden, beantwortet Befehle und sendet Ereignisse an alle', async () => {
    const pfad = testPfad();
    const befehle: string[] = [];
    const server = new IpcServer(
      () => ({ name: 'Test', version: '1', pid: process.pid, verbunden: true, serverVersion: '9', aktionenLaufend: 0 }),
      (b, antworte) => { befehle.push(b); if (b === 'status') antworte({ typ: 'ereignis', zeit: 't', art: 'hinweis', text: 'status erneut' }); },
      pfad, null, // kein TCP-Zugang: sonst überschriebe der Test die ipc.json des echten Satelliten
    );
    await server.start();
    const got: IpcNachricht[] = [];
    const warte = (n: number) => new Promise<void>((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (got.length >= n) { clearInterval(t); res(); } else if (Date.now() - t0 > 3000) { clearInterval(t); rej(new Error('timeout ' + got.length)); } }, 10); });
    const client = await verbindeIpc(n => got.push(n), undefined, pfad);
    expect(client).toBeDefined();
    await warte(1);
    expect(got[0]).toMatchObject({ typ: 'status', status: { name: 'Test', verbunden: true, serverVersion: '9' } });
    client!.sende({ typ: 'befehl', befehl: 'status' });
    await warte(2);
    expect(befehle).toEqual(['status']);
    expect(got[1]).toMatchObject({ typ: 'ereignis', text: 'status erneut' });
    server.sende({ typ: 'bestaetigung', bestaetigung: { id: 'b1', description: 'Darf ich?' } });
    await warte(3);
    expect(got[2]).toMatchObject({ typ: 'bestaetigung', bestaetigung: { id: 'b1' } });
    expect(server.verbundene).toBe(1);
    client!.close();
    server.stop();
  });

  it('v1312: TCP-Zugang nur mit Geheimnis aus der Datei; falsches Geheimnis trennt', async () => {
    const pfad = testPfad();
    const datei = path.join(os.tmpdir(), `alfred-ipc-${process.pid}-${Date.now()}.json`);
    const server = new IpcServer(() => ({ name: 'T', version: '1', pid: 1, verbunden: false, aktionenLaufend: 0 }), (b, antworte) => { if (b === 'konfig') antworte({ typ: 'konfig', konfig: { server: 'https://s', geraetId: 'g', token: 'tok', name: 'T', insecure: true } }); }, pfad, datei);
    await server.start();
    const info = JSON.parse((await import('node:fs')).readFileSync(datei, 'utf8')) as { port: number; geheimnis: string };
    expect(info.port).toBe(server.tcpPort);
    const net = await import('node:net');
    const lies = (sock: import('node:net').Socket, n: number) => new Promise<string[]>((res) => { const zeilen: string[] = []; let rest = ''; sock.on('data', (d) => { rest += String(d); const t = rest.split('\n'); rest = t.pop() ?? ''; zeilen.push(...t.filter(Boolean)); if (zeilen.length >= n) res(zeilen); }); setTimeout(() => res(zeilen), 1500); });
    const gut = net.createConnection({ host: '127.0.0.1', port: info.port });
    await new Promise<void>(r => gut.on('connect', () => r()));
    const antworten = lies(gut, 2);
    gut.write(JSON.stringify({ typ: 'befehl', befehl: 'hallo', geheimnis: info.geheimnis }) + '\n');
    await warteKurz(100);
    gut.write(JSON.stringify({ typ: 'befehl', befehl: 'konfig' }) + '\n');
    const z = await antworten;
    expect(JSON.parse(z[0]!).typ).toBe('status');
    expect(JSON.parse(z[1]!)).toMatchObject({ typ: 'konfig', konfig: { token: 'tok' } });
    gut.destroy();
    const boese = net.createConnection({ host: '127.0.0.1', port: info.port });
    await new Promise<void>(r => boese.on('connect', () => r()));
    const zu = new Promise<boolean>(r => { boese.on('close', () => r(true)); setTimeout(() => r(false), 1500); });
    boese.write(JSON.stringify({ typ: 'befehl', befehl: 'hallo', geheimnis: 'falsch' }) + '\n');
    expect(await zu).toBe(true);
    server.stop();
    expect((await import('node:fs')).existsSync(datei)).toBe(false);
  });

  it('ohne Server: verbindeIpc liefert undefined statt zu hängen', async () => {
    const r = await verbindeIpc(() => undefined, undefined, testPfad(), 500);
    expect(r).toBeUndefined();
  });
});
