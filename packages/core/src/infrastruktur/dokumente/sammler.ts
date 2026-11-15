// Sammler: Change und Verlauf für ein Dokument holen (I/O nur über die übergebenen Quellen).
import type { CmdbChangeRequest } from '@alfred/types';
import { MAX_VERLAUF_TEXT, type ChangeLauf, type VerlaufEintrag } from '../change-lauf.js';

export interface DokuQuellen {
  changes(o: string): Promise<CmdbChangeRequest[]>;
  haltIncidents(o: string, changeId: string): Promise<Array<{ id: string; createdAt: string; text: string }>>;
}

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

/**
 * Verlauf eines Changes: aus lauf.verlauf (seit den Dokument-Vorlagen vom Motor geführt); für ältere Läufe rekonstruiert aus den
 * Halte-Incidents des Motors (Text „Change <volle id> (<Titel>) angehalten.\n<Grund>“) — dort stehen nur Halte, keine Wiederholungen.
 */
export async function verlaufVon(q: DokuQuellen, o: string, c: CmdbChangeRequest): Promise<{ eintraege: VerlaufEintrag[]; quelle: 'lauf' | 'incidents' | 'keine' }> {
  const lauf = c.lauf as ChangeLauf | undefined;
  if (Array.isArray(lauf?.verlauf) && lauf.verlauf.length > 0) return { eintraege: lauf.verlauf, quelle: 'lauf' };

  const kennung = `Change ${c.id}`;
  const eintraege: VerlaufEintrag[] = [];
  for (const i of await q.haltIncidents(o, c.id)) {
    if (!i.text.includes(kennung)) continue;
    const pos = i.text.indexOf('angehalten.\n');
    const grund = (pos >= 0 ? i.text.slice(pos + 'angehalten.\n'.length) : '').trim();
    const nr = /Schritt (\d+)/.exec(grund);
    eintraege.push({ zeit: i.createdAt, art: 'halt', schritt: nr ? Number(nr[1]) : 0, text: (grund || 'angehalten (Grund nicht erfasst)').slice(0, MAX_VERLAUF_TEXT) });
  }
  if (!eintraege.length) return { eintraege: [], quelle: 'keine' };
  eintraege.sort((a, b) => a.zeit.localeCompare(b.zeit));
  return { eintraege, quelle: 'incidents' };
}
