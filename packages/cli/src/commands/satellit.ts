import os from 'node:os';
import path from 'node:path';
import { readdirSync, statSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { exec, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { GeraetManifest, GeraetNachricht, GeraetPlattform } from '@alfred/types';
import { istPfadErlaubt, PULS_INTERVALL_MS, SHELL_TIMEOUT_MS, TRANSFER_MAX_BYTES, TRANSFER_GROSS_MAX_BYTES, sha256Hex, mimeAusName, eindeutigerName, sichererDateiname } from '@alfred/core';
import { geraetAnfrage, geraetJson } from './geraet-http.js'; // v1249
import { aktualisiereWennNeuer, bestaetigeAktuell, merkeReleaseKey, NEUSTART_CODE, ladeAktuell } from './satellit-update.js'; // v1258
import { vergleicheVersion, raeumeVersionen } from '@alfred/core';
import { getVersion } from '../version.js';
import { ladeKonfig, speichereKonfig, konfigPfad, type GeraetKonfig } from './pair.js';
import { cliOrdner } from './satellit-update.js'; // v1274
import { installiereDienst, entferneDienst, dienstStatus, dienstLogPfad, laeuftErhoeht } from './satellit-dienst.js';
import { installiereStarter } from './satellit-starter.js'; // v1304
import { BrowserHand, formatiereSeite } from './satellit-browser.js';
import { SinneErfasser } from './satellit-sinne.js'; // v1237
import { bildschirmfoto, aktivesFensterTitel } from './satellit-bildschirm.js'; // v1268, v1281
import { fensterListe, programmStarten, fensterVordergrund } from './satellit-fenster.js'; // v1271
import { zwischenablageLesen, zwischenablageSetzen, ZWISCHENABLAGE_MAX_ZEICHEN } from './satellit-zwischenablage.js'; // v1273
import { benachrichtigungen } from './satellit-benachrichtigungen.js'; // v1275
import { Bedienung, GESPERRTE_FENSTER_STANDARD } from './satellit-bedienen.js'; // v1276
import { IpcServer, type IpcEreignisArt, type SatellitStatus } from './satellit-ipc.js'; // v1302
import { heimInParams } from './satellit-pfad.js'; // v1303
import { outlookVorhanden, excelVorhanden, outlookPosteingang, outlookMailLesen, outlookEntwurf, outlookSenden, outlookTermine, outlookTerminAnlegen, excelLesen, excelSchreiben } from './satellit-office.js'; // v1292

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
      // v1273 — Zwischenablage (Lesen mit Bestätigung: oft Passwörter oder Vertrauliches)
      { name: 'zwischenablage_lesen', beschreibung: 'Liest den Text in der Zwischenablage dieses Geräts (für „was habe ich kopiert", „nimm den Text aus der Zwischenablage")', autonomie: 'bestaetigen' },
      { name: 'zwischenablage_setzen', beschreibung: 'Legt Text in die Zwischenablage dieses Geräts („kopier mir das in die Zwischenablage")', autonomie: 'auto', parameter: { text: { type: 'string', description: 'Text' } } },
      // v1276 — Bedienen Stufe A (Windows UIA, v1283 auch macOS Accessibility): Element-Karte, kein blinder Mausklick
      ...(process.platform === 'win32' || process.platform === 'darwin' ? [
        { name: 'fenster_lesen', beschreibung: 'Nummerierte Element-Karte des aktiven Fensters (oder nach Titel): Buttons, Felder, Menüs, Tabs mit Name, Wert, Zustand. Vor jedem element_klicken/tippen nötig, nach jeder Aktion erneut (Karte verfällt). Mehrschrittig: zuerst action=vorhaben mit den Bedien-Aktionen.', autonomie: 'auto' as const, parameter: { titel: { type: 'string', description: 'Teil des Fenstertitels oder Programmname (optional, sonst das aktive Fenster)' } } },
        { name: 'element_klicken', beschreibung: 'Betätigt Element Nr. N aus der Element-Karte (Button, Menü, Tab, Kontrollkästchen) über die Bedienhilfen — kein Mausklick. Kauf-, Zahlungs-, Banking-Fenster sind gesperrt.', autonomie: 'bestaetigen' as const, parameter: { nr: { type: 'number', description: 'Nummer aus fenster_lesen' } } },
        { name: 'tippen', beschreibung: 'Tippt Text in Element Nr. N (Eingabefeld, Dokument), optional mit Enter. Passwortfelder sind gesperrt.', autonomie: 'bestaetigen' as const, parameter: { nr: { type: 'number', description: 'Nummer aus fenster_lesen' }, text: { type: 'string', description: 'Text' }, enter: { type: 'boolean', description: 'danach Enter' } } },
        { name: 'taste', beschreibung: process.platform === 'darwin' ? 'Tastenkombination im aktiven Programm, z. B. cmd+s, cmd+q, enter, cmd+shift+t (cmd ist die Mac-Taste, strg = control). Zeichen wie * + / = direkt angeben, nicht shift+Ziffer (deutsches Layout)' : 'Tastenkombination im aktiven Fenster, z. B. strg+s, alt+f4, enter, strg+shift+t, f5. Zeichen wie * + / = direkt angeben, nicht shift+Ziffer', autonomie: 'bestaetigen' as const, parameter: { kombi: { type: 'string', description: process.platform === 'darwin' ? 'z. B. cmd+s' : 'z. B. strg+s' } } },
        { name: 'klicken_bei', beschreibung: 'Rückfall ohne Element-Karte: Mausklick an einer Stelle des LETZTEN Bildschirmfotos (x, y in Fotopixeln). Nur wenn das Ziel keine Nummer hat. Klickt nur ins Vordergrundfenster; danach neues Foto zur Kontrolle.', autonomie: 'bestaetigen' as const, parameter: { x: { type: 'number', description: 'x im letzten Foto' }, y: { type: 'number', description: 'y im letzten Foto' }, doppelt: { type: 'boolean', description: 'Doppelklick' } } },
      ] : []),
      // v1275 — Systembenachrichtigungen (Bestätigung: Nachrichtenvorschauen, Codes)
      ...(process.platform === 'linux' ? [] : [{ name: 'benachrichtigungen', beschreibung: 'Liest die letzten Systembenachrichtigungen dieses Geräts (App, Zeit, Titel, Text) — für „was ist an Meldungen gekommen", „habe ich etwas verpasst"', autonomie: 'bestaetigen' as const, parameter: { stunden: { type: 'number', description: 'Zeitraum in Stunden (Standard 24)' }, anzahl: { type: 'number', description: 'Höchstens so viele (Standard 20)' } } }]),
      // v1272 — Freigaben aus dem Chat
      { name: 'freigaben', beschreibung: 'Zeigt die freigegebenen Verzeichnisse dieses Geräts mit Recht (lesen + schreiben / nur lesen)', autonomie: 'auto' },
      { name: 'freigabe_aendern', beschreibung: 'Gibt ein Verzeichnis frei oder entzieht die Freigabe: recht=lesen (liste, öffnen, holen), schreiben (zusätzlich ablegen, shell) oder keins (entfernen). Gilt sofort und dauerhaft.', autonomie: 'bestaetigen', parameter: { pfad: { type: 'string', description: 'Absoluter Pfad des Verzeichnisses (oder ~/…)' }, recht: { type: 'string', description: 'lesen | schreiben | keins' } } },
      // v1271 — Programme und Fenster
      { name: 'fenster', beschreibung: 'Listet die offenen Fenster dieses Geräts (Titel, Programm) — für „was ist offen", „welche Programme laufen"', autonomie: 'auto' },
      { name: 'fenster_vordergrund', beschreibung: 'Holt ein offenes Fenster in den Vordergrund (Suchtext im Titel oder Programmname)', autonomie: 'auto', parameter: { titel: { type: 'string', description: 'Teil des Fenstertitels oder Programmname, z. B. Outlook' } } },
      { name: 'programm_starten', beschreibung: 'Startet ein Programm auf diesem Gerät (Name im Pfad, App-Name unter macOS, oder voller Pfad), optional mit Argumenten', autonomie: 'bestaetigen', parameter: { programm: { type: 'string', description: 'Programmname oder Pfad, z. B. notepad, outlook, Safari' }, argumente: { type: 'string', description: 'Argumente, durch Leerzeichen getrennt (optional)' } } },
      // v1268 — Bildschirm sehen: das Modell bekommt das Bild zu sehen und kann es beschreiben
      { name: 'bildschirm', beschreibung: 'Bildschirmfoto dieses Geräts (ganzer Bildschirm oder aktives Fenster). Alfred SIEHT das Bild danach selbst — für „was ist auf meinem Bildschirm", „was ist das für ein Fehler". Mit markieren=true trägt es die Nummern der letzten Element-Karte ein (Windows).', autonomie: 'auto', parameter: { bereich: { type: 'string', description: 'alles (alle Monitore, Standard) oder fenster (nur das aktive Fenster)' }, markieren: { type: 'boolean', description: 'Nummern der Element-Karte (fenster_lesen) ins Bild zeichnen' } } },
      { name: 'browser_schliessen', beschreibung: 'Schließt den Alfred-Browser', autonomie: 'auto' },
      // v1292 — Office über COM (nur Windows mit klassischem Outlook-Profil bzw. Excel): Schnittstelle statt Oberfläche
      ...(outlookVorhanden() ? [
        { name: 'outlook_mails', beschreibung: 'Liest Outlook auf diesem Gerät: ohne id die neuesten Mails des Posteingangs (Absender, Betreff, Vorschau; optional nur ungelesen, Suchtext, Ordner), mit id eine Mail vollständig', autonomie: 'auto' as const, parameter: { id: { type: 'string', description: 'EntryID aus der Liste → ganze Mail lesen' }, anzahl: { type: 'number', description: 'Anzahl (Standard 15, max 50)' }, ungelesen: { type: 'boolean', description: 'nur ungelesene' }, suche: { type: 'string', description: 'Text in Betreff oder Absender' }, ordner: { type: 'string', description: 'posteingang (Standard), entwuerfe, gesendet' } } },
        { name: 'outlook_entwurf', beschreibung: 'Legt in Outlook einen Mail-Entwurf an (neu oder Antwort auf id) — gespeichert und geöffnet, NICHT gesendet. Senden ist ein eigener Schritt (outlook_senden).', autonomie: 'bestaetigen' as const, parameter: { an: { type: 'string', description: 'Empfänger (bei Antwort leer lassen)' }, betreff: { type: 'string', description: 'Betreff' }, text: { type: 'string', description: 'Mailtext' }, cc: { type: 'string', description: 'CC (optional)' }, antwortAuf: { type: 'string', description: 'EntryID der Mail, auf die geantwortet wird (optional)' }, anhaenge: { type: 'string', description: 'Dateipfade aus freigegebenen Verzeichnissen, durch ; getrennt (optional)' } } },
        { name: 'outlook_senden', beschreibung: 'Sendet einen vorhandenen Outlook-Entwurf (id aus outlook_entwurf oder Ordner entwuerfe)', autonomie: 'bestaetigen' as const, parameter: { id: { type: 'string', description: 'EntryID des Entwurfs' } } },
        { name: 'outlook_termine', beschreibung: 'Liest Termine aus dem Outlook-Kalender dieses Geräts (Standard: heute bis in 7 Tagen, Serien aufgelöst)', autonomie: 'auto' as const, parameter: { von: { type: 'string', description: 'Datum JJJJ-MM-TT (Standard heute)' }, bis: { type: 'string', description: 'Datum JJJJ-MM-TT (Standard heute + 7)' }, anzahl: { type: 'number', description: 'max. Anzahl (Standard 40)' } } },
        { name: 'outlook_termin_anlegen', beschreibung: 'Legt einen Termin im Outlook-Kalender an (gespeichert; Einladungen an Teilnehmer werden NICHT versendet)', autonomie: 'bestaetigen' as const, parameter: { betreff: { type: 'string', description: 'Betreff' }, start: { type: 'string', description: 'Beginn JJJJ-MM-TT HH:MM' }, ende: { type: 'string', description: 'Ende JJJJ-MM-TT HH:MM' }, ort: { type: 'string', description: 'Ort (optional)' }, text: { type: 'string', description: 'Notiz (optional)' }, teilnehmer: { type: 'string', description: 'Teilnehmer-Adressen, durch ; getrennt (optional)' } } },
      ] : []),
      ...(excelVorhanden() ? [
        { name: 'excel_lesen', beschreibung: 'Liest einen Bereich aus einer Excel-Datei in einem freigegebenen Verzeichnis (unsichtbar, nur lesend; max. 200 Zeilen × 30 Spalten)', autonomie: 'auto' as const, parameter: { datei: { type: 'string', description: 'Pfad der .xlsx' }, blatt: { type: 'string', description: 'Blattname (Standard erstes Blatt)' }, bereich: { type: 'string', description: 'z. B. A1:F20 (Standard: benutzter Bereich)' } } },
        { name: 'excel_schreiben', beschreibung: 'Schreibt einen Wert in eine Zelle einer Excel-Datei in einem freigegebenen Verzeichnis mit Schreibrecht und speichert', autonomie: 'bestaetigen' as const, parameter: { datei: { type: 'string', description: 'Pfad der .xlsx' }, blatt: { type: 'string', description: 'Blattname (optional)' }, zelle: { type: 'string', description: 'z. B. B7' }, wert: { type: 'string', description: 'Wert oder Formel (=SUMME(…))' } } },
      ] : []),
    ],
    sinne: ['leerlauf', 'fenster', 'akku'], // v1237
  };
}

/** v1237 — Sinne alle 60 s an das Gehirn. */
export const SINNE_INTERVALL_MS = 60_000;

type Ergebnis = { success: boolean; data?: unknown; display?: string; error?: string };

// v1276 — Bedienen (Stufe A): ein Zustand je Satellit (letzte Element-Karte, Notbremse)
let bedienung: Bedienung | undefined;
// v1281 — Geometrie des letzten Bildschirmfotos (für klicken_bei: Fotokoordinaten → Bildschirm)
let letztesFoto: { region: { x: number; y: number; w: number; h: number }; skala: number; zeit: number; breite: number; hoehe: number } | undefined;
function bedienen(k: GeraetKonfig): Bedienung {
  if (!bedienung) bedienung = new Bedienung(k.gesperrteFenster ?? GESPERRTE_FENSTER_STANDARD);
  return bedienung;
}

/**
 * v1274 — Entkoppeln: Kopplung (geraet.json), installierte Versionen (~/.alfred/cli) und den Autostart-Dienst entfernen,
 * dann beenden. Reihenfolge: erst die Dateien, dann der Dienst — der Dienst-Stopp kann diesen Prozess selbst beenden.
 */
export function entkoppleLokal(): string[] {
  const schritte: string[] = [];
  try { if (existsSync(konfigPfad())) { rmSync(konfigPfad(), { force: true }); schritte.push('Kopplung entfernt (geraet.json)'); } } catch (err) { schritte.push(`geraet.json nicht entfernt: ${(err as Error).message}`); }
  try { if (existsSync(cliOrdner())) { rmSync(cliOrdner(), { recursive: true, force: true }); schritte.push('installierte Versionen entfernt (~/.alfred/cli)'); } } catch (err) { schritte.push(`~/.alfred/cli nicht entfernt: ${(err as Error).message}`); }
  try { schritte.push(entferneDienst()); } catch (err) { schritte.push(`Dienst nicht entfernt: ${(err as Error).message}`); }
  return schritte;
}

export async function fuehreAus(k: GeraetKonfig, aktion: string, params: Record<string, unknown>): Promise<Ergebnis> {
  const frei = k.freigegebeneVerzeichnisse;
  const lesbar = [...frei, ...(k.nurLesen ?? [])]; // v1272 — Leserecht: freigegebene plus nur-lesen
  heimInParams(params); // v1303 — „~/Downloads" → Home-Verzeichnis, sonst scheitert die Rechteprüfung an der Tilde
  switch (aktion) {
    // v1276 — Bedienen Stufe A
    case 'fenster_lesen': {
      const karte = await bedienen(k).fensterLesen(params.titel ? String(params.titel) : undefined);
      return { success: true, data: { fenster: karte.fenster, programm: karte.programm, karte: karte.hash, elemente: karte.elemente.map(e => ({ nr: e.nr, typ: e.typ, name: e.name, wert: e.wert ?? undefined, zustand: e.zustand ?? undefined, passwort: e.passwort || undefined })) }, display: Bedienung.formatiere(karte) };
    }
    case 'element_klicken': {
      const r = await bedienen(k).klicken(Number(params.nr));
      return { success: true, data: { nr: r.element.nr, name: r.element.name, wie: r.wie, fenster: r.fenster }, display: `Betätigt: ${r.element.nr}. [${r.element.typ}] ${r.element.name} (${r.wie}) — Fenster jetzt „${r.fenster}". Karte verfallen: fenster_lesen vor dem nächsten Schritt.` };
    }
    case 'tippen': {
      const r = await bedienen(k).tippen(Number(params.nr), String(params.text ?? ''), params.enter === true || params.enter === 'true');
      return { success: true, data: { nr: r.element.nr, name: r.element.name, wie: r.wie, fenster: r.fenster }, display: `Getippt in ${r.element.nr}. [${r.element.typ}] ${r.element.name} (${r.wie}). Karte verfallen: fenster_lesen vor dem nächsten Schritt.` };
    }
    case 'klicken_bei': {
      if (!letztesFoto || Date.now() - letztesFoto.zeit > 60_000) return { success: false, error: 'Kein frisches Bildschirmfoto (höchstens 60 s alt) — erst bildschirm, dann klicken_bei' };
      const px = Number(params.x), py = Number(params.y);
      if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > letztesFoto.breite || py > letztesFoto.hoehe) return { success: false, error: `x/y müssen im Foto liegen (0–${letztesFoto.breite} × 0–${letztesFoto.hoehe})` };
      const sx = letztesFoto.region.x + px * letztesFoto.skala, sy = letztesFoto.region.y + py * letztesFoto.skala;
      const r = await bedienen(k).klickenBei(sx, sy, params.doppelt === true || params.doppelt === 'true', await aktivesFensterTitel());
      letztesFoto = undefined; // nach dem Klick ist das Foto veraltet
      return { success: true, data: r, display: `Geklickt bei Foto (${Math.round(px)}, ${Math.round(py)}) = Bildschirm (${r.x}, ${r.y}). Neues Foto zur Kontrolle machen.` };
    }
    case 'taste': {
      const keys = await bedienen(k).taste(String(params.kombi ?? ''));
      return { success: true, data: { kombi: params.kombi, sendkeys: keys }, display: `Taste ${String(params.kombi)} gesendet. Karte verfallen: fenster_lesen vor dem nächsten Schritt.` };
    }
    // v1292 — Office über COM
    case 'outlook_mails': {
      if (params.id) {
        const m = await outlookMailLesen(String(params.id));
        return { success: true, data: m, display: `Mail auf ${k.name}: Von ${m.von} · ${m.datum}\nAn: ${m.an}${m.cc ? ` · CC: ${m.cc}` : ''}\nBetreff: ${m.betreff}${m.anhaenge.length ? `\nAnhänge: ${m.anhaenge.join(', ')}` : ''}\n\n${m.text}${m.gekuerzt ? '\n[… gekürzt]' : ''}` };
      }
      const ordner = ['posteingang', 'entwuerfe', 'gesendet'].includes(String(params.ordner)) ? String(params.ordner) as 'posteingang' | 'entwuerfe' | 'gesendet' : 'posteingang';
      const r = await outlookPosteingang({ anzahl: Number(params.anzahl) || undefined, ungelesen: params.ungelesen === true || params.ungelesen === 'true', suche: params.suche ? String(params.suche) : undefined, ordner });
      const zeile = (m: { id: string; datum: string; von: string; betreff: string; ungelesen: boolean; anhaenge: number; vorschau?: string }) => `- ${m.ungelesen ? '● ' : ''}${m.datum.slice(0, 16).replace('T', ' ')} ${m.von} — ${m.betreff}${m.anhaenge ? ` [${m.anhaenge} Anh.]` : ''} (id ${m.id.slice(-12)})`;
      return { success: true, data: r, display: `${r.ordner} auf ${k.name}: ${r.gesamt} Mails, ${r.ungelesen} ungelesen — ${r.mails.length} gezeigt:\n${r.mails.map(zeile).join('\n') || '(keine)'}\nGanze Mail: outlook_mails mit id (volle EntryID in data).` };
    }
    case 'outlook_entwurf': {
      const anhaenge = params.anhaenge ? String(params.anhaenge).split(';').map(p => p.trim()).filter(Boolean) : [];
      for (const p of anhaenge) if (!istPfadErlaubt(p, lesbar)) return { success: false, error: `Anhang nicht in einem freigegebenen Verzeichnis: ${p}` };
      const r = await outlookEntwurf({ an: String(params.an ?? ''), betreff: String(params.betreff ?? ''), text: String(params.text ?? ''), cc: params.cc ? String(params.cc) : undefined, antwortAuf: params.antwortAuf ? String(params.antwortAuf) : undefined, anhaenge });
      return { success: true, data: r, display: `Entwurf in Outlook angelegt und geöffnet: „${r.betreff}" an ${r.an || '(kein Empfänger)'} — NICHT gesendet. Senden: outlook_senden mit id ${r.id}` };
    }
    case 'outlook_senden': {
      if (!params.id) return { success: false, error: 'id des Entwurfs fehlt' };
      const r = await outlookSenden(String(params.id));
      return r.gesendet ? { success: true, data: r, display: `Gesendet: „${r.betreff}" an ${r.an}` } : { success: false, error: `Nicht gesendet: „${r.betreff}" (schon gesendet oder kein Entwurf)` };
    }
    case 'outlook_termine': {
      const r = await outlookTermine({ von: params.von ? String(params.von) : undefined, bis: params.bis ? String(params.bis) : undefined, anzahl: Number(params.anzahl) || undefined });
      const zeile = (t: { start: string; ende: string; betreff: string; ort: string; ganztags: boolean }) => `- ${t.ganztags ? t.start.slice(0, 10) + ' ganztags' : t.start.slice(0, 16).replace('T', ' ') + '–' + t.ende.slice(11, 16)} ${t.betreff}${t.ort ? ` (${t.ort})` : ''}`;
      return { success: true, data: r, display: `Termine ${r.von} bis ${r.bis} auf ${k.name} (${r.termine.length}):\n${r.termine.map(zeile).join('\n') || '(keine)'}` };
    }
    case 'outlook_termin_anlegen': {
      if (!params.betreff || !params.start || !params.ende) return { success: false, error: 'betreff, start und ende sind nötig' };
      const r = await outlookTerminAnlegen({ betreff: String(params.betreff), start: String(params.start), ende: String(params.ende), ort: params.ort ? String(params.ort) : undefined, text: params.text ? String(params.text) : undefined, teilnehmer: params.teilnehmer ? String(params.teilnehmer) : undefined });
      return { success: true, data: r, display: `Termin angelegt: „${r.betreff}" ${r.start.replace('T', ' ')} bis ${r.ende.slice(11, 16)}` };
    }
    case 'excel_lesen': {
      const datei = String(params.datei ?? '');
      if (!istPfadErlaubt(datei, lesbar)) return { success: false, error: `Datei nicht in einem freigegebenen Verzeichnis: ${datei}` };
      const r = await excelLesen({ datei, blatt: params.blatt ? String(params.blatt) : undefined, bereich: params.bereich ? String(params.bereich) : undefined });
      return { success: true, data: r, display: `${path.basename(datei)} · Blatt ${r.blatt} · ${r.bereich}${r.gekuerzt ? ' (gekürzt)' : ''}:\n${r.zeilen.map(z => z.join(' | ')).join('\n')}` };
    }
    case 'excel_schreiben': {
      const datei = String(params.datei ?? '');
      if (!istPfadErlaubt(datei, frei)) return { success: false, error: `Datei nicht in einem Verzeichnis mit Schreibrecht: ${datei}` };
      if (!params.zelle) return { success: false, error: 'zelle fehlt' };
      const r = await excelSchreiben({ datei, blatt: params.blatt ? String(params.blatt) : undefined, zelle: String(params.zelle), wert: String(params.wert ?? '') });
      return { success: true, data: r, display: `${path.basename(datei)} · ${r.blatt}!${r.zelle} = ${r.wert} (gespeichert)` };
    }
    // v1275 — Systembenachrichtigungen
    case 'benachrichtigungen': {
      const l = await benachrichtigungen(Number(params.stunden ?? 24) || 24, Number(params.anzahl ?? 20) || 20);
      const zeile = (b: { app: string; zeit: string; titel?: string; text: string }) => `- ${new Date(b.zeit).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${b.app}: ${b.titel ? `${b.titel} — ` : ''}${b.text}`;
      return { success: true, data: { benachrichtigungen: l }, display: l.length ? `Benachrichtigungen auf ${k.name} (${l.length}):\n${l.map(zeile).join('\n')}` : `Keine Benachrichtigungen im Zeitraum auf ${k.name}` };
    }
    // v1273 — Zwischenablage
    case 'zwischenablage_lesen': {
      const z = await zwischenablageLesen();
      if (!z.text) return { success: true, data: { text: '', leer: true }, display: `Die Zwischenablage auf ${k.name} enthält keinen Text` };
      return { success: true, data: { text: z.text, zeichen: z.text.length, gekuerzt: z.gekuerzt }, display: `Zwischenablage auf ${k.name} (${z.text.length} Zeichen${z.gekuerzt ? `, auf ${ZWISCHENABLAGE_MAX_ZEICHEN} gekürzt` : ''}):\n${z.text}` };
    }
    case 'zwischenablage_setzen': {
      const text = String(params.text ?? '');
      if (!text) return { success: false, error: 'text fehlt' };
      await zwischenablageSetzen(text);
      return { success: true, data: { zeichen: text.length }, display: `${text.length} Zeichen in die Zwischenablage auf ${k.name} gelegt` };
    }
    // v1272 — Freigaben aus dem Chat pflegen (Spec §17 Punkt 3)
    case 'freigaben': {
      const zeilen = [...frei.map(p => `- ${p} (lesen + schreiben)`), ...(k.nurLesen ?? []).map(p => `- ${p} (nur lesen)`)];
      return { success: true, data: { schreiben: frei, lesen: k.nurLesen ?? [] }, display: zeilen.length ? `Freigaben auf ${k.name}:\n${zeilen.join('\n')}` : `Keine Freigaben auf ${k.name}` };
    }
    case 'freigabe_aendern': {
      const roh = String(params.pfad ?? '').trim();
      const recht = String(params.recht ?? 'lesen');
      if (!roh) return { success: false, error: 'pfad fehlt' };
      if (!['lesen', 'schreiben', 'keins'].includes(recht)) return { success: false, error: 'recht muss lesen, schreiben oder keins sein' };
      const pfad = path.resolve(roh.startsWith('~') ? path.join(os.homedir(), roh.slice(1)) : roh);
      if (recht !== 'keins') {
        try { if (!statSync(pfad).isDirectory()) return { success: false, error: `Kein Verzeichnis: ${pfad}` }; } catch { return { success: false, error: `Verzeichnis nicht gefunden: ${pfad}` }; }
      }
      const gleich = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      k.freigegebeneVerzeichnisse = k.freigegebeneVerzeichnisse.filter(p => !gleich(path.resolve(p), pfad));
      k.nurLesen = (k.nurLesen ?? []).filter(p => !gleich(path.resolve(p), pfad));
      if (recht === 'schreiben') k.freigegebeneVerzeichnisse.push(pfad);
      if (recht === 'lesen') k.nurLesen.push(pfad);
      speichereKonfig(k);
      const text = recht === 'keins' ? `Freigabe entfernt: ${pfad}` : `Freigegeben (${recht === 'schreiben' ? 'lesen + schreiben' : 'nur lesen'}): ${pfad}`;
      return { success: true, data: { pfad, recht, schreiben: k.freigegebeneVerzeichnisse, lesen: k.nurLesen }, display: `${text} — gilt sofort auf ${k.name}` };
    }
    case 'liste': {
      const p = String(params.path ?? '');
      if (!istPfadErlaubt(p, lesbar)) return { success: false, error: `Pfad nicht freigegeben: ${p}. Lesbar: ${lesbar.join(', ')}` };
      const eintraege = readdirSync(p).slice(0, 200).map(n => { try { const s = statSync(path.join(p, n)); return { name: n, typ: s.isDirectory() ? 'ordner' : 'datei', groesse: s.size, geaendert: s.mtime.toISOString() }; } catch { return { name: n, typ: '?' }; } });
      // v1255 — Größe und Datum stehen in der Anzeige (Owner-Fall Mac: „die drei kleinsten Dateien" löste sonst eine Shell aus)
      const groesseText = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
      return { success: true, data: { path: p, eintraege }, display: `${p}: ${eintraege.length} Einträge (Name · Größe · geändert)\n` + eintraege.slice(0, 80).map(e => `- ${e.typ === 'ordner' ? '📁' : '📄'} ${e.name}${e.typ === 'datei' ? ` · ${groesseText(e.groesse ?? 0)}` : ''}${e.geaendert ? ` · ${e.geaendert.slice(0, 10)}` : ''}`).join('\n') };
    }
    case 'oeffnen': {
      const ziel = String(params.path ?? params.url ?? '');
      const istUrl = /^https?:\/\//i.test(ziel);
      if (!istUrl && !istPfadErlaubt(ziel, lesbar)) return { success: false, error: `Pfad nicht freigegeben: ${ziel}. Lesbar: ${lesbar.join(', ')}` };
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
      if (!cwd) return { success: false, error: 'Kein Arbeitsverzeichnis: es ist kein Verzeichnis mit Schreibrecht freigegeben (freigabe_aendern)' };
      if (!istPfadErlaubt(cwd, frei)) return { success: false, error: `Arbeitsverzeichnis nicht freigegeben (Schreibrecht nötig): ${cwd}. Mit Schreibrecht: ${frei.join(', ')}` };
      // v1291 — Realfall Office-VM: Freigabe-Eintrag war ein zusammengeklebter Pfad → cwd existierte nicht → „spawn powershell.exe ENOENT" ohne Hinweis
      if (!existsSync(cwd)) return { success: false, error: `Arbeitsverzeichnis existiert nicht: ${cwd} — Freigaben mit freigaben prüfen` };
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
      if (!istPfadErlaubt(p, lesbar)) return { success: false, error: `Pfad nicht freigegeben: ${p}. Lesbar: ${lesbar.join(', ')}` };
      if (!existsSync(p) || !statSync(p).isFile()) return { success: false, error: `Keine Datei: ${p}` };
      const st = statSync(p);
      const groesse = st.size;
      if (groesse > TRANSFER_GROSS_MAX_BYTES) return { success: false, error: `Datei zu groß (${groesse} B, Grenze ${TRANSFER_GROSS_MAX_BYTES} B)` };
      // v1255 — Owner-Fall Mac: iCloud-Drive-Dateien ohne lokale Kopie lassen sich nicht lesen (Systemfehler -11)
      if (process.platform !== 'win32' && groesse > 0 && st.blocks === 0) return { success: false, error: `Datei liegt nicht lokal vor (Cloud-Platzhalter, z. B. iCloud Drive): ${p} — bitte am Gerät herunterladen.` };
      let data: Buffer;
      try { data = readFileSync(p); }
      catch (err) { const m = (err as Error).message; return { success: false, error: /-11|EDEADLK|ENOTSUP|dataless/i.test(m) ? `Datei liegt nicht lokal vor (Cloud-Platzhalter): ${p} — bitte am Gerät herunterladen.` : `Lesen fehlgeschlagen: ${m}` }; }
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
      if (!istPfadErlaubt(ziel, frei)) return { success: false, error: `Pfad nicht freigegeben (Schreibrecht nötig): ${ziel}. Mit Schreibrecht: ${frei.join(', ')}` };
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
    // v1271 — Programme und Fenster
    case 'fenster': {
      const l = await fensterListe();
      return { success: true, data: { fenster: l }, display: l.length ? `Offene Fenster auf ${k.name} (${l.length}):\n${l.map(f => `- ${f.titel || '(ohne Titel)'} — ${f.programm}`).join('\n')}` : `Keine Fenster mit Titel auf ${k.name}` };
    }
    case 'fenster_vordergrund': {
      const f = await fensterVordergrund(String(params.titel ?? ''));
      return { success: true, data: f, display: `Im Vordergrund: ${f.titel || f.programm} (${f.programm})` };
    }
    case 'programm_starten': {
      const argumente = Array.isArray(params.argumente) ? (params.argumente as unknown[]).map(String) : String(params.argumente ?? '').split(/\s+/).filter(Boolean);
      const t = await programmStarten(String(params.programm ?? ''), argumente);
      return { success: true, data: { programm: params.programm, argumente }, display: t };
    }
    // v1268 — Bildschirm sehen
    case 'bildschirm': {
      const bereich = params.bereich === 'fenster' ? 'fenster' : 'alles';
      // v1279 — Set of Marks: Nummern der letzten Element-Karte ins Bild (nur Windows, nur mit frischer Karte)
      const marken = (params.markieren === true || params.markieren === 'true') && process.platform === 'win32' ? bedienen(k).marken() : []; // Markierungen bisher nur Windows
      // v1281 — optionale Foto-Sperre (Owner: keine Sperre, wenn dann nur optional): Titelmuster in geraet.json `fotoSperre`
      const sperre = (k as GeraetKonfig & { fotoSperre?: string[] }).fotoSperre ?? [];
      if (sperre.length) {
        const titel = await aktivesFensterTitel();
        const treffer = sperre.find(m => m && titel.toLowerCase().includes(m.toLowerCase()));
        if (treffer) return { success: false, error: `Kein Bildschirmfoto: das aktive Fenster „${titel}" fällt unter die Foto-Sperre („${treffer}")` };
      }
      const f = await bildschirmfoto(bereich, 1600, marken);
      if (f.region && f.skala) letztesFoto = { region: f.region, skala: f.skala, zeit: Date.now(), breite: f.breite, hoehe: f.hoehe };
      return { success: true, data: { screenshotBase64: f.jpegBase64, mimeType: 'image/jpeg', breite: f.breite, hoehe: f.hoehe, titel: f.titel, bereich: f.bereich }, display: `Bildschirmfoto (${f.bereich === 'fenster' ? 'aktives Fenster' : 'ganzer Bildschirm'}, ${f.breite}×${f.hoehe}${f.titel ? `, Fenster „${f.titel}"` : ''}${f.marken ? `, ${f.marken} Elemente nummeriert wie in fenster_lesen` : ''})` };
    }
    case 'browser_schliessen': {
      await browser(k).schliessen();
      return { success: true, display: 'Alfred-Browser geschlossen' };
    }
    // v1274 — vom Gehirn angestoßen: erst antworten, dann lokal entkoppeln und beenden
    case 'entkoppeln': {
      setTimeout(() => { const s = entkoppleLokal(); console.log(`Entkoppelt: ${s.join('; ')}`); process.exit(0); }, 800);
      return { success: true, data: { entkoppelt: true }, display: `Satellit ${k.name} entfernt Kopplung, installierte Versionen und Dienst und beendet sich` };
    }
    default:
      return { success: false, error: `Aktion unbekannt: ${aktion}` };
  }
}

export async function satellitCommand(opts: { starter?: boolean; einmal?: boolean; install?: boolean; uninstall?: boolean; status?: boolean; dienst?: boolean; entkoppeln?: boolean }): Promise<void> {
  // v1274 — vollständig entkoppeln: Token im Gehirn widerrufen, dann lokal alles entfernen
  if (opts.entkoppeln) {
    const k = ladeKonfig();
    if (k) {
      try { const r = await geraetJson<{ ok: boolean }>(k, 'POST', '/api/geraete/abmelden'); console.log(r?.ok ? `Im Gehirn abgemeldet: ${k.name}` : 'Gehirn kannte das Gerät nicht mehr'); }
      catch (err) { console.log(`Gehirn nicht erreichbar (${(err as Error).message}) — das Gerät dort per Chat entkoppeln („Alfred, entkopple ${k.name}")`); }
    } else console.log('Keine Kopplung vorhanden');
    for (const s of entkoppleLokal()) console.log(s);
    console.log('Die CLI selbst bleibt installiert — entfernen mit: npm uninstall -g @madh-io/alfred-ai');
    return;
  }
  // v1228 — Dienst-Verwaltung
  if (opts.install) { console.log(installiereDienst()); for (const z of installiereStarter()) console.log(z); return; } // v1304 — Starter in ~/.alfred/bin + PATH
  if (opts.starter) { for (const z of installiereStarter()) console.log(z); return; }
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
  // v1294 — Realfall Office-VM: erhöht gestarteter Satellit erreicht weder Outlook (COM 80080005) noch normale Fenster (UIA)
  if (laeuftErhoeht()) console.error('WARNUNG: Der Satellit läuft mit Administratorrechten. Outlook/Excel über COM und das Bedienen normaler Fenster scheitern dann. Bitte aus einer normalen (nicht erhöhten) Eingabeaufforderung starten: alfred satellit --install');
  const s = starteSatellit(k, { einmal: opts.einmal, log: m => console.log(m), fehler: m => console.error(m) });
  process.on('SIGINT', () => { console.log('\nSatellit beendet.'); s.stop(); process.exit(0); });
  process.on('SIGTERM', () => { s.stop(); process.exit(0); });
  await s.fertig;
}

/**
 * v1232 — Der Satellit als Funktion: Verbindung halten, Aktionen ausführen, Ereignisse melden.
 * Genutzt vom Dienst (`alfred satellit`) und von der Sitzung (`alfred sitzung`), wenn kein Dienst läuft.
 */
function ipcPfadText(): string { try { return process.platform === 'win32' ? 'Named Pipe' : '~/.alfred/satellit.sock'; } catch { return 'IPC'; } }

export function starteSatellit(k: GeraetKonfig, opts: { einmal?: boolean; log?: (zeile: string) => void; fehler?: (zeile: string) => void; ohneIpc?: boolean }): { stop: () => void; fertig: Promise<void> } {
  const log = opts.log ?? (() => undefined);
  const fehler = opts.fehler ?? log;
  const version = getVersion();
  // v1302 — lokales IPC: Status, Ereignisse und Bestätigungen für Sitzungen am Gerät (Spec §8)
  let verbunden = false; let serverVersion: string | undefined; let verbundenSeit: string | undefined;
  const status = (): SatellitStatus => ({ name: k.name, version, pid: process.pid, verbunden, serverVersion, verbundenSeit, aktionenLaufend });
  let ipc: IpcServer | undefined;
  const ereignis = (art: IpcEreignisArt, text: string) => { try { ipc?.sende({ typ: 'ereignis', zeit: new Date().toISOString(), art, text }); } catch { /* */ } };
  if (!opts.einmal && !opts.ohneIpc && !process.env.ALFRED_KEIN_IPC) {
    const s = new IpcServer(status, (befehl, antworte) => {
      if (befehl === 'status') antworte({ typ: 'status', status: status() });
      if (befehl === 'beenden') { log('Beendet über IPC (Sitzung)'); stop(); setTimeout(() => process.exit(0), 200); }
      // v1309 — Einstellungen geändert (Sitzung oder alfred einstellungen): geraet.json neu lesen, Bedienung mit neuer Sperrliste
      if (befehl === 'neuladen') {
        const neu = ladeKonfig();
        if (neu) { Object.assign(k, neu); bedienung = undefined; log('Einstellungen neu geladen'); antworte({ typ: 'ereignis', zeit: new Date().toISOString(), art: 'hinweis', text: 'Einstellungen neu geladen' }); }
      }
    });
    s.start().then(() => { ipc = s; log(`IPC bereit: ${ipcPfadText()}`); }).catch(err => fehler(`IPC nicht verfügbar: ${(err as Error).message}`));
  }
  const manifest = baueManifest(version);
  for (const a of manifest.aktionen) if (a.beschreibung.length > 300) a.beschreibung = a.beschreibung.slice(0, 297) + '…'; // v1277 — Manifest-Grenze des Gehirns
  const wsUrl = k.server.replace(/^http/i, 'ws') + '/api/geraete/ws';
  let rueckzugMs = 1000;
  let laeuft = true;
  let aktiv: WebSocket | undefined;
  // v1258 — Autoupdate: nach dem Willkommen prüfen, nur im Leerlauf, dann mit Code 75 beenden (der Starter startet die neue Version)
  let aktionenLaufend = 0;
  let updateLaeuft = false;
  let manifestAbgewiesen = 0; // v1278
  const pruefeUpdate = (serverVersion: string) => {
    if (updateLaeuft || vergleicheVersion(serverVersion, version) <= 0) return;
    updateLaeuft = true;
    log(`Server ${serverVersion} ist neuer als ${version} — Update in 15 s`); // v1262 — sichtbar machen
    const versuch = async (runde: number) => {
      if (aktionenLaufend > 0) { log(`Update wartet: ${aktionenLaufend} Aktion(en) laufen (Runde ${runde + 1})`); if (runde < 60) setTimeout(() => versuch(runde + 1), 30_000); else updateLaeuft = false; return; }
      log('Update-Prüfung beim Server …');
      try {
        const neu = await aktualisiereWennNeuer(k, version, log);
        if (neu) { log(`Update auf ${neu} installiert — Neustart über den Starter`); ereignis('update', `Update auf ${neu} installiert — Neustart`); setTimeout(() => { stop(); process.exit(NEUSTART_CODE); }, 500); return; }
        // v1265 — Server ist neuer, hat sein Release aber noch nicht bereit (kurz nach dem Start): später erneut
        if (runde < 10) { log(`Release ${serverVersion} noch nicht bereit — neuer Versuch in 60 s`); setTimeout(() => versuch(runde + 1), 60_000); return; }
      } catch (err) { fehler(`Update fehlgeschlagen: ${(err as Error).message}`); if (runde < 10) { setTimeout(() => versuch(runde + 1), 60_000); return; } }
      updateLaeuft = false;
    };
    setTimeout(() => versuch(0), 15_000);
  };
  const sinne = new SinneErfasser({ ohneFenster: (k as GeraetKonfig & { sinneOhneFenster?: boolean }).sinneOhneFenster === true });
  const stop = () => { laeuft = false; sinne.stop(); try { aktiv?.close(); } catch { /* */ } try { ipc?.stop(); } catch { /* */ } };

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
          if (n.typ === 'willkommen') {
            rueckzugMs = 1000; log(`[${new Date().toLocaleTimeString('de-AT')}] Verbunden mit Alfred ${n.serverVersion} — im Gehirn als Skill ${n.skillName} (Satellit ${version})`);
            verbunden = true; serverVersion = String(n.serverVersion ?? ''); verbundenSeit = new Date().toISOString(); ereignis('verbunden', `Verbunden mit Alfred ${serverVersion}`); // v1302
            // v1258 — Release-Schlüssel merken, laufende Version bestätigen, Update prüfen
            const rk = merkeReleaseKey((n as { releaseKey?: unknown }).releaseKey);
            if (rk === 'gemerkt') log('Release-Schlüssel des Servers gemerkt'); else if (rk === 'abweichend') fehler('WARNUNG: Release-Schlüssel des Servers weicht vom gemerkten ab — Updates werden abgelehnt');
            bestaetigeAktuell(version);
            // v1288 — alte Installationen aufräumen (Befund PC 07.10.: 22 Versionen, je ~800 MB); bleibt: laufende + vorige
            try { const a = ladeAktuell(); const weg = raeumeVersionen([version, a?.version ?? '', a?.vorige ?? '']); if (weg.length) log(`Alte Versionen entfernt: ${weg.join(', ')}`); } catch { /* beim nächsten Mal */ }
            if (rk !== 'abweichend' && !process.env.ALFRED_KEIN_UPDATE) pruefeUpdate(String(n.serverVersion ?? ''));
            return;
          }
          if (n.typ === 'puls_ok') return;
          if (n.typ === 'fehler') { fehler(`Fehler vom Gehirn: ${n.grund}`); return; }
          if (n.typ === 'abgemeldet') { fehler(`Abgemeldet: ${n.grund}. Bitte neu koppeln (alfred pair).`); stop(); ws.close(); return; }
          // v1302 — neue Bestätigung vom Gehirn: an angehängte Sitzungen weiterreichen
          if ((n as { typ: string }).typ === 'bestaetigung') {
            const b = (n as { bestaetigung?: { id: string; description: string } }).bestaetigung;
            if (b?.id) { log(`Bestätigung offen: ${b.description.slice(0, 100)}`); try { ipc?.sende({ typ: 'bestaetigung', bestaetigung: b }); } catch { /* */ } }
            return;
          }
          if (n.typ === 'aktion') {
            const start = Date.now();
            log(`[${new Date().toLocaleTimeString('de-AT')}] Aktion ${n.aktion} ${JSON.stringify(n.params).slice(0, 160)}`);
            ereignis('aktion', `Aktion ${n.aktion}`);
            let r: Ergebnis;
            aktionenLaufend += 1;
            try { r = await fuehreAus(k, n.aktion, n.params ?? {}); } catch (err) { r = { success: false, error: (err as Error).message }; }
            finally { aktionenLaufend -= 1; }
            sende({ typ: 'aktion_ergebnis', id: n.id, success: r.success, data: r.data, display: r.display, error: r.error, dauerMs: Date.now() - start });
            log(`  → ${r.success ? 'ok' : 'Fehler: ' + r.error}`);
            ereignis('ergebnis', `${n.aktion}: ${r.success ? (r.display ?? 'ok').split('\n')[0]!.slice(0, 120) : 'Fehler: ' + (r.error ?? '').slice(0, 120)}`);
          }
        });
        ws.on('close', (code, reason) => { if (puls) clearInterval(puls); if (sinneTimer) clearInterval(sinneTimer); if (verbunden) { verbunden = false; ereignis('getrennt', `Verbindung geschlossen (${code})`); } resolve(`geschlossen (${code} ${String(reason)})`); });
        ws.on('error', (err) => { resolve(`Fehler: ${err.message}`); });
      });
      // v1278 — Realfall 1276: Manifest vom Gehirn abgewiesen (4004) → Endlosschleife, der Starter konnte nicht zurückfallen.
      // Unter dem Starter nach dem zweiten Mal beenden (Code 1): er markiert die Probe als gescheitert und startet die vorige Version.
      if (/4004/.test(ende)) {
        manifestAbgewiesen += 1;
        if (manifestAbgewiesen >= 2 && process.env.ALFRED_STARTER_VERSION) { fehler('Manifest zweimal abgewiesen — beende mich, der Starter startet die vorige Version'); process.exit(1); }
      } else manifestAbgewiesen = 0;
      if (!laeuft || opts.einmal) break;
      log(`[${new Date().toLocaleTimeString('de-AT')}] Verbindung ${ende} — neuer Versuch in ${Math.round(rueckzugMs / 1000)} s`);
      await new Promise(r => setTimeout(r, rueckzugMs));
      rueckzugMs = Math.min(rueckzugMs * 2, 120_000);
    }
  })();
  return { stop, fertig };
}
