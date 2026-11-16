/**
 * Spec Bauplan- und Dokument-Vorlagen §5.5/§7b — Schema der Bauplan-Vorlagen (Daten, streng validiert).
 *
 * Eine Vorlage beschreibt ein Paket normaler Changes mit Parametern; sie wird nie ohne Change-Freigabe ausgeführt. Die Freigabe
 * der Vorlage ist an ihren Abdruck gebunden (SHA-256 der kanonischen JSON-Form) — jede Änderung ergibt einen neuen Abdruck.
 * Hier nur die reine Strukturprüfung; Platzhalter, Geheimnisse und Probe prüft validierung.ts.
 */
import { createHash } from 'node:crypto';
import { kanonisch } from '../dokumente/beweis.js';
import type { Pruefung, PruefTyp } from '../change-schritte.js';

export type ParamTyp = 'name' | 'ipv4' | 'cidr' | 'vlan' | 'vmid' | 'node' | 'storage' | 'zahl' | 'text' | 'liste';
export type AbleitungsFunktion = 'netzadresse' | 'erste_adresse' | 'adresse' | 'praefix';
export interface BauplanParameter {
  name: string; typ: ParamTyp; pflicht: boolean; beschreibung: string; beispiel?: unknown;
  grenzen?: { regex?: string; min?: number; max?: number; laenge?: number };
  ableitung?: { funktion: AbleitungsFunktion; von: string; n?: number };
}
export interface BauplanChange {
  schluessel: string; titel: string; begruendung: string; typ: 'normal'; risiko: 'low' | 'medium' | 'high' | 'critical';
  ausfallMinuten?: number; abhaengigVon: string[]; betroffen?: string[];
  /** Task 4 Fix-Runde 1 — wie im Change-Plan: nur Neues entsteht, darum keine Sicherung vor der ersten Änderung ({{param.*}} erlaubt) */
  ohneSicherungGrund?: string;
  /** Task 6 — wie ChangePlan.zweck: nur „stilllegung“; Pflicht für endgültig löschende Schritte (z. B. proxmox.delete_vm) */
  zweck?: 'stilllegung';
  schritte: Array<Record<string, unknown> & { kapitel?: string }>;
}
export interface BauplanVorlage {
  schema: 1; key: string; titel: string; zweck: string; dokumentart: 'testprotokoll' | 'betrieb'; abbauVorlage?: string;
  parameter: BauplanParameter[]; annahmen: Array<{ id: string; text: string; pruefung: Pruefung }>; changes: BauplanChange[];
}

export const PARAM_TYPEN: readonly ParamTyp[] = ['name', 'ipv4', 'cidr', 'vlan', 'vmid', 'node', 'storage', 'zahl', 'text', 'liste'];
export const ABLEITUNGS_FUNKTIONEN: readonly AbleitungsFunktion[] = ['netzadresse', 'erste_adresse', 'adresse', 'praefix'];
const PRUEF_TYPEN: readonly PruefTyp[] = ['http', 'port', 'dns', 'ping', 'container_healthy', 'datei', 'befehl', 'skill'];
const RISIKEN = ['low', 'medium', 'high', 'critical'];
const DOKUMENTARTEN = ['testprotokoll', 'betrieb'];

export const KEY_MUSTER = /^[a-z][a-z0-9_]{2,40}$/;
export const PARAM_NAME_MUSTER = /^[a-z][a-z0-9_]{0,30}$/;
export const SCHLUESSEL_MUSTER = /^[a-z][a-z0-9_]{0,20}$/;
export const GRENZEN = { changes: 30, parameter: 40, annahmen: 20, jsonZeichen: 500_000 } as const;

/** Höchstlänge eines text-Parameters (auch Obergrenze für grenzen.laenge) — begrenzt zugleich den Aufwand von grenzen.regex */
export const TEXT_MAX_LAENGE = 200;
/** Reservierter Change-Schlüssel: unter ihm laufen die Annahmen in der Probe */
export const ANNAHMEN_SCHLUESSEL = 'annahmen';

/**
 * ReDoS-Schutz für grenzen.regex: keine Rückverweise, keine Lookarounds, keine quantifizierte Gruppe, die selbst einen
 * Quantifizierer oder eine Alternative enthält ((a+)+, (a*)*, (a|aa)+). Zeichenklassen und Escapes zählen nicht.
 * Bewusst konservativ: auch harmlose Formen wie (a|b)?c werden abgewiesen — dann als Zeichenklasse ([ab]?c) schreiben.
 */
export function regexRisiko(src: string): string | undefined {
  if (/\\[1-9]|\\k</.test(src)) return 'Rückverweise (\\1, \\k<…>) sind nicht erlaubt';
  const stapel: Array<{ riskant: boolean }> = [];
  let oben = { riskant: false };
  const quantorAb = (i: number): boolean => /^(\*|\+|\?|\{\d+(,\d*)?\})/.test(src.slice(i));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; if (quantorAb(i + 1)) oben.riskant = true; continue; }
    if (c === '[') { // Zeichenklasse überspringen
      i++; if (src[i] === '^') i++; if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      if (quantorAb(i + 1)) oben.riskant = true;
      continue;
    }
    if (c === '(') {
      if (/^\(\?(=|!|<=|<!)/.test(src.slice(i))) return 'Lookahead/Lookbehind sind nicht erlaubt';
      stapel.push(oben); oben = { riskant: false };
      const praefix = /^\(\?(:|<[A-Za-z_]\w*>)/.exec(src.slice(i)); // (?:…) und (?<name>…) — das „?“ ist kein Quantifizierer
      if (praefix) i += praefix[0].length - 1;
      continue;
    }
    if (c === ')') {
      const innen = oben; oben = stapel.pop() ?? { riskant: false };
      if (quantorAb(i + 1)) {
        if (innen.riskant) return 'verschachtelte Quantifizierer bzw. quantifizierte Alternative (z. B. (a+)+, (a|aa)+) sind nicht erlaubt';
        oben.riskant = true;
      } else if (innen.riskant) oben.riskant = true;
      continue;
    }
    if (c === '|') { oben.riskant = true; continue; }
    if (quantorAb(i)) { oben.riskant = true; const m = /^(\{\d+(,\d*)?\}|[*+?])\??/.exec(src.slice(i)); i += (m?.[0].length ?? 1) - 1; continue; }
    if (quantorAb(i + 1)) oben.riskant = true;
  }
  return undefined;
}

const VORLAGE_FELDER =['schema', 'key', 'titel', 'zweck', 'dokumentart', 'abbauVorlage', 'parameter', 'annahmen', 'changes'];
const PARAM_FELDER = ['name', 'typ', 'pflicht', 'beschreibung', 'beispiel', 'grenzen', 'ableitung'];
const GRENZ_FELDER = ['regex', 'min', 'max', 'laenge'];
const ABLEITUNG_FELDER = ['funktion', 'von', 'n'];
const ANNAHME_FELDER = ['id', 'text', 'pruefung'];
const CHANGE_FELDER = ['schluessel', 'titel', 'begruendung', 'typ', 'risiko', 'ausfallMinuten', 'abhaengigVon', 'betroffen', 'ohneSicherungGrund', 'zweck', 'schritte'];

const istObjekt = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const istText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const istZahl = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function unbekannte(o: Record<string, unknown>, erlaubt: string[], wo: string, fehler: string[]): void {
  for (const k of Object.keys(o)) if (!erlaubt.includes(k)) fehler.push(`${wo}: unbekanntes Feld „${k}“ (erlaubt: ${erlaubt.join(', ')})`);
}

function pruefeParameter(roh: unknown, i: number, fehler: string[]): void {
  const wo = `parameter[${i}]`;
  if (!istObjekt(roh)) { fehler.push(`${wo}: muss ein Objekt sein`); return; }
  unbekannte(roh, PARAM_FELDER, wo, fehler);
  if (typeof roh.name !== 'string' || !PARAM_NAME_MUSTER.test(roh.name)) fehler.push(`${wo}: name muss ${PARAM_NAME_MUSTER} entsprechen`);
  if (!PARAM_TYPEN.includes(roh.typ as ParamTyp)) fehler.push(`${wo}: typ muss einer von ${PARAM_TYPEN.join(', ')} sein`);
  if (typeof roh.pflicht !== 'boolean') fehler.push(`${wo}: pflicht muss true oder false sein`);
  if (!istText(roh.beschreibung)) fehler.push(`${wo}: beschreibung fehlt`);
  if (roh.grenzen !== undefined) {
    const g = roh.grenzen;
    if (!istObjekt(g)) fehler.push(`${wo}: grenzen muss ein Objekt sein`);
    else {
      unbekannte(g, GRENZ_FELDER, `${wo}.grenzen`, fehler);
      if (g.regex !== undefined) {
        if (typeof g.regex !== 'string' || g.regex.length > 200) fehler.push(`${wo}: grenzen.regex muss ein Text (≤ 200 Zeichen) sein`);
        else {
          let gueltig = true;
          try { new RegExp(g.regex); } catch { gueltig = false; fehler.push(`${wo}: grenzen.regex ist kein gültiger regulärer Ausdruck`); }
          const grund = gueltig ? regexRisiko(g.regex) : undefined;
          if (grund) fehler.push(`${wo}: grenzen.regex nicht erlaubt — ${grund}`);
        }
      }
      for (const k of ['min', 'max'] as const) if (g[k] !== undefined && !istZahl(g[k])) fehler.push(`${wo}: grenzen.${k} muss eine Zahl sein`);
      if (g.laenge !== undefined && !(Number.isInteger(g.laenge) && (g.laenge as number) >= 1 && (g.laenge as number) <= TEXT_MAX_LAENGE)) fehler.push(`${wo}: grenzen.laenge muss eine ganze Zahl 1–${TEXT_MAX_LAENGE} sein`);
      if (istZahl(g.min) && istZahl(g.max) && g.min > g.max) fehler.push(`${wo}: grenzen.min ist größer als grenzen.max`);
    }
  }
}

/** Ableitungen erst nach allen Parametern prüfen (Quelle muss existieren, cidr sein, selbst nicht abgeleitet) */
function pruefeAbleitung(p: Record<string, unknown>, i: number, alle: Map<string, Record<string, unknown>>, fehler: string[]): void {
  if (p.ableitung === undefined) return;
  const wo = `parameter[${i}]`;
  const a = p.ableitung;
  if (!istObjekt(a)) { fehler.push(`${wo}: ableitung muss ein Objekt sein`); return; }
  unbekannte(a, ABLEITUNG_FELDER, `${wo}.ableitung`, fehler);
  const f = a.funktion as AbleitungsFunktion;
  if (!ABLEITUNGS_FUNKTIONEN.includes(f)) { fehler.push(`${wo}: ableitung.funktion muss eine von ${ABLEITUNGS_FUNKTIONEN.join(', ')} sein`); return; }
  const quelle = typeof a.von === 'string' ? alle.get(a.von) : undefined;
  if (!quelle) fehler.push(`${wo}: ableitung.von „${String(a.von)}“ ist kein Parameter der Vorlage`);
  else if (quelle.typ !== 'cidr') fehler.push(`${wo}: ableitung.von „${String(a.von)}“ muss vom Typ cidr sein`);
  else if (quelle.ableitung !== undefined) fehler.push(`${wo}: ableitung.von „${String(a.von)}“ ist selbst abgeleitet`);
  if (f === 'adresse') {
    if (!(Number.isInteger(a.n) && (a.n as number) >= 0)) fehler.push(`${wo}: ableitung adresse braucht n (ganze Zahl ≥ 0)`);
  } else if (a.n !== undefined) fehler.push(`${wo}: ableitung ${f} kennt kein n`);
  const soll: ParamTyp = f === 'praefix' ? 'zahl' : 'ipv4';
  if (p.typ !== soll) fehler.push(`${wo}: ableitung ${f} liefert ${soll} — typ muss ${soll} sein`);
}

function pruefeAnnahme(roh: unknown, i: number, fehler: string[]): void {
  const wo = `annahmen[${i}]`;
  if (!istObjekt(roh)) { fehler.push(`${wo}: muss ein Objekt sein`); return; }
  unbekannte(roh, ANNAHME_FELDER, wo, fehler);
  if (typeof roh.id !== 'string' || !PARAM_NAME_MUSTER.test(roh.id)) fehler.push(`${wo}: id muss ${PARAM_NAME_MUSTER} entsprechen`);
  if (!istText(roh.text)) fehler.push(`${wo}: text fehlt`);
  if (!istObjekt(roh.pruefung) || !PRUEF_TYPEN.includes(roh.pruefung.typ as PruefTyp)) fehler.push(`${wo}: pruefung muss ein Objekt mit typ ${PRUEF_TYPEN.join('|')} sein`);
}

function pruefeChange(roh: unknown, i: number, fehler: string[]): void {
  const wo = `changes[${i}]`;
  if (!istObjekt(roh)) { fehler.push(`${wo}: muss ein Objekt sein`); return; }
  unbekannte(roh, CHANGE_FELDER, wo, fehler);
  if (typeof roh.schluessel !== 'string' || !SCHLUESSEL_MUSTER.test(roh.schluessel)) fehler.push(`${wo}: schluessel muss ${SCHLUESSEL_MUSTER} entsprechen`);
  else if (roh.schluessel === ANNAHMEN_SCHLUESSEL) fehler.push(`${wo}: schluessel „${ANNAHMEN_SCHLUESSEL}“ ist reserviert (Eingangskontrolle der Probe)`);
  if (!istText(roh.titel)) fehler.push(`${wo}: titel fehlt`);
  if (!istText(roh.begruendung)) fehler.push(`${wo}: begruendung fehlt`);
  if (roh.typ !== 'normal') fehler.push(`${wo}: typ muss „normal“ sein (Bauplan-Changes laufen immer über die normale Freigabe)`);
  if (!RISIKEN.includes(roh.risiko as string)) fehler.push(`${wo}: risiko muss einer von ${RISIKEN.join(', ')} sein`);
  if (roh.ausfallMinuten !== undefined && !(istZahl(roh.ausfallMinuten) && roh.ausfallMinuten >= 0)) fehler.push(`${wo}: ausfallMinuten muss eine Zahl ≥ 0 sein`);
  if (roh.ohneSicherungGrund !== undefined && !(istText(roh.ohneSicherungGrund) && roh.ohneSicherungGrund.length <= 500)) fehler.push(`${wo}: ohneSicherungGrund muss ein Text (≤ 500 Zeichen) sein`);
  if (roh.zweck !== undefined && roh.zweck !== 'stilllegung') fehler.push(`${wo}: zweck darf nur „stilllegung“ sein`);
  if (!Array.isArray(roh.abhaengigVon) || roh.abhaengigVon.some(x => typeof x !== 'string')) fehler.push(`${wo}: abhaengigVon muss eine Liste von Schlüsseln sein`);
  if (roh.betroffen !== undefined && (!Array.isArray(roh.betroffen) || roh.betroffen.some(x => typeof x !== 'string'))) fehler.push(`${wo}: betroffen muss eine Liste von Texten sein`);
  if (!Array.isArray(roh.schritte) || roh.schritte.length === 0) { fehler.push(`${wo}: schritte muss eine nicht leere Liste sein`); return; }
  roh.schritte.forEach((s, j) => {
    if (!istObjekt(s)) fehler.push(`${wo}.schritte[${j}]: muss ein Objekt sein`);
    else if (s.kapitel !== undefined && !istText(s.kapitel)) fehler.push(`${wo}.schritte[${j}]: kapitel muss ein Text sein`);
  });
}

/** Abhängigkeiten: nur bekannte Schlüssel, nicht auf sich selbst, kein Kreis */
function pruefeAbhaengigkeiten(changes: Record<string, unknown>[], fehler: string[]): void {
  const kanten = new Map<string, string[]>();
  for (const c of changes) if (typeof c.schluessel === 'string' && Array.isArray(c.abhaengigVon)) kanten.set(c.schluessel, c.abhaengigVon.filter((x): x is string => typeof x === 'string'));
  for (const [k, ab] of kanten) for (const a of ab) {
    if (a === k) fehler.push(`changes „${k}“: hängt von sich selbst ab`);
    else if (!kanten.has(a)) fehler.push(`changes „${k}“: abhaengigVon „${a}“ ist kein Change der Vorlage`);
  }
  const zustand = new Map<string, 1 | 2>();
  const besuche = (k: string, pfad: string[]): boolean => {
    if (zustand.get(k) === 2) return false;
    if (zustand.get(k) === 1) { fehler.push(`changes: Kreis in den Abhängigkeiten (${[...pfad, k].join(' → ')})`); return true; }
    zustand.set(k, 1);
    for (const a of kanten.get(k) ?? []) if (a !== k && kanten.has(a) && besuche(a, [...pfad, k])) return true;
    zustand.set(k, 2);
    return false;
  };
  for (const k of kanten.keys()) if (besuche(k, [])) break;
}

/** Strukturprüfung. Bei Fehlern keine Vorlage; sonst eine tiefe Kopie der Eingabe. */
export function pruefeSchema(roh: unknown): { vorlage?: BauplanVorlage; fehler: string[] } {
  const fehler: string[] = [];
  if (!istObjekt(roh)) return { fehler: ['Vorlage muss ein JSON-Objekt sein'] };
  let json: string;
  try { json = JSON.stringify(roh); } catch { return { fehler: ['Vorlage ist kein serialisierbares JSON'] }; }
  if (json.length > GRENZEN.jsonZeichen) return { fehler: [`Vorlage ist zu groß (${json.length} Zeichen, höchstens ${GRENZEN.jsonZeichen})`] };

  unbekannte(roh, VORLAGE_FELDER, 'Vorlage', fehler);
  if (roh.schema !== 1) fehler.push('schema muss 1 sein');
  if (typeof roh.key !== 'string' || !KEY_MUSTER.test(roh.key)) fehler.push(`key muss ${KEY_MUSTER} entsprechen`);
  if (!istText(roh.titel)) fehler.push('titel fehlt');
  if (!istText(roh.zweck)) fehler.push('zweck fehlt');
  if (!DOKUMENTARTEN.includes(roh.dokumentart as string)) fehler.push(`dokumentart muss eine von ${DOKUMENTARTEN.join(', ')} sein`);
  if (roh.abbauVorlage !== undefined && (typeof roh.abbauVorlage !== 'string' || !KEY_MUSTER.test(roh.abbauVorlage))) fehler.push(`abbauVorlage muss ${KEY_MUSTER} entsprechen`);

  if (!Array.isArray(roh.parameter)) fehler.push('parameter muss eine Liste sein');
  else if (roh.parameter.length > GRENZEN.parameter) fehler.push(`höchstens ${GRENZEN.parameter} parameter`);
  else {
    roh.parameter.forEach((p, i) => pruefeParameter(p, i, fehler));
    const alle = new Map<string, Record<string, unknown>>();
    for (const p of roh.parameter) if (istObjekt(p) && typeof p.name === 'string') {
      if (alle.has(p.name)) fehler.push(`parameter „${p.name}“ ist doppelt`);
      alle.set(p.name, p);
    }
    roh.parameter.forEach((p, i) => { if (istObjekt(p)) pruefeAbleitung(p, i, alle, fehler); });
  }

  if (!Array.isArray(roh.annahmen)) fehler.push('annahmen muss eine Liste sein');
  else if (roh.annahmen.length > GRENZEN.annahmen) fehler.push(`höchstens ${GRENZEN.annahmen} annahmen`);
  else {
    roh.annahmen.forEach((a, i) => pruefeAnnahme(a, i, fehler));
    const ids = new Set<string>();
    for (const a of roh.annahmen) if (istObjekt(a) && typeof a.id === 'string') { if (ids.has(a.id)) fehler.push(`annahmen „${a.id}“ ist doppelt`); ids.add(a.id); }
  }

  if (!Array.isArray(roh.changes) || roh.changes.length === 0) fehler.push('changes muss eine nicht leere Liste sein');
  else if (roh.changes.length > GRENZEN.changes) fehler.push(`höchstens ${GRENZEN.changes} changes`);
  else {
    roh.changes.forEach((c, i) => pruefeChange(c, i, fehler));
    const schl = new Set<string>();
    for (const c of roh.changes) if (istObjekt(c) && typeof c.schluessel === 'string') { if (schl.has(c.schluessel)) fehler.push(`changes „${c.schluessel}“ ist doppelt`); schl.add(c.schluessel); }
    pruefeAbhaengigkeiten(roh.changes.filter(istObjekt), fehler);
  }

  if (fehler.length) return { fehler };
  return { vorlage: JSON.parse(json) as BauplanVorlage, fehler };
}

/** Abdruck der Vorlage: SHA-256 (hex) der kanonischen JSON-Form — die Freigabe gilt genau dafür. */
export function abdruck(v: BauplanVorlage): string {
  return createHash('sha256').update(kanonisch(v), 'utf8').digest('hex');
}
