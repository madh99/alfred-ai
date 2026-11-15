// Sammler: Change und Verlauf für ein Dokument holen (I/O nur über die übergebenen Quellen).
import type { CmdbChangeRequest } from '@alfred/types';
import { schwaerze } from '../../fernzugriff/kaefig.js';
import { MAX_VERLAUF_TEXT, type ChangeLauf, type VerlaufEintrag } from '../change-lauf.js';

export interface DokuQuellen {
  changes(o: string): Promise<CmdbChangeRequest[]>;
  haltIncidents(o: string, changeId: string): Promise<Array<{ id: string; createdAt: string; text: string }>>;
}

export type VerlaufQuelle = 'lauf' | 'incidents' | 'lauf+incidents' | 'keine';

/** Change über volle ID oder ID-Präfix; Text = Fehlermeldung (unbekannt oder mehrdeutig mit Kandidaten). */
export async function findeChange(q: DokuQuellen, o: string, ref: string): Promise<CmdbChangeRequest | string> {
  const r = ref.trim().toLowerCase();
  if (!r) return 'Change nicht gefunden: keine ID angegeben.';
  const alle = await q.changes(o);
  const genau = alle.find(c => c.id.toLowerCase() === r);
  if (genau) return genau;
  const treffer = alle.filter(c => c.id.toLowerCase().startsWith(r));
  if (treffer.length === 1) return treffer[0]!;
  if (treffer.length === 0) return `Change „${ref.trim()}“ nicht gefunden.`;
  return `Change „${ref.trim()}“ ist mehrdeutig — ${treffer.length} Treffer: ${treffer.map(c => `${c.id} („${c.title.slice(0, 80)}“)`).join(', ')}. Bitte die volle ID angeben.`;
}

/** Halte aus den Incidents des Motors (Text „Change <volle id> (<Titel>) angehalten.\n<Grund>“); Grund geschwärzt, dann gekürzt. */
async function halteAusIncidents(q: DokuQuellen, o: string, c: CmdbChangeRequest): Promise<VerlaufEintrag[]> {
  const kennung = `Change ${c.id}`;
  const eintraege: VerlaufEintrag[] = [];
  for (const i of await q.haltIncidents(o, c.id)) {
    if (!i.text.includes(kennung)) continue;
    const pos = i.text.indexOf('angehalten.\n');
    const grund = (pos >= 0 ? i.text.slice(pos + 'angehalten.\n'.length) : '').trim();
    const nr = /Schritt (\d+)/.exec(grund);
    eintraege.push({ zeit: i.createdAt, art: 'halt', schritt: nr ? Number(nr[1]) : 0, text: schwaerze(grund || 'angehalten (Grund nicht erfasst)').text.slice(0, MAX_VERLAUF_TEXT) });
  }
  return eintraege;
}

/**
 * Verlauf eines Changes: aus lauf.verlauf (seit den Dokument-Vorlagen vom Motor geführt); für ältere Läufe rekonstruiert aus den
 * Halte-Incidents — dort stehen nur Halte, keine Wiederholungen. Enthält lauf.verlauf keinen Halt, gibt es aber Halte-Incidents
 * (z. B. vor Einführung des Verlaufs angehalten, danach wiederholt), werden diese Halte zeitlich eingereiht (Quelle lauf+incidents).
 */
export async function verlaufVon(q: DokuQuellen, o: string, c: CmdbChangeRequest): Promise<{ eintraege: VerlaufEintrag[]; quelle: VerlaufQuelle }> {
  const lauf = c.lauf as ChangeLauf | undefined;
  const ausLauf = Array.isArray(lauf?.verlauf) ? lauf.verlauf : [];
  if (ausLauf.some(e => e.art === 'halt')) return { eintraege: ausLauf, quelle: 'lauf' };

  const halte = await halteAusIncidents(q, o, c);
  if (!halte.length) return ausLauf.length ? { eintraege: ausLauf, quelle: 'lauf' } : { eintraege: [], quelle: 'keine' };
  const schluessel = (e: VerlaufEintrag) => `${e.zeit}|${e.art}|${e.text}`;
  const gesehen = new Set<string>();
  const eintraege = [...ausLauf, ...halte]
    .filter(e => { const k = schluessel(e); if (gesehen.has(k)) return false; gesehen.add(k); return true; })
    .map((e, i) => ({ e, i }))
    // stabil nach Zeit; gleiche Zeit behält die Reihenfolge (Lauf vor Incident)
    .sort((a, b) => a.e.zeit.localeCompare(b.e.zeit) || a.i - b.i)
    .map(x => x.e);
  return { eintraege, quelle: ausLauf.length ? 'lauf+incidents' : 'incidents' };
}
