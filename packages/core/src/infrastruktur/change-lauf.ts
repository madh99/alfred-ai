/**
 * Spec Infrastruktur-Vorhaben, I4 (Owner 22.10.2026 „I4 wie vorgeschlagen umsetzen“) — reine Bausteine des Ausführungsmotors:
 * Laufzustand je Change, Auflösen der Verweise auf frühere Schritte, Auswerten von Prüfungen. Ohne I/O, ohne Modell.
 */
import type { ChangeSchritt, Pruefung } from './change-schritte.js';
import { schwaerze } from '../fernzugriff/kaefig.js';

export type LaufPhase = 'laeuft' | 'wartet_owner' | 'angehalten' | 'rueckweg' | 'fertig';
export interface SchrittErgebnis {
  nr: number; ok: boolean; start: string; ende?: string;
  /** die Aktion selbst lief durch (auch wenn danach die Prüfung scheiterte) — dann gehört ihr Rückweg dazu */
  aktionOk?: boolean;
  /** v1630 — die Aktion scheiterte, hat aber schon etwas angelegt (der Skill lieferte Daten, z. B. vmid) — ihr Rückweg gehört dazu */
  teilweise?: boolean;
  ausgabe?: string; daten?: unknown; fehler?: string;
  /** v1692 — vom Owner übersprungen (nur nicht verändernde Schritte): zählt als erledigt, hat aber nichts bewirkt */
  uebersprungen?: boolean;
  /** v1633 — ausgabe: was die Prüfung gelesen hat (Befehl/Skill, gekürzt), damit der Bericht es belegt (Realfall 24.10.: /etc/os-release) */
  pruefung?: { ok: boolean; text: string; versuche: number; ausgabe?: string };
}
export interface RueckwegErgebnis { zuSchritt: number; ok: boolean; text: string; zeit: string }
export interface ChangeLauf {
  phase: LaufPhase;
  /** Nummer des Schritts, der gerade läuft bzw. an dem angehalten wurde */
  schritt: number;
  start: string; ende?: string;
  ergebnisse: SchrittErgebnis[];
  rueckweg?: RueckwegErgebnis[];
  /** Grund des Anhaltens (für Owner und Incident) */
  grund?: string;
  incidentId?: string;
  /** Offene Owner-Frage (Owner-Schritt, Rückweg, Rückweg nach Störung): nur Hash der Einmal-Freigabe */
  frage?: { art: 'owner_schritt' | 'rueckweg' | 'rueckweg_nach_stoerung'; hash: string; schritt: number; bis: string };
  /** I4b Teil 2 — Störungen nach Abschluss, die möglicherweise der Change verursacht hat */
  stoerungen?: Array<{ incidentId: string; titel: string; schwere: string; zeit: string }>;
  /** Wiederholen nach gelungener Aktion mit gescheiterter Prüfung: nur die Prüfung neu (Aktion nicht doppelt — z. B. Download „gibt es schon“) */
  nurPruefung?: { nr: number; ausgabe?: string; daten?: unknown };
  /** v1661 — Plan ab dem Haltepunkt korrigiert; weiter erst mit der Freigabe des neuen Plans */
  korrektur?: { abSchritt: number; zeit: string; aktionGeaendert?: boolean };
  /** Dokument-Vorlagen — Halte, Wiederholungen, Überspringen und Planänderungen in Reihenfolge (nur angehängt, nie überschrieben) */
  verlauf?: VerlaufEintrag[];
}

/** art „ausgelassen“ = Platzhalter für gekappte Einträge (anzahl = wie viele insgesamt fehlen) */
export interface VerlaufEintrag { zeit: string; art: 'halt' | 'wiederholen' | 'ueberspringen' | 'plan_geaendert' | 'ausgelassen'; schritt: number; text: string; anzahl?: number }
export const MAX_VERLAUF_TEXT = 300;
export const MAX_VERLAUF = 200;
const VERLAUF_ANFANG = 50;

/**
 * Verlaufseintrag anhängen; der Text wird erst geschwärzt, dann auf MAX_VERLAUF_TEXT Zeichen begrenzt (ein Geheimnis an der
 * Schnittstelle bleibt so nicht halb stehen). Höchstens MAX_VERLAUF Einträge: die ersten 50 und die neuesten bleiben, dazwischen
 * ein Platzhalter „… N Einträge ausgelassen“, dessen Zahl bei jedem weiteren Kappen mitwächst.
 */
export function merkeVerlauf(l: ChangeLauf, e: VerlaufEintrag): void {
  let neu = [...(l.verlauf ?? []), { ...e, text: schwaerze(e.text).text.slice(0, MAX_VERLAUF_TEXT) }];
  if (neu.length > MAX_VERLAUF) {
    const marke = neu[VERLAUF_ANFANG]?.art === 'ausgelassen' ? neu[VERLAUF_ANFANG] : undefined;
    const rest = neu.slice(VERLAUF_ANFANG + (marke ? 1 : 0));
    const behalten = rest.slice(rest.length - (MAX_VERLAUF - VERLAUF_ANFANG - 1));
    const weg = rest.slice(0, rest.length - behalten.length);
    const anzahl = (marke?.anzahl ?? 0) + weg.length;
    neu = [...neu.slice(0, VERLAUF_ANFANG), { zeit: weg.at(-1)?.zeit ?? marke?.zeit ?? e.zeit, art: 'ausgelassen', schritt: 0, text: `… ${anzahl} Einträge ausgelassen`, anzahl }, ...behalten];
  }
  l.verlauf = neu;
}

export const MAX_AUSGABE = 2000;
export const MAX_DATEN = 6000;

/** Daten eines Skill-Ergebnisses kürzen, damit der Lauf in der DB handlich bleibt (Verweise brauchen nur flache Felder). */
export function kuerzeDaten(d: unknown): unknown {
  if (d === undefined || d === null) return undefined;
  let t: string;
  try { t = JSON.stringify(d); } catch { return undefined; }
  if (t.length <= MAX_DATEN) return d;
  if (typeof d === 'object' && !Array.isArray(d)) {
    const flach: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) flach[k] = typeof v === 'string' ? v.slice(0, 300) : v;
    return flach;
  }
  return undefined;
}

/** Wert eines Pfads („vmid“, „vm.ip“, „liste.0.name“) aus einem Objekt. */
export function pfadWert(o: unknown, pfad: string): unknown {
  let x: unknown = o;
  for (const teil of pfad.split('.')) {
    if (x === null || x === undefined) return undefined;
    x = Array.isArray(x) && /^\d+$/.test(teil) ? x[Number(teil)] : typeof x === 'object' ? (x as Record<string, unknown>)[teil] : undefined;
  }
  return x;
}

const VERWEIS = /\{\{\s*(?:(?:change:([A-Za-z0-9_-]{1,64})\.)?schritt(\d+)\.([a-zA-Z_][\w.]*)|geheim:([a-z0-9][\w.-]{1,60})|geheimdatei:([a-z0-9][\w.-]{1,60}))\s*\}\}/g;

/** I4c — Namen der Tresor-Verweise in einem Wert (für das Vorab-Lesen im Motor) */
export function geheimNamen(wert: unknown): { werte: string[]; dateien: string[] } {
  const t = JSON.stringify(wert ?? null);
  return { werte: [...new Set([...t.matchAll(/\{\{\s*geheim:([a-z0-9][\w.-]{1,60})\s*\}\}/g)].map(m => m[1]!))], dateien: [...new Set([...t.matchAll(/\{\{\s*geheimdatei:([a-z0-9][\w.-]{1,60})\s*\}\}/g)].map(m => m[1]!))] };
}

/**
 * Verweise auflösen: `{{schrittN.feld}}` aus den Daten früherer Schritte; steht der Verweis allein, bleibt der Typ erhalten
 * (Zahl bleibt Zahl). `{{geheim:…}}` geht erst mit dem Tresor (I4c) → Fehler.
 */
/** Eingesetzte Werte (Sicherheitsbefund 22.10.: Ausgaben eines Hosts dürfen nicht als Shell-Code in spätere Befehle wandern) */
export const SICHERER_WERT = /^[\w.:\/@-]{1,253}$/;
/** v1690 — Proxmox-Task-IDs enthalten bei API-Token den Benutzer „root@pam!token“ (Realfall a3982e74 Schritt 8): nur in genau dieser Form zulässig */
export const PROXMOX_UPID = /^UPID:[\w.-]{1,63}:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}:[\w.-]{1,40}:[\w.-]{0,40}:[\w.-]{1,64}@[\w.-]{1,32}(?:![\w.-]{1,64})?:$/;
/** Felder, in die ein Verweis nie als ganzer Wert eingesetzt werden darf (ganzer Befehl aus fremder Ausgabe) */
const BEFEHLS_FELDER = new Set(['befehl', 'command', 'cmd', 'script', 'skript']);
/**
 * v1830 — Realfall 12.11. PKI-B e44e8270 Schritt 26: windows_pki datei_ablegen bekommt das Root-Zertifikat aus Schritt 25 als Base64
 * ({{schritt25.zertifikat.base64}}); „+“ und „=“ fielen durch SICHERER_WERT. Nur als GANZER Wert und nur im Datenfeld „base64“ ist
 * striktes Base64 zulässig (keine Leerzeichen, Anführungszeichen oder Shell-Zeichen; Länge Vielfaches von 4, höchstens 16 MB).
 */
export const BASE64_FELDER = new Set(['base64']);
/** v1833 — Realfall 13.11. PKI-B Schritt 34: die PKI-Bausteine heißen auch csr_base64, crl_base64, root_base64, zert_base64, sub_base64 */
export const istBase64Feld = (feld: string): boolean => BASE64_FELDER.has(feld) || /^[a-z]{2,12}_base64$/.test(feld);
export const STRIKTES_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * v1844 — Rückweg windows_pki publication_setzen mit cdp_roh/aia_roh = {{schrittN.vorher.cdp}} (PKI-A 14, PKI-B 33/44): der Verweis
 * liefert eine Liste wie ["1:C:\Windows\System32\CertSrv\CertEnroll\%3%8%9.crl", "2:http://…"]; Liste, „%“ und „\“ fielen durch
 * SICHERER_WERT — der Rückweg wäre abgewiesen worden. Nur als GANZER Wert, nur in Feldern <name>_roh und nur eine Liste von höchstens
 * 20 Einträgen im CA-Format <Flags>:<Ort> ohne Zeilenumbruch, Anführungszeichen oder Backtick (der Baustein prüft erneut).
 */
export const istRohListenFeld = (feld: string): boolean => /^[a-z]{2,12}_roh$/.test(feld);
// Positivliste der Zeichen in CA-Pfaden; „$“ nur als Endung versteckter Freigaben (\\fs01.ad.3033.at\pki$\, Realwert PKI-B Schritt 44),
// also direkt vor „\“ oder am Ende — „$(…)“ und „${…}“ sind damit ausgeschlossen
export const ROH_EINTRAG = /^\d{1,3}:(?:[A-Za-z0-9 .:/\\%_@-]|\$(?=\\|$)){1,400}$/;

/**
 * Verweise auflösen: `{{schrittN.feld}}` aus den Daten früherer Schritte; steht der Verweis allein, bleibt der Typ erhalten
 * (Zahl bleibt Zahl). Jeder eingesetzte Text muss SICHERER_WERT entsprechen (keine Leerzeichen, Shell-Zeichen, Anführungszeichen);
 * in Befehlsfeldern ist ein Verweis als ganzer Wert verboten. `{{geheim:…}}` geht erst mit dem Tresor (I4c) → Fehler.
 * V3 — `{{change:<id>.schrittN.feld}}` nur aus `vorgaenger` (Ergebnisse abgeschlossener Changes der Abhängigkeits-Hülle, vom Motor
 * bereitgestellt); fehlt die ID dort → Fehler. Dieselbe Wert-Sicherheit und dieselben Ganzwert-Ausnahmen wie bei `{{schrittN.feld}}`.
 */
export function loeseAuf<T>(wert: T, ergebnisse: SchrittErgebnis[], geheim?: { werte: Map<string, string>; dateien: Map<string, string> }, vorgaenger?: Map<string, SchrittErgebnis[] | string>): { wert: T; fehler?: string } {
  let fehler: string | undefined;
  // v1735 — Realfall 94959771 (01.11.): provision_windows_vm scheiterte nach dem Anlegen der VM (teilweise, Daten mit vmid); der
  // Rückweg delete_vm {{schritt1.vmid}} fand keinen Wert, weil nur erfolgreiche Schritte zählten — die VM blieb stehen. Werte aus
  // Schritten, die etwas bewirkt haben (Aktion ok oder teilweise), gelten jetzt auch; nach einem Fehler läuft vorwärts ohnehin nichts weiter.
  const nutzbar = (x: SchrittErgebnis) => x.ok || !!x.aktionOk || !!x.teilweise;
  const sicher = (w: unknown, verweis: string): boolean => {
    if (typeof w === 'number' || typeof w === 'boolean') return true;
    if (typeof w === 'string' && (SICHERER_WERT.test(w) || PROXMOX_UPID.test(w))) return true;
    fehler ??= `Verweis {{${verweis}}} liefert einen unzulässigen Wert (nur Buchstaben, Ziffern und . : / @ - erlaubt)`;
    return false;
  };
  // V3 — Ergebnisse, aus denen ein Verweis liest: ohne Change-ID dieser Lauf, sonst nur ein bereitgestellter Vorgänger
  const herkunft = (cid: string | undefined): SchrittErgebnis[] | undefined => {
    if (!cid) return ergebnisse;
    const q = vorgaenger?.get(cid);
    // V3 Fix 1 — Text statt Ergebnissen = Grund, warum der Vorgänger nicht gilt (z. B. nach der Planung geändert)
    if (typeof q === 'string') { fehler ??= `Verweis auf Change ${cid.slice(0, 8)}: ${q}`; return undefined; }
    if (!q) fehler ??= `Verweis auf Change ${cid.slice(0, 8)}: nicht abgeschlossen oder keine Abhängigkeit`;
    return q;
  };
  const ersetze = (v: unknown, feld?: string): unknown => {
    if (typeof v === 'string') {
      // I4c — {{geheim:x}} als ganzer Wert → Tresor-Wert (nur im Motor, nie im Lauf gespeichert)
      const g = /^\{\{\s*geheim:([a-z0-9][\w.-]{1,60})\s*\}\}$/.exec(v.trim());
      if (g) { const w = geheim?.werte.get(g[1]!); if (w === undefined) fehler ??= `Tresor-Eintrag ${g[1]} nicht verfügbar`; return w ?? ''; }
      const allein = /^\{\{\s*(?:change:([A-Za-z0-9_-]{1,64})\.)?schritt(\d+)\.([a-zA-Z_][\w.]*)\s*\}\}$/.exec(v.trim());
      if (allein) {
        if (feld && BEFEHLS_FELDER.has(feld.toLowerCase())) { fehler ??= `Verweis als ganzer Befehl ist nicht erlaubt (${feld})`; return ''; }
        const quelle = herkunft(allein[1]);
        if (!quelle) return '';
        const name = `${allein[1] ? `change:${allein[1]}.` : ''}schritt${allein[2]}.${allein[3]}`;
        const e = quelle.find(x => x.nr === Number(allein[2]) && (allein[1] ? x.ok : nutzbar(x)));
        const w = e ? pfadWert(e.daten, allein[3]!) : undefined;
        if (w === undefined) { fehler ??= `Verweis {{${name}}} hat keinen Wert (Schritt ${allein[2]}${allein[1] ? ` von Change ${allein[1].slice(0, 8)}` : ''} lieferte kein Feld „${allein[3]}“)`; return allein[1] ? '' : w; }
        if (feld && istBase64Feld(feld) && typeof w === 'string' && w.length > 0 && w.length <= 16 * 1024 * 1024 && STRIKTES_BASE64.test(w)) return w;
        if (feld && istRohListenFeld(feld) && Array.isArray(w) && w.length >= 1 && w.length <= 20 && w.every(x => typeof x === 'string' && ROH_EINTRAG.test(x))) return [...w];
        return sicher(w, name) ? w : '';
      }
      return v.replace(VERWEIS, (_m, cid: string | undefined, nr: string | undefined, f2: string | undefined, gName: string | undefined, gDatei: string | undefined) => {
        if (gName) { fehler ??= `{{geheim:${gName}}} nur als ganzer Wert erlaubt`; return ''; }
        if (gDatei) { const pfad = geheim?.dateien.get(gDatei); if (!pfad) fehler ??= `Geheimnis-Datei ${gDatei} nicht bereit`; return pfad ?? ''; }
        const quelle = herkunft(cid);
        if (!quelle) return '';
        const name = `${cid ? `change:${cid}.` : ''}schritt${nr}.${f2}`;
        const e = quelle.find(x => x.nr === Number(nr) && (cid ? x.ok : nutzbar(x)));
        const w = e ? pfadWert(e.daten, f2!) : undefined;
        if (w === undefined || (typeof w === 'object' && w !== null)) { fehler ??= `Verweis {{${name}}} hat keinen einfachen Wert`; return ''; }
        return sicher(w, name) ? String(w) : '';
      });
    }
    if (Array.isArray(v)) return v.map(x => ersetze(x, feld));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, w]) => [k, ersetze(w, k)]));
    return v;
  };
  const neu = ersetze(wert) as T;
  return fehler ? { wert: neu, fehler } : { wert: neu };
}

/**
 * V3 Fix 1 (I-2) — nach dem Auflösen darf kein Verweis-Text übrig sein ({{Change:…}}, {{Schritt1.x}}, kaputte Verweise): sonst ginge
 * der Platzhalter roh an einen Skill. Liefert den Fehlertext oder undefined.
 */
export function unaufgeloesterVerweis(wert: unknown): string | undefined {
  let t: string;
  try { t = JSON.stringify(wert ?? null); } catch { return 'unaufgelöster Verweis (Eingabe nicht lesbar)'; }
  const m = /\{\{\s*(change|schritt\d)[^}]{0,60}/i.exec(t);
  return m ? `unaufgelöster Verweis „${m[0].slice(0, 70)}“ — Schritt nicht ausgeführt` : undefined;
}

/** v1643 — alle einfachen Werte eines Datenobjekts (ohne Feldnamen), für Textprüfungen gegen Skill-Daten */
export function datenWerte(d: unknown, aus: string[] = [], tiefe = 0): string[] {
  if (d === null || d === undefined || tiefe > 12 || aus.length > 5000) return aus;
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') { aus.push(String(d)); return aus; }
  if (Array.isArray(d)) { for (const x of d) datenWerte(x, aus, tiefe + 1); return aus; }
  if (typeof d === 'object') for (const v of Object.values(d as Record<string, unknown>)) datenWerte(v, aus, tiefe + 1);
  return aus;
}

/** Prüfungs-Text gegen erwartet/nichtEnthalten (ohne Groß/Klein). */
export function textErfuellt(text: string, p: Pick<Pruefung, 'erwartet' | 'nichtEnthalten'>): { ok: boolean; grund?: string } {
  const t = text.toLowerCase();
  if (p.erwartet && !t.includes(p.erwartet.toLowerCase())) return { ok: false, grund: `„${p.erwartet}“ nicht gefunden` };
  if (p.nichtEnthalten && t.includes(p.nichtEnthalten.toLowerCase())) return { ok: false, grund: `„${p.nichtEnthalten}“ ist enthalten` };
  return { ok: true };
}

/** Rückweg-Reihenfolge: erledigte Schritte mit Rückweg in umgekehrter Reihenfolge (ohne „keiner“). */
export function rueckwegSchritte(schritte: ChangeSchritt[], ergebnisse: SchrittErgebnis[]): ChangeSchritt[] {
  const erledigt = new Set(ergebnisse.filter(e => !e.uebersprungen && (e.ok || e.aktionOk || e.teilweise)).map(e => e.nr));
  return [...schritte].reverse().filter(s => erledigt.has(s.nr) && s.rueckweg && !s.rueckweg.keiner && s.rueckweg.skill);
}

/** Schritte, deren Wirkung über die Laufzeit hinaus Assets verändert (für CMDB-Protokoll und Host-Sperre). */
export const wirkt = (s: ChangeSchritt) => s.art === 'aktion' && (s.einordnung === 'aendern' || s.einordnung === 'loeschen' || s.einordnung === 'sicherung');

/**
 * v1620 — was nach dem Lauf noch wirkt, ohne zurückgenommen zu sein: ausgeführte ändernde/löschende Schritte ohne erfolgreichen Rückweg.
 * Sicherungen (Snapshots) zählen nicht — sie schützen nur und werden beim Aufräumen entfernt. Ebenso wenig Schritte mit „kein Rückweg“:
 * ihre bleibende Wirkung (Tresor-Eintrag, Vorkopie, beabsichtigte Löschung) ist so freigegeben (Realfall e1843faa/dea4b9cd).
 */
export function restWirkung(schritte: ChangeSchritt[], l: ChangeLauf): ChangeSchritt[] {
  const erledigt = new Set(l.ergebnisse.filter(e => e.ok || e.aktionOk || e.teilweise).map(e => e.nr));
  const zurueck = new Set((l.rueckweg ?? []).filter(r => r.ok).map(r => r.zuSchritt));
  return schritte.filter(s => s.art === 'aktion' && (s.einordnung === 'aendern' || s.einordnung === 'loeschen') && !s.rueckweg?.keiner && erledigt.has(s.nr) && !zurueck.has(s.nr));
}

/** Kurzbericht nach Ende (PIR-Grundlage). */
export function laufBericht(titel: string, schritte: ChangeSchritt[], l: ChangeLauf, ergebnis: 'completed' | 'failed' | 'rolled_back' | 'cancelled'): string {
  const dauer = l.ende ? Math.round((Date.parse(l.ende) - Date.parse(l.start)) / 1000) : undefined;
  const z = [`${titel}: ${{ completed: 'abgeschlossen', failed: 'fehlgeschlagen', rolled_back: 'zurückgerollt', cancelled: 'abgebrochen' }[ergebnis]}${dauer !== undefined ? ` nach ${dauer < 120 ? `${dauer} s` : `${Math.round(dauer / 60)} min`}` : ''}.`];
  for (const s of schritte) {
    const e = l.ergebnisse.find(x => x.nr === s.nr);
    // v1633 — bei reinen Prüf-Schritten die erste Zeile des Gelesenen als Beleg (Realfall 24.10.: welches System meldet die Probe-VM?)
    const beleg = s.art === 'pruefung' && e?.pruefung?.ausgabe ? e.pruefung.ausgabe.split('\n').map(x => x.trim()).find(Boolean)?.slice(0, 100) : undefined;
    z.push(`${e ? (e.uebersprungen ? '↷' : e.ok ? '✓' : '✗') : '·'} ${s.nr}. ${s.titel}${e?.uebersprungen ? ` — ${e.ausgabe ?? 'übersprungen'}` : ''}${e?.pruefung ? ` — Prüfung ${e.pruefung.ok ? 'ok' : 'NICHT ok'}: ${e.pruefung.text}${beleg ? ` → ${beleg}` : ''}` : ''}${e?.fehler ? ` — ${e.fehler}` : ''}`);
  }
  if (l.rueckweg?.length) z.push('Rückweg:', ...l.rueckweg.map(r => `${r.ok ? '✓' : '✗'} zu Schritt ${r.zuSchritt}: ${r.text}`));
  if (l.grund && ergebnis !== 'completed') z.push(`Grund: ${l.grund}`);
  return z.join('\n');
}
