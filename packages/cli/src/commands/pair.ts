import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetch as undiciFetch } from 'undici';
import { getVersion } from '../version.js';
import { baueManifest, SATELLIT_STANDARD_VERZEICHNISSE } from './satellit.js';

/**
 * v1224 — `alfred pair --server https://host:3420 --code 12345678 [--name "PC"] [--insecure]`
 * Koppelt dieses Gerät mit dem Gehirn. Der Code kommt aus der Web-GUI (Kachel Geräte) bzw.
 * POST /api/geraete/pairing-code. Das Token landet in ~/.alfred/geraet.json (nur Owner lesbar).
 */
export interface GeraetKonfig {
  server: string;
  geraetId: string;
  token: string;
  name: string;
  insecure?: boolean;
  /** Verzeichnisse mit Lese- UND Schreibrecht (liste, oeffnen, datei_holen, datei_ablegen, shell). */
  freigegebeneVerzeichnisse: string[];
  /** v1272 — Verzeichnisse nur zum Lesen (liste, oeffnen, datei_holen); aus dem Chat gepflegt. */
  nurLesen?: string[];
  /** v1276 — Fenster, die Alfred nie bedient (Titelmuster); fehlt der Eintrag, gilt die Standardliste (Banking, PayPal, Kasse …). */
  gesperrteFenster?: string[];
  /** v1281 — optional: kein Bildschirmfoto, wenn der Titel des aktiven Fensters eines dieser Muster enthält (Standard: keine Sperre). */
  fotoSperre?: string[];
  /** v1409 R3b — Claude-Code-Aufträge ohne sudo (lokale Einstellung, Owner 13.10.: „optional sperrbar") */
  sudoSperre?: boolean;
  /** v1429 R4a — lokales Veto: alle Beobachter dieses Geräts aus (Regeln bleiben am Server) */
  beobachterAus?: boolean;
  /** v1411 R3d — Vertrauensstufe „projekt": nur lokal setzbar (alfred einstellungen vertrauen …), Pfad + Ablaufzeit (ISO) */
  vertrauen?: Array<{ pfad: string; bis: string }>;
  /** v1531 — Sicherheit: gemerkter Server-Schlüssel (SHA-256 der SPKI, hex), Befehls-Schlüssel (PEM), Stufe streng */
  serverSchluessel?: string[];
  befehlsKey?: string;
  sicherheitStreng?: boolean;
  /** v1529 — Ablage-Ordner: eigene Uploads des Owners landen hier ohne Rückfrage. Fehlt der Eintrag, gilt Downloads. Nur lokal setzbar. */
  ablageOrdner?: string[];
  erlaubteProgramme: string[];
  /** v1252 — Wort fürs Zuhören (Standard „Alfred"); v1309 über die Einstellungen pflegbar. */
  aktivierungswort?: string;
  /** v1237 — Fenstertitel nicht in den Sinnen mitsenden. */
  sinneOhneFenster?: boolean;
  /** v1309 — Sitzung mit einfacher Ausgabe statt Ink starten. */
  sitzungEinfach?: boolean;
  /** v1258 — öffentlicher Release-Schlüssel des Servers (beim ersten Willkommen gemerkt). */
  releaseKey?: string;
}

export function konfigPfad(): string { return path.join(os.homedir(), '.alfred', 'geraet.json'); }

/**
 * v1225 — Sicherheitsbefund: das Gerätetoken lag im Klartext. Unter Windows wird es jetzt mit DPAPI
 * (Benutzerkontext) verschlüsselt abgelegt; nur derselbe Windows-Benutzer kann es lesen. Auf macOS und
 * Linux bleibt die Datei mit Rechten 0600; Schlüsselbund folgt mit der Desktop-App (Phase 4).
 */
function dpapi(richtung: 'protect' | 'unprotect', wert: string): string {
  const skript = richtung === 'protect'
    ? "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:ALFRED_GERAET_WERT), $null, 'CurrentUser'))"
    : "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:ALFRED_GERAET_WERT), $null, 'CurrentUser'))";
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skript], { env: { ...process.env, ALFRED_GERAET_WERT: wert }, encoding: 'utf8', windowsHide: true }).trim();
}

export function ladeKonfig(): GeraetKonfig | undefined {
  const p = konfigPfad();
  if (!existsSync(p)) return undefined;
  try {
    const k = JSON.parse(readFileSync(p, 'utf8')) as GeraetKonfig & { tokenGeschuetzt?: string };
    if (!k.token && k.tokenGeschuetzt?.startsWith('dpapi:')) k.token = dpapi('unprotect', k.tokenGeschuetzt.slice(6));
    return k;
  } catch { return undefined; }
}

export function speichereKonfig(k: GeraetKonfig): void {
  const p = konfigPfad();
  mkdirSync(path.dirname(p), { recursive: true });
  const ablage: Record<string, unknown> = { ...k };
  if (process.platform === 'win32') {
    try { ablage.tokenGeschuetzt = 'dpapi:' + dpapi('protect', k.token); delete ablage.token; } catch { /* DPAPI nicht verfügbar → Klartext mit 0600 */ }
  }
  writeFileSync(p, JSON.stringify(ablage, null, 2), { mode: 0o600 });
}

export async function pairCommand(opts: { server?: string; code?: string; name?: string; insecure?: boolean; verzeichnisse?: string; schluessel?: string }): Promise<void> {
  if (!opts.server || !opts.code) {
    console.error('Nutzung: alfred pair --server https://host:3420 --code 12345678 [--schluessel <Server-Schlüssel aus der Web-Oberfläche>] [--name "Mein PC"] [--insecure] [--verzeichnisse "C:\\Users\\me\\Documents;D:\\Projekte"]');
    process.exit(1);
  }
  const server = opts.server.replace(/\/+$/, '');
  const name = opts.name ?? os.hostname();
  const freigegebene = (opts.verzeichnisse ? opts.verzeichnisse.split(/[;,]/).map(s => s.trim()).filter(Boolean) : SATELLIT_STANDARD_VERZEICHNISSE());
  // v1291 — Realfall Office-VM: PowerShell klebte zwei kommagetrennte Argumente mit Leerzeichen zusammen → ein Pfad, der nicht existiert
  for (const v of freigegebene) {
    if (!existsSync(v)) console.error(`  WARNUNG: Verzeichnis existiert nicht: ${v} — in PowerShell die Liste in EIN Anführungszeichenpaar setzen, Trenner ; oder ,`);
  }
  const manifest = baueManifest(getVersion());
  // v1531 — Server-Schlüssel schon beim Koppeln merken und anzeigen (wie die Handy-App): danach nur noch dieser Server
  let pin: string | undefined;
  try {
    const u = new URL(server);
    if (u.protocol === 'https:') {
      const { connect } = await import('node:tls');
      const { spkiHex } = await import('@alfred/core');
      pin = await new Promise<string>((ok, fehl) => { const s = connect({ host: u.hostname, port: Number(u.port || 443), servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: !opts.insecure }, () => { const c = s.getPeerCertificate(true); s.end(); c?.raw ? ok(spkiHex(c.raw)) : fehl(new Error('kein Zertifikat')); }); s.once('error', fehl); });
      console.log(`Server-Schlüssel: ${pin.match(/.{1,4}/g)!.slice(0, 4).join(' ')} … (wird gemerkt; ein anderer Server wird später abgelehnt)`);
    }
  } catch (err) { console.error(`Server-Schlüssel nicht lesbar: ${(err as Error).message}`); }
  // v1533 — erwarteter Schlüssel aus der Web-Oberfläche (der fertige Befehl dort enthält ihn): passt er nicht, wird nicht gekoppelt
  const erwartet = schluesselNormal(opts.schluessel);
  if (opts.schluessel !== undefined) {
    if (erwartet.length < 16) { console.error('--schluessel: mindestens 16 Hex-Zeichen (so wie in der Web-Oberfläche angezeigt)'); process.exit(1); }
    if (!pin) { console.error('Server-Schlüssel nicht lesbar — nicht gekoppelt'); process.exit(1); }
    if (!pin.startsWith(erwartet)) { console.error(`ABBRUCH: Der Server legt einen anderen Schlüssel vor (${pin.slice(0, 16)}… statt ${erwartet.slice(0, 16)}…). Nicht gekoppelt — ist das wirklich dein Alfred-Server?`); process.exit(1); }
    console.log('Server-Schlüssel stimmt mit der Web-Oberfläche überein ✓');
  }
  // v1533 — die Kopplung selbst läuft über eine Verbindung, die genau diesen Schlüssel erzwingt (kein Wechsel zwischen Prüfung und Anfrage)
  const daten = JSON.stringify({ code: opts.code.trim(), name, manifest });
  let status = 0; let body: { ok?: boolean; id?: string; token?: string; name?: string; skillName?: string; grund?: string; error?: string } = {};
  if (pin) {
    const { tlsOptionen } = await import('./satellit-sicherheit.js');
    const https = await import('node:https');
    const pruef = { server, geraetId: '', token: '', name, insecure: !!opts.insecure, freigegebeneVerzeichnisse: [], erlaubteProgramme: [], serverSchluessel: [pin], sicherheitStreng: true } as GeraetKonfig;
    ({ status, body } = await new Promise<{ status: number; body: typeof body }>((ok, fehl) => {
      const req = https.request(`${server}/api/geraete/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(daten) }, ...tlsOptionen(pruef), timeout: 30_000 }, (res) => {
        const teile: Buffer[] = []; res.on('data', (c: Buffer) => teile.push(c));
        res.on('end', () => { try { ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(teile).toString('utf8')) }); } catch { ok({ status: res.statusCode ?? 0, body: {} }); } });
      });
      req.on('error', fehl); req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung'))); req.end(daten);
    }));
  } else {
    // nur noch für http (ohne TLS); bei https ohne lesbaren Schlüssel wird nicht gekoppelt
    if (/^https:/i.test(server)) { console.error('Server-Schlüssel nicht lesbar — nicht gekoppelt'); process.exit(1); }
    const res = await undiciFetch(`${server}/api/geraete/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: daten });
    status = res.status; body = await res.json() as typeof body;
  }
  if (status < 200 || status >= 300 || !body.ok || !body.id || !body.token) {
    console.error(`Pairing fehlgeschlagen: ${body.grund ?? body.error ?? status}`);
    process.exit(1);
  }
  speichereKonfig({ server, geraetId: body.id, token: body.token, name: body.name ?? name, insecure: !!opts.insecure, freigegebeneVerzeichnisse: freigegebene, erlaubteProgramme: [], ...(pin ? { serverSchluessel: [pin] } : {}) });
  console.log(`Gekoppelt: ${body.name} → ${server} (Skill im Gehirn: ${body.skillName})`);
  console.log(`Konfiguration: ${konfigPfad()}`);
  console.log(`Freigegebene Verzeichnisse: ${freigegebene.join(', ')}`);
  console.log('Starte den Satelliten mit: alfred satellit');
}

/** v1533 — Schlüssel aus der Anzeige („75ed 3a0b c4f2 6c96 …“) oder ganz: nur Hex, klein. */
export function schluesselNormal(t: string | undefined): string { return (t ?? '').toLowerCase().replace(/[^0-9a-f]/g, ''); }
