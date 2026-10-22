/**
 * Spec Infrastruktur-Vorhaben, I4 (Owner 22.10.2026 „I4 wie vorgeschlagen umsetzen“) — reine Bausteine des Ausführungsmotors:
 * Laufzustand je Change, Auflösen der Verweise auf frühere Schritte, Auswerten von Prüfungen. Ohne I/O, ohne Modell.
 */
import type { ChangeSchritt, Pruefung } from './change-schritte.js';

export type LaufPhase = 'laeuft' | 'wartet_owner' | 'angehalten' | 'rueckweg' | 'fertig';
export interface SchrittErgebnis {
  nr: number; ok: boolean; start: string; ende?: string;
  /** die Aktion selbst lief durch (auch wenn danach die Prüfung scheiterte) — dann gehört ihr Rückweg dazu */
  aktionOk?: boolean;
  ausgabe?: string; daten?: unknown; fehler?: string;
  pruefung?: { ok: boolean; text: string; versuche: number };
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
  /** Offene Owner-Frage (Owner-Schritt oder Rückweg): nur Hash der Einmal-Freigabe */
  frage?: { art: 'owner_schritt' | 'rueckweg'; hash: string; schritt: number; bis: string };
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

const VERWEIS = /\{\{\s*(?:schritt(\d+)\.([a-zA-Z_][\w.]*)|geheim:([a-z0-9][\w.-]{1,60}))\s*\}\}/g;

/**
 * Verweise auflösen: `{{schrittN.feld}}` aus den Daten früherer Schritte; steht der Verweis allein, bleibt der Typ erhalten
 * (Zahl bleibt Zahl). `{{geheim:…}}` geht erst mit dem Tresor (I4c) → Fehler.
 */
/** Eingesetzte Werte (Sicherheitsbefund 22.10.: Ausgaben eines Hosts dürfen nicht als Shell-Code in spätere Befehle wandern) */
export const SICHERER_WERT = /^[\w.:\/@-]{1,253}$/;
/** Felder, in die ein Verweis nie als ganzer Wert eingesetzt werden darf (ganzer Befehl aus fremder Ausgabe) */
const BEFEHLS_FELDER = new Set(['befehl', 'command', 'cmd', 'script', 'skript']);

/**
 * Verweise auflösen: `{{schrittN.feld}}` aus den Daten früherer Schritte; steht der Verweis allein, bleibt der Typ erhalten
 * (Zahl bleibt Zahl). Jeder eingesetzte Text muss SICHERER_WERT entsprechen (keine Leerzeichen, Shell-Zeichen, Anführungszeichen);
 * in Befehlsfeldern ist ein Verweis als ganzer Wert verboten. `{{geheim:…}}` geht erst mit dem Tresor (I4c) → Fehler.
 */
export function loeseAuf<T>(wert: T, ergebnisse: SchrittErgebnis[]): { wert: T; fehler?: string } {
  let fehler: string | undefined;
  const sicher = (w: unknown, verweis: string): boolean => {
    if (typeof w === 'number' || typeof w === 'boolean') return true;
    if (typeof w === 'string' && SICHERER_WERT.test(w)) return true;
    fehler ??= `Verweis {{${verweis}}} liefert einen unzulässigen Wert (nur Buchstaben, Ziffern und . : / @ - erlaubt)`;
    return false;
  };
  const ersetze = (v: unknown, feld?: string): unknown => {
    if (typeof v === 'string') {
      const allein = /^\{\{\s*schritt(\d+)\.([a-zA-Z_][\w.]*)\s*\}\}$/.exec(v.trim());
      if (allein) {
        if (feld && BEFEHLS_FELDER.has(feld.toLowerCase())) { fehler ??= `Verweis als ganzer Befehl ist nicht erlaubt (${feld})`; return ''; }
        const e = ergebnisse.find(x => x.nr === Number(allein[1]) && x.ok);
        const w = e ? pfadWert(e.daten, allein[2]!) : undefined;
        if (w === undefined) { fehler ??= `Verweis {{schritt${allein[1]}.${allein[2]}}} hat keinen Wert (Schritt ${allein[1]} lieferte kein Feld „${allein[2]}“)`; return w; }
        return sicher(w, `schritt${allein[1]}.${allein[2]}`) ? w : '';
      }
      return v.replace(VERWEIS, (_m, nr: string | undefined, f2: string | undefined, geheim: string | undefined) => {
        if (geheim) { fehler ??= `Tresor-Verweis {{geheim:${geheim}}} — der Tresor folgt mit I4c`; return ''; }
        const e = ergebnisse.find(x => x.nr === Number(nr) && x.ok);
        const w = e ? pfadWert(e.daten, f2!) : undefined;
        if (w === undefined || (typeof w === 'object' && w !== null)) { fehler ??= `Verweis {{schritt${nr}.${f2}}} hat keinen einfachen Wert`; return ''; }
        return sicher(w, `schritt${nr}.${f2}`) ? String(w) : '';
      });
    }
    if (Array.isArray(v)) return v.map(x => ersetze(x, feld));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, w]) => [k, ersetze(w, k)]));
    return v;
  };
  const neu = ersetze(wert) as T;
  return fehler ? { wert: neu, fehler } : { wert: neu };
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
  const erledigt = new Set(ergebnisse.filter(e => e.ok || e.aktionOk).map(e => e.nr));
  return [...schritte].reverse().filter(s => erledigt.has(s.nr) && s.rueckweg && !s.rueckweg.keiner && s.rueckweg.skill);
}

/** Schritte, deren Wirkung über die Laufzeit hinaus Assets verändert (für CMDB-Protokoll und Host-Sperre). */
export const wirkt = (s: ChangeSchritt) => s.art === 'aktion' && (s.einordnung === 'aendern' || s.einordnung === 'loeschen' || s.einordnung === 'sicherung');

/** Kurzbericht nach Ende (PIR-Grundlage). */
export function laufBericht(titel: string, schritte: ChangeSchritt[], l: ChangeLauf, ergebnis: 'completed' | 'failed' | 'rolled_back' | 'cancelled'): string {
  const dauer = l.ende ? Math.round((Date.parse(l.ende) - Date.parse(l.start)) / 1000) : undefined;
  const z = [`${titel}: ${{ completed: 'abgeschlossen', failed: 'fehlgeschlagen', rolled_back: 'zurückgerollt', cancelled: 'abgebrochen' }[ergebnis]}${dauer !== undefined ? ` nach ${dauer < 120 ? `${dauer} s` : `${Math.round(dauer / 60)} min`}` : ''}.`];
  for (const s of schritte) {
    const e = l.ergebnisse.find(x => x.nr === s.nr);
    z.push(`${e ? (e.ok ? '✓' : '✗') : '·'} ${s.nr}. ${s.titel}${e?.pruefung ? ` — Prüfung ${e.pruefung.ok ? 'ok' : 'NICHT ok'}: ${e.pruefung.text}` : ''}${e?.fehler ? ` — ${e.fehler}` : ''}`);
  }
  if (l.rueckweg?.length) z.push('Rückweg:', ...l.rueckweg.map(r => `${r.ok ? '✓' : '✗'} zu Schritt ${r.zuSchritt}: ${r.text}`));
  if (l.grund && ergebnis !== 'completed') z.push(`Grund: ${l.grund}`);
  return z.join('\n');
}
