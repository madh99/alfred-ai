import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, unlinkSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * v1302 — Lokales IPC des Satelliten (Spec §8 „Anhängen statt verbinden", Owner-Freigabe 08.10. „punkt 1 und 2").
 * Der Satellit öffnet einen Unix-Socket (`~/.alfred/satellit.sock`, 0600) bzw. unter Windows eine Named Pipe
 * (`\\.\pipe\alfred-satellit-<Benutzer>`). Sitzungen und später die Desktop-App hängen sich daran und bekommen
 * Status, Ereignisse (Verbindung, Aktionen, Updates) und neue Bestätigungen sofort — statt das Protokoll per Regex
 * mitzulesen. Chat und Bestätigungsentscheidungen bleiben beim Server (HTTP mit Gerätetoken, seit v1232 bewiesen).
 * Protokoll: eine JSON-Zeile je Nachricht, in beide Richtungen.
 */
export interface SatellitStatus {
  name: string; version: string; pid: number; verbunden: boolean; serverVersion?: string; verbundenSeit?: string; aktionenLaufend: number;
}
export interface BestaetigungKurz { id: string; description: string; source?: string; skillName?: string; createdAt?: string; expiresAt?: string }
export type IpcEreignisArt = 'verbunden' | 'getrennt' | 'aktion' | 'ergebnis' | 'update' | 'hinweis' | 'nachricht'; // v1318 nachricht = Antwort vom Gehirn
export type IpcNachricht =
  | { typ: 'status'; status: SatellitStatus }
  | { typ: 'ereignis'; zeit: string; art: IpcEreignisArt; text: string }
  | { typ: 'bestaetigung'; bestaetigung: BestaetigungKurz }
  | { typ: 'befehl'; befehl: 'status' | 'beenden' | 'neuladen' | 'konfig' | 'hallo'; geheimnis?: string } // v1309 neuladen; v1312 konfig/hallo für die Desktop-App
  | { typ: 'konfig'; konfig: { server: string; geraetId: string; token: string; name: string; insecure: boolean; aktivierungswort?: string } }; // v1312 — Antwort auf befehl konfig; v1314 Aktivierungswort

export type IpcBefehl = 'status' | 'beenden' | 'neuladen' | 'konfig';

/** v1312 — Zugang für die Desktop-App (Flutter kann keine Named Pipe von Node öffnen): zusätzlich 127.0.0.1:<Port> mit Geheimnis in ~/.alfred/ipc.json (0600). */
export function ipcTcpDatei(): string { return path.join(os.homedir(), '.alfred', 'ipc.json'); }

export function ipcPfad(): string {
  if (process.platform === 'win32') {
    const nutzer = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
    return `\\\\.\\pipe\\alfred-satellit-${nutzer}`;
  }
  return path.join(os.homedir(), '.alfred', 'satellit.sock');
}

/** Zeilenweise JSON aus einem Strom: unvollständige Zeile bleibt im Puffer. */
export function zeilenLeser(aufNachricht: (n: IpcNachricht) => void): (stueck: Buffer | string) => void {
  let rest = '';
  return (stueck) => {
    rest += String(stueck);
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const zeile = rest.slice(0, i).trim(); rest = rest.slice(i + 1);
      if (!zeile) continue;
      try { aufNachricht(JSON.parse(zeile) as IpcNachricht); } catch { /* kaputte Zeile überspringen */ }
    }
  };
}

export class IpcServer {
  private server?: net.Server;
  private tcp?: net.Server;
  private readonly clients = new Set<net.Socket>();
  private geheimnis = '';
  constructor(
    private readonly statusQuelle: () => SatellitStatus,
    private readonly beiBefehl: (befehl: IpcBefehl, antworte: (n: IpcNachricht) => void) => void,
    private readonly pfad: string = ipcPfad(),
    private readonly tcpDatei: string | null = ipcTcpDatei(),
  ) {}

  get verbundene(): number { return this.clients.size; }
  /** Port des TCP-Zugangs (nach start), für Tests. */
  get tcpPort(): number | undefined { const a = this.tcp?.address(); return a && typeof a === 'object' ? a.port : undefined; }

  /** Verbindung aufnehmen; bei `geschuetzt` erst nach korrektem hallo mit Geheimnis (TCP). */
  private nimmAuf(sock: net.Socket, geschuetzt: boolean): void {
    this.clients.add(sock);
    let frei = !geschuetzt;
    const antworte = (n: IpcNachricht) => { try { sock.write(JSON.stringify(n) + '\n'); } catch { /* */ } };
    if (frei) antworte({ typ: 'status', status: this.statusQuelle() });
    sock.on('data', zeilenLeser((n) => {
      if (n.typ !== 'befehl') return;
      if (!frei) {
        if (n.befehl === 'hallo' && n.geheimnis && n.geheimnis === this.geheimnis) { frei = true; antworte({ typ: 'status', status: this.statusQuelle() }); }
        else { try { sock.destroy(); } catch { /* */ } }
        return;
      }
      if (n.befehl !== 'hallo') this.beiBefehl(n.befehl, antworte);
    }));
    sock.on('close', () => this.clients.delete(sock));
    sock.on('error', () => this.clients.delete(sock));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        try { mkdirSync(path.dirname(this.pfad), { recursive: true }); } catch { /* */ }
        if (existsSync(this.pfad)) { try { unlinkSync(this.pfad); } catch { /* */ } } // Leiche eines früheren Laufs
      }
      const server = net.createServer((sock) => this.nimmAuf(sock, false));
      server.on('error', (err) => reject(err));
      server.listen(this.pfad, () => {
        if (process.platform !== 'win32') { try { chmodSync(this.pfad, 0o600); } catch { /* */ } }
        this.server = server;
        // v1312 — TCP-Zugang für die Desktop-App: nur 127.0.0.1, zufälliger Port, Geheimnis in der Datei (0600)
        if (this.tcpDatei) {
          const tcp = net.createServer((sock) => this.nimmAuf(sock, true));
          tcp.on('error', () => { /* dann nur Pipe/Socket */ });
          tcp.listen(0, '127.0.0.1', () => {
            this.tcp = tcp;
            this.geheimnis = randomBytes(24).toString('hex');
            try { mkdirSync(path.dirname(this.tcpDatei!), { recursive: true }); writeFileSync(this.tcpDatei!, JSON.stringify({ port: this.tcpPort, geheimnis: this.geheimnis, pid: process.pid }), { mode: 0o600 }); } catch { /* */ }
            resolve();
          });
        } else resolve();
      });
    });
  }

  sende(n: IpcNachricht): void {
    const zeile = JSON.stringify(n) + '\n';
    for (const c of this.clients) { try { c.write(zeile); } catch { /* */ } }
  }

  stop(): void {
    for (const c of this.clients) { try { c.destroy(); } catch { /* */ } }
    this.clients.clear();
    try { this.server?.close(); } catch { /* */ }
    try { this.tcp?.close(); } catch { /* */ }
    if (this.tcpDatei && existsSync(this.tcpDatei)) { try { unlinkSync(this.tcpDatei); } catch { /* */ } }
    if (process.platform !== 'win32' && existsSync(this.pfad)) { try { unlinkSync(this.pfad); } catch { /* */ } }
  }
}

export interface IpcClient { sende: (n: IpcNachricht) => void; close: () => void }

/** Verbindet sich mit dem laufenden Satelliten; undefined, wenn keiner lauscht (älterer Satellit oder keiner gestartet). */
export function verbindeIpc(aufNachricht: (n: IpcNachricht) => void, beiEnde?: () => void, pfad: string = ipcPfad(), timeoutMs = 2000): Promise<IpcClient | undefined> {
  return new Promise((resolve) => {
    let entschieden = false;
    const sock = net.createConnection(pfad);
    const timer = setTimeout(() => { if (!entschieden) { entschieden = true; sock.destroy(); resolve(undefined); } }, timeoutMs);
    sock.on('connect', () => {
      if (entschieden) return;
      entschieden = true; clearTimeout(timer);
      sock.on('data', zeilenLeser(aufNachricht));
      sock.on('close', () => beiEnde?.());
      resolve({ sende: (n) => { try { sock.write(JSON.stringify(n) + '\n'); } catch { /* */ } }, close: () => { try { sock.destroy(); } catch { /* */ } } });
    });
    sock.on('error', () => { if (!entschieden) { entschieden = true; clearTimeout(timer); resolve(undefined); } });
  });
}
