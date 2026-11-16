/**
 * Spec Bauplan- und Dokument-Vorlagen §5.6 (V4) — Bauplan aus erfolgreich ausgeführten Changes ableiten (rein, ohne Speicher).
 *
 * Aus den Plänen der gewählten Changes entstehen Parameter-Kandidaten (typisierte Werte an genau benannten Fundstellen),
 * Verweise über Change-Grenzen (fest eingetragene IDs, die ein früherer Change im Lauf erzeugt hat) und daraus ein Entwurf,
 * der pruefeSchema besteht. Das Modell liefert nur die Auswahl (Kandidat → Parametername) und die Kopfdaten; alles andere
 * ist Code. Ersetzt wird nur an den Fundstellen (ganzer Wert oder Token-Grenze im Text), nie per globalem Suchen/Ersetzen.
 * Werte aus Laufergebnissen dienen nur zum Erkennen von Verweisen und werden nie in den Entwurf kopiert.
 *
 * Schutzregeln: ein gewählter Wert, der nur als Teil eines Tresor-Namens vorkommt, lehnt den Entwurf ab (sonst nutzte jede
 * neue Instanz die Geheimnisse der Original-Instanz); Assets, die das Paket selbst anlegt, fallen aus betroffen; „frei“-
 * Annahmen nur für Werte, die ein gewählter Change selbst anlegt.
 */
import { GEHEIM_NAME } from '../../fernzugriff/kaefig.js';
import { ZEITLIMIT_STANDARD_S } from '../change-schritte.js';
import { NAME_WERT, pruefeWert } from './parameter.js';
import { PARAM_NAME_MUSTER, pruefeSchema, type BauplanChange, type BauplanParameter, type BauplanVorlage, type ParamTyp } from './schema.js';

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
 * win-dc01-admin) in parameter, pruefung, rueckweg — nie in Titeln. id = <change-id>:<schritt>:<pfad>:<index> (volle ID; index = Nummer
 * des Vorkommens im Text); token = umgebendes Wort. Für gewählte Werte entscheidet der Aufrufer je id „ersetzen“ oder „fest“;
 * tresor gesetzt = Teil eines Tresor-Namens, nie ersetzbar.
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
export type TeilEntscheid = Record<string, 'ersetzen' | 'fest'>;

/** Durchsuchte Teile eines Schritts (dazu der Change-Titel) */
const SUCH_TEILE = new Set(['parameter', 'pruefung', 'rueckweg', 'titel']);
const IMMER_KANDIDAT = new Set<ParamTyp>(['vmid', 'vlan', 'cidr', 'ipv4']);
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
/** Nur bei Hex-IDs (UUID, Thumbprint) ist ein Anfang ≥ 8 Zeichen eindeutig genug für einen Verweis — nie bei Namen (alfred-pbs-taeglich) oder UPIDs */
const HEX_ID = (id: string): boolean => UUID_FORM.test(id) || /^[0-9a-f]{8,}$/i.test(id);
const ANLEGE_AKTION = (aktion: unknown): boolean => typeof aktion === 'string' && (/^(create_|provision_)/.test(aktion) || aktion === 'clone_vm');

const kurz = (id: string): string => id.slice(0, 8);
const istObjekt = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const schritteVon = (c: QuellChange): Array<Record<string, unknown>> => (Array.isArray(c.plan.schritte) ? c.plan.schritte : []).filter(istObjekt);

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

interface Ort { blatt: Blatt; ganz: boolean }
interface Teil { blatt: Blatt; start: number; ende: number; id: string; token: string; tresor?: string; platzhalter?: string }

/** Umgebendes Wort eines Vorkommens (bis Leerraum oder Anführungszeichen) */
function tokenUm(text: string, start: number, ende: number): string {
  let a = start; let e = ende;
  while (a > 0 && !/[\s"'„“]/.test(text[a - 1]!)) a--;
  while (e < text.length && !/[\s"'„“]/.test(text[e]!)) e++;
  return text.slice(a, e);
}
interface KandidatIntern { kandidat: Kandidat; orte: Ort[]; teile: Teil[]; erkannt: Blatt }

/** Fundstellen und Teilvorkommen eines Werts (typ, wert) über alle Blätter */
function suche(alle: Blatt[], typ: ParamTyp, wert: string | number): { orte: Ort[]; teile: Teil[] } {
  const orte: Ort[] = []; const teile: Teil[] = [];
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
      if (titel) return; // Titel sind Beschreibung: Teilvorkommen dort werden weder gelistet noch entschieden
      const g = t.platzhalter ? GEHEIM_IN_PLATZHALTER.exec(t.platzhalter) : null;
      const tresor = tresorFeld ? b.wert as string : g ? g[1] : undefined;
      teile.push({
        blatt: b, start: t.start, ende: t.ende, id: `${b.change}:${b.schritt}:${b.pfad}:${i}`, token: tokenUm(b.wert as string, t.start, t.ende),
        ...(tresor ? { tresor } : {}), ...(t.platzhalter ? { platzhalter: t.platzhalter } : {}),
      });
    });
  }
  return { orte, teile };
}

const fundstelle = (b: Blatt, ganz: boolean): Fundstelle => ({ change: b.change, schritt: b.schritt, pfad: b.pfad, ganz });
const teilvorkommen = (t: Teil): Teilvorkommen => ({ ...fundstelle(t.blatt, false), id: t.id, token: t.token, ...(t.tresor ? { tresor: t.tresor } : {}) });

function snake(s: string): string {
  let n = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(n)) n = `p_${n}`;
  return n.slice(0, 31).replace(/_+$/, '') || 'wert';
}

function kandidatenIntern(q: QuellChange[]): KandidatIntern[] {
  const alle = q.flatMap(c => blaetter(c));
  const erkannt = new Map<string, { typ: ParamTyp; wert: string | number; blatt: Blatt }>();
  for (const b of alle) {
    const typ = typVon(b.schluessel, b.wert, b.inListe);
    if (!typ) continue;
    const k = `${typ}|${typeof b.wert}|${String(b.wert)}`;
    if (!erkannt.has(k)) erkannt.set(k, { typ, wert: b.wert as string | number, blatt: b });
  }
  const aus: KandidatIntern[] = [];
  const vergeben = new Set<string>();
  for (const { typ, wert, blatt } of erkannt.values()) {
    const { orte, teile } = suche(alle, typ, wert);
    if (orte.length < 2 && !IMMER_KANDIDAT.has(typ)) continue;
    // Vorschlag: Schlüssel der ersten typisierten Einzelwert-Fundstelle (new_vmid statt add_vmids), sonst der erkennenden
    const quelle = orte.find(o => o.ganz && !o.blatt.inListe && typVon(o.blatt.schluessel, o.blatt.wert, false) === typ)?.blatt ?? blatt;
    const basis = snake(quelle.schluessel);
    let vorschlag = basis;
    for (let n = 2; vergeben.has(vorschlag); n++) vorschlag = `${basis.slice(0, 31 - String(n).length - 1)}_${n}`;
    vergeben.add(vorschlag);
    aus.push({
      kandidat: { nr: aus.length + 1, wert, typ, vorschlag, fundstellen: orte.map(o => fundstelle(o.blatt, o.ganz)), teilvorkommen: teile.map(teilvorkommen) },
      orte, teile, erkannt: quelle,
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
 * Change in der abhaengigVon-Hülle gleicht. Mehrdeutig, außerhalb der Hülle oder ohne Quelle → kein Verweis, Hinweis.
 */
export function findeVerweise(q: QuellChange[]): { verweise: Verweis[]; hinweise: string[] } {
  const ids = erzeugteIds(q);
  const huelle = huellen(q);
  const reihe = new Map(q.map((c, i) => [c.id, i]));
  const verweise: Verweis[] = [];
  const hinweise = new Set<string>();
  const ort = (b: Blatt) => b.schritt === 0 ? `${kurz(b.change)} Titel` : `${kurz(b.change)} Schritt ${b.schritt} ${b.pfad}`;
  const quellText = (s: Quelle) => `${kurz(s.change)} Schritt ${s.schritt}.${s.feld}`;
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
          hinweise.add(`${ort(b)}: ${wert} ist mehrdeutig (${inHuelle.map(quellText).join(', ')}) — kein Verweis, Wert bleibt fest`);
        } else {
          hinweise.add(`${ort(b)}: ${wert} stammt aus ${quellen.map(quellText).join(', ')}, kein Vorgänger von ${kurz(c.id)} laut abhaengigVon — kein Verweis, Wert bleibt fest`);
        }
        continue;
      }
      if (b.schritt > 0 && ID_FORM.test(wert) && !quellen.length) {
        hinweise.add(`${ort(b)}: feste ID ${wert} stammt aus keinem gewählten Change — kein Verweis, Wert bleibt fest`);
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
            hinweise.add(`${ort(b)}: Anfang ${w.wort} ist mehrdeutig (${inHuelle.map(p => quellText(p.s)).join(', ')}) — kein Verweis, Wert bleibt fest`);
          } else {
            hinweise.add(`${ort(b)}: Anfang ${w.wort} stammt aus ${passend.map(p => quellText(p.s)).join(', ')}, kein Vorgänger von ${kurz(c.id)} laut abhaengigVon — kein Verweis, Wert bleibt fest`);
          }
        }
      }
      // ID als Teil eines Texts (Titel „Policy e5d24ae1 entfernen“) — wird nie ersetzt
      for (const [id, qs] of ids) {
        const fremd = qs.filter(s => s.change !== c.id);
        if (!fremd.length || wert === id || erledigt.has(id)) continue;
        const teil = wert.includes(id) ? id : UUID_FORM.test(id) && treffer(wert, id.slice(0, 8)).some(t => t.token) ? id.slice(0, 8) : undefined;
        if (teil) hinweise.add(`${ort(b)}: enthält ${teil === id ? 'die ID' : 'den Anfang der ID'} ${id} aus ${fremd.map(quellText).join(', ')} im Text — bleibt fest, bei Bedarf von Hand anpassen`);
      }
    }
  }
  verweise.sort((a, b) => (reihe.get(a.change)! - reihe.get(b.change)!) || a.schritt - b.schritt);
  return { verweise, hinweise: [...hinweise] };
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
  if (angelegt((f, s) => f === 'network_name' && s.skill === 'unifi' && s.aktion === 'create_network'))
    return { id: `${name}_frei`, text: `Netzname ${name} ist in UniFi frei`, pruefung: { typ: 'skill', skill: 'unifi', aktion: 'list_networks', parameter: {}, nichtEnthalten: `| ${p} |` } as never };
  return undefined;
}

/**
 * Entwurf einer Bauplan-Vorlage aus den gewählten Changes (Reihenfolge wie übergeben, Schlüssel aus QuellChange.schluessel)
 * und der Auswahl Kandidaten-Nummer → Parametername. Ohne Fehler besteht das Ergebnis pruefeSchema.
 */
export function baueEntwurf(
  q: QuellChange[], auswahl: Record<number, string>,
  kopf: { key: string; titel: string; zweck: string; dokumentart: 'testprotokoll' | 'betrieb' },
  teilEntscheid: TeilEntscheid = {},
): { vorlage?: BauplanVorlage; fehler: string[]; hinweise: string[] } {
  const fehler: string[] = [];
  const hinweise: string[] = [];
  const intern = kandidatenIntern(q);
  const nachNr = new Map(intern.map(k => [k.kandidat.nr, k]));

  // 1. Auswahl prüfen
  const gewaehlt: Array<{ k: KandidatIntern; name: string }> = [];
  const namen = new Set<string>();
  for (const [nrText, name] of Object.entries(auswahl)) {
    const k = nachNr.get(Number(nrText));
    if (!k) { fehler.push(`Auswahl: Kandidat ${nrText} gibt es nicht (1–${intern.length})`); continue; }
    if (typeof name !== 'string' || !PARAM_NAME_MUSTER.test(name)) { fehler.push(`Auswahl ${nrText}: Parametername ${JSON.stringify(name)} muss ${PARAM_NAME_MUSTER} entsprechen`); continue; }
    if (GEHEIM_NAME.test(name)) { fehler.push(`Auswahl ${nrText}: Parametername „${name}“ klingt nach einem Geheimnis — Parameter dürfen keine Geheimnisse tragen`); continue; }
    if (namen.has(name)) { fehler.push(`Auswahl ${nrText}: Parametername „${name}“ ist doppelt vergeben`); continue; }
    namen.add(name);
    gewaehlt.push({ k, name });
  }

  // 2. Vorgänger nur aus der Auswahl
  const nachId = new Map(q.map(c => [c.id, c]));
  for (const c of q) for (const a of (Array.isArray(c.plan.abhaengigVon) ? c.plan.abhaengigVon : []) as unknown[])
    if (typeof a !== 'string' || !nachId.has(a)) fehler.push(`Change ${c.id}: Vorgänger ${String(a)} liegt nicht in der Auswahl`);

  // 3. Teilvorkommen in Tresor-Namen → ablehnen
  for (const { k } of gewaehlt) for (const t of k.teile) if (t.tresor)
    fehler.push(`${String(k.kandidat.wert)} steckt im Tresor-Namen ${t.tresor} — die Vorlage würde die Geheimnisse der Original-Instanz wiederverwenden; Wert fest lassen oder Vorlage von Hand anpassen`);
  if (fehler.length) return { fehler: [...new Set(fehler)], hinweise };

  // 3b. Jedes übrige Teilvorkommen eines gewählten Werts braucht eine ausdrückliche Entscheidung (nie stilles Festlassen)
  const teilNachId = new Map<string, { k: KandidatIntern; name: string; t: Teil }>();
  for (const g of gewaehlt) for (const t of g.k.teile) teilNachId.set(t.id, { ...g, t });
  for (const [id, e] of Object.entries(teilEntscheid)) {
    if (!teilNachId.has(id)) fehler.push(`Teilvorkommen ${id}: gehört zu keinem gewählten Wert`);
    else if (e !== 'ersetzen' && e !== 'fest') fehler.push(`Teilvorkommen ${id}: Entscheidung muss „ersetzen“ oder „fest“ sein (erhalten ${JSON.stringify(e)})`);
  }
  const offen = [...teilNachId.values()].filter(x => teilEntscheid[x.t.id] === undefined);
  if (offen.length) fehler.push(`Teilvorkommen ohne Entscheidung (je id „ersetzen“ oder „fest“): ${offen.map(x => `${x.t.id} (${String(x.k.kandidat.wert)} in ${x.t.token})`).join('; ')}`);
  // gleiches Wort im selben Schritt (VM157_ABWESEND in befehl und erwartet) muss gleich entschieden sein, sonst passt die Prüfung nicht mehr
  const gruppen = new Map<string, Array<{ id: string; e: string | undefined }>>();
  for (const x of teilNachId.values()) {
    if (x.t.tresor) continue;
    const g = `${x.t.blatt.change}|${x.t.blatt.schritt}|${x.k.kandidat.typ}|${String(x.k.kandidat.wert)}|${x.t.token}`;
    const l = gruppen.get(g) ?? []; l.push({ id: x.t.id, e: teilEntscheid[x.t.id] }); gruppen.set(g, l);
  }
  for (const [g, l] of gruppen) {
    const arten = new Set(l.map(x => x.e).filter(e => e !== undefined));
    if (arten.size > 1) {
      const [change, schritt, , , token] = g.split('|') as [string, string, string, string, string];
      fehler.push(`Teilvorkommen ${l.map(x => `${x.id} (${String(x.e)})`).join(', ')}: gleiches Wort ${token} in ${kurz(change)} Schritt ${schritt} — gleich entscheiden`);
    }
  }
  if (fehler.length) return { fehler, hinweise };

  const verw = findeVerweise(q);
  hinweise.push(...verw.hinweise);

  // 4. Kopien und Orte darin; Ersetzungen je Ort sammeln
  const kopien = new Map(q.map(c => [c.id, JSON.parse(JSON.stringify(c.plan)) as Record<string, unknown>]));
  const ortKey = (change: string, schritt: number, pfad: string) => `${change}|${schritt}|${pfad}`;
  const ziele = new Map<string, Blatt>();
  for (const c of q) for (const b of blaetter(c, kopien.get(c.id))) ziele.set(ortKey(c.id, b.schritt, b.pfad), b);
  type Ersatz = { wer: string; ganz?: string; text?: Array<{ start: number; ende: number; durch: string }> };
  const ersetzungen = new Map<string, Ersatz[]>();
  const merke = (key: string, e: Ersatz) => { const l = ersetzungen.get(key) ?? []; l.push(e); ersetzungen.set(key, l); };
  for (const v of verw.verweise) {
    const s = nachId.get(v.quelle.change)!;
    const ref = `{{change:${s.schluessel}.schritt${v.quelle.schritt}.${v.quelle.feld}}}`;
    const wer = `Verweis auf ${kurz(s.id)} Schritt ${v.quelle.schritt}`;
    if (v.start !== undefined && v.ende !== undefined) merke(ortKey(v.change, v.schritt, v.pfad), { wer, text: [{ start: v.start, ende: v.ende, durch: ref }] });
    else merke(ortKey(v.change, v.schritt, v.pfad), { wer, ganz: ref });
  }
  for (const { k, name } of gewaehlt) {
    const p = `{{param.${name}}}`;
    for (const o of k.orte) {
      const key = ortKey(o.blatt.change, o.blatt.schritt, o.blatt.pfad);
      if (o.ganz || typeof o.blatt.wert !== 'string') merke(key, { wer: name, ganz: p });
      else merke(key, { wer: name, text: treffer(o.blatt.wert, String(k.kandidat.wert)).filter(t => t.token).map(t => ({ start: t.start, ende: t.ende, durch: p })) });
    }
    // Teilvorkommen nur nach ausdrücklicher Entscheidung (Tresor-Teile sind oben schon abgelehnt)
    for (const t of k.teile) {
      const wo = `${kurz(t.blatt.change)} Schritt ${t.blatt.schritt} ${t.blatt.pfad}`;
      if (teilEntscheid[t.id] === 'fest') { hinweise.push(`bewusst fest: ${t.token} in ${wo}`); continue; }
      if (t.platzhalter) { fehler.push(`Teilvorkommen ${t.id}: ${String(k.kandidat.wert)} steht im Platzhalter ${t.platzhalter} — nur „fest“ möglich`); continue; }
      merke(ortKey(t.blatt.change, t.blatt.schritt, t.blatt.pfad), { wer: name, text: [{ start: t.start, ende: t.ende, durch: p }] });
    }
  }
  if (fehler.length) return { fehler, hinweise };
  for (const [key, liste] of ersetzungen) {
    const ziel = ziele.get(key);
    const [change, schritt, pfad] = key.split('|') as [string, string, string];
    const wo = Number(schritt) === 0 ? `${kurz(change)} Titel` : `${kurz(change)} Schritt ${schritt} ${pfad}`;
    if (!ziel) { fehler.push(`${wo}: Fundstelle nicht gefunden`); continue; }
    const ganze = liste.filter(e => e.ganz !== undefined);
    if (ganze.length > 1 || (ganze.length && liste.length > 1)) { fehler.push(`${wo}: gehört zu mehreren gewählten Werten (${liste.map(e => e.wer).join(', ')}) — nur einen davon wählen`); continue; }
    if (ganze.length) { (ziel.behaelter as Record<string | number, unknown>)[ziel.index] = ganze[0]!.ganz; continue; }
    const teile = liste.flatMap(e => (e.text ?? []).map(t => ({ ...t, wer: e.wer }))).sort((a, b) => a.start - b.start);
    const ueberlappt = teile.find((t, i) => i > 0 && t.start < teile[i - 1]!.ende);
    if (ueberlappt) { fehler.push(`${wo}: Werte überlappen im Text (${[...new Set(teile.map(t => t.wer))].join(', ')}) — nur einen davon wählen`); continue; }
    const alt = String(ziel.wert);
    // „{“ davor oder „}“ danach würde mit dem eingesetzten {{…}} einen ungültigen Platzhalter bilden
    const klammer = teile.find(t => alt[t.start - 1] === '{' || alt[t.ende] === '}');
    if (klammer) { fehler.push(`${wo}: Ersetzen in „${tokenUm(alt, klammer.start, klammer.ende)}“ würde einen ungültigen Platzhalter bilden — Wert hier nicht als Parameter möglich`); continue; }
    let text = alt;
    for (const t of [...teile].reverse()) text = text.slice(0, t.start) + t.durch + text.slice(t.ende);
    (ziel.behaelter as Record<string | number, unknown>)[ziel.index] = text;
  }
  if (fehler.length) return { fehler, hinweise };

  // 5. Changes bauen: Laufzeitfelder weg, abhaengigVon auf Schlüssel, betroffen ohne selbst angelegte Assets
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
  if (fehler.length) return { fehler, hinweise };

  // 6. Parameter und automatische Annahmen
  const parameter: BauplanParameter[] = gewaehlt.map(({ k, name }) => ({
    name, typ: k.kandidat.typ, pflicht: true,
    beschreibung: `abgeleitet aus ${kurz(k.erkannt.change)} ${k.erkannt.schritt ? `schritt${k.erkannt.schritt}.` : ''}${k.erkannt.pfad}`,
    beispiel: k.kandidat.wert,
  }));
  const annahmen: BauplanVorlage['annahmen'] = [];
  for (const { k, name } of gewaehlt) {
    const a = annahmeFuer(k, name, schrittVon);
    if (a) annahmen.push(a); else hinweise.push(`keine automatische Vorab-Kontrolle für ${name} (${k.kandidat.typ})`);
  }

  const schema = pruefeSchema({ schema: 1, key: kopf.key, titel: kopf.titel, zweck: kopf.zweck, dokumentart: kopf.dokumentart, parameter, annahmen, changes });
  if (!schema.vorlage) return { fehler: schema.fehler, hinweise };
  return { vorlage: schema.vorlage, fehler: [], hinweise };
}
