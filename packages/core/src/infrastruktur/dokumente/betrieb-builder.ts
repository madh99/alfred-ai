// Builder D-BETRIEB: Betriebsdokument (As-built) deterministisch aus den gesammelten Quellen (ohne I/O, ohne Modell).
// Kapitel 4, 5, 8, 9, 10 und die Komponenten-Bildung stehen in betrieb-kapitel.ts.
import type { CmdbChangeRequest } from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import type { ChangeLauf, VerlaufEintrag } from '../change-lauf.js';
import type { ChangeSchritt } from '../change-schritte.js';
import { DOKU_ARTEN, pruefeDokument } from './arten.js';
import { zeitText } from './beweis.js';
import type { BetriebParameter } from './betrieb-parameter.js';
import type { Gesammelt, Quelle } from './betrieb-quellen.js';
import {
  g, id8, kapitelBetrieb, kapitelIdentitaeten, kapitelNetz, kapitelSicherung, kapitelUeberwachung, komponenten, komponentenHinweise, komponentenZeile,
  nichtLesbar, problemTabelle, type Komponente,
} from './betrieb-kapitel.js';
import type { Block, Dokument, Kapitel } from './modell.js';

export type { Gesammelt } from './betrieb-quellen.js';

const MAX_KANTEN = 150;
const ordnerName = (s: string) => s.replace(/[^\w.-]/g, '_');
const laufVon = (c: CmdbChangeRequest) => c.lauf as ChangeLauf | undefined;
const gestartet = (c: CmdbChangeRequest) => !!laufVon(c)?.start;

function kapitel(id: string, bloecke: Block[]): Kapitel {
  const i = DOKU_ARTEN.betrieb.kapitel.findIndex(k => k.id === id);
  if (i < 0) throw new Error(`Kapitel ${id} gibt es in betrieb nicht`);
  return { nr: i + 1, id, titel: DOKU_ARTEN.betrieb.kapitel[i]!.titel, bloecke };
}
const frei = (feld: string, text?: string): Block => (text === undefined ? { art: 'frei', feld } : { art: 'frei', feld, text: schwaerze(text).text });

function kapitelZweck(ks: Komponente[], p: BetriebParameter, zweck?: string): Block[] {
  const bloecke: Block[] = [frei('zweck', zweck)];
  bloecke.push({ art: 'absatz', text: `Geltungsbereich: ${ks.length ? ks.map(k => g(k.name)).join(', ') : 'keine Komponente auflösbar'}.` });
  bloecke.push(p.vorhabenId ? { art: 'absatz', text: `Vorhaben: ${g(p.vorhabenId)}` } : { art: 'nichtBelegt', grund: 'Vorhaben: keines angegeben' });
  const regeln: string[] = [];
  const dcs = ks.filter(k => k.dc);
  if (dcs.length) regeln.push(`Domänencontroller (${dcs.map(k => g(k.name)).join(', ')}) bewusst ohne PBS-Sicherung und ohne Snapshots (Kapitel 8).`);
  regeln.push('Proxmox-Cluster-Firewall bleibt auf „Any“ (Kapitel 4).');
  bloecke.push({ art: 'absatz', text: 'Owner-Entscheidungen, die dieses Dokument abbildet:' }, { art: 'liste', punkte: regeln });
  return bloecke;
}

/** Mermaid-Bezeichnung: geschwärzt, ohne Zeilenumbruch, Anführungszeichen als Entität */
const label = (s: string) => g(s, 60).replace(/[\r\n]+/g, ' ').replace(/"/g, '#quot;');

function kapitelArchitektur(gs: Gesammelt, ks: Komponente[], p: BetriebParameter): Block[] {
  const bloecke: Block[] = [];
  const eigen = new Map<string, string>(); // Asset-ID → Knotenname
  for (const k of ks) for (const a of k.assets) eigen.set(a.id, k.name);
  const b = gs.beziehungen;
  const knoten = new Map<string, string>(); // Name (klein) → Knoten-ID
  const zeilen: string[] = [];
  const knotenVon = (name: string) => {
    const s = name.toLowerCase();
    let id = knoten.get(s);
    if (!id) { id = `n${knoten.size}`; knoten.set(s, id); zeilen.push(`  ${id}["${label(name)}"]`); }
    return id;
  };
  for (const k of ks) knotenVon(k.name);
  if (b.fehler || !b.daten) bloecke.push(nichtLesbar('CMDB-Beziehungen', b));
  else {
    const nameVon = (id: string) => eigen.get(id) ?? b.daten!.fremde[id]?.name ?? `?unbekannt:${id8(id)}`;
    const kanten = new Set<string>();
    for (const r of b.daten.relationen) {
      const s = nameVon(r.sourceAssetId), t = nameVon(r.targetAssetId);
      if (s.toLowerCase() === t.toLowerCase()) continue;
      kanten.add(`${knotenVon(s)} -->|${r.relationType}| ${knotenVon(t)}`);
      if (kanten.size >= MAX_KANTEN) break;
    }
    zeilen.push(...[...kanten].map(k => `  ${k}`));
    if (!b.daten.relationen.length) bloecke.push({ art: 'absatz', text: 'Keine CMDB-Beziehungen zu diesen Assets erfasst — das Diagramm zeigt nur die Komponenten.' });
    if (kanten.size >= MAX_KANTEN) bloecke.push({ art: 'absatz', text: `Diagramm auf ${MAX_KANTEN} Beziehungen begrenzt (${b.daten.relationen.length} erfasst).` });
  }
  bloecke.unshift({ art: 'mermaid', text: ['graph LR', ...zeilen].join('\n') });
  const a = gs.architektur;
  if (!p.architekturDocId) bloecke.push({ art: 'nichtBelegt', grund: 'Architektur-Dokument: keines angegeben' });
  else if (!a || a.fehler || !a.daten) bloecke.push(nichtLesbar(`Architektur-Dokument ${id8(p.architekturDocId)}`, a ?? { stand: '', fehler: 'nicht gesammelt' }));
  else bloecke.push({ art: 'absatz', text: `Architektur-Dokument: „${g(a.daten.titel, 200)}“ (${id8(a.daten.id)}, Version ${a.daten.version})` });
  return bloecke;
}

function kapitelKomponenten(gs: Gesammelt, ks: Komponente[]): Block[] {
  if (gs.assets.fehler || !gs.assets.daten) return [nichtLesbar('CMDB-Assets', gs.assets)];
  const bloecke: Block[] = [];
  if (gs.assets.daten.fehlend.length) bloecke.push({ art: 'nichtBelegt', grund: `Assets der Instanz nicht mehr in der CMDB oder außer Betrieb: ${gs.assets.daten.fehlend.map(x => g(x)).join(', ')}` });
  if (!ks.length) return bloecke.length ? bloecke : [{ art: 'nichtBelegt', grund: 'keine Komponente auflösbar' }];
  if (gs.proxmox.fehler) bloecke.push(nichtLesbar('Proxmox', gs.proxmox, ' — VMID und Node aus der CMDB-Erfassung, Speicher und vCPU/RAM aus CMDB-Attributen'));
  bloecke.push({ art: 'tabelle', kopf: ['Name', 'Bausteine', 'VMID', 'Node', 'Speicher', 'vCPU/RAM', 'OS/Build', 'IP', 'Rollen', 'Lizenz', 'Status'], zeilen: ks.map(komponentenZeile) });
  const h = komponentenHinweise(ks, !gs.proxmox.fehler);
  if (h.length) bloecke.push({ art: 'absatz', text: 'Hinweise:' }, { art: 'liste', punkte: h });
  return bloecke;
}

function kapitelAbhaengigkeiten(gs: Gesammelt, ks: Komponente[]): Block[] {
  const b = gs.beziehungen;
  if (b.fehler || !b.daten) return [nichtLesbar('CMDB-Beziehungen', b)];
  const eigen = new Map<string, string>();
  for (const k of ks) for (const a of k.assets) eigen.set(a.id, k.name);
  const zeilen: string[][] = []; const intern: string[] = [];
  for (const r of b.daten.relationen) {
    const s = eigen.get(r.sourceAssetId), t = eigen.get(r.targetAssetId);
    const fremd = (id: string) => b.daten!.fremde[id] ?? { name: `?unbekannt:${id8(id)}`, assetType: '?', status: '?' };
    if (s && t) { if (s.toLowerCase() !== t.toLowerCase()) intern.push(`${g(s)} ${r.relationType} ${g(t)}`); continue; }
    if (s) { const f = fremd(r.targetAssetId); zeilen.push(['hängt ab von', g(s), r.relationType, g(f.name), g(f.assetType), g(f.status)]); }
    else if (t) { const f = fremd(r.sourceAssetId); zeilen.push(['davon hängt ab', g(t), r.relationType, g(f.name), g(f.assetType), g(f.status)]); }
  }
  const bloecke: Block[] = [zeilen.length
    ? { art: 'tabelle', kopf: ['Richtung', 'Komponente', 'Beziehung', 'Gegenüber', 'Typ', 'Status'], zeilen }
    : { art: 'absatz', text: 'Keine Beziehungen zu Assets außerhalb des Systems erfasst.' }];
  if (intern.length) bloecke.push({ art: 'absatz', text: 'Innerhalb des Systems:' }, { art: 'liste', punkte: [...new Set(intern)] });
  return bloecke;
}

const aktionText = (s: ChangeSchritt) => (s.skill ? (s.aktion ? `${s.skill}.${s.aktion}` : s.skill) : (s.aktion ?? s.art ?? '—'));
const pruefText = (s: ChangeSchritt) => (s.pruefung ? `${s.pruefung.typ}${s.pruefung.erwartet ? `: erwartet „${s.pruefung.erwartet}“` : ''}` : '—');

function kapitelWiederaufbau(gs: Gesammelt): Block[] {
  const bloecke: Block[] = [{ art: 'nichtBelegt', grund: 'Bauplan-Vorlage folgt mit V3 — bis dahin aus den durchgeführten Changes (Reihenfolge, Schritte, Prüfung)' }];
  if (gs.changes.fehler || !gs.changes.daten) return [...bloecke, nichtLesbar('Changes', gs.changes)];
  const fertig = gs.changes.daten.filter(c => c.status === 'completed');
  if (!fertig.length) return [...bloecke, { art: 'nichtBelegt', grund: 'keine abgeschlossenen Changes zu diesen Assets' }];
  fertig.forEach((c, i) => {
    bloecke.push({ art: 'absatz', text: `${i + 1}. Change ${id8(c.id)} — ${g(c.title, 200)} (abgeschlossen ${zeitText(laufVon(c)?.ende ?? c.completedAt)})` });
    const plan = (c.schritte ?? []) as ChangeSchritt[];
    bloecke.push(plan.length
      ? { art: 'tabelle', kopf: ['Nr', 'Was', 'Womit', 'Prüfung'], zeilen: plan.map(s => [String(s.nr), g(s.titel, 120), g(aktionText(s), 80), g(pruefText(s), 120)]) }
      : { art: 'nichtBelegt', grund: `Change ${id8(c.id)} ohne Schritte` });
  });
  bloecke.push({ art: 'absatz', text: 'Parameterwerte dieser Instanz (Namen, VMIDs, IPs, Netze): Kapitel 3 und 4.' });
  return bloecke;
}

function kapitelHistorie(gs: Gesammelt): Block[] {
  if (gs.changes.fehler || !gs.changes.daten) return [nichtLesbar('Changes', gs.changes)];
  const l = gs.changes.daten;
  return [
    l.length
      ? { art: 'tabelle', kopf: ['Change', 'Titel', 'Typ', 'Status', 'Datum'], zeilen: l.map(c => [id8(c.id), g(c.title, 160), c.type, c.status, zeitText(c.completedAt ?? c.startedAt ?? c.createdAt)]) }
      : { art: 'absatz', text: 'Keine Changes zu diesen Assets.' },
    ...(gs.changes.hinweis ? [{ art: 'absatz', text: `Hinweis: ${g(gs.changes.hinweis)}` } as Block] : []),
  ];
}

function kapitelBeweise(gs: Gesammelt): Block[] {
  if (gs.changes.fehler || !gs.changes.daten) return [nichtLesbar('Changes', gs.changes)];
  const l = gs.changes.daten.filter(gestartet);
  if (!l.length) return [{ art: 'nichtBelegt', grund: 'keine gelaufenen Changes zu diesen Assets' }];
  if (gs.abnahmen.fehler || !gs.abnahmen.daten) return [nichtLesbar('Abnahmeprotokolle', gs.abnahmen)];
  const a = gs.abnahmen.daten;
  const mit = l.filter(c => a[c.id]); const ohne = l.filter(c => !a[c.id]);
  const bloecke: Block[] = [{ art: 'absatz', text: 'Je Change das jüngste Abnahmeprotokoll; Rohläufe und Prüfanleitung (PRUEFUNG.txt) liegen bei diesem Protokoll.' }];
  if (mit.length) {
    bloecke.push({ art: 'tabelle', kopf: ['Change', 'Titel', 'Abnahmeprotokoll', 'Version', 'Prüfsumme(n) SHA-256'], zeilen: mit.map(c => {
      const v = a[c.id]!;
      return [id8(c.id), g(c.title, 120), id8(v.docId), String(v.version), v.pruefsummen.length ? v.pruefsummen.join(', ') : 'keine (Change ohne Lauf)'];
    }) });
  }
  if (ohne.length) bloecke.push({ art: 'nichtBelegt', grund: `kein Abnahmeprotokoll: ${ohne.map(c => id8(c.id)).join(', ')}` });
  if (gs.abnahmen.hinweis) bloecke.push({ art: 'absatz', text: `Hinweis: ${g(gs.abnahmen.hinweis)}` });
  return bloecke;
}

function kapitelAbweichungen(gs: Gesammelt, abweichungen?: string): Block[] {
  const bloecke: Block[] = [];
  if (gs.changes.fehler || !gs.changes.daten) bloecke.push(nichtLesbar('Changes', gs.changes));
  else {
    const zaehle = (v: VerlaufEintrag[], art: VerlaufEintrag['art']) => v.filter(e => e.art === art).length;
    const gelaufen = gs.changes.daten.filter(gestartet);
    const ohneVerlauf = gelaufen.filter(c => !Array.isArray(laufVon(c)?.verlauf));
    const zeilen = gelaufen.filter(c => (laufVon(c)?.verlauf ?? []).some(e => e.art !== 'ausgelassen')).map(c => {
      const v = laufVon(c)!.verlauf!;
      return [id8(c.id), g(c.title, 120), String(zaehle(v, 'halt')), String(zaehle(v, 'wiederholen')), String(zaehle(v, 'ueberspringen')), String(zaehle(v, 'plan_geaendert'))];
    });
    bloecke.push(zeilen.length
      ? { art: 'tabelle', kopf: ['Change', 'Titel', 'Halte', 'Wiederholungen', 'Übersprungen', 'Planänderungen'], zeilen }
      : { art: 'absatz', text: 'Keine Halte oder Wiederholungen in den erfassten Läufen.' });
    if (ohneVerlauf.length) bloecke.push({ art: 'nichtBelegt', grund: `Verlauf nicht erfasst (Lauf vor Einführung des Verlaufs, Halte nur in den Abnahmeprotokollen): ${ohneVerlauf.map(c => id8(c.id)).join(', ')}` });
  }
  bloecke.push({ art: 'absatz', text: 'Offene Befunde:' }, ...problemTabelle(gs));
  bloecke.push(frei('abweichungen', abweichungen));
  return bloecke;
}

function quellen(gs: Gesammelt): Dokument['kopf']['quellen'] {
  const eintrag = (quelle: string, q: Quelle<unknown>) => ({ quelle, stand: q.stand, ...(q.fehler ? { fehler: g(q.fehler, 300) } : {}) });
  const aus = [
    eintrag('cmdb', gs.assets), eintrag('beziehungen', gs.beziehungen), eintrag('proxmox', gs.proxmox), eintrag('sicherung', gs.sicherung),
    eintrag('unifi', gs.unifi), eintrag('tresor', gs.tresor), eintrag('fernzugaenge', gs.fernzugaenge), eintrag('jobs', gs.jobs),
    eintrag('wartung', gs.wartung), eintrag('problems', gs.problems), eintrag('changes', gs.changes), eintrag('abnahmen', gs.abnahmen),
    ...(gs.architektur ? [eintrag('architektur', gs.architektur)] : []), eintrag('netzBestand', gs.netzBestand),
  ];
  for (const [k, v] of Object.entries(gs.netzBestand.daten?.stand ?? {})) aus.push({ quelle: `cmdb:${k}`, stand: v });
  return aus;
}

export function baueBetrieb(name: string, p: BetriebParameter, gs: Gesammelt, freiText: { zweck?: string; abweichungen?: string }, jetzt: string): Dokument {
  const ks = komponenten(gs);
  const d: Dokument = {
    kopf: {
      art: 'betrieb', artVersion: DOKU_ARTEN.betrieb.version,
      titel: `${DOKU_ARTEN.betrieb.titel}: ${g(name, 120)}`,
      ordner: ordnerName(name),
      erzeugt: jetzt,
      quellen: quellen(gs),
      verweise: [
        ...(p.vorhabenId ? [`vorhaben:${p.vorhabenId}`] : []),
        ...(p.architekturDocId ? [`dokument:${id8(p.architekturDocId)}`] : []),
        ...(gs.changes.daten ?? []).map(c => `change:${id8(c.id)}`),
      ],
    },
    kapitel: [
      kapitel('zweck', kapitelZweck(ks, p, freiText.zweck)),
      kapitel('architektur', kapitelArchitektur(gs, ks, p)),
      kapitel('komponenten', kapitelKomponenten(gs, ks)),
      kapitel('netz', kapitelNetz(gs, ks)),
      kapitel('identitaeten', kapitelIdentitaeten(gs, ks)),
      kapitel('abhaengigkeiten', kapitelAbhaengigkeiten(gs, ks)),
      kapitel('wiederaufbau', kapitelWiederaufbau(gs)),
      kapitel('sicherung', kapitelSicherung(gs, ks, p)),
      kapitel('ueberwachung', kapitelUeberwachung(gs, ks, p)),
      kapitel('betrieb', kapitelBetrieb(gs, p)),
      kapitel('historie', kapitelHistorie(gs)),
      kapitel('beweise', kapitelBeweise(gs)),
      kapitel('abweichungen', kapitelAbweichungen(gs, freiText.abweichungen)),
    ],
    anhaenge: [],
  };
  const m = pruefeDokument(d);
  if (m.length) throw new Error(`Dokument ungültig: ${m.join('; ')}`);
  return d;
}
