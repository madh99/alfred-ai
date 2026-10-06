import os from 'node:os';
import path from 'node:path';
import { readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { exec, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { GeraetManifest, GeraetNachricht, GeraetPlattform } from '@alfred/types';
import { istPfadErlaubt, PULS_INTERVALL_MS, SHELL_TIMEOUT_MS } from '@alfred/core';
import { getVersion } from '../version.js';
import { ladeKonfig, type GeraetKonfig } from './pair.js';
import { installiereDienst, entferneDienst, dienstStatus, dienstLogPfad } from './satellit-dienst.js';

/**
 * v1224 — `alfred satellit`: der Dienst auf dem Gerät. Hält die Verbindung zum Gehirn, meldet
 * das Manifest und führt Aktionen lokal aus — nur innerhalb freigegebener Verzeichnisse.
 * Phase 1: oeffnen (bestaetigen), shell (bestaetigen), liste (auto), hinweis (auto).
 * Spec docs/specs/2026-10-06-geraete-architektur.md.
 */
export function plattform(): GeraetPlattform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

export function SATELLIT_STANDARD_VERZEICHNISSE(): string[] {
  const h = os.homedir();
  return [path.join(h, 'Documents'), path.join(h, 'Downloads'), path.join(h, 'Desktop')];
}

export function baueManifest(version: string): GeraetManifest {
  return {
    protokoll: 1,
    plattform: plattform(),
    hostname: os.hostname(),
    satellitVersion: version,
    aktionen: [
      { name: 'oeffnen', beschreibung: 'Öffnet eine Datei, einen Ordner (im Explorer/Finder) oder eine URL auf diesem Gerät', autonomie: 'bestaetigen', parameter: { path: { type: 'string', description: 'Absoluter Pfad (innerhalb freigegebener Verzeichnisse) oder URL' } } },
      { name: 'shell', beschreibung: `Führt einen Befehl auf diesem Gerät aus — ${process.platform === 'win32' ? 'PowerShell' : 'sh'} (Arbeitsverzeichnis innerhalb freigegebener Verzeichnisse). Zum Öffnen von Dateien, Ordnern oder URLs lieber „oeffnen" nutzen.`, autonomie: 'bestaetigen', parameter: { command: { type: 'string', description: process.platform === 'win32' ? 'PowerShell-Befehl' : 'Shell-Befehl' }, cwd: { type: 'string', description: 'Arbeitsverzeichnis (optional)' } } },
      { name: 'liste', beschreibung: 'Listet ein freigegebenes Verzeichnis dieses Geräts (Namen, Größe, Datum)', autonomie: 'auto', parameter: { path: { type: 'string', description: 'Absoluter Pfad eines freigegebenen Verzeichnisses' } } },
      { name: 'hinweis', beschreibung: 'Zeigt dem Owner einen kurzen Hinweis auf diesem Gerät', autonomie: 'auto', parameter: { text: { type: 'string', description: 'Text' } } },
    ],
    sinne: [],
  };
}

type Ergebnis = { success: boolean; data?: unknown; display?: string; error?: string };

export async function fuehreAus(k: GeraetKonfig, aktion: string, params: Record<string, unknown>): Promise<Ergebnis> {
  const frei = k.freigegebeneVerzeichnisse;
  switch (aktion) {
    case 'liste': {
      const p = String(params.path ?? '');
      if (!istPfadErlaubt(p, frei)) return { success: false, error: `Pfad nicht freigegeben: ${p}. Freigegeben: ${frei.join(', ')}` };
      const eintraege = readdirSync(p).slice(0, 200).map(n => { try { const s = statSync(path.join(p, n)); return { name: n, typ: s.isDirectory() ? 'ordner' : 'datei', groesse: s.size, geaendert: s.mtime.toISOString() }; } catch { return { name: n, typ: '?' }; } });
      return { success: true, data: { path: p, eintraege }, display: `${p}: ${eintraege.length} Einträge\n` + eintraege.slice(0, 50).map(e => `- ${e.typ === 'ordner' ? '📁' : '📄'} ${e.name}`).join('\n') };
    }
    case 'oeffnen': {
      const ziel = String(params.path ?? params.url ?? '');
      const istUrl = /^https?:\/\//i.test(ziel);
      if (!istUrl && !istPfadErlaubt(ziel, frei)) return { success: false, error: `Pfad nicht freigegeben: ${ziel}. Freigegeben: ${frei.join(', ')}` };
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', ziel]] as const
        : process.platform === 'darwin' ? ['open', [ziel]] as const
        : ['xdg-open', [ziel]] as const;
      await new Promise<void>((resolve, reject) => { const c = spawn(cmd[0], [...cmd[1]], { detached: true, stdio: 'ignore', shell: false }); c.on('error', reject); c.on('spawn', () => { c.unref(); resolve(); }); });
      return { success: true, data: { ziel }, display: `Geöffnet auf ${k.name}: ${ziel}` };
    }
    case 'shell': {
      const command = String(params.command ?? '').trim();
      if (!command) return { success: false, error: 'command fehlt' };
      const cwd = params.cwd ? String(params.cwd) : frei[0];
      if (!istPfadErlaubt(cwd, frei)) return { success: false, error: `Arbeitsverzeichnis nicht freigegeben: ${cwd}` };
      // v1227 — Realfall 19:43: „Start-Process brave.exe" scheiterte, weil exec() unter Windows cmd.exe nutzt.
      // Der Owner (und das Modell) denken auf Windows in PowerShell → dort PowerShell, sonst sh.
      return await new Promise<Ergebnis>((resolve) => {
        const fertig = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const out = String(stdout).slice(0, 4000); const errOut = String(stderr).slice(0, 2000);
          if (err) resolve({ success: false, error: `${err.message}\n${errOut}`.trim(), data: { stdout: out, stderr: errOut } });
          else resolve({ success: true, data: { stdout: out, stderr: errOut, cwd }, display: out || errOut || '(keine Ausgabe)' });
        };
        const opts = { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true };
        if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], opts, fertig);
        else exec(command, { ...opts, shell: '/bin/sh' }, fertig);
      });
    }
    case 'hinweis': {
      const text = String(params.text ?? '');
      console.log(`\n🔔 Hinweis von Alfred: ${text}\n`);
      return { success: true, display: `Hinweis angezeigt auf ${k.name}` };
    }
    default:
      return { success: false, error: `Aktion unbekannt: ${aktion}` };
  }
}

export async function satellitCommand(opts: { einmal?: boolean; install?: boolean; uninstall?: boolean; status?: boolean; dienst?: boolean }): Promise<void> {
  // v1228 — Dienst-Verwaltung
  if (opts.install) { console.log(installiereDienst()); return; }
  if (opts.uninstall) { console.log(entferneDienst()); return; }
  if (opts.status) { console.log(dienstStatus()); return; }
  if (opts.dienst) {
    // Im Dienstmodus gibt es keine Konsole: alles ins Protokoll ~/.alfred/satellit.log
    mkdirSync(path.dirname(dienstLogPfad()), { recursive: true });
    const schreibe = (...args: unknown[]) => { try { appendFileSync(dienstLogPfad(), `${new Date().toISOString()} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); } catch { /* */ } };
    console.log = schreibe; console.error = schreibe;
  }
  const k = ladeKonfig();
  if (!k) { console.error('Nicht gekoppelt. Zuerst: alfred pair --server https://host:3420 --code <Code>'); process.exit(1); }
  const version = getVersion();
  const manifest = baueManifest(version);
  const wsUrl = k.server.replace(/^http/i, 'ws') + '/api/geraete/ws';
  let rueckzugMs = 1000;
  let laeuft = true;
  const stop = () => { laeuft = false; };
  process.on('SIGINT', () => { console.log('\nSatellit beendet.'); stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  console.log(`Satellit ${k.name} (${manifest.plattform}, v${version}) → ${k.server}`);
  console.log(`Freigegebene Verzeichnisse: ${k.freigegebeneVerzeichnisse.join(', ')}`);

  while (laeuft) {
    const ende = await new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl, { rejectUnauthorized: !k.insecure });
      let puls: ReturnType<typeof setInterval> | undefined;
      const sende = (n: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: randomUUID(), zeit: new Date().toISOString(), version: 1, ...n })); };
      ws.on('open', () => {
        sende({ typ: 'hallo', geraetId: k.geraetId, token: k.token, manifest });
        puls = setInterval(() => sende({ typ: 'puls' }), PULS_INTERVALL_MS);
      });
      ws.on('message', async (raw) => {
        let n: GeraetNachricht;
        try { n = JSON.parse(String(raw)) as GeraetNachricht; } catch { return; }
        if (n.typ === 'willkommen') { rueckzugMs = 1000; console.log(`[${new Date().toLocaleTimeString('de-AT')}] Verbunden mit Alfred ${n.serverVersion} — im Gehirn als Skill ${n.skillName}`); return; }
        if (n.typ === 'puls_ok') return;
        if (n.typ === 'fehler') { console.error(`Fehler vom Gehirn: ${n.grund}`); return; }
        if (n.typ === 'abgemeldet') { console.error(`Abgemeldet: ${n.grund}. Bitte neu koppeln (alfred pair).`); stop(); ws.close(); return; }
        if (n.typ === 'aktion') {
          const start = Date.now();
          console.log(`[${new Date().toLocaleTimeString('de-AT')}] Aktion ${n.aktion} ${JSON.stringify(n.params).slice(0, 160)}`);
          let r: Ergebnis;
          try { r = await fuehreAus(k, n.aktion, n.params ?? {}); } catch (err) { r = { success: false, error: (err as Error).message }; }
          sende({ typ: 'aktion_ergebnis', id: n.id, success: r.success, data: r.data, display: r.display, error: r.error, dauerMs: Date.now() - start });
          console.log(`  → ${r.success ? 'ok' : 'Fehler: ' + r.error}`);
        }
      });
      ws.on('close', (code, reason) => { if (puls) clearInterval(puls); resolve(`geschlossen (${code} ${String(reason)})`); });
      ws.on('error', (err) => { resolve(`Fehler: ${err.message}`); });
    });
    if (!laeuft || opts.einmal) break;
    console.log(`[${new Date().toLocaleTimeString('de-AT')}] Verbindung ${ende} — neuer Versuch in ${Math.round(rueckzugMs / 1000)} s`);
    await new Promise(r => setTimeout(r, rueckzugMs));
    rueckzugMs = Math.min(rueckzugMs * 2, 120_000);
  }
}
