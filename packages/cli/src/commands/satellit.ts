import os from 'node:os';
import path from 'node:path';
import { readdirSync, statSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { exec, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { GeraetManifest, GeraetNachricht, GeraetPlattform } from '@alfred/types';
import { istPfadErlaubt, PULS_INTERVALL_MS, SHELL_TIMEOUT_MS, TRANSFER_MAX_BYTES, TRANSFER_GROSS_MAX_BYTES, sha256Hex, mimeAusName, eindeutigerName, sichererDateiname } from '@alfred/core';
import { geraetAnfrage, geraetJson } from './geraet-http.js'; // v1249
import { getVersion } from '../version.js';
import { ladeKonfig, type GeraetKonfig } from './pair.js';
import { installiereDienst, entferneDienst, dienstStatus, dienstLogPfad } from './satellit-dienst.js';
import { BrowserHand, formatiereSeite } from './satellit-browser.js';
import { SinneErfasser } from './satellit-sinne.js'; // v1237

/** v1229 — eine Browser-Hand je Satellit-Prozess (eigenes Profil, sichtbares Fenster). */
let browserHand: BrowserHand | undefined;
function browser(k: GeraetKonfig): BrowserHand {
  if (!browserHand) browserHand = new BrowserHand({ executablePath: (k as GeraetKonfig & { browserPfad?: string }).browserPfad });
  return browserHand;
}

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
      // v1235 — Dateitransfer in beide Richtungen (bis 8 MB, SHA-256, nur freigegebene Verzeichnisse)
      { name: 'datei_holen', beschreibung: 'Holt eine Datei (bis 8 MB) aus einem freigegebenen Verzeichnis dieses Geräts zum Server — kommt als Anhang zum Owner und in den Dateispeicher', autonomie: 'bestaetigen', parameter: { path: { type: 'string', description: 'Absoluter Pfad der Datei (innerhalb freigegebener Verzeichnisse)' } } },
      { name: 'datei_ablegen', beschreibung: 'Legt eine Datei vom Server in einem freigegebenen Verzeichnis dieses Geräts ab (überschreibt nie)', autonomie: 'bestaetigen', parameter: { path: { type: 'string', description: 'Zielverzeichnis oder Zielpfad (innerhalb freigegebener Verzeichnisse)' }, quelle: { type: 'string', description: 'FileStore-Schlüssel (aus „Saved to FileStore … key=…") oder Pfad der Datei am Server' } } },
      // v1229 — Browser-Hand (eigenes Alfred-Profil im Browser des Geräts, Fenster sichtbar)
      { name: 'browser_oeffnen', beschreibung: 'Öffnet eine URL im Alfred-Browser auf diesem Gerät und liefert Titel und Seitentext', autonomie: 'auto', parameter: { url: { type: 'string', description: 'URL' } } },
      { name: 'browser_lesen', beschreibung: 'Liest die aktuelle Browser-Seite: Text und nummerierte Element-Karte (Links, Buttons, Felder). Vor jedem Klicken/Tippen nötig', autonomie: 'auto' },
      { name: 'browser_klicken', beschreibung: 'Klickt Element Nr. N aus der Element-Karte. Kauf-, Bestell- und Anmelde-Elemente sind gesperrt', autonomie: 'bestaetigen', parameter: { element: { type: 'number', description: 'Nummer aus browser_lesen' } } },
      { name: 'browser_tippen', beschreibung: 'Tippt Text in Element Nr. N (Suchfeld, Formular), optional mit Enter. Passwortfelder sind gesperrt', autonomie: 'bestaetigen', parameter: { element: { type: 'number', description: 'Nummer aus browser_lesen' }, text: { type: 'string', description: 'Text' }, enter: { type: 'boolean', description: 'Enter danach' } } },
      { name: 'browser_zurueck', beschreibung: 'Eine Seite zurück', autonomie: 'auto' },
      { name: 'browser_screenshot', beschreibung: 'Screenshot der aktuellen Seite (JPEG, an den Owner)', autonomie: 'auto' },
      { name: 'browser_schliessen', beschreibung: 'Schließt den Alfred-Browser', autonomie: 'auto' },
    ],
    sinne: ['leerlauf', 'fenster', 'akku'], // v1237
  };
}

/** v1237 — Sinne alle 60 s an das Gehirn. */
export const SINNE_INTERVALL_MS = 60_000;

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
    case 'datei_holen': {
      const p = String(params.path ?? '');
      if (!istPfadErlaubt(p, frei)) return { success: false, error: `Pfad nicht freigegeben: ${p}. Freigegeben: ${frei.join(', ')}` };
      if (!existsSync(p) || !statSync(p).isFile()) return { success: false, error: `Keine Datei: ${p}` };
      const groesse = statSync(p).size;
      if (groesse > TRANSFER_GROSS_MAX_BYTES) return { success: false, error: `Datei zu groß (${groesse} B, Grenze ${TRANSFER_GROSS_MAX_BYTES} B)` };
      const data = readFileSync(p);
      const name = path.basename(p);
      const sha256 = sha256Hex(data);
      if (groesse > TRANSFER_MAX_BYTES) {
        // v1249 — blockweise über HTTPS mit Wiederaufnahme; der Server speichert und liefert den Schlüssel
        const start = await geraetJson<{ id: string; blockGroesse: number }>(k, 'POST', '/api/geraete/dateien', { name, groesse, sha256 });
        let offset = 0; let fehler = 0;
        while (offset < groesse) {
          const block = data.subarray(offset, Math.min(offset + start.blockGroesse, groesse));
          try {
            const r = await geraetAnfrage(k, 'PUT', `/api/geraete/dateien/${start.id}?offset=${offset}`, block);
            const j = JSON.parse(r.data.toString('utf8') || '{}') as { empfangen?: number; offsetFehler?: boolean; error?: string };
            if (r.status === 409 && typeof j.empfangen === 'number') { offset = j.empfangen; continue; }
            if (r.status !== 200) throw new Error(j.error ?? `HTTP ${r.status}`);
            offset = j.empfangen ?? offset + block.length;
          } catch (err) {
            if (++fehler > 5) throw err;
            try { const st = await geraetJson<{ empfangen: number }>(k, 'GET', `/api/geraete/dateien/${start.id}`); offset = st.empfangen; } catch { /* nächster Versuch */ }
            await new Promise(r => setTimeout(r, 1000 * fehler));
          }
        }
        const fertig = await geraetJson<{ key: string }>(k, 'POST', `/api/geraete/dateien/${start.id}/fertig`);
        return { success: true, data: { key: fertig.key, dateiName: name, groesse, sha256, gross: true }, display: `${name} (${groesse} B) blockweise von ${k.name} hochgeladen, gespeichert als ${fertig.key}` };
      }
      return { success: true, data: { dateiBase64: data.toString('base64'), dateiName: name, mimeType: mimeAusName(name), groesse, sha256 }, display: `${name} (${groesse} B) von ${k.name} geholt` };
    }
    case 'datei_ablegen': {
      const ziel = String(params.path ?? '');
      if (!istPfadErlaubt(ziel, frei)) return { success: false, error: `Pfad nicht freigegeben: ${ziel}. Freigegeben: ${frei.join(', ')}` };
      let inhalt = typeof params.inhaltBase64 === 'string' ? Buffer.from(params.inhaltBase64, 'base64') : undefined;
      if (!inhalt && typeof params.downloadId === 'string') {
        // v1249 — große Datei blockweise vom Server holen (Range), mit Wiederaufnahme
        const groesse = Number(params.groesse ?? 0); const blockGroesse = Number(params.blockGroesse ?? 4 * 1024 * 1024);
        if (!groesse || groesse > TRANSFER_GROSS_MAX_BYTES) return { success: false, error: 'Größe fehlt oder zu groß' };
        const teile: Buffer[] = []; let offset = 0; let fehler = 0;
        while (offset < groesse) {
          try {
            const r = await geraetAnfrage(k, 'GET', `/api/geraete/dateien/${params.downloadId}`, undefined, { headers: { Range: `bytes=${offset}-${Math.min(offset + blockGroesse, groesse) - 1}` } });
            if (r.status !== 206 || r.data.length === 0) throw new Error(`HTTP ${r.status}`);
            teile.push(r.data); offset += r.data.length;
          } catch (err) { if (++fehler > 5) throw err; await new Promise(res => setTimeout(res, 1000 * fehler)); }
        }
        inhalt = Buffer.concat(teile);
      }
      if (!inhalt) return { success: false, error: 'Kein Inhalt vom Server erhalten' };
      if (inhalt.length > TRANSFER_GROSS_MAX_BYTES) return { success: false, error: 'Datei zu groß' };
      if (typeof params.sha256 === 'string' && sha256Hex(inhalt) !== params.sha256) return { success: false, error: 'Prüfsumme stimmt nicht' };
      const istOrdner = existsSync(ziel) && statSync(ziel).isDirectory();
      const ordner = istOrdner ? ziel : path.dirname(ziel);
      if (!existsSync(ordner)) return { success: false, error: `Zielordner fehlt: ${ordner}` };
      const gewuenscht = istOrdner ? sichererDateiname(params.dateiName) : path.basename(ziel);
      const name = eindeutigerName(gewuenscht, n => existsSync(path.join(ordner, n)));
      const voll = path.join(ordner, name);
      writeFileSync(voll, inhalt, { flag: 'wx' });
      return { success: true, data: { path: voll, groesse: inhalt.length, sha256: sha256Hex(inhalt) }, display: `Abgelegt auf ${k.name}: ${voll} (${inhalt.length} B)` };
    }
    case 'hinweis': {
      const text = String(params.text ?? '');
      console.log(`\n🔔 Hinweis von Alfred: ${text}\n`);
      return { success: true, display: `Hinweis angezeigt auf ${k.name}` };
    }
    // v1229 — Browser-Hand
    case 'browser_oeffnen': {
      const s = await browser(k).oeffnen(String(params.url ?? ''));
      return { success: true, data: s, display: formatiereSeite(s) };
    }
    case 'browser_lesen': {
      const s = await browser(k).lesen();
      return { success: true, data: { url: s.url, titel: s.titel, elemente: s.elemente.length }, display: formatiereSeite(s) };
    }
    case 'browser_klicken': {
      const s = await browser(k).klicken(Number(params.element));
      return { success: true, data: { url: s.url, titel: s.titel, geklickt: s.geklickt }, display: formatiereSeite(s) };
    }
    case 'browser_tippen': {
      const s = await browser(k).tippen(Number(params.element), String(params.text ?? ''), params.enter === true || params.enter === 'true');
      return { success: true, data: { url: s.url, titel: s.titel }, display: formatiereSeite(s) };
    }
    case 'browser_zurueck': {
      const s = await browser(k).zurueck();
      return { success: true, data: { url: s.url, titel: s.titel }, display: formatiereSeite(s) };
    }
    case 'browser_screenshot': {
      const b64 = await browser(k).screenshot();
      return { success: true, data: { screenshotBase64: b64, mimeType: 'image/jpeg' }, display: 'Screenshot aufgenommen' };
    }
    case 'browser_schliessen': {
      await browser(k).schliessen();
      return { success: true, display: 'Alfred-Browser geschlossen' };
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
  const s = starteSatellit(k, { einmal: opts.einmal, log: m => console.log(m), fehler: m => console.error(m) });
  process.on('SIGINT', () => { console.log('\nSatellit beendet.'); s.stop(); process.exit(0); });
  process.on('SIGTERM', () => { s.stop(); process.exit(0); });
  await s.fertig;
}

/**
 * v1232 — Der Satellit als Funktion: Verbindung halten, Aktionen ausführen, Ereignisse melden.
 * Genutzt vom Dienst (`alfred satellit`) und von der Sitzung (`alfred sitzung`), wenn kein Dienst läuft.
 */
export function starteSatellit(k: GeraetKonfig, opts: { einmal?: boolean; log?: (zeile: string) => void; fehler?: (zeile: string) => void }): { stop: () => void; fertig: Promise<void> } {
  const log = opts.log ?? (() => undefined);
  const fehler = opts.fehler ?? log;
  const version = getVersion();
  const manifest = baueManifest(version);
  const wsUrl = k.server.replace(/^http/i, 'ws') + '/api/geraete/ws';
  let rueckzugMs = 1000;
  let laeuft = true;
  let aktiv: WebSocket | undefined;
  const sinne = new SinneErfasser({ ohneFenster: (k as GeraetKonfig & { sinneOhneFenster?: boolean }).sinneOhneFenster === true });
  const stop = () => { laeuft = false; sinne.stop(); try { aktiv?.close(); } catch { /* */ } };

  log(`Satellit ${k.name} (${manifest.plattform}, v${version}) → ${k.server}`);
  log(`Freigegebene Verzeichnisse: ${k.freigegebeneVerzeichnisse.join(', ')}`);

  const fertig = (async () => {
    while (laeuft) {
      const ende = await new Promise<string>((resolve) => {
        const ws = new WebSocket(wsUrl, { rejectUnauthorized: !k.insecure });
        aktiv = ws;
        let puls: ReturnType<typeof setInterval> | undefined;
        let sinneTimer: ReturnType<typeof setInterval> | undefined;
        const sende = (n: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: randomUUID(), zeit: new Date().toISOString(), version: 1, ...n })); };
        const sendeSinne = async () => { try { const w = await sinne.erfasse(); if (Object.keys(w).length) sende({ typ: 'sinne', werte: w }); } catch { /* nächste Minute */ } };
        ws.on('open', () => {
          sende({ typ: 'hallo', geraetId: k.geraetId, token: k.token, manifest });
          puls = setInterval(() => sende({ typ: 'puls' }), PULS_INTERVALL_MS);
          // v1237 — Sinne: sofort nach dem Willkommen, dann jede Minute
          setTimeout(() => { void sendeSinne(); }, 1500);
          sinneTimer = setInterval(() => { void sendeSinne(); }, SINNE_INTERVALL_MS);
        });
        ws.on('message', async (raw) => {
          let n: GeraetNachricht;
          try { n = JSON.parse(String(raw)) as GeraetNachricht; } catch { return; }
          if (n.typ === 'willkommen') { rueckzugMs = 1000; log(`[${new Date().toLocaleTimeString('de-AT')}] Verbunden mit Alfred ${n.serverVersion} — im Gehirn als Skill ${n.skillName}`); return; }
          if (n.typ === 'puls_ok') return;
          if (n.typ === 'fehler') { fehler(`Fehler vom Gehirn: ${n.grund}`); return; }
          if (n.typ === 'abgemeldet') { fehler(`Abgemeldet: ${n.grund}. Bitte neu koppeln (alfred pair).`); stop(); ws.close(); return; }
          if (n.typ === 'aktion') {
            const start = Date.now();
            log(`[${new Date().toLocaleTimeString('de-AT')}] Aktion ${n.aktion} ${JSON.stringify(n.params).slice(0, 160)}`);
            let r: Ergebnis;
            try { r = await fuehreAus(k, n.aktion, n.params ?? {}); } catch (err) { r = { success: false, error: (err as Error).message }; }
            sende({ typ: 'aktion_ergebnis', id: n.id, success: r.success, data: r.data, display: r.display, error: r.error, dauerMs: Date.now() - start });
            log(`  → ${r.success ? 'ok' : 'Fehler: ' + r.error}`);
          }
        });
        ws.on('close', (code, reason) => { if (puls) clearInterval(puls); if (sinneTimer) clearInterval(sinneTimer); resolve(`geschlossen (${code} ${String(reason)})`); });
        ws.on('error', (err) => { resolve(`Fehler: ${err.message}`); });
      });
      if (!laeuft || opts.einmal) break;
      log(`[${new Date().toLocaleTimeString('de-AT')}] Verbindung ${ende} — neuer Versuch in ${Math.round(rueckzugMs / 1000)} s`);
      await new Promise(r => setTimeout(r, rueckzugMs));
      rueckzugMs = Math.min(rueckzugMs * 2, 120_000);
    }
  })();
  return { stop, fertig };
}
