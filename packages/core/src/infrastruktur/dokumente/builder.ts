// Builder: Abnahme- und Testprotokoll deterministisch aus Change-Läufen (ohne I/O, ohne Modell).
// Jeder Text aus Change, Lauf oder Incident läuft durch schwaerze(), bevor er in einen Block kommt.
import type { CmdbChangeRequest } from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import type { ChangeLauf, SchrittErgebnis, VerlaufEintrag } from '../change-lauf.js';
import type { ChangeSchritt } from '../change-schritte.js';
import { DOKU_ARTEN, pruefeDokument } from './arten.js';
import { beweisAnhang, pruefAnleitung, zeitText } from './beweis.js';
import { ABGESCHNITTEN_GRUND } from './sammler.js';
import type { Anhang, Block, DokuArtKey, Dokument, Kapitel } from './modell.js';

type VerlaufInfo = { eintraege: VerlaufEintrag[]; quelle: string; abgeschnitten?: boolean };
type VerlaufMap = Map<string, VerlaufInfo>;

const ANGELEGT = new Set(['create_network', 'create_zone', 'create_firewall_policy', 'provision_windows_vm', 'allow_network_on_port']);
const VERLAUF_ART: Record<VerlaufEintrag['art'], string> = { halt: 'Halt', wiederholen: 'Wiederholt', ueberspringen: 'Übersprungen', plan_geaendert: 'Plan geändert', ausgelassen: 'Ausgelassen' };

/** geschwärzt und danach gekürzt (ein Geheimnis an der Schnittstelle bleibt so nicht halb stehen) */
const g = (s: unknown, max?: number): string => {
  if (s === undefined || s === null || s === '') return '—';
  const t = schwaerze(String(s)).text;
  return max !== undefined && t.length > max ? t.slice(0, max) + '…' : t;
};
const id8 = (c: CmdbChangeRequest) => c.id.slice(0, 8);
const ordnerName = (s: string) => s.replace(/[^\w.-]/g, '_');
const laufVon = (c: CmdbChangeRequest) => c.lauf as ChangeLauf | undefined;
const planVon = (c: CmdbChangeRequest) => (c.schritte ?? []) as ChangeSchritt[];
const aktionText = (s?: ChangeSchritt) => (s?.skill ? (s.aktion ? `${s.skill}.${s.aktion}` : s.skill) : (s?.aktion ?? s?.art ?? '—'));
const ergebnisText = (e?: SchrittErgebnis) => (!e ? 'nicht gelaufen' : e.uebersprungen ? 'übersprungen' : e.ok ? 'ok' : 'Fehler');
const daten = (e?: SchrittErgebnis) => (e?.daten && typeof e.daten === 'object' ? (e.daten as Record<string, unknown>) : undefined);
const ueberschrift = (c: CmdbChangeRequest): Block => ({ art: 'absatz', text: `Change ${id8(c)} — ${g(c.title)}` });

function kapitel(art: DokuArtKey, id: string, bloecke: Block[]): Kapitel {
  const i = DOKU_ARTEN[art].kapitel.findIndex(k => k.id === id);
  if (i < 0) throw new Error(`Kapitel ${id} gibt es in ${art} nicht`);
  return { nr: i + 1, id, titel: DOKU_ARTEN[art].kapitel[i]!.titel, bloecke };
}

function frei(feld: string, text?: string): Block {
  return text === undefined ? { art: 'frei', feld } : { art: 'frei', feld, text: schwaerze(text).text };
}

/** Plan-Schritte mit dem Ergebnis aus dem Lauf; Schritte ohne Plan-Eintrag (sollte nicht vorkommen) zählen trotzdem. */
function schrittTabelle(c: CmdbChangeRequest): Block[] {
  const plan = planVon(c);
  const erg = new Map((laufVon(c)?.ergebnisse ?? []).map(e => [e.nr, e]));
  const nummern = [...new Set([...plan.map(s => s.nr), ...erg.keys()])].sort((a, b) => a - b);
  if (!nummern.length) return [{ art: 'nichtBelegt', grund: 'Change ohne Schritte' }];
  const nachNr = new Map(plan.map(s => [s.nr, s]));
  const bloecke: Block[] = [{
    art: 'tabelle', kopf: ['Nr', 'Titel', 'Aktion', 'Ergebnis'],
    zeilen: nummern.map(nr => [String(nr), g(nachNr.get(nr)?.titel), g(aktionText(nachNr.get(nr))), ergebnisText(erg.get(nr))]),
  }];
  const rw = laufVon(c)?.rueckweg ?? [];
  if (rw.length) {
    bloecke.push({ art: 'absatz', text: 'Rückweg:' });
    bloecke.push({ art: 'tabelle', kopf: ['Zu Schritt', 'Ergebnis', 'Zeit', 'Text'], zeilen: rw.map(r => [String(r.zuSchritt), r.ok ? 'ok' : 'Fehler', zeitText(r.zeit), g(r.text, 300)]) });
  }
  return bloecke;
}

/**
 * Hinweise zum Verlauf eines Changes: Herkunft (Halte-Incidents) und eine gespeicherte, noch nicht entschiedene Plan-Korrektur
 * (lauf.korrektur — die Ablage überschreibt sie bei jeder neuen Korrektur, frühere sind nicht erhalten).
 */
function verlaufHinweise(c: CmdbChangeRequest, v?: VerlaufInfo): Block[] {
  const bloecke: Block[] = [];
  // Abfragegrenze der Incidents erreicht: es kann weitere Halte geben — offen belegen, nie glätten
  if (v?.abgeschnitten) bloecke.push({ art: 'nichtBelegt', grund: `Change ${id8(c)}: ${ABGESCHNITTEN_GRUND}` });
  if (v?.quelle === 'incidents') bloecke.push({ art: 'absatz', text: `Change ${id8(c)} — Quelle: rekonstruiert aus Halte-Incidents (dort stehen nur Halte, keine Wiederholungen oder Planänderungen).` });
  if (v?.quelle === 'lauf+incidents') bloecke.push({ art: 'absatz', text: `Change ${id8(c)} — Halte rekonstruiert aus Halte-Incidents (vor Einführung des Verlaufs im Lauf), übrige Einträge aus dem Lauf.` });
  const k = laufVon(c)?.korrektur;
  if (k && !(v?.eintraege ?? []).some(e => e.art === 'plan_geaendert' && e.zeit === k.zeit)) {
    bloecke.push({ art: 'absatz', text: `Change ${id8(c)} — Plan ab Schritt ${k.abSchritt} am ${zeitText(k.zeit)} korrigiert, noch nicht entschieden (nur die letzte Korrektur ist erfasst).` });
  }
  return bloecke;
}

function verlaufBloecke(c: CmdbChangeRequest, verlauf: VerlaufMap): Block[] {
  const v = verlauf.get(c.id);
  const bloecke = verlaufHinweise(c, v);
  if (!v || !v.eintraege.length) return bloecke.length ? bloecke : [{ art: 'nichtBelegt', grund: 'kein Verlauf erfasst' }];
  bloecke.push({
    art: 'tabelle', kopf: ['Zeit', 'Art', 'Schritt', 'Text'],
    zeilen: v.eintraege.map(e => [zeitText(e.zeit), VERLAUF_ART[e.art] ?? g(e.art), e.schritt > 0 ? String(e.schritt) : '—', g(e.text, 300)]),
  });
  return bloecke;
}

/** Beweise je Change; mehrere Changes bekommen eine Zwischenüberschrift. Rohläufe und Prüfanleitung als Anhänge. */
function beweise(changes: CmdbChangeRequest[]): { bloecke: Block[]; anhaenge: Anhang[] } {
  const bloecke: Block[] = []; const anhaenge: Anhang[] = []; const summen: Array<{ name: string; pruefsumme: string }> = [];
  for (const c of changes) {
    const b = beweisAnhang(c);
    if (changes.length > 1) bloecke.push(ueberschrift(c));
    bloecke.push(...b.bloecke);
    if (b.rohlauf && b.pruefsumme) { anhaenge.push(b.rohlauf); summen.push({ name: b.rohlauf.name, pruefsumme: b.pruefsumme }); }
  }
  if (summen.length) anhaenge.push(pruefAnleitung(summen));
  return { bloecke, anhaenge };
}

function abschluss(d: Dokument): Dokument {
  const m = pruefeDokument(d);
  if (m.length) throw new Error(`Dokument ungültig: ${m.join('; ')}`);
  return d;
}

function quellenVon(changes: CmdbChangeRequest[], verlauf: VerlaufMap, jetzt: string): Dokument['kopf']['quellen'] {
  const q: Dokument['kopf']['quellen'] = changes.map(c => ({ quelle: `Change ${id8(c)}`, stand: c.updatedAt }));
  for (const c of changes) if (verlauf.get(c.id)?.quelle === 'incidents') q.push({ quelle: `Halte-Incidents ${id8(c)}`, stand: jetzt });
  return q;
}

export function baueAbnahme(changes: CmdbChangeRequest[], verlauf: VerlaufMap, freiText: { zweck?: string; abweichungen?: string }, jetzt: string): Dokument {
  if (!changes.length) throw new Error('Abnahmeprotokoll ohne Change');
  const erster = changes[0]!;
  const serie = changes.length > 1;

  const kopfZeilen = changes.map(c => {
    const l = laufVon(c);
    const freigabe = c.freigegebenAt ? `${zeitText(c.freigegebenAt)} über ${g(c.freigegebenUeber)}` : '—';
    return [id8(c), g(c.title), c.type, c.status, c.fingerabdruck ? c.fingerabdruck.slice(0, 12) : '—', freigabe, zeitText(l?.start ?? c.startedAt), zeitText(l?.ende ?? c.completedAt)];
  });
  const kopfBloecke: Block[] = [{ art: 'tabelle', kopf: ['Change', 'Titel', 'Typ', 'Status', 'Plan-Abdruck', 'Freigabe', 'Start', 'Ende'], zeilen: kopfZeilen }];
  // die Freigabe deckt genau einen Plan: weicht der freigegebene Abdruck ab, steht das offen im Kopf
  for (const c of changes) {
    if (c.freigabeFingerabdruck && c.fingerabdruck && c.freigabeFingerabdruck !== c.fingerabdruck) {
      kopfBloecke.push({ art: 'absatz', text: `Change ${id8(c)}: freigegebener Plan-Abdruck ${c.freigabeFingerabdruck.slice(0, 12)} weicht vom gespeicherten ${c.fingerabdruck.slice(0, 12)} ab.` });
    }
  }

  const proChange = (f: (c: CmdbChangeRequest) => Block[]) => changes.flatMap(c => (serie ? [ueberschrift(c), ...f(c)] : f(c)));
  const b = beweise(changes);
  const d: Dokument = {
    kopf: {
      art: 'abnahme', artVersion: DOKU_ARTEN.abnahme.version,
      titel: serie ? `Sammelprotokoll: ${g(erster.title, 120)} und ${changes.length - 1} weitere` : `${DOKU_ARTEN.abnahme.titel}: ${g(erster.title, 120)} (${id8(erster)})`,
      ordner: ordnerName(serie ? `serie-${id8(erster)}` : `change-${id8(erster)}`),
      erzeugt: jetzt,
      quellen: quellenVon(changes, verlauf, jetzt),
      verweise: changes.map(c => `change:${c.id}`),
    },
    kapitel: [
      kapitel('abnahme', 'kopf', kopfBloecke),
      kapitel('abnahme', 'zweck', [frei('zweck', freiText.zweck)]),
      kapitel('abnahme', 'schritte', proChange(schrittTabelle)),
      kapitel('abnahme', 'verlauf', proChange(c => verlaufBloecke(c, verlauf))),
      kapitel('abnahme', 'abweichungen', [frei('abweichungen', freiText.abweichungen)]),
      kapitel('abnahme', 'beweise', b.bloecke),
    ],
    anhaenge: b.anhaenge,
  };
  return abschluss(d);
}

export function baueTestprotokoll(name: string, changes: CmdbChangeRequest[], verlauf: VerlaufMap, freiText: { zweck?: string; befunde_produktion?: string }, jetzt: string): Dokument {
  if (!changes.length) throw new Error('Testprotokoll ohne Change');

  // alle Lauf-Schritte mit ihrem Plan-Eintrag, in Change- und Schrittreihenfolge
  const schritte = changes.flatMap(c => {
    const plan = new Map(planVon(c).map(s => [s.nr, s]));
    return [...(laufVon(c)?.ergebnisse ?? [])].sort((a, b) => a.nr - b.nr).map(e => ({ c, e, s: plan.get(e.nr) }));
  });

  const faelle = schritte.filter(x => typeof daten(x.e)?.ergebnis === 'string');
  const faelleBloecke: Block[] = faelle.length
    ? [{
        art: 'tabelle', kopf: ['Change', 'Schritt', 'Titel', 'Ergebnis', 'Grund'],
        zeilen: faelle.map(({ c, e, s }) => {
          const grund = daten(e)?.grund;
          return [id8(c), String(e.nr), g(s?.titel), g(daten(e)!.ergebnis), typeof grund === 'string' && grund ? g(grund, 300) : g(e.ausgabe, 200)];
        }),
      }]
    : [{ art: 'nichtBelegt', grund: 'keine Schritte mit Testergebnis (daten.ergebnis) im Lauf' }];
  const halte = changes.flatMap(c => (verlauf.get(c.id)?.eintraege ?? []).map(v => ({ c, v })));
  const hinweise = changes.flatMap(c => verlaufHinweise(c, verlauf.get(c.id)));
  if (halte.length || hinweise.length) faelleBloecke.push({ art: 'absatz', text: 'Halte, Wiederholungen und Planänderungen während der Tests:' }, ...hinweise);
  if (halte.length) {
    faelleBloecke.push({ art: 'tabelle', kopf: ['Change', 'Zeit', 'Art', 'Schritt', 'Text'], zeilen: halte.map(({ c, v }) => [id8(c), zeitText(v.zeit), VERLAUF_ART[v.art] ?? g(v.art), v.schritt > 0 ? String(v.schritt) : '—', g(v.text, 300)]) });
  }

  const verbindung = schritte.filter(x => x.s?.aktion === 'verbindung_pruefen');
  const angelegt = schritte.filter(x => !!x.s?.aktion && ANGELEGT.has(x.s.aktion));
  const umgebung: Block[] = [];
  umgebung.push(verbindung.length
    ? { art: 'tabelle', kopf: ['Change', 'Schritt', 'Titel', 'Ergebnis'], zeilen: verbindung.map(({ c, e, s }) => [id8(c), String(e.nr), g(s?.titel), ergebnisText(e)]) }
    : { art: 'nichtBelegt', grund: 'keine Verbindungsprüfung (verbindung_pruefen) im Lauf' });
  umgebung.push(angelegt.length
    ? { art: 'liste', punkte: angelegt.map(({ c, e, s }) => `${id8(c)} Schritt ${e.nr} „${g(s?.titel)}“ (${ergebnisText(e)}): ${g(e.ausgabe, 160)}`) }
    : { art: 'nichtBelegt', grund: 'keine angelegten Objekte (Netz, Zone, Firewall-Regel, VM) im Lauf' });

  const letzter = changes[changes.length - 1]!;
  const abbau: Block[] = laufVon(letzter)?.ergebnisse?.length
    ? [{ art: 'absatz', text: `Abbau: Change ${id8(letzter)} „${g(letzter.title)}“, Status ${letzter.status}, Ende ${zeitText(laufVon(letzter)?.ende ?? letzter.completedAt)}` }, ...schrittTabelle(letzter)]
    : [{ art: 'nichtBelegt', grund: `Abbau-Change ${id8(letzter)} ohne Lauf` }];

  const b = beweise(changes);
  const d: Dokument = {
    kopf: {
      art: 'testprotokoll', artVersion: DOKU_ARTEN.testprotokoll.version,
      titel: `${DOKU_ARTEN.testprotokoll.titel}: ${g(name, 120)}`,
      ordner: ordnerName(name),
      erzeugt: jetzt,
      quellen: quellenVon(changes, verlauf, jetzt),
      verweise: changes.map(c => `change:${c.id}`),
    },
    kapitel: [
      kapitel('testprotokoll', 'zweck', [frei('zweck', freiText.zweck)]),
      kapitel('testprotokoll', 'umgebung', umgebung),
      kapitel('testprotokoll', 'faelle', faelleBloecke),
      kapitel('testprotokoll', 'befunde', [frei('befunde_produktion', freiText.befunde_produktion)]),
      kapitel('testprotokoll', 'abbau', abbau),
      kapitel('testprotokoll', 'beweise', b.bloecke),
    ],
    anhaenge: b.anhaenge,
  };
  return abschluss(d);
}
