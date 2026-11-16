/**
 * Spec Bauplan- und Dokument-Vorlagen §5.6 (V4) — Bauplan aus erfolgreich ausgeführten Changes ableiten (rein, ohne Speicher).
 *
 * Aus den Plänen der gewählten Changes entstehen Parameter-Kandidaten (typisierte Werte an genau benannten Fundstellen),
 * Verweise über Change-Grenzen (fest eingetragene IDs, die ein früherer Change im Lauf erzeugt hat) und daraus ein Entwurf,
 * der pruefeSchema besteht. Das Modell liefert nur die Auswahl (Kandidat → Parametername), die Entscheidungen und die
 * Kopfdaten; alles andere ist Code. Ersetzt wird nur an den Fundstellen (ganzer Wert oder Token-Grenze im Text), nie per
 * globalem Suchen/Ersetzen. Werte aus Laufergebnissen dienen nur zum Erkennen von Verweisen und werden nie in den Entwurf kopiert.
 *
 * Final-Welle (Owner-Regel: nichts ändert sich still): jeder nicht parametrisierte Wert, der auf Objekte der Original-Instanz
 * zielt, braucht eine ausdrückliche Entscheidung (Entscheid, id → „ersetzen“|„fest“), die auch in der Freigabe-Frage steht:
 * (a) Teilvorkommen gewählter Werte, (b) feste IDs ohne Verweis, (c) vom Paket angelegte, aber nicht gewählte Werte
 * (samt allen Stellen, die auf sie zielen) und Adressen in einem gewählten Netz, (d) vorhandene Objekte, die das Paket verändert,
 * aber nicht anlegt (VM 9102 / probe-win25b: Snapshot, RAM, Neustart, Beitritt). Fehlt eine, entsteht nichts.
 *
 * Schutzregeln: ein gewählter Wert, der als Teil eines Tresor-Namens vorkommt, lehnt den Entwurf ab (sonst nutzte jede
 * neue Instanz die Geheimnisse der Original-Instanz); Assets, die das Paket selbst anlegt, fallen aus betroffen; „frei“-
 * Annahmen nur für Werte, die ein gewählter Change selbst anlegt.
 */
import { createHash } from 'node:crypto';
import { GEHEIM_NAME } from '../../fernzugriff/kaefig.js';
import { aktionsArt, ZEITLIMIT_STANDARD_S } from '../change-schritte.js';
import { NAME_WERT, pruefeWert } from './parameter.js';
import { PARAM_NAME_MUSTER, pruefeSchema, type AbleitungsFunktion, type BauplanChange, type BauplanParameter, type BauplanVorlage, type ParamTyp } from './schema.js';

export interface QuellChange {
  id: string;
  schluessel: string;
  /** Planform wie planAusChange (change-planung.ts) */
  plan: Record<string, unknown>;
  ergebnisse: Array<{ nr: number; ok: boolean; daten?: Record<string, unknown> }>;
  /** Asset-ID → CMDB-Name der betroffenen Assets */
  betroffenNamen: Record<string, string>;
}
/** pfad z. B. parameter.vmid, parameter.add_vmids[0], pruefung.erwartet, rueckweg.parameter.vmid, titel; schritt 0 = Change-Titel */
export interface Fundstelle { change: string; schritt: number; pfad: string; ganz: boolean }
/**
 * Vorkommen als Teil eines zusammengesetzten Tokens (157 in /etc/pve/qemu-server/157.conf, 829 in vmbr829, dc01 in
 * win-dc01-admin) in parameter, pruefung, rueckweg — nie in Titeln (dort ersetzt die Ableitung ohne Entscheidung).
 * id = <change-id>:<schritt>:<pfad>:<typ>|<wert>#<index> (volle ID; Typ und Wert, weil an derselben Stelle mehrere Werte
 * stecken können — pve und 157 in /etc/pve/qemu-server/157.conf; index = Nummer des Vorkommens des Werts im Text);
 * token = umgebendes Wort. tresor gesetzt = Teil eines Tresor-Namens, nie ersetzbar.
 */
export interface Teilvorkommen extends Fundstelle { id: string; token: string; tresor?: string }
export interface Kandidat {
  nr: number; wert: string | number; typ: ParamTyp; vorschlag: string; fundstellen: Fundstelle[];
  teilvorkommen: Teilvorkommen[];
}
/**
 * art „praefix“: in einer Prüfung steht nur der Anfang (≥ 8 Zeichen) der erzeugten ID — ganz (wert = Präfix) oder als
 * durch Leerraum getrenntes Wort (start/ende im Text); ersetzt wird durch den Verweis auf die volle ID.
 */
export interface Verweis {
  change: string; schritt: number; pfad: string; wert: string; quelle: { change: string; schritt: number; feld: string };
  art?: 'praefix'; start?: number; ende?: number;
}
/** Feste ID außerhalb eines Titels, die auf ein Objekt der Original-Instanz zeigt (kein Verweis möglich) — id = <change-id>:<schritt>:<pfad>:id|<wert> */
export interface FesteId { id: string; change: string; schritt: number; pfad: string; wert: string; grund: string }
/** Entscheidung je id: „ersetzen“ (nur Teilvorkommen) oder „fest“ (bewusst unverändert, steht in der Freigabe-Frage) */
export type Entscheid = Record<string, 'ersetzen' | 'fest'>;
/** Name aus Fix-Runde 1 — heute Teil des einheitlichen Entscheid */
export type TeilEntscheid = Entscheid;
/** Auswahl je Kandidaten-Nummer: Parametername oder {name, wert} (wert wird gegen den Kandidaten geprüft) */
export type AuswahlEintrag = string | { name: string; wert?: unknown };
/**
 * Entscheidungspunkt: art teil (a) = Teilvorkommen eines Kandidaten, id (b) = feste ID, anlage (c) = vom Paket angelegter Wert
 * (id anlage:<typ>|<wert>) bzw. Adresse in einem Netz-Kandidaten. nurFest: „ersetzen“ gibt es nicht (Ausweg: als Parameter wählen).
 */
export interface Entscheidungspunkt {
  id: string; art: 'teil' | 'id' | 'anlage' | 'veraendert' | 'tresor'; wert: string; typ?: ParamTyp; kandidat?: number; token?: string; tresor?: string;
  orte: Fundstelle[]; grund: string; nurFest: boolean;
  /** nur bei Adress-Punkten eines Netz-Kandidaten (art anlage): das Netz — nötig nur, wenn dieses Netz gewählt ist */
  netz?: string;
}
/** Bewusst feste Stelle (für Anzeige und die Spalte ableitung); tresor = Tresor-Namen, in denen der feste Wert außerdem steckt */
export interface FestEintrag {
  id: string; art: 'teil' | 'id' | 'anlage' | 'veraendert' | 'tresor'; wort: string; change8: string; schritt: number; pfad: string; grund: string; tresor?: string;
  /** Sammel-Schlüssel, aus dem die Entscheidung stammt (fehlt = einzelne id) */
  gruppe?: string;
}
/** Sammel-Entscheidung, die tatsächlich Punkte entschieden hat (für Anzeige und Freigabe-Frage) */
export interface SammelEintrag { schluessel: string; entscheidung: 'ersetzen' | 'fest'; anzahl: number; arten: Record<string, number> }
/**
 * Sammel-Schlüssel in entscheid: teil:wort|<wert>|<wort> (alle Teilvorkommen dieses gewählten Werts in genau diesem Wort, „ersetzen“
 * oder „fest“), teil:wert|<wert> (alle Teilvorkommen des Werts — nur „fest“: „ersetzen“ nur je Wort, weil derselbe Wert in
 * verschiedenen Wörtern Verschiedenes bedeutet, /etc/pve ↔ pvesm ↔ data2-pve), anlage:*, veraendert:*, tresor:*, fest:* — nur „fest“.
 * Vorrang: einzelne id, teil:wort, teil:wert bzw. Kategorie, zuletzt fest:*.
 */
export const SAMMEL_SCHLUESSEL = /^(teil:wort\|.+|teil:wert\|.+|anlage:\*|veraendert:\*|tresor:\*|fest:\*)$/;
/** Ersetztes Wort (für Anzeige und Freigabe-Frage): vmbr829 → vmbr{{param.vlan}} an n Stellen */
export interface ErsetztesWort { wert: string; wort: string; nach: string; anzahl: number }

/** Durchsuchte Teile eines Schritts (dazu der Change-Titel) */
const SUCH_TEILE = new Set(['parameter', 'pruefung', 'rueckweg', 'titel']);
const IMMER_KANDIDAT = new Set<ParamTyp>(['vmid', 'vlan', 'cidr', 'ipv4']);
/** M-b — bei gleichem Wert auf einem Parameter gewinnt der strengere Typ */
const TYP_RANG: ParamTyp[] = ['vmid', 'vlan', 'cidr', 'ipv4', 'node', 'storage', 'name'];
const VMID_SCHLUESSEL = /^(vmid|new_vmid|vm_id)$/;
const VLAN_SCHLUESSEL = /^(vlan|vlan_id|vlan_tag)$/;
const VMID_LISTE = /(^|_)vmids$/;
const VLAN_LISTE = /(^|_)vlans$/;
const NAME_SCHLUESSEL = /name|zugang|zone|domain|domaene/i;
const TRESOR_FELD = /tresor|konto/i;
/** Zahl-Felder anderer Bedeutung: dort ist 152 nie VMID/VLAN (destination_port "152") */
const ZAHL_FREMD = /port|anzahl|count|limit|timeout|sekunden|groesse|size/i;
const PLATZHALTER = /\{\{[^{}]*\}\}/g;
const GEHEIM_IN_PLATZHALTER = /^\{\{\s*(?:geheim|geheimdatei):([^\s{}]+)\s*\}\}$/;
/** daten-Felder, deren Werte als erzeugte IDs gelten (keine Namen/Domänen) */
const ID_FELD = /(^|_)id$|uuid|thumbprint|upid/i;
const FELD_NAME = /^[a-zA-Z_]\w*$/;
/** Werte, die nach erzeugter ID aussehen (UUID, Thumbprint, UPID) — für Hinweise auf feste IDs ohne Quelle */
const ID_FORM = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|UPID:.+)$/i;
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** I1 — UUID oder lange Hex-Kette (≥ 32) als Wort im Text */
const ID_IM_TEXT = /(?<![0-9a-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})(?![0-9a-z])/gi;
/** Nur bei Hex-IDs (UUID, Thumbprint) ist ein Anfang ≥ 8 Zeichen eindeutig genug für einen Verweis — nie bei Namen (alfred-pbs-taeglich) oder UPIDs */
const HEX_ID = (id: string): boolean => UUID_FORM.test(id) || /^[0-9a-f]{8,}$/i.test(id);
const ANLEGE_AKTION = (aktion: unknown): boolean => typeof aktion === 'string' && (/^(create_|provision_)/.test(aktion) || aktion === 'clone_vm');
/** I4 — Schritte, die ein Objekt anlegen (auch Wald, DNS-Eintrag); weiter als ANLEGE_AKTION, die nur Annahmen/betroffen steuert */
const ANLAGE_AKTION = (aktion: unknown): boolean => typeof aktion === 'string' && (ANLEGE_AKTION(aktion) || /_anlegen$/.test(aktion) || aktion === 'dns_eintrag' || aktion === 'dc_hinzufuegen' || aktion === 'iso_ablegen');
/** I4 — Felder, deren Wert das Paket anlegt (Name, Hostname, Zone, Policy, DNS-Record, Domäne, NetBIOS-Name, Netz, Dateiname — z. B. fernzugriff.iso_ablegen); bridge nur bei *bridge*-Aktionen */
const ANLAGE_NAME_FELD = /(^|_)name$|^hostname$|^domaene$|^domain$|^record$|^netbios|^subnet$|^dateiname$/;
/**
 * (d) fail-closed (Sicherheitsbefund v1881) — in einer verändernden Aktion (aktionsArt ≠ lesen; ohne skill/aktion gilt sie als
 * verändernd) braucht JEDER typisierte Wert in parameter.* und rueckweg.parameter.* (auch Listen und verschachtelte Felder) eine
 * Entscheidung, sofern das Paket ihn nicht selbst anlegt und er nicht als Parameter gewählt ist. Ausgenommen sind nur die
 * Träger-Felder: sie nennen den Ort der Aktion, nicht das veränderte Objekt, und sind gemeinsame Infrastruktur jeder Anwendung —
 * node, storage (Proxmox-Knoten/Speicher), device, switch_port (UniFi-Gerät/Port), job_id, job (Backup-Job).
 */
const TRAEGER_FELD = /^(node|storage|device|switch_port|job_id|job)$/;
const PARAM_PFAD = /^(rueckweg\.)?parameter(\.[A-Za-z0-9_]+|\[\d+\])+$/;
/** Felder, deren Wert ein Objekt benennt, auch wenn er keine gültige Namensform hat (früher die Ziel-Felder) */
const OBJEKT_FELD = /^(vmid|vm_id|vm_name|zugang|hostname)$/;
const IPV4_IM_TEXT = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

const kurz = (id: string): string => id.slice(0, 8);
const istObjekt = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const schritteVon = (c: QuellChange): Array<Record<string, unknown>> => (Array.isArray(c.plan.schritte) ? c.plan.schritte : []).filter(istObjekt);
const ortText = (change: string, schritt: number, pfad: string): string => schritt === 0 ? `${kurz(change)} Titel` : `${kurz(change)} Schritt ${schritt} ${pfad}`;

interface Blatt {
  change: string; schritt: number; pfad: string;
  /** Feldname des Werts (bei Listeneinträgen der Name der Liste) */
  schluessel: string; inListe: boolean; wert: unknown;
  /** Behälter und Schlüssel zum Setzen in einer Kopie */
  behaelter: Record<string, unknown> | unknown[]; index: string | number;
}

/** Alle Blätter der durchsuchten Teile (Change-Titel = Schritt 0) — in Plan-Reihenfolge */
function blaetter(c: QuellChange, plan: Record<string, unknown> = c.plan): Blatt[] {
  const aus: Blatt[] = [];
  const lauf = (x: unknown, b: Omit<Blatt, 'wert'>): void => {
    if (Array.isArray(x)) { x.forEach((e, i) => lauf(e, { ...b, pfad: `${b.pfad}[${i}]`, inListe: true, behaelter: x, index: i })); return; }
    if (istObjekt(x)) { for (const [k, w] of Object.entries(x)) lauf(w, { ...b, pfad: `${b.pfad}.${k}`, schluessel: k, inListe: false, behaelter: x, index: k }); return; }
    aus.push({ ...b, wert: x });
  };
  if (typeof plan.titel === 'string') aus.push({ change: c.id, schritt: 0, pfad: 'titel', schluessel: 'titel', inListe: false, wert: plan.titel, behaelter: plan, index: 'titel' });
  const schritte = (Array.isArray(plan.schritte) ? plan.schritte : []) as unknown[];
  schritte.forEach((s, i) => {
    if (!istObjekt(s)) return;
    for (const [teil, w] of Object.entries(s)) {
      if (!SUCH_TEILE.has(teil)) continue;
      lauf(w, { change: c.id, schritt: i + 1, pfad: teil, schluessel: teil, inListe: false, behaelter: s, index: teil });
    }
  });
  return aus;
}

const PROBE = (typ: ParamTyp): BauplanParameter => ({ name: 'x', typ, pflicht: true, beschreibung: 'x' });
const gueltig = (typ: ParamTyp, wert: unknown): boolean => pruefeWert(PROBE(typ), wert) === undefined;

/** Typ eines ganzen Werts nach Schlüsselname und Wert; undefined = kein typisierter Wert */
function typVon(schluessel: string, wert: unknown, inListe: boolean): ParamTyp | undefined {
  if (typeof wert === 'number') {
    if (!Number.isInteger(wert)) return undefined;
    if ((inListe ? VMID_LISTE : VMID_SCHLUESSEL).test(schluessel) && gueltig('vmid', wert)) return 'vmid';
    if ((inListe ? VLAN_LISTE : VLAN_SCHLUESSEL).test(schluessel) && gueltig('vlan', wert)) return 'vlan';
    return undefined;
  }
  if (typeof wert !== 'string') return undefined;
  if (/^[0-9.]+\/\d{1,2}$/.test(wert)) return gueltig('cidr', wert) ? 'cidr' : undefined;
  if (gueltig('ipv4', wert)) return 'ipv4';
  if (!NAME_WERT.test(wert)) return undefined;
  if (schluessel === 'node') return 'node';
  if (schluessel === 'storage') return 'storage';
  if (NAME_SCHLUESSEL.test(schluessel)) return 'name';
  return undefined;
}

/**
 * Wertliste in einem Feld („192.168.1.92,192.168.1.223“, „10.0.0.0/24 10.0.1.0/24“, exclude_vmids „157;158“): getrennt durch Komma,
 * Semikolon oder Leerraum. Nur wenn JEDES Element typisiert ist (ipv4, cidr; Zahlen nur als vmid/vlan nach Feldname, nie unter
 * Port-/Zähl-Feldern) — sonst undefined (Freitext, Portlisten „53,88“ bleiben ungeteilt).
 */
function listenElemente(schluessel: string, wert: unknown): Array<{ typ: ParamTyp; wert: string | number }> | undefined {
  if (typeof wert !== 'string' || wert.includes('{{')) return undefined;
  const teile = wert.trim().split(/[,;\s]+/).filter(Boolean);
  if (teile.length < 2) return undefined;
  const aus: Array<{ typ: ParamTyp; wert: string | number }> = [];
  for (const t of teile) {
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (ZAHL_FREMD.test(schluessel)) return undefined;
      const typ: ParamTyp | undefined = /vmid/i.test(schluessel) && gueltig('vmid', n) ? 'vmid' : /vlan/i.test(schluessel) && gueltig('vlan', n) ? 'vlan' : undefined;
      if (!typ) return undefined;
      aus.push({ typ, wert: n });
    } else if (/^[0-9.]+\/\d{1,2}$/.test(t)) {
      if (!gueltig('cidr', t)) return undefined;
      aus.push({ typ: 'cidr', wert: t });
    } else if (gueltig('ipv4', t)) aus.push({ typ: 'ipv4', wert: t });
    else return undefined;
  }
  return aus;
}

interface Treffer { start: number; ende: number; token: boolean; platzhalter?: string }
/** Alle Vorkommen von wert in text; token = an Token-Grenze und außerhalb eines {{…}}-Platzhalters */
function treffer(text: string, wert: string): Treffer[] {
  if (!wert) return [];
  const spannen = [...text.matchAll(PLATZHALTER)].map(m => ({ a: m.index!, e: m.index! + m[0].length, t: m[0] }));
  const aus: Treffer[] = [];
  for (let i = text.indexOf(wert); i >= 0; i = text.indexOf(wert, i + 1)) {
    const e = i + wert.length;
    const vor = i > 0 ? text[i - 1]! : '';
    const nach = e < text.length ? text[e]! : '';
    // zusätzlich zur Spec-Grenze: nach „/“ oder „\“ ist es ein Pfadteil (/etc/pve/…, C:\SQLMedia) — nie der Knoten-/Rechnername
    const grenzeVor = !/[A-Za-z0-9._\-/\\]/.test(vor);
    // „.“ danach nur als Satzende (Leerraum oder Textende dahinter): 157.conf ist kein Token, „VM 157.“ schon
    const grenzeNach = nach === '.' ? (e + 1 >= text.length || /\s/.test(text[e + 1]!)) : !/[A-Za-z0-9_-]/.test(nach);
    const sp = spannen.find(s => i >= s.a && e <= s.e) ?? spannen.find(s => i < s.e && e > s.a);
    aus.push({ start: i, ende: e, token: grenzeVor && grenzeNach && !sp, ...(sp ? { platzhalter: sp.t } : {}) });
  }
  return aus;
}

/**
 * Ziffern-Grenze für Zahl- und Adresswerte in Beschreibungen (Titel, begruendung): nie Teil einer längeren Zahl — 829 nicht in 8290/1829,
 * 10.203.29.3 nicht in 10.203.29.31, 10.203.29.3.5 oder 210.203.29.3. Davor keine Ziffer (und kein Punkt nach einer Ziffer), danach keine
 * Ziffer und kein „.<Ziffer>“ (ein Satzende-Punkt bleibt erlaubt). Namen (node, storage, name) bleiben unberührt.
 */
function zahlGrenze(text: string, start: number, ende: number, typ: ParamTyp): boolean {
  if (typ !== 'vmid' && typ !== 'vlan' && typ !== 'zahl' && typ !== 'ipv4' && typ !== 'cidr') return true;
  const vor = text[start - 1] ?? '';
  if (/\d/.test(vor) || (vor === '.' && /\d/.test(text[start - 2] ?? ''))) return false;
  const nach = text[ende] ?? '';
  return !/\d/.test(nach) && !(nach === '.' && /\d/.test(text[ende + 1] ?? ''));
}

interface Ort { blatt: Blatt; ganz: boolean }
interface Teil { blatt: Blatt; start: number; ende: number; id: string; token: string; tresor?: string; platzhalter?: string }
/** Teilvorkommen in einem Titel (M-e) — ohne Entscheidung ersetzt */
interface TitelTeil { blatt: Blatt; start: number; ende: number }

/** Anfang des umgebenden Worts (wie tokenUm) */
function tokenAnfang(text: string, start: number): number {
  let a = start;
  while (a > 0 && !/[\s"'„“]/.test(text[a - 1]!)) a--;
  return a;
}
/** Umgebendes Wort eines Vorkommens (bis Leerraum oder Anführungszeichen) */
function tokenUm(text: string, start: number, ende: number): string {
  let a = start; let e = ende;
  while (a > 0 && !/[\s"'„“]/.test(text[a - 1]!)) a--;
  while (e < text.length && !/[\s"'„“]/.test(text[e]!)) e++;
  return text.slice(a, e);
}
interface KandidatIntern { kandidat: Kandidat; orte: Ort[]; teile: Teil[]; titelTeile: TitelTeil[]; erkannt: Blatt }

/** Fundstellen und Teilvorkommen eines Werts (typ, wert) über alle Blätter */
function suche(alle: Blatt[], typ: ParamTyp, wert: string | number): { orte: Ort[]; teile: Teil[]; titelTeile: TitelTeil[] } {
  const orte: Ort[] = []; const teile: Teil[] = []; const titelTeile: TitelTeil[] = [];
  const text = String(wert);
  for (const b of alle) {
    if (typeof b.wert === 'number') {
      if (b.wert === wert && typVon(b.schluessel, b.wert, b.inListe) === typ) orte.push({ blatt: b, ganz: true });
      continue;
    }
    if (typeof b.wert !== 'string') continue;
    if ((typ === 'vmid' || typ === 'vlan') && ZAHL_FREMD.test(b.schluessel)) continue;
    const tresorFeld = TRESOR_FELD.test(b.schluessel);
    if (b.wert === text) {
      const t = typVon(b.schluessel, b.wert, b.inListe);
      if (t !== undefined && t !== typ) continue; // gleicher Wert, andere Bedeutung (z. B. node pve ↔ zugang pve)
      orte.push({ blatt: b, ganz: typeof wert === 'string' });
      continue;
    }
    const tr = treffer(b.wert, text);
    if (!tr.length) continue;
    const titel = b.pfad === 'titel';
    // Im Tresor-Feld ist jedes Vorkommen außer dem ganzen Wert ein Teil des Tresor-Namens
    if (!tresorFeld && tr.some(t => t.token)) orte.push({ blatt: b, ganz: false });
    tr.forEach((t, i) => {
      if (!tresorFeld && t.token) return;
      // M-e: Titel sind Beschreibung — Teilvorkommen dort ersetzt die Ableitung ohne Entscheidung (außer in Platzhaltern)
      if (titel) { if (!t.platzhalter && zahlGrenze(b.wert as string, t.start, t.ende, typ)) titelTeile.push({ blatt: b, start: t.start, ende: t.ende }); return; }
      const g = t.platzhalter ? GEHEIM_IN_PLATZHALTER.exec(t.platzhalter) : null;
      const tresor = tresorFeld ? b.wert as string : g ? g[1] : undefined;
      teile.push({
        blatt: b, start: t.start, ende: t.ende, id: `${b.change}:${b.schritt}:${b.pfad}:${typ}|${text}#${i}`, token: tokenUm(b.wert as string, t.start, t.ende),
        ...(tresor ? { tresor } : {}), ...(t.platzhalter ? { platzhalter: t.platzhalter } : {}),
      });
    });
  }
  return { orte, teile, titelTeile };
}

const fundstelle = (b: Blatt, ganz: boolean): Fundstelle => ({ change: b.change, schritt: b.schritt, pfad: b.pfad, ganz });
const teilvorkommen = (t: Teil): Teilvorkommen => ({ ...fundstelle(t.blatt, false), id: t.id, token: t.token, ...(t.tresor ? { tresor: t.tresor } : {}) });

function snake(s: string): string {
  let n = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(n)) n = `p_${n}`;
  return n.slice(0, 31).replace(/_+$/, '') || 'wert';
}

interface Anlage { id: string; typ: ParamTyp; wert: string | number; blatt: Blatt; skillAktion: string }
/**
 * I4 — Werte, die ein gewählter Change selbst anlegt: Namen/Hostnamen/Zonen/Policies/DNS-Records/Domänen in Anlege-Schritten,
 * VMIDs über new_vmid (bzw. vmid in create_vm/create_lxc), VLANs über unifi.create_network. id = anlage:<typ>|<wert>.
 */
function anlagen(q: QuellChange[]): Anlage[] {
  const aus = new Map<string, Anlage>();
  for (const c of q) {
    const schritte = schritteVon(c);
    for (const b of blaetter(c)) {
      const f = b.schritt > 0 ? /^parameter\.([A-Za-z0-9_]+)$/.exec(b.pfad)?.[1] : undefined;
      const s = f ? schritte[b.schritt - 1] : undefined;
      if (!f || !s || !ANLAGE_AKTION(s.aktion)) continue;
      const liste = typeof b.wert === 'string' && ANLAGE_NAME_FELD.test(f) ? listenElemente(f, b.wert) : undefined;
      if (liste) {
        for (const el of liste) {
          const id = `anlage:${el.typ}|${String(el.wert)}`;
          if (!aus.has(id)) aus.set(id, { id, typ: el.typ, wert: el.wert, blatt: b, skillAktion: `${String(s.skill)}.${String(s.aktion)}` });
        }
        continue;
      }
      let typ: ParamTyp | undefined;
      if (typeof b.wert === 'number') {
        if (((f === 'new_vmid' && ANLEGE_AKTION(s.aktion)) || (/^(vmid|vm_id)$/.test(f) && /^create_(vm|lxc)$/.test(String(s.aktion)))) && gueltig('vmid', b.wert)) typ = 'vmid';
        else if (/^(vlan|vlan_id)$/.test(f) && s.skill === 'unifi' && s.aktion === 'create_network' && gueltig('vlan', b.wert)) typ = 'vlan';
      } else if (typeof b.wert === 'string' && b.wert.trim() && !b.wert.includes('{{') && (ANLAGE_NAME_FELD.test(f) || (f === 'bridge' && /bridge/.test(String(s.aktion))))) {
        typ = typVon(f, b.wert, false) ?? 'name';
      }
      if (!typ) continue;
      const id = `anlage:${typ}|${String(b.wert)}`;
      if (!aus.has(id)) aus.set(id, { id, typ, wert: b.wert as string | number, blatt: b, skillAktion: `${String(s.skill)}.${String(s.aktion)}` });
    }
  }
  return [...aus.values()];
}

interface Veraendert { id: string; typ: ParamTyp; wert: string | number; erste: Blatt; aktionen: string[] }
/** (d) — vorhandene Objekte, die ein gewählter Change verändert, aber kein gewählter Change anlegt. id = veraendert:<typ>|<wert> */
function veraenderte(q: QuellChange[]): Veraendert[] {
  const angelegt = new Set(anlagen(q).map(x => x.id.slice('anlage:'.length)));
  const aus = new Map<string, Veraendert>();
  for (const c of q) {
    const schritte = schritteVon(c);
    for (const b of blaetter(c)) {
      if (b.schritt === 0 || !PARAM_PFAD.test(b.pfad)) continue;
      const s = schritte[b.schritt - 1];
      const traeger = b.pfad.startsWith('rueckweg.') ? s?.rueckweg : s;
      if (!istObjekt(traeger)) continue;
      const skill = traeger.skill; const aktion = traeger.aktion;
      const bekannt = typeof skill === 'string' && typeof aktion === 'string';
      if (bekannt && aktionsArt(skill, aktion, istObjekt(traeger.parameter) ? traeger.parameter : undefined) === 'lesen') continue;
      if (TRAEGER_FELD.test(b.schluessel)) continue;
      let typ: ParamTyp | undefined;
      if (typeof b.wert === 'number') typ = typVon(b.schluessel, b.wert, b.inListe);
      else if (typeof b.wert === 'string' && b.wert.trim() && !b.wert.includes('{{')) typ = typVon(b.schluessel, b.wert, b.inListe) ?? (OBJEKT_FELD.test(b.schluessel) && !listenElemente(b.schluessel, b.wert) ? 'name' : undefined);
      // Wertliste in einem Feld: jedes typisierte Element ist ein eigener Wert
      const werte = typ ? [{ typ, wert: b.wert as string | number }] : listenElemente(b.schluessel, b.wert) ?? [];
      const sa = bekannt ? `${String(skill)}.${String(aktion)}` : 'unbekannte Aktion';
      for (const el of werte) {
        const k = `${el.typ}|${String(el.wert)}`;
        if (angelegt.has(k)) continue;
        const v = aus.get(k);
        if (v) { if (!v.aktionen.includes(sa)) v.aktionen.push(sa); } else aus.set(k, { id: `veraendert:${k}`, typ: el.typ, wert: el.wert, erste: b, aktionen: [sa] });
      }
    }
  }
  return [...aus.values()];
}

const GEHEIM_NAMEN = /\{\{\s*(?:geheim|geheimdatei):([^\s{}]+)\s*\}\}/g;
interface TresorWert { id: string; wert: string; feld: boolean; geheim: boolean; erste: Blatt; aktionen: string[] }
/**
 * Tresor-Einträge: Werte in Tresor-Feldern (TRESOR_FELD, z. B. konto_tresor „pkilab-sql“) und Namen in {{geheim:…}}/{{geheimdatei:…}}
 * in parameter.* / rueckweg.parameter.* einer verändernden Aktion. Eine neue Instanz nutzte sonst still das Geheimnis der Original-Instanz.
 * Entscheidung tresor:name|<wert>: „fest“ (bewusst denselben Eintrag nutzen) oder — nur bei Tresor-Feldern — als Parameter (Name, nie Wert).
 */
function tresorWerte(q: QuellChange[]): TresorWert[] {
  const aus = new Map<string, TresorWert>();
  const merke = (wert: string, b: Blatt, sa: string, feld: boolean) => {
    const id = `tresor:name|${wert}`;
    const v = aus.get(id);
    if (!v) { aus.set(id, { id, wert, feld, geheim: !feld, erste: b, aktionen: [sa] }); return; }
    if (!v.aktionen.includes(sa)) v.aktionen.push(sa);
    if (feld) v.feld = true; else v.geheim = true;
  };
  for (const c of q) {
    const schritte = schritteVon(c);
    for (const b of blaetter(c)) {
      if (b.schritt === 0 || !PARAM_PFAD.test(b.pfad) || typeof b.wert !== 'string') continue;
      const s = schritte[b.schritt - 1];
      const traeger = b.pfad.startsWith('rueckweg.') ? s?.rueckweg : s;
      if (!istObjekt(traeger)) continue;
      const skill = traeger.skill; const aktion = traeger.aktion;
      const bekannt = typeof skill === 'string' && typeof aktion === 'string';
      if (bekannt && aktionsArt(skill, aktion, istObjekt(traeger.parameter) ? traeger.parameter : undefined) === 'lesen') continue;
      const sa = bekannt ? `${String(skill)}.${String(aktion)}` : 'unbekannte Aktion';
      if (TRESOR_FELD.test(b.schluessel) && b.wert.trim() && !b.wert.includes('{{')) merke(b.wert.trim(), b, sa, true);
      for (const m of b.wert.matchAll(GEHEIM_NAMEN)) merke(m[1]!, b, sa, false);
    }
  }
  return [...aus.values()];
}
/** Stellen eines Tresor-Namens: als Wert (ganz/Token) und in {{geheim:<name>}}/{{geheimdatei:<name>}} */
function tresorStellen(alle: Blatt[], name: string): Fundstelle[] {
  const aus = new Map<string, Fundstelle>();
  for (const o of suche(alle, 'name', name).orte) aus.set(`${o.blatt.change}|${o.blatt.schritt}|${o.blatt.pfad}`, fundstelle(o.blatt, o.ganz));
  for (const b of alle) {
    if (typeof b.wert !== 'string') continue;
    if ([...b.wert.matchAll(GEHEIM_NAMEN)].some(m => m[1] === name)) aus.set(`${b.change}|${b.schritt}|${b.pfad}`, fundstelle(b, false));
  }
  return [...aus.values()];
}

function kandidatenIntern(q: QuellChange[]): KandidatIntern[] {
  const alle = q.flatMap(c => blaetter(c));
  const erkannt = new Map<string, { typ: ParamTyp; wert: string | number; blatt: Blatt }>();
  for (const b of alle) {
    const typ = typVon(b.schluessel, b.wert, b.inListe);
    if (!typ) {
      // Wertliste in einem Feld: jedes Element ist ein eigener Kandidat (Fundstellen = Token im Text)
      if (b.pfad !== 'titel') for (const el of listenElemente(b.schluessel, b.wert) ?? []) {
        const k = `${el.typ}|${typeof el.wert}|${String(el.wert)}`;
        if (!erkannt.has(k)) erkannt.set(k, { typ: el.typ, wert: el.wert, blatt: b });
      }
      continue;
    }
    const k = `${typ}|${typeof b.wert}|${String(b.wert)}`;
    if (!erkannt.has(k)) erkannt.set(k, { typ, wert: b.wert as string | number, blatt: b });
  }
  // I4 — angelegte Werte sind immer Kandidat (wählbar statt nur „fest“), auch mit nur einer Fundstelle
  const angelegt = new Set<string>();
  // (d) — veränderte vorhandene Objekte ebenso: der Ausweg „als Parameter wählen“ muss es immer geben
  const tresorKandidaten = tresorWerte(q).filter(t => t.feld && NAME_WERT.test(t.wert)).map(t => ({ typ: 'name' as ParamTyp, wert: t.wert as string | number, blatt: t.erste }));
  for (const a of [...anlagen(q), ...veraenderte(q).map(v => ({ typ: v.typ, wert: v.wert, blatt: v.erste })), ...tresorKandidaten]) {
    const k = `${a.typ}|${typeof a.wert}|${String(a.wert)}`;
    if (!gueltig(a.typ, a.wert)) continue;
    angelegt.add(k);
    if (!erkannt.has(k)) erkannt.set(k, { typ: a.typ, wert: a.wert, blatt: a.blatt });
  }
  const aus: KandidatIntern[] = [];
  const vergeben = new Set<string>();
  for (const [key, { typ, wert, blatt }] of erkannt) {
    const { orte, teile, titelTeile } = suche(alle, typ, wert);
    if (orte.length < 2 && !IMMER_KANDIDAT.has(typ) && !angelegt.has(key)) continue;
    // Vorschlag: Schlüssel der ersten typisierten Einzelwert-Fundstelle (new_vmid statt add_vmids), sonst der erkennenden
    const quelle = orte.find(o => o.ganz && !o.blatt.inListe && typVon(o.blatt.schluessel, o.blatt.wert, false) === typ)?.blatt ?? blatt;
    const basis = snake(quelle.schluessel);
    let vorschlag = basis;
    for (let n = 2; vergeben.has(vorschlag); n++) vorschlag = `${basis.slice(0, 31 - String(n).length - 1)}_${n}`;
    vergeben.add(vorschlag);
    aus.push({
      kandidat: { nr: aus.length + 1, wert, typ, vorschlag, fundstellen: orte.map(o => fundstelle(o.blatt, o.ganz)), teilvorkommen: teile.map(teilvorkommen) },
      orte, teile, titelTeile, erkannt: quelle,
    });
  }
  return aus;
}

/** Parameter-Kandidaten der gewählten Changes (Reihenfolge = erstes Vorkommen, nr ab 1) */
export function findeKandidaten(q: QuellChange[]): Kandidat[] {
  return kandidatenIntern(q).map(k => k.kandidat);
}

/** Transitive Hülle der Vorgänger je Change-ID (nur innerhalb der Auswahl) */
function huellen(q: QuellChange[]): Map<string, Set<string>> {
  const direkt = new Map(q.map(c => [c.id, (Array.isArray(c.plan.abhaengigVon) ? c.plan.abhaengigVon : []).filter((x): x is string => typeof x === 'string')]));
  const aus = new Map<string, Set<string>>();
  for (const c of q) {
    const s = new Set<string>(); const offen = [...(direkt.get(c.id) ?? [])];
    while (offen.length) { const a = offen.pop()!; if (s.has(a) || !direkt.has(a)) continue; s.add(a); offen.push(...(direkt.get(a) ?? [])); }
    aus.set(c.id, s);
  }
  return aus;
}

interface Quelle { change: string; schritt: number; feld: string; wert: string }

/** Erzeugte IDs je Wert: nur ok-Ergebnisse, ID-Felder, ≥ 8 Zeichen, keine Zahlen < 1000, kein Echo der eigenen Eingabe */
function erzeugteIds(q: QuellChange[]): Map<string, Quelle[]> {
  const aus = new Map<string, Quelle[]>();
  for (const c of q) {
    const schritte = schritteVon(c);
    const planTexte = blaetter(c).map(b => b.wert).filter((w): w is string => typeof w === 'string');
    const gesehen = new Set<string>();
    const ergebnisse = [...c.ergebnisse].filter(e => e.ok && istObjekt(e.daten));
    const position = (nr: number): number => { const i = schritte.findIndex(s => s.nr === nr); return i >= 0 ? i + 1 : nr; };
    ergebnisse.sort((a, b) => position(a.nr) - position(b.nr));
    for (const e of ergebnisse) {
      for (const [feld, w] of Object.entries(e.daten!)) {
        if (!ID_FELD.test(feld) || !FELD_NAME.test(feld)) continue;
        const wert = typeof w === 'string' ? w : typeof w === 'number' && Number.isInteger(w) && w >= 1000 ? String(w) : undefined;
        if (!wert || wert.length < 8) continue;
        // Echo: der Wert stand schon als ganzer Wert im Plan dieses Change (Eingabe, z. B. job_id) — nicht vom Lauf erzeugt
        if (planTexte.some(t => t === wert)) continue;
        // im selben Change zählt nur der erste erzeugende Schritt (spätere Schritte geben ihn nur wieder)
        if (gesehen.has(wert)) continue;
        gesehen.add(wert);
        const liste = aus.get(wert) ?? [];
        liste.push({ change: c.id, schritt: position(e.nr), feld, wert });
        aus.set(wert, liste);
      }
    }
  }
  return aus;
}

/**
 * Verweise über Change-Grenzen: jeder ganze String-Wert eines Schritts, der genau einer erzeugten ID eines früheren gewählten
 * Change in der abhaengigVon-Hülle gleicht. Mehrdeutig, außerhalb der Hülle oder ohne Quelle → kein Verweis: in Titeln ein
 * Hinweis, sonst (I1) eine feste ID, die ausdrücklich „fest“ entschieden werden muss.
 */
export function findeVerweise(q: QuellChange[]): { verweise: Verweis[]; hinweise: string[]; feste: FesteId[] } {
  const ids = erzeugteIds(q);
  const huelle = huellen(q);
  const reihe = new Map(q.map((c, i) => [c.id, i]));
  const verweise: Verweis[] = [];
  const hinweise = new Set<string>();
  const feste = new Map<string, FesteId>();
  const ort = (b: Blatt) => ortText(b.change, b.schritt, b.pfad);
  const quellText = (s: Quelle) => `${kurz(s.change)} Schritt ${s.schritt}.${s.feld}`;
  /** Titel → Hinweis (keine Wirkung); sonst feste ID als Entscheidungspunkt */
  const melde = (b: Blatt, wert: string, grund: string): void => {
    if (b.pfad === 'titel') { hinweise.add(`${ort(b)}: ${grund}`); return; }
    const id = `${b.change}:${b.schritt}:${b.pfad}:id|${wert}`;
    if (!feste.has(id)) feste.set(id, { id, change: b.change, schritt: b.schritt, pfad: b.pfad, wert, grund });
  };
  for (const c of q) {
    const vor = huelle.get(c.id) ?? new Set<string>();
    for (const b of blaetter(c)) {
      if (typeof b.wert !== 'string') continue;
      const wert = b.wert;
      const quellen = (ids.get(wert) ?? []).filter(s => s.change !== c.id);
      if (b.schritt > 0 && quellen.length) {
        const inHuelle = quellen.filter(s => vor.has(s.change) && (reihe.get(s.change) ?? Infinity) < (reihe.get(c.id) ?? -1));
        if (inHuelle.length === 1) {
          const s = inHuelle[0]!;
          verweise.push({ change: c.id, schritt: b.schritt, pfad: b.pfad, wert, quelle: { change: s.change, schritt: s.schritt, feld: s.feld } });
        } else if (inHuelle.length > 1) {
          melde(b, wert, `${wert} ist mehrdeutig (${inHuelle.map(quellText).join(', ')}) — kein Verweis, Wert bleibt fest`);
        } else {
          melde(b, wert, `${wert} stammt aus ${quellen.map(quellText).join(', ')}, kein Vorgänger von ${kurz(c.id)} laut abhaengigVon — kein Verweis, Wert bleibt fest`);
        }
        continue;
      }
      if (b.schritt > 0 && ID_FORM.test(wert) && !quellen.length) {
        const text = `feste ID ${wert} stammt aus keinem gewählten Change — kein Verweis, Wert bleibt fest`;
        // UPID u. ä.: nur Hinweis; UUID/Hex (≥ 32) zeigt auf ein Objekt der Original-Instanz → Entscheidung
        if (UUID_FORM.test(wert) || /^[0-9a-f]{32,}$/i.test(wert)) melde(b, wert, text); else hinweise.add(`${ort(b)}: ${text}`);
        continue;
      }
      // Prüfungen: Anfang (≥ 8 Zeichen) einer erzeugten ID — ganz oder als Wort — wird Verweis auf die volle ID
      // (nichtEnthalten/erwartet sind Teiltext-Prüfungen: die volle ID trägt dieselbe Aussage, wie in pki_lab)
      const erledigt = new Set<string>();
      if (b.schritt > 0 && b.pfad.startsWith('pruefung.')) {
        const woerter = [...wert.matchAll(/\S+/g)].map(m => ({ wort: m[0], start: m.index!, ende: m.index! + m[0].length }));
        for (const w of woerter) {
          if (w.wort.length < 8) continue;
          const passend = [...ids].filter(([id]) => HEX_ID(id) && id !== w.wort && id.startsWith(w.wort))
            .flatMap(([id, qs]) => qs.filter(s => s.change !== c.id).map(s => ({ id, s })));
          if (!passend.length) continue;
          passend.forEach(p => erledigt.add(p.id));
          const inHuelle = passend.filter(p => vor.has(p.s.change) && (reihe.get(p.s.change) ?? Infinity) < (reihe.get(c.id) ?? -1));
          if (inHuelle.length === 1) {
            const s = inHuelle[0]!.s;
            verweise.push({
              change: c.id, schritt: b.schritt, pfad: b.pfad, wert: w.wort, quelle: { change: s.change, schritt: s.schritt, feld: s.feld }, art: 'praefix',
              ...(w.wort === wert ? {} : { start: w.start, ende: w.ende }),
            });
          } else if (inHuelle.length > 1) {
            melde(b, w.wort, `Anfang ${w.wort} ist mehrdeutig (${inHuelle.map(p => quellText(p.s)).join(', ')}) — kein Verweis, Wert bleibt fest`);
          } else {
            melde(b, w.wort, `Anfang ${w.wort} stammt aus ${passend.map(p => quellText(p.s)).join(', ')}, kein Vorgänger von ${kurz(c.id)} laut abhaengigVon — kein Verweis, Wert bleibt fest`);
          }
        }
      }
      // ID als Teil eines Texts (Titel „Policy e5d24ae1 entfernen“, Befehl mit voller ID) — wird nie ersetzt
      const gemeldet = new Set<string>();
      for (const [id, qs] of ids) {
        const fremd = qs.filter(s => s.change !== c.id);
        if (!fremd.length || wert === id || erledigt.has(id)) continue;
        const teil = wert.includes(id) ? id : UUID_FORM.test(id) && treffer(wert, id.slice(0, 8)).some(t => t.token) ? id.slice(0, 8) : undefined;
        if (!teil) continue;
        gemeldet.add(id.toLowerCase());
        melde(b, teil, `enthält ${teil === id ? 'die ID' : 'den Anfang der ID'} ${id} aus ${fremd.map(quellText).join(', ')} im Text — bleibt fest, bei Bedarf von Hand anpassen`);
      }
      // I1 — UUID/Hex-ID im Text ohne Quelle in der Auswahl (Titel bleiben Hinweis-frei wie bisher)
      if (b.schritt > 0 && b.pfad !== 'titel') {
        const spannen = [...wert.matchAll(PLATZHALTER)].map(m => ({ a: m.index!, e: m.index! + m[0].length }));
        for (const m of wert.matchAll(ID_IM_TEXT)) {
          const a = m.index!; const e = a + m[0].length;
          if (spannen.some(s => a < s.e && e > s.a) || gemeldet.has(m[0].toLowerCase()) || erledigt.has(m[0])) continue;
          if ((ids.get(m[0]) ?? []).some(s => s.change !== c.id)) continue;
          melde(b, m[0], `feste ID ${m[0]} im Text stammt aus keinem gewählten Change — kein Verweis, Wert bleibt fest`);
        }
      }
    }
  }
  verweise.sort((a, b) => (reihe.get(a.change)! - reihe.get(b.change)!) || a.schritt - b.schritt);
  return { verweise, hinweise: [...hinweise], feste: [...feste.values()] };
}

/** Skill.Aktion an einer Stelle (Schritt, Prüfung oder Rückweg) — für Meldungen „… (windows_ad.dns_client)“ */
function aktionAm(q: QuellChange[], change: string, schritt: number, pfad: string): string {
  const s = schritt > 0 ? schritteVon(q.find(c => c.id === change)!)[schritt - 1] : undefined;
  if (!s) return '';
  const teil = pfad.startsWith('pruefung') ? s.pruefung : pfad.startsWith('rueckweg') ? s.rueckweg : s;
  const t = istObjekt(teil) ? teil : s;
  return typeof t.skill === 'string' ? `${t.skill}.${String(t.aktion ?? '?')}` : typeof s.skill === 'string' ? `${s.skill}.${String(s.aktion ?? '?')}` : String(s.art ?? '');
}

const zuZahl = (ip: string): number => ip.split('.').reduce((s, o) => s * 256 + Number(o), 0);
function netzVon(cidr: string): { netz: number; praefix: number } | undefined {
  const m = /^([0-9.]+)\/(\d{1,2})$/.exec(cidr);
  return m && gueltig('ipv4', m[1]) ? { netz: zuZahl(m[1]!), praefix: Number(m[2]) } : undefined;
}
const imNetz = (ip: string, n: { netz: number; praefix: number }): boolean => {
  const g = 2 ** (32 - n.praefix);
  return zuZahl(ip) >= n.netz && zuZahl(ip) < n.netz + g;
};
/** IPv4-Adressen in parameter/pruefung/rueckweg, die im Netz liegen — auch mit Präfix (10.0.5.7/24); nur Netzangaben (10.0.5.0/24) zählen nicht */
function ipsImNetz(q: QuellChange[], cidr: string): string[] {
  const n = netzVon(cidr);
  if (!n) return [];
  const aus = new Set<string>();
  for (const b of q.flatMap(c => blaetter(c))) {
    if (b.pfad === 'titel' || typeof b.wert !== 'string') continue;
    for (const m of b.wert.matchAll(IPV4_IM_TEXT)) {
      const pr = /^\/(\d{1,2})(?!\d)/.exec(b.wert.slice(m.index! + m[0].length));
      if (pr && gueltig('cidr', `${m[0]}/${pr[1]}`)) continue; // Netzangabe, keine Host-Adresse
      if (gueltig('ipv4', m[0]) && imNetz(m[0], n)) aus.add(m[0]);
    }
  }
  return [...aus];
}

/**
 * Alle Entscheidungspunkte der gewählten Changes, unabhängig von der Auswahl: (a) Teilvorkommen aller Kandidaten, (b) feste IDs,
 * (c) vom Paket angelegte Werte (orte = alle Stellen außerhalb von Titeln) und Adressen in jedem Netz-Kandidaten. Welche davon
 * beim Erzeugen nötig sind, hängt von der Auswahl ab (Teilvorkommen nur gewählter Werte; angelegte Werte nur, wo sie stehen bleiben).
 */
export function findeEntscheidungen(q: QuellChange[]): Entscheidungspunkt[] {
  const intern = kandidatenIntern(q);
  const punkte = new Map<string, Entscheidungspunkt>();
  for (const k of intern) for (const t of k.teile) {
    punkte.set(t.id, {
      id: t.id, art: 'teil', wert: String(k.kandidat.wert), typ: k.kandidat.typ, kandidat: k.kandidat.nr, token: t.token, ...(t.tresor ? { tresor: t.tresor } : {}),
      orte: [fundstelle(t.blatt, false)], grund: `Teil von „${t.token}“`, nurFest: !!t.tresor || !!t.platzhalter,
    });
  }
  for (const f of findeVerweise(q).feste) punkte.set(f.id, { id: f.id, art: 'id', wert: f.wert, orte: [{ change: f.change, schritt: f.schritt, pfad: f.pfad, ganz: false }], grund: f.grund, nurFest: true });
  const ohneTitel = q.flatMap(c => blaetter(c)).filter(b => b.pfad !== 'titel');
  const kandNr = (typ: ParamTyp, wert: string | number) => intern.find(k => k.kandidat.typ === typ && String(k.kandidat.wert) === String(wert))?.kandidat.nr;
  for (const a of anlagen(q)) {
    const nr = kandNr(a.typ, a.wert);
    punkte.set(a.id, {
      id: a.id, art: 'anlage', wert: String(a.wert), typ: a.typ, ...(nr ? { kandidat: nr } : {}),
      orte: suche(ohneTitel, a.typ, a.wert).orte.map(o => fundstelle(o.blatt, o.ganz)),
      grund: `vom Paket angelegt in ${ortText(a.blatt.change, a.blatt.schritt, a.blatt.pfad)} (${a.skillAktion})`, nurFest: true,
    });
  }
  for (const v of veraenderte(q)) {
    const nr = kandNr(v.typ, v.wert);
    punkte.set(v.id, {
      id: v.id, art: 'veraendert', wert: String(v.wert), typ: v.typ, ...(nr ? { kandidat: nr } : {}),
      orte: suche(ohneTitel, v.typ, v.wert).orte.map(o => fundstelle(o.blatt, o.ganz)),
      grund: `vorhandener Wert, nicht vom Paket angelegt — in verändernder Aktion ${v.aktionen.join(', ')} (zuerst ${ortText(v.erste.change, v.erste.schritt, v.erste.pfad)})`, nurFest: true,
    });
  }
  for (const t of tresorWerte(q)) {
    const nr = t.feld ? kandNr('name', t.wert) : undefined;
    punkte.set(t.id, {
      id: t.id, art: 'tresor', wert: t.wert, typ: 'name', ...(nr ? { kandidat: nr } : {}), orte: tresorStellen(ohneTitel, t.wert),
      grund: `bestehender Tresor-Eintrag, benutzt von ${t.aktionen.join(', ')} (zuerst ${ortText(t.erste.change, t.erste.schritt, t.erste.pfad)})`, nurFest: !nr,
    });
  }
  for (const k of intern) {
    if (k.kandidat.typ !== 'cidr') continue;
    for (const ip of ipsImNetz(q, String(k.kandidat.wert))) {
      const id = `anlage:ipv4|${ip}`;
      if (punkte.has(id)) continue;
      const nr = kandNr('ipv4', ip);
      punkte.set(id, {
        id, art: 'anlage', wert: ip, typ: 'ipv4', netz: String(k.kandidat.wert), ...(nr ? { kandidat: nr } : {}), orte: suche(ohneTitel, 'ipv4', ip).orte.map(o => fundstelle(o.blatt, o.ganz)),
        grund: `Adresse im Netz ${String(k.kandidat.wert)} (Kandidat #${k.kandidat.nr}) — nur nötig, wenn das Netz gewählt und diese Adresse nicht gewählt ist`, nurFest: true,
      });
    }
  }
  return [...punkte.values()];
}

/** I3 — Stand eines Vorschlags: sha256 (12) über sortierte volle Change-IDs, Kandidaten (nr|typ|wert) und alle Entscheidungspunkt-ids */
export function standVon(q: QuellChange[]): string {
  const roh = JSON.stringify([
    q.map(c => c.id).sort(),
    findeKandidaten(q).map(k => `${k.nr}|${k.typ}|${String(k.wert)}`),
    findeEntscheidungen(q).map(p => p.id).sort(),
  ]);
  return createHash('sha256').update(roh).digest('hex').slice(0, 12);
}

/** Annahme „frei“ je gewähltem Parameter — Muster exakt wie die live bewiesene Vorlage pki_lab */
function annahmeFuer(k: KandidatIntern, name: string, schritt: (b: Blatt) => Record<string, unknown> | undefined): BauplanVorlage['annahmen'][number] | undefined {
  const oben = (o: Ort): string | undefined => /^parameter\.([A-Za-z0-9_]+)$/.exec(o.blatt.pfad)?.[1];
  const angelegt = (pruefe: (feld: string, s: Record<string, unknown>) => boolean): boolean =>
    k.orte.some(o => { const f = oben(o); const s = schritt(o.blatt); return o.ganz && !!f && !!s && pruefe(f, s); });
  const p = `{{param.${name}}}`;
  if (k.kandidat.typ === 'vmid' && angelegt((f, s) => (f === 'new_vmid' && ANLEGE_AKTION(s.aktion)) || (/^(vmid|vm_id)$/.test(f) && /^create_(vm|lxc)$/.test(String(s.aktion)))))
    return { id: `${name}_frei`, text: `VMID ${name} ist clusterweit frei`, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_vms', parameter: {}, erwartet: '| VMID |', nichtEnthalten: `| ${p} |` } as never };
  if (k.kandidat.typ === 'vlan' && angelegt((f, s) => /^(vlan|vlan_id)$/.test(f) && s.skill === 'unifi' && s.aktion === 'create_network'))
    return { id: `${name}_frei`, text: `VLAN ${name} ist in UniFi keinem Netz zugeordnet`, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_networks', parameter: {}, nichtEnthalten: `| ${p} |` } as never };
  // Nach V4 — ein Netz, das das Paket in UniFi anlegt, darf sich mit keinem vorhandenen überschneiden (unifi.subnet_pruefen liest nur);
  // nichtEnthalten „BELEGT“ zusätzlich, damit ein vorhandenes Netz mit „FREI“ im Namen die Prüfung nicht besteht
  if (k.kandidat.typ === 'cidr' && angelegt((f, s) => f === 'subnet' && s.skill === 'unifi' && s.aktion === 'create_network'))
    return { id: `${name}_frei`, text: `Netz ${name} überschneidet sich mit keinem vorhandenen Netz`, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'subnet_pruefen', parameter: { subnet: p }, erwartet: 'FREI', nichtEnthalten: 'BELEGT' } as never };
  if (angelegt((f, s) => f === 'network_name' && s.skill === 'unifi' && s.aktion === 'create_network'))
    return { id: `${name}_frei`, text: `Netzname ${name} ist in UniFi frei`, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_networks', parameter: {}, nichtEnthalten: `| ${p} |` } as never };
  return undefined;
}

/**
 * Kurzfassung der offenen Entscheidungen — steht als ERSTE Fehlerzeile, damit die Sammel-Schlüssel auch bei gekürzter Ausgabe
 * sichtbar bleiben: je Kategorie der Schlüssel, die Anzahl und die ersten Werte.
 */
export function offenUebersicht(offen: Entscheidungspunkt[]): string {
  const werte = (l: Entscheidungspunkt[], wert: (p: Entscheidungspunkt) => string) => {
    const w = [...new Set(l.map(wert))];
    return `${w.slice(0, 5).join(', ')}${w.length > 5 ? `, … (+${w.length - 5})` : ''}`;
  };
  const z = [`Offene Entscheidungen: ${offen.length}. Am einfachsten mit Sammel-Schlüsseln in entscheid (einzelne ids gehen vor; alle offenen Punkte auf einmal fest: {"fest:*": "fest"}):`];
  const teil = new Map<string, Entscheidungspunkt[]>();
  for (const p of offen.filter(x => x.art === 'teil')) { const l = teil.get(p.wert) ?? []; l.push(p); teil.set(p.wert, l); }
  for (const [w, l] of teil) {
    const woerter = new Map<string, number>();
    for (const p of l) woerter.set(p.token ?? p.wert, (woerter.get(p.token ?? p.wert) ?? 0) + 1);
    const liste = [...woerter].map(([t, n]) => `teil:wort|${w}|${t} (${n})`);
    z.push(`- teil:wert|${w} — ${l.length} offen („fest“ für alle; „ersetzen“ nur je Wort): ${liste.slice(0, 6).join(', ')}${liste.length > 6 ? `, … (+${liste.length - 6})` : ''}`);
  }
  for (const [art, text] of [['anlage', 'vom Paket angelegt'], ['veraendert', 'verändert vorhandene Objekte'], ['tresor', 'bestehende Tresor-Einträge']] as const) {
    const l = offen.filter(p => p.art === art);
    if (l.length) z.push(`- ${art}:* — ${l.length} offen (${text}, nur „fest“): ${werte(l, p => p.wert)}`);
  }
  const ids = offen.filter(p => p.art === 'id');
  if (ids.length) z.push(`- fest:* — ${ids.length} feste IDs der Original-Instanz offen (nur „fest“): ${werte(ids, p => p.wert)}`);
  z.push('Einzelheiten je id folgen unten.');
  return z.join('\n');
}

export interface EntwurfErgebnis {
  vorlage?: BauplanVorlage; fehler: string[]; hinweise: string[];
  /** fehlende Entscheidungen (alle Kategorien auf einmal) */
  offen: Entscheidungspunkt[];
  /** bewusst feste Stellen (Teilvorkommen, feste IDs, angelegte Werte) */
  fest: FestEintrag[];
  /** Parameter ohne automatische Vorab-Kontrolle (abgeleitete ausgenommen) */
  ohneAnnahme: string[];
  /** benutzte Sammel-Entscheidungen */
  sammel: SammelEintrag[];
  /** ersetzte Teilvorkommen je Wort */
  ersetzt: ErsetztesWort[];
}

const ortListe = (q: QuellChange[], orte: Fundstelle[]): string => orte.map(o => {
  const a = aktionAm(q, o.change, o.schritt, o.pfad);
  return `${ortText(o.change, o.schritt, o.pfad)}${a ? ` (${a})` : ''}`;
}).join(', ');

/**
 * Entwurf einer Bauplan-Vorlage aus den gewählten Changes (Reihenfolge wie übergeben, Schlüssel aus QuellChange.schluessel),
 * der Auswahl Kandidaten-Nummer → Parametername (oder {name, wert}) und den Entscheidungen. Ohne Fehler besteht das Ergebnis pruefeSchema.
 */
export function baueEntwurf(
  q: QuellChange[], auswahl: Record<number | string, AuswahlEintrag>,
  kopf: { key: string; titel: string; zweck: string; dokumentart: 'testprotokoll' | 'betrieb' },
  eingabe: Entscheid = {},
): EntwurfErgebnis {
  const fehler: string[] = [];
  const hinweise: string[] = [];
  const fest: FestEintrag[] = [];
  const ende = (offen: Entscheidungspunkt[] = []): EntwurfErgebnis => ({ fehler: [...new Set(fehler)], hinweise, offen, fest: [], ohneAnnahme: [], sammel: [], ersetzt: [] });
  const intern = kandidatenIntern(q);
  const nachNr = new Map(intern.map(k => [k.kandidat.nr, k]));

  // 1. Auswahl prüfen (M-b: gleicher Name nur bei gleichem Wert)
  const gewaehlt: Array<{ k: KandidatIntern; name: string }> = [];
  const namen = new Map<string, KandidatIntern>();
  for (const [nrText, roh] of Object.entries(auswahl)) {
    const k = nachNr.get(Number(nrText));
    if (!k) { fehler.push(`Auswahl: Kandidat ${nrText} gibt es nicht (1–${intern.length})`); continue; }
    const name = istObjekt(roh) ? roh.name : roh;
    if (istObjekt(roh) && roh.wert !== undefined && String(roh.wert) !== String(k.kandidat.wert)) {
      fehler.push(`Auswahl ${nrText}: Kandidat ${nrText} hat den Wert ${String(k.kandidat.wert)}, nicht ${String(roh.wert)} — Vorschlag neu holen`); continue;
    }
    if (typeof name !== 'string' || !PARAM_NAME_MUSTER.test(name)) { fehler.push(`Auswahl ${nrText}: Parametername ${JSON.stringify(name)} muss ${PARAM_NAME_MUSTER} entsprechen`); continue; }
    if (GEHEIM_NAME.test(name)) { fehler.push(`Auswahl ${nrText}: Parametername „${name}“ klingt nach einem Geheimnis — Parameter dürfen keine Geheimnisse tragen`); continue; }
    const vorher = namen.get(name);
    if (vorher && String(vorher.kandidat.wert) !== String(k.kandidat.wert)) { fehler.push(`Auswahl ${nrText}: Parametername „${name}“ ist doppelt vergeben (Kandidat ${vorher.kandidat.nr} hat einen anderen Wert)`); continue; }
    namen.set(name, vorher ?? k);
    gewaehlt.push({ k, name });
  }
  // C1 — jede Teilvorkommen-id gehört genau einer Stelle eines gewählten Werts
  const teilNachId = new Map<string, { k: KandidatIntern; name: string; t: Teil }>();
  for (const g of gewaehlt) for (const t of g.k.teile) {
    if (teilNachId.has(t.id)) fehler.push(`Teilvorkommen ${t.id}: id doppelt (Kandidaten ${teilNachId.get(t.id)!.k.kandidat.nr} und ${g.k.kandidat.nr}) — Vorschlag neu holen`);
    else teilNachId.set(t.id, { ...g, t });
  }

  // 2. Vorgänger nur aus der Auswahl
  const nachId = new Map(q.map(c => [c.id, c]));
  for (const c of q) for (const a of (Array.isArray(c.plan.abhaengigVon) ? c.plan.abhaengigVon : []) as unknown[])
    if (typeof a !== 'string' || !nachId.has(a)) fehler.push(`Change ${c.id}: Vorgänger ${String(a)} liegt nicht in der Auswahl`);

  // 3. Teilvorkommen in Tresor-Namen → ablehnen
  for (const { k } of gewaehlt) for (const t of k.teile) if (t.tresor)
    fehler.push(`${String(k.kandidat.wert)} steckt im Tresor-Namen ${t.tresor} — die Vorlage würde die Geheimnisse der Original-Instanz wiederverwenden; Wert fest lassen oder Vorlage von Hand anpassen`);
  if (fehler.length) return ende();

  // 4. Entscheidungen prüfen: bekannte id, gültiger Wert, „ersetzen“ nur wo möglich
  const punkte = new Map(findeEntscheidungen(q).map(p => [p.id, p]));
  // Sammel-Schlüssel auflösen: einzelne ids gehen vor, dann teil:wert|… bzw. Kategorie, dann fest:*
  const spezifisch: Entscheid = {};
  const sammel: Record<string, 'ersetzen' | 'fest'> = {};
  for (const [id, e] of Object.entries(eingabe ?? {})) {
    if (!SAMMEL_SCHLUESSEL.test(id)) { spezifisch[id] = e; continue; }
    if (e !== 'ersetzen' && e !== 'fest') { fehler.push(`Sammel-Schlüssel ${id}: muss „ersetzen“ oder „fest“ sein (erhalten ${JSON.stringify(e)})`); continue; }
    if (e === 'ersetzen' && id.startsWith('teil:wert|')) {
      const w = id.slice('teil:wert|'.length);
      const woerter = new Map<string, number>();
      for (const x of teilNachId.values()) if (!x.t.tresor && String(x.k.kandidat.wert) === w) woerter.set(x.t.token, (woerter.get(x.t.token) ?? 0) + 1);
      fehler.push(`Sammel-Schlüssel ${id}: nur „fest“ möglich — „ersetzen“ nur je Wort, weil derselbe Wert in verschiedenen Wörtern Verschiedenes bedeuten kann: ${[...woerter].map(([t, n]) => `teil:wort|${w}|${t} (${n})`).join(', ') || 'keine Teilvorkommen'}`);
      continue;
    }
    if (e === 'ersetzen' && !id.startsWith('teil:wort|')) { fehler.push(`Sammel-Schlüssel ${id}: nur „fest“ möglich („ersetzen“ gibt es nur je Wort: teil:wort|<wert>|<wort>)`); continue; }
    sammel[id] = e;
  }
  const entscheid: Entscheid = { ...spezifisch };
  const ausGruppe = new Map<string, string>();
  for (const p of punkte.values()) {
    if (entscheid[p.id] !== undefined) continue;
    if (p.art === 'teil' && (!teilNachId.has(p.id) || p.tresor)) continue;
    const reihe = p.art === 'teil' ? [`teil:wort|${p.wert}|${p.token ?? ''}`, `teil:wert|${p.wert}`, 'fest:*'] : p.art === 'id' ? ['fest:*'] : [`${p.art}:*`, 'fest:*'];
    const key = reihe.find(k => sammel[k] !== undefined);
    if (!key) continue;
    entscheid[p.id] = sammel[key]!;
    ausGruppe.set(p.id, key);
  }
  /** Sammel-Schlüssel → ids, die er tatsächlich entschieden hat (ungenutzt = Fehler) */
  const genutzt = new Map<string, Set<string>>();
  const nutze = (id: string): { gruppe?: string } => {
    const k = ausGruppe.get(id);
    if (!k) return {};
    const l = genutzt.get(k) ?? new Set<string>(); l.add(id); genutzt.set(k, l);
    return { gruppe: k };
  };
  for (const [id, e] of Object.entries(spezifisch)) {
    const p = punkte.get(id);
    if (e !== 'ersetzen' && e !== 'fest') { fehler.push(`Entscheidung ${id}: muss „ersetzen“ oder „fest“ sein (erhalten ${JSON.stringify(e)})`); continue; }
    if (!p || (p.art === 'teil' && !teilNachId.has(id))) { fehler.push(`Entscheidung ${id}: gehört zu keinem gewählten Wert und keinem Entscheidungspunkt dieses Vorschlags`); continue; }
    if (e === 'ersetzen' && p.art === 'id') fehler.push(`Entscheidung ${id}: feste ID ${p.wert} der Original-Instanz — nur „fest“ möglich (sonst den Change mitwählen, der sie erzeugt)`);
    if (e === 'ersetzen' && p.art === 'veraendert') fehler.push(`Entscheidung ${id}: ${p.wert} ist ein vorhandenes Objekt, das das Paket verändert — nur „fest“ — oder den Wert als Parameter wählen${p.kandidat ? ` (Kandidat #${p.kandidat})` : ''}`);
    if (e === 'ersetzen' && p.art === 'tresor') fehler.push(`Entscheidung ${id}: ${p.wert} ist ein Tresor-Eintrag — nur „fest“ — oder den Namen als Parameter wählen${p.kandidat ? ` (Kandidat #${p.kandidat})` : ' (im Platzhalter nicht möglich)'}`);
    if (e === 'ersetzen' && p.art === 'anlage') fehler.push(`Entscheidung ${id}: ${p.wert} ist vom Paket angelegt — nur „fest“ — oder den Wert als Parameter wählen${p.kandidat ? ` (Kandidat #${p.kandidat})` : ''}`);
  }
  // gleiches Wort im selben Schritt (VM157_ABWESEND in befehl und erwartet) muss gleich entschieden sein, sonst passt die Prüfung nicht mehr
  const gruppen = new Map<string, Array<{ id: string; e: string | undefined }>>();
  for (const x of teilNachId.values()) {
    if (x.t.tresor) continue;
    const g = `${x.t.blatt.change}|${x.t.blatt.schritt}|${x.k.kandidat.typ}|${String(x.k.kandidat.wert)}|${x.t.token}`;
    const l = gruppen.get(g) ?? []; l.push({ id: x.t.id, e: entscheid[x.t.id] }); gruppen.set(g, l);
  }
  for (const [g, l] of gruppen) {
    const arten = new Set(l.map(x => x.e).filter(e => e !== undefined));
    if (arten.size > 1) {
      const [change, schritt, , , token] = g.split('|') as [string, string, string, string, string];
      fehler.push(`Teilvorkommen ${l.map(x => `${x.id} (${String(x.e)})`).join(', ')}: gleiches Wort ${token} in ${kurz(change)} Schritt ${schritt} — gleich entscheiden`);
    }
  }
  // M-b — dieselbe Stelle als Teil zweier gewählter Kandidaten (zugang pve / node pve) braucht dieselbe Entscheidung
  const spanne = new Map<string, Array<{ id: string; e: string | undefined }>>();
  for (const x of teilNachId.values()) {
    const s = `${x.t.blatt.change}|${x.t.blatt.schritt}|${x.t.blatt.pfad}|${x.t.start}|${x.t.ende}`;
    const l = spanne.get(s) ?? []; l.push({ id: x.t.id, e: entscheid[x.t.id] }); spanne.set(s, l);
  }
  for (const l of spanne.values()) if (new Set(l.map(x => x.e).filter(e => e !== undefined)).size > 1)
    fehler.push(`Teilvorkommen ${l.map(x => `${x.id} (${String(x.e)})`).join(', ')}: gleiche Stelle — gleich entscheiden`);
  if (fehler.length) return ende();

  const verw = findeVerweise(q);
  hinweise.push(...verw.hinweise);

  // M-c — gewählte Netze: Adressen darin werden Ableitungen, „/<praefix>“ dahinter wird praefix(netz)
  const netze = gewaehlt.filter(g => g.k.kandidat.typ === 'cidr').map(g => ({ name: g.name, cidr: String(g.k.kandidat.wert), n: netzVon(String(g.k.kandidat.wert))! }))
    .filter(n => n.n).sort((a, b) => b.n.praefix - a.n.praefix);
  const netzFuer = (ip: string) => netze.find(n => imNetz(ip, n.n));
  const praefixName = new Map<string, string>();
  const vergebeneNamen = new Set(gewaehlt.map(g => g.name));
  const praefixParam = (netz: string): string => {
    let n = praefixName.get(netz);
    if (n) return n;
    const basis = `${netz.slice(0, 23)}_praefix`;
    n = basis;
    for (let i = 2; vergebeneNamen.has(n); i++) n = `${basis.slice(0, 29)}_${i}`;
    vergebeneNamen.add(n); praefixName.set(netz, n);
    return n;
  };

  // 5. Kopien und Orte darin; Ersetzungen je Ort sammeln
  const kopien = new Map(q.map(c => [c.id, JSON.parse(JSON.stringify(c.plan)) as Record<string, unknown>]));
  const ortKey = (change: string, schritt: number, pfad: string) => `${change}|${schritt}|${pfad}`;
  const ziele = new Map<string, Blatt>();
  for (const c of q) for (const b of blaetter(c, kopien.get(c.id))) ziele.set(ortKey(c.id, b.schritt, b.pfad), b);
  type Spanne = { start: number; ende: number; durch: string; info?: string };
  type Ersatz = { wer: string; ganz?: string; text?: Spanne[] };
  const ersetzungen = new Map<string, Ersatz[]>();
  const merke = (key: string, e: Ersatz) => { const l = ersetzungen.get(key) ?? []; l.push(e); ersetzungen.set(key, l); };
  /** „fest“ entschiedene Teilvorkommen — gemeldet nur, wenn die Stelle danach wirklich unverändert steht (nicht von einem längeren Wert ersetzt) */
  const festTeile: Array<{ key: string; start: number; ende: number; hinweis: string; eintrag: FestEintrag }> = [];
  const ersetzteWoerter = new Map<string, ErsetztesWort>();
  const angewandt = new Map<string, Array<{ start: number; ende: number }>>();
  /** Titel (M-e): ohne Entscheidung, längster Wert gewinnt, nie Fehler */
  const titelSpannen = new Map<string, Spanne[]>();
  const merkeTitel = (key: string, s: Spanne) => { const l = titelSpannen.get(key) ?? []; l.push(s); titelSpannen.set(key, l); };
  for (const v of verw.verweise) {
    const s = nachId.get(v.quelle.change)!;
    const ref = `{{change:${s.schluessel}.schritt${v.quelle.schritt}.${v.quelle.feld}}}`;
    const wer = `Verweis auf ${kurz(s.id)} Schritt ${v.quelle.schritt}`;
    if (v.start !== undefined && v.ende !== undefined) merke(ortKey(v.change, v.schritt, v.pfad), { wer, text: [{ start: v.start, ende: v.ende, durch: ref }] });
    else merke(ortKey(v.change, v.schritt, v.pfad), { wer, ganz: ref });
  }
  for (const { k, name } of gewaehlt) {
    const p = `{{param.${name}}}`;
    const wert = String(k.kandidat.wert);
    const netz = k.kandidat.typ === 'ipv4' ? netzFuer(wert) : undefined;
    for (const o of k.orte) {
      const key = ortKey(o.blatt.change, o.blatt.schritt, o.blatt.pfad);
      if (o.blatt.pfad === 'titel') {
        const t = String(o.blatt.wert);
        if (o.ganz) merkeTitel(key, { start: 0, ende: t.length, durch: p });
        else for (const x of treffer(t, wert).filter(x => x.token)) merkeTitel(key, { start: x.start, ende: x.ende, durch: p });
        continue;
      }
      if (o.ganz || typeof o.blatt.wert !== 'string') { merke(key, { wer: name, ganz: p }); continue; }
      const alt = o.blatt.wert;
      merke(key, {
        wer: name, text: treffer(alt, wert).filter(t => t.token).map(t => {
          // „10.203.29.2/27“: Präfix des gewählten Netzes hinter einer abgeleiteten Adresse folgt dem Netz
          const pr = netz ? /^\/(\d{1,2})(?!\d)/.exec(alt.slice(t.ende)) : null;
          if (netz && pr && Number(pr[1]) === netz.n.praefix) return { start: t.start, ende: t.ende + pr[0].length, durch: `${p}/{{param.${praefixParam(netz.name)}}}` };
          return { start: t.start, ende: t.ende, durch: p };
        }),
      });
    }
    for (const t of k.titelTeile) merkeTitel(ortKey(t.blatt.change, t.blatt.schritt, t.blatt.pfad), { start: t.start, ende: t.ende, durch: p });
    // Teilvorkommen nur nach ausdrücklicher Entscheidung (Tresor-Teile sind oben schon abgelehnt)
    for (const t of k.teile) {
      const e = entscheid[t.id];
      if (e === undefined) continue; // fehlt → unten als offen gemeldet
      const g = nutze(t.id);
      const wo = ortText(t.blatt.change, t.blatt.schritt, t.blatt.pfad);
      if (e === 'fest') {
        festTeile.push({
          key: ortKey(t.blatt.change, t.blatt.schritt, t.blatt.pfad), start: t.start, ende: t.ende, hinweis: `bewusst fest: ${t.token} in ${wo}`,
          eintrag: { id: t.id, art: 'teil', wort: t.token, change8: kurz(t.blatt.change), schritt: t.blatt.schritt, pfad: t.blatt.pfad, grund: `Teil mit ${wert} (Parameter ${name}) bleibt unverändert`, ...g },
        });
        continue;
      }
      if (t.platzhalter) { fehler.push(`Teilvorkommen ${t.id}: ${wert} steht im Platzhalter ${t.platzhalter} — nur „fest“ möglich`); continue; }
      merke(ortKey(t.blatt.change, t.blatt.schritt, t.blatt.pfad), { wer: name, text: [{ start: t.start, ende: t.ende, durch: p, info: `${wert} in ${t.token} (${t.id})` }] });
      const a = tokenAnfang(String(t.blatt.wert), t.start);
      const nach = t.token.slice(0, t.start - a) + p + t.token.slice(t.ende - a);
      const kw = `${wert}|${t.token}|${nach}`;
      const x = ersetzteWoerter.get(kw) ?? { wert, wort: t.token, nach, anzahl: 0 };
      x.anzahl++; ersetzteWoerter.set(kw, x);
    }
  }
  for (const [key, liste] of ersetzungen) {
    const ziel = ziele.get(key);
    const [change, schritt, pfad] = key.split('|') as [string, string, string];
    const wo = ortText(change, Number(schritt), pfad);
    if (!ziel) { fehler.push(`${wo}: Fundstelle nicht gefunden`); continue; }
    // M-b: gleicher Wert über zwei Kandidaten auf demselben Parameter → identische Ersetzung nur einmal
    const ganze = [...new Map(liste.filter(e => e.ganz !== undefined).map(e => [e.ganz!, e])).values()];
    const texte = liste.filter(e => e.ganz === undefined);
    const infos = texte.flatMap(e => (e.text ?? []).map(t => t.info).filter((x): x is string => !!x));
    const ausweg = infos.length ? ` — nur einen davon wählen oder die Stelle auf „fest“ setzen (${infos.join('; ')})` : ' — nur einen davon wählen';
    if (ganze.length > 1) { fehler.push(`${wo}: gehört zu mehreren gewählten Werten (${liste.map(e => e.wer).join(', ')}) — nur einen davon wählen`); continue; }
    if (ganze.length && texte.length) { fehler.push(`${wo}: Werte überlappen (${[...new Set(liste.map(e => e.wer))].join(', ')})${ausweg}`); continue; }
    if (ganze.length) { (ziel.behaelter as Record<string | number, unknown>)[ziel.index] = ganze[0]!.ganz; angewandt.set(key, [{ start: 0, ende: Infinity }]); continue; }
    const teile = [...new Map(texte.flatMap(e => (e.text ?? []).map(t => ({ ...t, wer: e.wer }))).map(t => [`${t.start}|${t.ende}|${t.durch}`, t])).values()]
      .sort((a, b) => a.start - b.start);
    const ueberlappt = teile.find((t, i) => i > 0 && t.start < teile[i - 1]!.ende);
    if (ueberlappt) {
      fehler.push(`${wo}: Werte überlappen im Text (${[...new Set(teile.map(t => t.wer))].join(', ')})${ausweg}`);
      continue;
    }
    const alt = String(ziel.wert);
    // „{“ davor oder „}“ danach würde mit dem eingesetzten {{…}} einen ungültigen Platzhalter bilden
    const klammer = teile.find(t => alt[t.start - 1] === '{' || alt[t.ende] === '}');
    if (klammer) { fehler.push(`${wo}: Ersetzen in „${tokenUm(alt, klammer.start, klammer.ende)}“ würde einen ungültigen Platzhalter bilden — Wert hier nicht als Parameter möglich`); continue; }
    let text = alt;
    for (const t of [...teile].reverse()) text = text.slice(0, t.start) + t.durch + text.slice(t.ende);
    (ziel.behaelter as Record<string | number, unknown>)[ziel.index] = text;
    angewandt.set(key, teile.map(t => ({ start: t.start, ende: t.ende })));
  }
  for (const f of festTeile) {
    if ((angewandt.get(f.key) ?? []).some(a => f.start < a.ende && f.ende > a.start)) continue; // 10.203.29.3 in 10.203.29.30: dort steht der Parameter der .30
    hinweise.push(f.hinweis);
    fest.push(f.eintrag);
  }
  // Titel: längste Werte zuerst, nichts Überlappendes, nie an „{“/„}“ — Titel haben keine Wirkung, darum ohne Fehler
  const beschreibung = (alt: string, liste: Spanne[]): string => {
    const gewaehltT: Spanne[] = [];
    for (const s of [...liste].sort((a, b) => (b.ende - b.start) - (a.ende - a.start) || a.start - b.start)) {
      if (alt[s.start - 1] === '{' || alt[s.ende] === '}') continue;
      if (gewaehltT.some(g => s.start < g.ende && s.ende > g.start)) continue;
      gewaehltT.push(s);
    }
    let text = alt;
    for (const t of gewaehltT.sort((a, b) => b.start - a.start)) text = text.slice(0, t.start) + t.durch + text.slice(t.ende);
    return text;
  };
  for (const [key, liste] of titelSpannen) {
    const ziel = ziele.get(key);
    if (!ziel || typeof ziel.wert !== 'string') continue;
    (ziel.behaelter as Record<string | number, unknown>)[ziel.index] = beschreibung(ziel.wert, liste);
  }
  // Nach V4 — begruendung ist wie der Titel reine Beschreibung (steht aber in späteren Freigaben): gewählte Werte genauso ersetzen —
  // jedes Vorkommen außerhalb eines {{…}}-Platzhalters (ganzer Wert, Token und Teil eines Worts), längster Wert gewinnt, ohne Entscheidung
  for (const plan of kopien.values()) {
    if (typeof plan.begruendung !== 'string') continue;
    const alt = plan.begruendung;
    const liste: Spanne[] = gewaehlt.flatMap(({ k, name }) => treffer(alt, String(k.kandidat.wert)).filter(t => !t.platzhalter && zahlGrenze(alt, t.start, t.ende, k.kandidat.typ)).map(t => ({ start: t.start, ende: t.ende, durch: `{{param.${name}}}` })));
    if (liste.length) plan.begruendung = beschreibung(alt, liste);
  }

  // 6. Offene Entscheidungen — alle Kategorien auf einmal
  const offenTeil = [...teilNachId.values()].filter(x => !x.t.tresor && entscheid[x.t.id] === undefined);
  const offenId = [...punkte.values()].filter(p => p.art === 'id' && entscheid[p.id] === undefined);
  for (const p of punkte.values()) if (p.art === 'id' && entscheid[p.id] === 'fest') {
    const o = p.orte[0]!;
    hinweise.push(`bewusst fest (feste ID): ${p.wert} in ${ortText(o.change, o.schritt, o.pfad)} — ${p.grund}`);
    fest.push({ id: p.id, art: 'id', wort: p.wert, change8: kurz(o.change), schritt: o.schritt, pfad: o.pfad, grund: p.grund, ...nutze(p.id) });
  }
  // (c) angelegte Werte und Adressen gewählter Netze, die nach dem Ersetzen noch irgendwo (außer Titeln) stehen
  const nachher = q.flatMap(c => blaetter(c, kopien.get(c.id))).filter(b => b.pfad !== 'titel');
  const offenAnlage: Entscheidungspunkt[] = [];
  const offenVeraendert: Entscheidungspunkt[] = [];
  const offenTresor: Entscheidungspunkt[] = [];
  for (const p of punkte.values()) {
    if (p.art === 'tresor') {
      const rest = tresorStellen(nachher, p.wert);
      if (!rest.length) { if (spezifisch[p.id] !== undefined) fehler.push(`Entscheidung ${p.id}: nicht nötig — ${p.wert} ist als Parameter gewählt und steht nirgends mehr fest`); continue; }
      if (entscheid[p.id] === 'fest') {
        hinweise.push(`bewusst fest (bestehender Tresor-Eintrag): ${p.wert} an ${rest.length} Stelle${rest.length === 1 ? '' : 'n'} (${ortListe(q, rest.slice(0, 5))}${rest.length > 5 ? ', …' : ''}) — jede Anwendung nutzt denselben Tresor-Eintrag`);
        const g = nutze(p.id);
        for (const o of rest) fest.push({ id: p.id, art: 'tresor', wort: p.wert, change8: kurz(o.change), schritt: o.schritt, pfad: o.pfad, grund: p.grund, ...g });
      } else if (entscheid[p.id] === undefined) offenTresor.push({ ...p, orte: rest });
      continue;
    }
    if (p.art !== 'anlage' && p.art !== 'veraendert') continue;
    // fail-closed: ein Punkt ohne Typ kann nicht geprüft werden → nie still überspringen
    if (!p.typ) { if (entscheid[p.id] !== 'fest') fehler.push(`Entscheidungspunkt ${p.id}: ohne Typ nicht prüfbar — nur „fest“ möglich`); continue; }
    const anlageWert = p.typ === 'vmid' || p.typ === 'vlan' ? Number(p.wert) : p.wert;
    // einzige Ausnahme, ausdrücklich und art-gebunden: Adress-Punkt eines Netz-Kandidaten, dessen Netz nicht gewählt ist
    const istNetzAdresse = p.art === 'anlage' && p.netz !== undefined;
    if (istNetzAdresse && !netzFuer(p.wert)) { if (spezifisch[p.id] !== undefined) fehler.push(`Entscheidung ${p.id}: nicht nötig — kein gewähltes Netz enthält ${p.wert}`); continue; }
    const gefunden = suche(nachher, p.typ, anlageWert);
    const rest = gefunden.orte.map(o => fundstelle(o.blatt, o.ganz));
    // Tresor-Namen, in denen der feste Wert außerdem steckt (win-dc01-admin bei dc01) — am fest-Eintrag sichtbar
    const tresorOrte = new Map<string, string[]>();
    for (const t of gefunden.teile.filter(x => x.tresor)) { const l = tresorOrte.get(t.tresor!) ?? []; l.push(ortText(t.blatt.change, t.blatt.schritt, t.blatt.pfad)); tresorOrte.set(t.tresor!, l); }
    const tresor = tresorOrte.size ? [...tresorOrte].map(([n, o]) => `${n} (${[...new Set(o)].join(', ')})`).join('; ') : undefined;
    if (!rest.length) {
      if (spezifisch[p.id] !== undefined) fehler.push(`Entscheidung ${p.id}: nicht nötig — ${p.wert} ist als Parameter gewählt und steht nirgends mehr fest`);
      continue;
    }
    if (entscheid[p.id] === 'fest') {
      const art = p.art === 'veraendert' ? 'verändert vorhandenes Objekt' : 'vom Paket angelegt';
      hinweise.push(`bewusst fest (${art}): ${p.wert} an ${rest.length} Stelle${rest.length === 1 ? '' : 'n'} (${ortListe(q, rest.slice(0, 5))}${rest.length > 5 ? ', …' : ''}) — ${p.grund}${tresor ? ` — steckt auch im Tresor-Namen ${tresor}` : ''}`);
      const g = nutze(p.id);
      for (const o of rest) fest.push({ id: p.id, art: p.art, wort: p.wert, change8: kurz(o.change), schritt: o.schritt, pfad: o.pfad, grund: p.grund, ...(tresor ? { tresor } : {}), ...g });
      continue;
    }
    if (entscheid[p.id] === undefined) (p.art === 'veraendert' ? offenVeraendert : offenAnlage).push({ ...p, orte: rest });
  }
  const offen: Entscheidungspunkt[] = [
    ...offenTeil.map(x => punkte.get(x.t.id)!).filter(Boolean),
    ...offenId, ...offenAnlage, ...offenVeraendert, ...offenTresor,
  ];
  for (const k of Object.keys(sammel)) if (!genutzt.has(k)) fehler.push(`Sammel-Schlüssel ${k}: trifft keinen offenen Punkt — entfernen`);
  if (offen.length) fehler.unshift(offenUebersicht(offen));
  if (offenTeil.length) fehler.push(`Teilvorkommen ohne Entscheidung (je id „ersetzen“ oder „fest“): ${offenTeil.map(x => `${x.t.id} (${String(x.k.kandidat.wert)} in ${x.t.token})`).join('; ')}`);
  if (offenId.length) fehler.push(`Feste IDs der Original-Instanz ohne Entscheidung (je id nur „fest“ — oder den erzeugenden Change mitwählen): ${offenId.map(p => `${p.id} (${ortListe(q, p.orte)}: ${p.grund})`).join('; ')}`);
  if (offenAnlage.length) fehler.push(`Vom Paket angelegt, aber nicht als Parameter gewählt — diese Stellen zielen sonst auf die Original-Instanz (je id „fest“ oder den Wert als Parameter wählen): ${offenAnlage.map(p => `${p.id} (${p.wert}${p.kandidat ? `, Kandidat #${p.kandidat}` : ''}; ${p.grund}; noch an ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}: ${ortListe(q, p.orte)})`).join('; ')}`);
  if (offenVeraendert.length) fehler.push(`Verändert vorhandene Objekte, die das Paket nicht anlegt und die nicht als Parameter gewählt sind — jede Anwendung träfe wieder dasselbe Objekt (je id „fest“ oder den Wert als Parameter wählen): ${offenVeraendert.map(p => `${p.id} (${p.wert}${p.kandidat ? `, Kandidat #${p.kandidat}` : ''}; ${p.grund}; an ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}: ${ortListe(q, p.orte)})`).join('; ')}`);
  if (offenTresor.length) fehler.push(`Verwendet bestehende Tresor-Einträge — eine neue Instanz nutzte sonst still das Geheimnis der Original-Instanz (je id „fest“ oder den Namen als Parameter wählen): ${offenTresor.map(p => `${p.id} (${p.wert}${p.kandidat ? `, Kandidat #${p.kandidat}` : ', nur „fest“'}; ${p.grund}; an ${p.orte.length} Stelle${p.orte.length === 1 ? '' : 'n'}: ${ortListe(q, p.orte)})`).join('; ')}`);
  if (fehler.length) return ende(offen);
  for (const [k, ids] of genutzt) hinweise.push(`Sammel-Entscheidung ${k} = ${sammel[k]}: ${ids.size} Punkt${ids.size === 1 ? '' : 'e'}`);

  // 7. Changes bauen: Laufzeitfelder weg, abhaengigVon auf Schlüssel, betroffen ohne selbst angelegte Assets
  const schrittVon = (b: Blatt): Record<string, unknown> | undefined => b.schritt > 0 ? schritteVon(nachId.get(b.change)!)[b.schritt - 1] : undefined;
  const angelegteNamen = new Set<string>();
  for (const { k } of gewaehlt) if (k.kandidat.typ === 'name' && k.orte.some(o => {
    const f = /^parameter\.([A-Za-z0-9_]+)$/.exec(o.blatt.pfad)?.[1]; const s = schrittVon(o.blatt);
    return o.ganz && !!f && /name$/.test(f) && !!s && ANLEGE_AKTION(s.aktion);
  })) angelegteNamen.add(String(k.kandidat.wert).toLowerCase());
  const changes: BauplanChange[] = [];
  for (const c of q) {
    const plan = kopien.get(c.id)!;
    const schritte = schritteVon({ ...c, plan }).map(s => {
      const { nr: _nr, einordnung: _e, ...rest } = s;
      if (rest.zeitlimitS === ZEITLIMIT_STANDARD_S) delete rest.zeitlimitS;
      return rest;
    });
    const betroffen: string[] = [];
    for (const a of (Array.isArray(plan.betroffen) ? plan.betroffen : []) as unknown[]) {
      if (typeof a !== 'string') continue;
      const n = c.betroffenNamen[a];
      if (n !== undefined && angelegteNamen.has(n.toLowerCase())) { hinweise.push(`${kurz(c.id)} betroffen: Asset ${a} (${n}) legt das Paket selbst an — entfernt`); continue; }
      betroffen.push(a);
    }
    if (!betroffen.length) fehler.push(`Change ${kurz(c.id)} („${String(c.plan.titel)}“): bleibt ohne betroffen — mindestens ein vorhandenes Asset nötig (Asset von Hand ergänzen oder Wert nicht als Parameter wählen)`);
    if (plan.typ !== undefined && plan.typ !== 'normal') hinweise.push(`${kurz(c.id)}: typ ${String(plan.typ)} → normal (Bauplan-Changes laufen über die normale Freigabe)`);
    const begruendung = typeof plan.begruendung === 'string' && plan.begruendung.trim() ? plan.begruendung : `Abgeleitet aus Change ${kurz(c.id)}`;
    changes.push({
      schluessel: c.schluessel, titel: plan.titel as string, begruendung, typ: 'normal', risiko: plan.risiko as BauplanChange['risiko'],
      ...(typeof plan.ausfallMinuten === 'number' ? { ausfallMinuten: plan.ausfallMinuten } : {}),
      abhaengigVon: ((plan.abhaengigVon ?? []) as string[]).map(a => nachId.get(a)!.schluessel),
      betroffen,
      ...(plan.zweck === 'stilllegung' ? { zweck: 'stilllegung' as const } : {}),
      ...(typeof plan.ohneSicherungGrund === 'string' && plan.ohneSicherungGrund.trim() ? { ohneSicherungGrund: plan.ohneSicherungGrund } : {}),
      schritte,
    });
  }
  if (fehler.length) return ende();

  // 8. Parameter (je Name einer; strengerer Typ gewinnt), Ableitungen im gewählten Netz, automatische Annahmen
  const parameter: BauplanParameter[] = [];
  const ohneAnnahme: string[] = [];
  const annahmen: BauplanVorlage['annahmen'] = [];
  for (const name of [...new Set(gewaehlt.map(g => g.name))]) {
    const ks = gewaehlt.filter(g => g.name === name).map(g => g.k);
    const typ = TYP_RANG.find(t => ks.some(k => k.kandidat.typ === t)) ?? ks[0]!.kandidat.typ;
    const k0 = ks.find(k => k.kandidat.typ === typ)!;
    const beschreibung = `abgeleitet aus ${kurz(k0.erkannt.change)} ${k0.erkannt.schritt ? `schritt${k0.erkannt.schritt}.` : ''}${k0.erkannt.pfad}`;
    const netz = typ === 'ipv4' ? netzFuer(String(k0.kandidat.wert)) : undefined;
    if (netz) {
      const off = zuZahl(String(k0.kandidat.wert)) - netz.n.netz;
      const ableitung: { funktion: AbleitungsFunktion; von: string; n?: number } = off === 0 ? { funktion: 'netzadresse', von: netz.name }
        : off === 1 ? { funktion: 'erste_adresse', von: netz.name } : { funktion: 'adresse', von: netz.name, n: off };
      parameter.push({ name, typ: 'ipv4', pflicht: false, beschreibung: `${beschreibung} — folgt dem Netz ${netz.name} (Netz+${off})`, beispiel: k0.kandidat.wert, ableitung });
      continue;
    }
    parameter.push({ name, typ, pflicht: true, beschreibung, beispiel: k0.kandidat.wert });
    const a = ks.map(k => annahmeFuer(k, name, schrittVon)).find(x => x);
    if (a) annahmen.push(a);
    else { ohneAnnahme.push(name); hinweise.push(`keine automatische Vorab-Kontrolle für ${name} (${typ})`); }
  }
  for (const [netz, name] of praefixName) parameter.push({ name, typ: 'zahl', pflicht: false, beschreibung: `Präfixlänge des Netzes ${netz} (abgeleitet)`, ableitung: { funktion: 'praefix', von: netz } });

  const schema = pruefeSchema({ schema: 1, key: kopf.key, titel: kopf.titel, zweck: kopf.zweck, dokumentart: kopf.dokumentart, parameter, annahmen, changes });
  if (!schema.vorlage) return { fehler: schema.fehler, hinweise, offen: [], fest: [], ohneAnnahme: [], sammel: [], ersetzt: [] };
  const sammelListe: SammelEintrag[] = [...genutzt].map(([schluessel, ids]) => {
    const arten: Record<string, number> = {};
    for (const id of ids) { const a = punkte.get(id)?.art ?? 'teil'; arten[a] = (arten[a] ?? 0) + 1; }
    return { schluessel, entscheidung: sammel[schluessel]!, anzahl: ids.size, arten };
  });
  return { vorlage: schema.vorlage, fehler: [], hinweise, offen: [], fest, ohneAnnahme, sammel: sammelListe, ersetzt: [...ersetzteWoerter.values()] };
}
