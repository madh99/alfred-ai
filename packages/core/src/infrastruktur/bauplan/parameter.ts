/**
 * Spec Bauplan- und Dokument-Vorlagen §5.5/§5.7 — Parameter der Bauplan-Vorlagen: Typprüfung, feste Ableitungen, Einsetzen.
 *
 * Die Typen sind bewusst eng (Sicherheitsbefund 22.10.: eingesetzte Werte dürfen nie als Shell-Code wandern): Namen nur aus
 * Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich; Text ohne „{{“ und ohne Zeilenumbruch. Ableitungen sind feste Funktionen.
 */
import type { AbleitungsFunktion, BauplanChange, BauplanParameter, BauplanVorlage } from './schema.js';

export const NAME_WERT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const OKTETT = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OKTETT}(\\.${OKTETT}){3}$`);
const TEXT_STANDARD_LAENGE = 200;
const LISTE_MAX = 20;
/** `{{param.<name>}}` — ganzer Wert behält den Typ, sonst Textersetzung */
export const PARAM_VERWEIS = /\{\{\s*param\.([a-z][a-z0-9_]{0,30})\s*\}\}/g;
const PARAM_GANZ = /^\{\{\s*param\.([a-z][a-z0-9_]{0,30})\s*\}\}$/;

const ipZuZahl = (ip: string): number => ip.split('.').reduce((s, o) => s * 256 + Number(o), 0);
const zahlZuIp = (z: number): string => [24, 16, 8, 0].map(s => Math.floor(z / 2 ** s) % 256).join('.');
const groesse = (praefix: number): number => 2 ** (32 - praefix);

function zerlegeCidr(wert: string): { netz: number; praefix: number } | undefined {
  const m = /^([0-9.]+)\/(\d{1,2})$/.exec(wert);
  if (!m || !IPV4.test(m[1])) return undefined;
  const praefix = Number(m[2]);
  if (praefix > 32 || String(praefix) !== m[2]) return undefined;
  return { netz: ipZuZahl(m[1]), praefix };
}

/** Typprüfung eines Werts; liefert den Fehlertext oder undefined. */
export function pruefeWert(p: BauplanParameter, wert: unknown): string | undefined {
  const fehler = (t: string) => `Parameter ${p.name}: ${t}`;
  const g = p.grenzen ?? {};
  const zahlGrenzen = (z: number): string | undefined => {
    if (g.min !== undefined && z < g.min) return fehler(`${z} ist kleiner als ${g.min}`);
    if (g.max !== undefined && z > g.max) return fehler(`${z} ist größer als ${g.max}`);
  };
  const regexGrenze = (s: string): string | undefined => {
    if (g.regex !== undefined && !new RegExp(g.regex).test(s)) return fehler(`„${s}“ entspricht nicht ${g.regex}`);
  };
  switch (p.typ) {
    case 'name': case 'node': case 'storage':
      if (typeof wert !== 'string' || !NAME_WERT.test(wert)) return fehler(`muss ein Name sein (Buchstaben, Ziffern, . _ -, höchstens 63 Zeichen) — erhalten ${JSON.stringify(wert)}`);
      return regexGrenze(wert);
    case 'ipv4':
      if (typeof wert !== 'string' || !IPV4.test(wert)) return fehler(`muss eine IPv4-Adresse sein — erhalten ${JSON.stringify(wert)}`);
      return regexGrenze(wert);
    case 'cidr': {
      const c = typeof wert === 'string' ? zerlegeCidr(wert) : undefined;
      if (!c) return fehler(`muss ein Netz a.b.c.d/0..32 sein — erhalten ${JSON.stringify(wert)}`);
      if (c.netz % groesse(c.praefix) !== 0) return fehler(`${String(wert)} ist nicht der Netzanfang (richtig: ${zahlZuIp(c.netz - (c.netz % groesse(c.praefix)))}/${c.praefix})`);
      return regexGrenze(wert as string);
    }
    case 'vlan':
      if (!Number.isInteger(wert) || (wert as number) < 2 || (wert as number) > 4094) return fehler(`muss eine ganze Zahl 2–4094 sein — erhalten ${JSON.stringify(wert)}`);
      return zahlGrenzen(wert as number) ?? regexGrenze(String(wert));
    case 'vmid':
      if (!Number.isInteger(wert) || (wert as number) < 100 || (wert as number) > 999_999_999) return fehler(`muss eine ganze Zahl 100–999999999 sein — erhalten ${JSON.stringify(wert)}`);
      return zahlGrenzen(wert as number) ?? regexGrenze(String(wert));
    case 'zahl':
      if (typeof wert !== 'number' || !Number.isFinite(wert)) return fehler(`muss eine endliche Zahl sein — erhalten ${JSON.stringify(wert)}`);
      return zahlGrenzen(wert) ?? regexGrenze(String(wert));
    case 'text': {
      if (typeof wert !== 'string') return fehler(`muss ein Text sein — erhalten ${JSON.stringify(wert)}`);
      const laenge = g.laenge ?? TEXT_STANDARD_LAENGE;
      if (wert.length > laenge) return fehler(`höchstens ${laenge} Zeichen (erhalten ${wert.length})`);
      if (wert.includes('{{')) return fehler('darf kein „{{“ enthalten');
      if (/[\r\n]/.test(wert)) return fehler('darf keinen Zeilenumbruch enthalten');
      return regexGrenze(wert);
    }
    case 'liste': {
      if (!Array.isArray(wert)) return fehler(`muss eine Liste von Namen sein — erhalten ${JSON.stringify(wert)}`);
      if (wert.length > LISTE_MAX) return fehler(`höchstens ${LISTE_MAX} Einträge (erhalten ${wert.length})`);
      for (const e of wert) {
        if (typeof e !== 'string' || !NAME_WERT.test(e)) return fehler(`Eintrag ${JSON.stringify(e)} ist kein Name (Buchstaben, Ziffern, . _ -)`);
        const r = regexGrenze(e); if (r) return r;
      }
      return undefined;
    }
    default:
      return fehler(`unbekannter Typ ${String((p as { typ: unknown }).typ)}`);
  }
}

/** Feste Ableitungen aus einem (gültigen) CIDR. */
export function ableiten(funktion: AbleitungsFunktion, cidr: string, n?: number): { wert?: string | number; fehler?: string } {
  const c = zerlegeCidr(cidr);
  if (!c) return { fehler: `${cidr} ist kein gültiges Netz` };
  switch (funktion) {
    case 'netzadresse': return { wert: zahlZuIp(c.netz) };
    case 'praefix': return { wert: c.praefix };
    case 'erste_adresse': case 'adresse': {
      const k = funktion === 'erste_adresse' ? 1 : n;
      if (!Number.isInteger(k) || (k as number) < 0) return { fehler: 'adresse braucht n (ganze Zahl ≥ 0)' };
      if ((k as number) >= groesse(c.praefix)) return { fehler: `Adresse Netz+${k} liegt außerhalb von ${cidr}` };
      return { wert: zahlZuIp(c.netz + (k as number)) };
    }
    default: return { fehler: `unbekannte Ableitung ${String(funktion)}` };
  }
}

/** Ziffernstrings für Zahl-Typen annehmen (Modell liefert „832“ statt 832) — sonst unverändert */
function normalisiere(p: BauplanParameter, wert: unknown): unknown {
  if ((p.typ === 'vlan' || p.typ === 'vmid' || p.typ === 'zahl') && typeof wert === 'string' && /^-?\d+(\.\d+)?$/.test(wert.trim())) return Number(wert.trim());
  return wert;
}
const leer = (w: unknown) => w === undefined || w === null || w === '';

/** Eingaben prüfen (Pflicht, Typ, Grenzen), Ableitungen berechnen; unbekannte oder abgeleitete Eingaben sind Fehler. */
export function loeseParameter(v: BauplanVorlage, eingabe: Record<string, unknown>): { werte: Record<string, unknown>; fehler: string[] } {
  const fehler: string[] = [];
  const werte: Record<string, unknown> = {};
  const nachName = new Map(v.parameter.map(p => [p.name, p]));
  for (const k of Object.keys(eingabe)) {
    const p = nachName.get(k);
    if (!p) fehler.push(`Parameter ${k}: unbekannt (die Vorlage kennt ${v.parameter.map(x => x.name).join(', ') || 'keine'})`);
    else if (p.ableitung && !leer(eingabe[k])) fehler.push(`Parameter ${k}: wird abgeleitet (${p.ableitung.funktion} von ${p.ableitung.von}) und darf nicht angegeben werden`);
  }
  for (const p of v.parameter) {
    if (p.ableitung) continue;
    const roh = eingabe[p.name];
    if (leer(roh)) { if (p.pflicht) fehler.push(`Parameter ${p.name}: fehlt (Pflicht — ${p.beschreibung})`); continue; }
    const w = normalisiere(p, roh);
    const f = pruefeWert(p, w);
    if (f) fehler.push(f); else werte[p.name] = Array.isArray(w) ? [...w] : w;
  }
  for (const p of v.parameter) {
    if (!p.ableitung) continue;
    const quelle = werte[p.ableitung.von];
    if (typeof quelle !== 'string') continue; // Quelle fehlt (optional) oder ungültig — Fehler steht schon dort
    const r = ableiten(p.ableitung.funktion, quelle, p.ableitung.n);
    if (r.fehler) { fehler.push(`Parameter ${p.name}: ${r.fehler}`); continue; }
    const f = pruefeWert(p, r.wert);
    if (f) fehler.push(f); else werte[p.name] = r.wert;
  }
  return { werte, fehler };
}

const textVon = (w: unknown): string => Array.isArray(w) ? w.map(String).join(',') : String(w);

function ersetze(x: unknown, werte: Record<string, unknown>): unknown {
  if (typeof x === 'string') {
    const ganz = PARAM_GANZ.exec(x);
    if (ganz) { const w = werte[ganz[1]]; return Array.isArray(w) ? [...w] : w; }
    return x.replace(PARAM_VERWEIS, (_m, name: string) => (werte[name] === undefined ? '' : textVon(werte[name])));
  }
  if (Array.isArray(x)) return x.map(e => ersetze(e, werte)).filter(e => e !== undefined);
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, w] of Object.entries(x as Record<string, unknown>)) { const n = ersetze(w, werte); if (n !== undefined) o[k] = n; }
    return o;
  }
  return x;
}

/**
 * Setzt `{{param.x}}` in die Changes ein (Kopie, Vorlage bleibt unverändert). Ist der ganze Wert ein Verweis, behält er den Typ
 * (Zahl bleibt Zahl, Liste bleibt Liste); in einem längeren Text wird als Text eingesetzt (Liste kommagetrennt). Fehlt ein
 * optionaler Wert, entfällt ein ganzer Wert (Feld/Listeneintrag) bzw. wird im Text leer. Andere Platzhalter bleiben stehen.
 */
export function setzeEin(v: BauplanVorlage, werte: Record<string, unknown>): BauplanChange[] {
  return v.changes.map(c => ersetze(c, werte) as BauplanChange);
}
