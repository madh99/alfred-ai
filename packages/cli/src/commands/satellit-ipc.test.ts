import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { IpcServer, verbindeIpc, zeilenLeser, ipcPfad, type IpcNachricht } from './satellit-ipc.js';

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
      pfad,
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

  it('ohne Server: verbindeIpc liefert undefined statt zu hängen', async () => {
    const r = await verbindeIpc(() => undefined, undefined, testPfad(), 500);
    expect(r).toBeUndefined();
  });
});
