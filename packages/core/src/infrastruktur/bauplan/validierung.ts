/**
 * Spec Bauplan- und Dokument-Vorlagen §5.5/§7b — Validierung beim Speichern und vor jedem Anwenden.
 *
 * Reihenfolge: Schema → Platzhalter (jeder auflösbar, Verweise nur rückwärts bzw. in die Abhängigkeits-Hülle) → keine
 * Geheimniswerte im JSON → Probe: Beispielwerte einsetzen und die Pläne durch den Change-Validator schicken (Callback, damit
 * dieser Baustein rein bleibt). Ergebnis ohne Fehler = speicherbar; unbenutzte Parameter sind nur ein Hinweis.
 */
import { GEHEIM_NAME } from '../../fernzugriff/kaefig.js';
import { ANNAHMEN_SCHLUESSEL, pruefeSchema, type BauplanParameter, type BauplanVorlage } from './schema.js';
import { loeseParameter, setzeEin, setzeEinWert } from './parameter.js';

/** Wie change-lauf.ts BEFEHLS_FELDER: Felder, die als Befehl/Skript ausgeführt werden */
export const BEFEHLS_FELDER: ReadonlySet<string> = new Set(['befehl', 'command', 'cmd', 'script', 'skript']);
/** Ersatzwert für `{{change:…}}` in der Probe (zur Probezeit gibt es keinen Vorgänger-Lauf) */
export const PROBE_WERT = 'probe';

const JEDER_PLATZHALTER = /\{\{([^{}]*)\}\}/g;
const P_PARAM = /^param\.([a-z][a-z0-9_]{0,30})$/;
const P_SCHRITT = /^schritt(\d+)\.[a-zA-Z_][\w.]*$/;
const P_CHANGE = /^change:([a-z][a-z0-9_]{0,20})\.schritt(\d+)\.[a-zA-Z_][\w.]*$/;
const P_GEHEIM = /^geheim:[a-z0-9][\w.-]{1,60}$/;
const P_GEHEIMDATEI = /^geheimdatei:[a-z0-9][\w.-]{1,60}$/;
/** Go-Templates von `docker --format` (wie PLATZHALTER in change-schritte.ts) — kein Verweis, bleibt Text */
const P_GO_TEMPLATE = /^(\.|json \.|(range|with|if|index|println|printf|print|join|len|lower|upper|title|else|end)\b)/;
const CHANGE_VERWEIS = /\{\{\s*change:[a-z][a-z0-9_]{0,20}\.schritt\d+\.[a-zA-Z_][\w.]*\s*\}\}/g;
const CHANGE_VERWEIS_GANZ = /^\{\{\s*change:[a-z][a-z0-9_]{0,20}\.schritt\d+\.[a-zA-Z_][\w.]*\s*\}\}$/;
/** Ein Geheimnis-Feld darf nur einen Tresor-Verweis tragen, nie einen Wert */
const GEHEIM_VERWEIS_GANZ = /^\{\{\s*(geheim|geheimdatei):[a-z0-9][\w.-]{1,60}\s*\}\}$/;

type Bereich =
  | { art: 'kopf'; change: string }
  | { art: 'annahme' }
  /** teil = oberstes Feld des Schritts (parameter, pruefung, rueckweg, …) */
  | { art: 'schritt'; change: string; position: number; teil?: string };
interface Kontext { wo: string; feld?: string; bereich: Bereich }

function durchlaufe(x: unknown, k: Kontext, besuche: (s: string, k: Kontext) => void): void {
  if (typeof x === 'string') { besuche(x, k); return; }
  if (Array.isArray(x)) { x.forEach((e, i) => durchlaufe(e, { ...k, wo: `${k.wo}[${i}]` }, besuche)); return; }
  if (x && typeof x === 'object') for (const [f, w] of Object.entries(x as Record<string, unknown>)) durchlaufe(w, { ...k, wo: `${k.wo}.${f}`, feld: f }, besuche);
}

/** Transitive Hülle der Abhängigkeiten je Change */
function huelle(v: BauplanVorlage): Map<string, Set<string>> {
  const direkt = new Map(v.changes.map(c => [c.schluessel, c.abhaengigVon]));
  const ergebnis = new Map<string, Set<string>>();
  for (const c of v.changes) {
    const s = new Set<string>(); const offen = [...c.abhaengigVon];
    while (offen.length) { const a = offen.pop()!; if (s.has(a)) continue; s.add(a); offen.push(...(direkt.get(a) ?? [])); }
    ergebnis.set(c.schluessel, s);
  }
  return ergebnis;
}

function pruefePlatzhalter(v: BauplanVorlage, fehler: string[]): Set<string> {
  const params = new Map<string, BauplanParameter>(v.parameter.map(p => [p.name, p]));
  const schrittZahl = new Map(v.changes.map(c => [c.schluessel, c.schritte.length]));
  const vorgaenger = huelle(v);
  const benutzt = new Set<string>();

  const besuche = (s: string, k: Kontext): void => {
    for (const m of s.matchAll(JEDER_PLATZHALTER)) {
      const inhalt = m[1].trim();
      const b = k.bereich;
      const p = P_PARAM.exec(inhalt);
      if (p) {
        const par = params.get(p[1]);
        if (!par) { fehler.push(`${k.wo}: {{param.${p[1]}}} — kein Parameter der Vorlage`); continue; }
        benutzt.add(par.name);
        if (k.feld && BEFEHLS_FELDER.has(k.feld.toLowerCase()) && (par.typ === 'text' || par.typ === 'liste'))
          fehler.push(`${k.wo}: {{param.${par.name}}} vom Typ ${par.typ} ist im Befehlsfeld „${k.feld}“ verboten (nur enge Typen wie name, ipv4, vmid)`);
        continue;
      }
      const sch = P_SCHRITT.exec(inhalt);
      if (sch) {
        const n = Number(sch[1]);
        if (b.art !== 'schritt') fehler.push(`${k.wo}: {{${inhalt}}} — Schritt-Verweise nur in Schritten (${b.art === 'annahme' ? 'Annahme' : 'Change-Kopf'})`);
        else {
          // wie change-schritte.ts: in parameter nur frühere Schritte; pruefung und rueckweg laufen nach dem eigenen Schritt
          const eigenErlaubt = b.teil === 'pruefung' || b.teil === 'rueckweg';
          const hoechst = eigenErlaubt ? b.position : b.position - 1;
          if (n < 1 || n > hoechst) fehler.push(`${k.wo}: {{${inhalt}}} — ${eigenErlaubt ? `${b.teil} von Schritt ${b.position} darf auf Schritte 1–${hoechst}` : `Schritt ${b.position} darf nur auf frühere Schritte (1–${hoechst})`} desselben Change verweisen`);
        }
        continue;
      }
      const ch = P_CHANGE.exec(inhalt);
      if (ch) {
        const ziel = ch[1]; const n = Number(ch[2]);
        if (b.art !== 'schritt') fehler.push(`${k.wo}: {{${inhalt}}} — Change-Verweise nur in Schritten (${b.art === 'annahme' ? 'Annahme' : 'Change-Kopf'})`);
        else if (!vorgaenger.get(b.change)?.has(ziel)) fehler.push(`${k.wo}: {{${inhalt}}} — „${ziel}“ ist kein (auch kein mittelbarer) Vorgänger von „${b.change}“ laut abhaengigVon`);
        else if (n < 1 || n > (schrittZahl.get(ziel) ?? 0)) fehler.push(`${k.wo}: {{${inhalt}}} — „${ziel}“ hat nur ${schrittZahl.get(ziel)} Schritte`);
        continue;
      }
      if (P_GEHEIM.test(inhalt)) {
        // zur Laufzeit nur als ganzer Wert (change-lauf.ts) — im Text würde er still leer
        if (s.trim() !== m[0]) fehler.push(`${k.wo}: {{${inhalt}}} nur als ganzer Wert erlaubt (in Befehlen {{geheimdatei:…}} verwenden)`);
        continue;
      }
      if (P_GEHEIMDATEI.test(inhalt) || P_GO_TEMPLATE.test(inhalt)) continue;
      fehler.push(`${k.wo}: Platzhalter {{${inhalt}}} ist nicht erlaubt (nur {{param.x}}, {{schrittN.feld}}, {{change:<schluessel>.schrittN.feld}}, {{geheim:<name>}})`);
    }
  };

  for (const c of v.changes) {
    const wo = `changes „${c.schluessel}“`;
    for (const f of ['titel', 'begruendung', 'betroffen'] as const) durchlaufe(c[f], { wo: `${wo}.${f}`, feld: f, bereich: { art: 'kopf', change: c.schluessel } }, besuche);
    c.schritte.forEach((s, i) => {
      for (const [teil, w] of Object.entries(s))
        durchlaufe(w, { wo: `${wo} Schritt ${i + 1}.${teil}`, feld: teil, bereich: { art: 'schritt', change: c.schluessel, position: i + 1, teil } }, besuche);
    });
  }
  for (const a of v.annahmen) durchlaufe(a.pruefung, { wo: `Annahme „${a.id}“`, bereich: { art: 'annahme' } }, besuche);

  for (const name of [...benutzt]) { const q = params.get(name)?.ableitung?.von; if (q) benutzt.add(q); }
  return benutzt;
}

/** Jeder Schlüssel nach GEHEIM_NAME trägt nur einen Tresor-Verweis; Wahrheitswerte/null sind kein Geheimnis */
function pruefeGeheimnisse(v: BauplanVorlage, fehler: string[]): void {
  const meldung = (wo: string, schluessel: string) => fehler.push(`${wo}: „${schluessel}“ enthält einen Geheimniswert — erlaubt ist nur {{geheim:<tresorname>}}`);
  const wert = (w: unknown, wo: string, schluessel: string): void => {
    if (typeof w === 'string') { if (!GEHEIM_VERWEIS_GANZ.test(w)) meldung(wo, schluessel); }
    else if (typeof w === 'number' || typeof w === 'bigint') meldung(wo, schluessel);
    else if (Array.isArray(w)) w.forEach((e, i) => wert(e, `${wo}[${i}]`, schluessel));
    else if (w && typeof w === 'object') objekt(w, wo);
  };
  const objekt = (x: unknown, wo: string): void => {
    if (Array.isArray(x)) { x.forEach((e, i) => objekt(e, `${wo}[${i}]`)); return; }
    if (!x || typeof x !== 'object') return;
    for (const [k, w] of Object.entries(x as Record<string, unknown>)) {
      if (GEHEIM_NAME.test(k)) wert(w, `${wo}.${k}`, k);
      else objekt(w, `${wo}.${k}`);
    }
  };
  v.changes.forEach(c => objekt(c, `changes „${c.schluessel}“`));
  v.annahmen.forEach(a => objekt(a, `Annahme „${a.id}“`));
  for (const p of v.parameter) {
    if (p.beispiel === undefined) continue;
    if (GEHEIM_NAME.test(p.name)) wert(p.beispiel, `parameter ${p.name}.beispiel`, p.name);
    else objekt(p.beispiel, `parameter ${p.name}.beispiel`);
  }
}

function ersetzeChangeVerweise(x: unknown): unknown {
  if (typeof x === 'string') return CHANGE_VERWEIS_GANZ.test(x) ? PROBE_WERT : x.replace(CHANGE_VERWEIS, PROBE_WERT);
  if (Array.isArray(x)) return x.map(ersetzeChangeVerweise);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, w]) => [k, ersetzeChangeVerweise(w)]));
  return x;
}

/**
 * Probe-Pläne: Beispielwerte eingesetzt, Change-Verweise durch „probe“, ohne kapitel, im ChangePlan-Format. Gibt es Annahmen,
 * kommt ein zusätzlicher Change „annahmen“ mit je einem Prüfschritt dazu — so gelten für sie dieselben Prüf-/Käfig-Regeln.
 */
export function probePlaene(v: BauplanVorlage, werte: Record<string, unknown>): unknown[] {
  const plaene: unknown[] = setzeEin(v, werte).map(c => ({
    schluessel: c.schluessel, titel: c.titel, begruendung: c.begruendung, typ: c.typ, risiko: c.risiko,
    ...(c.ausfallMinuten !== undefined ? { ausfallMinuten: c.ausfallMinuten } : {}),
    abhaengigVon: [...c.abhaengigVon], betroffen: [...(c.betroffen ?? [])],
    schritte: c.schritte.map(s => { const { kapitel: _k, ...rest } = s; return ersetzeChangeVerweise(rest); }),
  }));
  if (v.annahmen.length) plaene.push({
    schluessel: ANNAHMEN_SCHLUESSEL, titel: 'Eingangskontrolle der Vorlage', begruendung: 'Vorab-Prüfungen der Bauplan-Vorlage',
    // Plan-Kopf wie ein echter Change (pruefeChangePlan verlangt ausfallMinuten und betroffen): betroffen = Vereinigung der
    // betroffenen Assets aller Changes; ist sie leer, scheitern die echten Changes am selben Punkt (gleiche Meldung)
    typ: 'normal', risiko: 'low', ausfallMinuten: 0, abhaengigVon: [], betroffen: [...new Set(v.changes.flatMap(c => c.betroffen ?? []))],
    schritte: v.annahmen.map((a, i) => ({ nr: i + 1, titel: `Eingangskontrolle: ${a.text}`, art: 'pruefung', pruefung: setzeEinWert(a.pruefung, werte), beiFehler: 'anhalten' })),
  });
  return plaene;
}

/**
 * Volle Validierung einer Vorlage. `vorlage` nur, wenn es keine Fehler gibt. `ctx.probe` bekommt die eingesetzten Pläne und
 * liefert die Fehler des Change-Validators (Task 3: ChangePlanung.pruefeNur); sie kommen mit „Probe: “ zurück.
 */
export async function pruefeVorlage(roh: unknown, ctx: { probe: (roh: unknown[]) => Promise<string[]> }): Promise<{ vorlage?: BauplanVorlage; fehler: string[]; hinweise: string[] }> {
  const schema = pruefeSchema(roh);
  if (!schema.vorlage) return { fehler: schema.fehler, hinweise: [] };
  const v = schema.vorlage;
  const fehler: string[] = [];
  const hinweise: string[] = [];

  const benutzt = pruefePlatzhalter(v, fehler);
  for (const p of v.parameter) if (!benutzt.has(p.name)) hinweise.push(`Parameter ${p.name} wird nirgends verwendet`);
  pruefeGeheimnisse(v, fehler);

  const eingabe: Record<string, unknown> = {};
  for (const p of v.parameter) {
    if (p.ableitung) continue;
    if (p.beispiel === undefined) { if (p.pflicht) fehler.push(`Parameter ${p.name}: Pflichtparameter braucht ein beispiel (für die Probe)`); continue; }
    eingabe[p.name] = p.beispiel;
  }
  if (fehler.length) return { fehler, hinweise };
  const beispiel = loeseParameter(v, eingabe);
  if (beispiel.fehler.length) return { fehler: beispiel.fehler.map(f => `Beispiel: ${f}`), hinweise };

  let plaene: unknown[];
  try { plaene = probePlaene(v, beispiel.werte); } catch (e) { return { fehler: [`Beispiel: ${(e as Error).message}`], hinweise }; }
  const probeFehler = await ctx.probe(plaene);
  if (probeFehler.length) return { fehler: probeFehler.map(f => `Probe: ${f}`), hinweise };
  return { vorlage: v, fehler: [], hinweise };
}
