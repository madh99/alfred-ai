// Sammler: Change und Verlauf für ein Dokument holen (I/O nur über die übergebenen Quellen).
import type { CmdbChangeRequest } from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import { MAX_VERLAUF_TEXT, type ChangeLauf, type VerlaufEintrag } from '../change-lauf.js';

/**
 * Quellen mit offener Grenze: `abgeschnitten` = die Liste hat die Abfragegrenze erreicht, es kann mehr geben. Das wird nie geglättet —
 * findeChange meldet es statt „nicht gefunden“, der Verlauf bekommt einen nichtBelegt-Block.
 */
export interface DokuQuellen {
  changes(o: string): Promise<{ changes: CmdbChangeRequest[]; abgeschnitten: boolean }>;
  /** Halte-Incidents ab `seit` (Anlage des Changes) */
  haltIncidents(o: string, changeId: string, seit: string): Promise<{ incidents: Array<{ id: string; createdAt: string; text: string }>; abgeschnitten: boolean }>;
}

export const ABGESCHNITTEN_GRUND = 'Incident-Liste abgeschnitten — Verlauf möglicherweise unvollständig';

export type VerlaufQuelle = 'lauf' | 'incidents' | 'lauf+incidents' | 'keine';

/** Change über volle ID oder ID-Präfix; Text = Fehlermeldung (unbekannt oder mehrdeutig mit Kandidaten). */
export async function findeChange(q: Pick<DokuQuellen, 'changes'>, o: string, ref: string): Promise<CmdbChangeRequest | string> {
  const r = ref.trim().toLowerCase();
  if (!r) return 'Change nicht gefunden: keine ID angegeben.';
  const { changes: alle, abgeschnitten } = await q.changes(o);
  const genau = alle.find(c => c.id.toLowerCase() === r);
  if (genau) return genau;
  const treffer = alle.filter(c => c.id.toLowerCase().startsWith(r));
  // abgeschnittene Liste: weder „nicht gefunden“ noch „eindeutig“ ist belegt
  if (abgeschnitten) return `Change „${ref.trim()}“ nicht sicher auflösbar: die Change-Liste hat die Abfragegrenze erreicht (${alle.length} geladen, ${treffer.length} Treffer darin) — es kann weitere geben. Bitte die volle ID angeben.`;
  if (treffer.length === 1) return treffer[0]!;
  if (treffer.length === 0) return `Change „${ref.trim()}“ nicht gefunden.`;
  return `Change „${ref.trim()}“ ist mehrdeutig — ${treffer.length} Treffer: ${treffer.map(c => `${c.id} („${c.title.slice(0, 80)}“)`).join(', ')}. Bitte die volle ID angeben.`;
}

/** Halte aus den Incidents des Motors (Text „Change <volle id> (<Titel>) angehalten.\n<Grund>“); Grund geschwärzt, dann gekürzt. */
async function halteAusIncidents(q: DokuQuellen, o: string, c: CmdbChangeRequest): Promise<{ eintraege: VerlaufEintrag[]; abgeschnitten: boolean }> {
  const kennung = `Change ${c.id}`;
  const eintraege: VerlaufEintrag[] = [];
  const h = await q.haltIncidents(o, c.id, c.createdAt);
  for (const i of h.incidents) {
    if (!i.text.includes(kennung)) continue;
    const pos = i.text.indexOf('angehalten.\n');
    const grund = (pos >= 0 ? i.text.slice(pos + 'angehalten.\n'.length) : '').trim();
    const nr = /Schritt (\d+)/.exec(grund);
    eintraege.push({ zeit: i.createdAt, art: 'halt', schritt: nr ? Number(nr[1]) : 0, text: schwaerze(grund || 'angehalten (Grund nicht erfasst)').text.slice(0, MAX_VERLAUF_TEXT) });
  }
  return { eintraege, abgeschnitten: h.abgeschnitten };
}

/**
 * Verlauf eines Changes: aus lauf.verlauf (seit den Dokument-Vorlagen vom Motor geführt); für ältere Läufe rekonstruiert aus den
 * Halte-Incidents — dort stehen nur Halte, keine Wiederholungen. Halte aus Incidents, die im Lauf fehlen (lauf.verlauf ohne Halt
 * oder Incident älter als der erste Laufeintrag), werden zeitlich eingereiht (Quelle lauf+incidents).
 */
export async function verlaufVon(q: DokuQuellen, o: string, c: CmdbChangeRequest): Promise<{ eintraege: VerlaufEintrag[]; quelle: VerlaufQuelle; abgeschnitten?: true }> {
  const lauf = c.lauf as ChangeLauf | undefined;
  const ausLauf = Array.isArray(lauf?.verlauf) ? lauf.verlauf : [];
  // Der Motor legt den Halte-Incident nur beim ERSTEN Halt an: liegt er vor dem ersten Laufeintrag (vor Einführung des Verlaufs
  // angehalten, danach wiederholt und erneut angehalten), fehlt dieser Halt im Lauf und wird ergänzt. Ohne Halt im Lauf zählen alle.
  const ersterImLauf = ausLauf.reduce<string | undefined>((m, e) => (m === undefined || e.zeit < m ? e.zeit : m), undefined);
  const ohneHalt = !ausLauf.some(e => e.art === 'halt');
  const hi = await halteAusIncidents(q, o, c);
  const ab = hi.abgeschnitten ? { abgeschnitten: true as const } : {};
  const halte = hi.eintraege.filter(h => ohneHalt || (ersterImLauf !== undefined && h.zeit < ersterImLauf));
  if (!halte.length) return ausLauf.length ? { eintraege: ausLauf, quelle: 'lauf', ...ab } : { eintraege: [], quelle: 'keine', ...ab };
  const schluessel = (e: VerlaufEintrag) => `${e.zeit}|${e.art}|${e.text}`;
  const gesehen = new Set<string>();
  const eintraege = [...ausLauf, ...halte]
    .filter(e => { const k = schluessel(e); if (gesehen.has(k)) return false; gesehen.add(k); return true; })
    .map((e, i) => ({ e, i }))
    // stabil nach Zeit; gleiche Zeit behält die Reihenfolge (Lauf vor Incident)
    .sort((a, b) => a.e.zeit.localeCompare(b.e.zeit) || a.i - b.i)
    .map(x => x.e);
  return { eintraege, quelle: ausLauf.length ? 'lauf+incidents' : 'incidents', ...ab };
}

/** Abfragegrenze für Changes und Incidents; erreicht eine Liste sie, gilt sie als abgeschnitten. */
export const QUELLEN_GRENZE = 5000;

export interface ItsmLesend {
  listChangeRequests(o: string, f: { limit: number }): Promise<CmdbChangeRequest[]>;
  listIncidents(o: string, f: { since?: string; limit: number }): Promise<Array<{ id: string; createdAt: string; description?: string; symptoms?: string }>>;
}

/**
 * DokuQuellen aus dem ITSM-Repository. Incidents nur ab Anlage des Changes (`since`) — listIncidents sortiert nach Schwere vor Zeit,
 * an der Grenze fielen sonst ausgerechnet die niedrig eingestuften Halte still heraus. Erreicht eine Liste die Grenze → abgeschnitten.
 */
export function itsmQuellen(itsm: ItsmLesend, grenze = QUELLEN_GRENZE): DokuQuellen {
  return {
    changes: async (o) => {
      const changes = await itsm.listChangeRequests(o, { limit: grenze });
      return { changes, abgeschnitten: changes.length >= grenze };
    },
    // Halte-Incidents des Change-Motors: Text „Change <id> (<Titel>) angehalten.\n<Grund>“
    haltIncidents: async (o, changeId, seit) => {
      const roh = await itsm.listIncidents(o, { since: seit, limit: grenze });
      const incidents = roh
        .map(i => ({ id: i.id, createdAt: i.createdAt, text: i.description ?? i.symptoms ?? '' }))
        .filter(i => i.text.includes(`Change ${changeId}`) && i.text.includes('angehalten.'));
      return { incidents, abgeschnitten: roh.length >= grenze };
    },
  };
}
