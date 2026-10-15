/**
 * v1465 — Prüfbericht nach fester Vorlage (Owner 15.10.: „ist gelaufen, sieht aber nun wieder ganz anders aus“ → „ok“ zum Vorschlag).
 * Das Modell liefert nur noch Daten (Stand-Zeilen mit Status) und optional eine kurze Einschätzung; den Bericht setzt Alfred selbst
 * zusammen — jedes Mal gleich, unabhängig vom Modell: Änderungen zuerst, dann eine Tabelle der aktuellen Einträge, dann „nicht prüfbar“,
 * zuletzt die Einschätzung. Der Status ist ein festes Wort (aus der Detailabfrage), keine Einschätzung des Modells.
 *
 * Stand-Zeile (neu): Kennung | Link | Bezeichnung | Wert | Ort | Status | Notiz | seit
 * Ältere Zeilen (Kennung | Link | Bezeichnung | Wert | „online, unverändert …“) werden ebenfalls gelesen.
 */

export type Status = 'aktiv' | 'reserviert' | 'verkauft' | 'weg' | 'nicht prüfbar';
export interface Eintrag { kennung: string; link?: string; bezeichnung: string; wert?: string; ort?: string; status: Status; notiz?: string; seit?: string }

const WERT = /^-?\d[\d.,\s]*\s*(EUR|€|USD|\$|CHF)\b|^(EUR|€)\s*\d/i;
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

/** Status aus Freitext; undefined, wenn kein Statuswort vorkommt. */
export function statusAus(t: string): Status | undefined {
  const s = t.toLowerCase();
  if (/nicht pr(ü|ue)fbar|unklar/.test(s)) return 'nicht prüfbar';
  if (/verkauft|sold/.test(s)) return 'verkauft';
  if (/reserviert|reserved/.test(s)) return 'reserviert';
  if (/\bweg\b|gel(ö|oe)scht|nicht mehr abrufbar|entfernt|offline|abgelaufen/.test(s)) return 'weg';
  if (/\b(aktiv|online|active|verf(ü|ue)gbar|unver(ä|ae)ndert)\b/.test(s)) return 'aktiv';
  return undefined;
}

/** Freitext der Statusspalte ohne Statuswörter (bleibt als Notiz, z. B. „außerhalb Filter (36 GB)“). */
function notizAus(t: string): string {
  return t.replace(/\b(online|aktiv|active|unver(ä|ae)ndert|verf(ü|ue)gbar)\b/gi, '').replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** Eine Stand-Zeile lesen (neu oder alt); undefined bei Leerzeilen, Überschriften oder ohne Kennung. */
export function zeileLesen(zeile: string): Eintrag | undefined {
  const z = zeile.trim().replace(/^[-*•]\s*/, '');
  if (!z.includes('|')) return undefined;
  const t = z.split('|').map(x => x.trim());
  if (t.every(x => /^-*$/.test(x))) return undefined; // Tabellen-Trennlinie
  const kennung = t[0]!;
  if (!kennung || /^kennung$/i.test(kennung)) return undefined;
  // neue Form: genau 8 Spalten, Spalte 6 ist ein Statuswort
  if (t.length === 8 && statusAus(t[5]!) && (!t[7] || DATUM.test(t[7]))) {
    return { kennung, ...(t[1] && /^https?:\/\//.test(t[1]) ? { link: t[1] } : {}), bezeichnung: t[2] || kennung, ...(t[3] ? { wert: t[3] } : {}), ...(t[4] ? { ort: t[4] } : {}), status: statusAus(t[5]!)!, ...(t[6] ? { notiz: t[6] } : {}), ...(t[7] ? { seit: t[7] } : {}) };
  }
  // ältere/freie Form: Spalten nach Art erkennen
  const rest = t.slice(1);
  const link = rest.find(x => /^https?:\/\//.test(x));
  const wert = rest.find(x => WERT.test(x));
  const seit = rest.find(x => DATUM.test(x));
  const statusSpalte = [...rest].reverse().find(x => x !== link && x !== wert && statusAus(x));
  const uebrig = rest.filter(x => x && x !== link && x !== wert && x !== seit && x !== statusSpalte);
  const notiz = [statusSpalte ? notizAus(statusSpalte) : '', ...uebrig.slice(2)].filter(Boolean).join('; ');
  return { kennung, ...(link ? { link } : {}), bezeichnung: uebrig[0] || kennung, ...(wert ? { wert } : {}), ...(uebrig[1] ? { ort: uebrig[1] } : {}), status: statusSpalte ? statusAus(statusSpalte)! : 'nicht prüfbar', ...(notiz ? { notiz } : {}), ...(seit ? { seit } : {}) };
}

export function standLesen(text: string | undefined): Eintrag[] {
  const aus: Eintrag[] = [];
  const gesehen = new Set<string>();
  for (const z of (text ?? '').split('\n')) { const e = zeileLesen(z); if (e && !gesehen.has(e.kennung)) { gesehen.add(e.kennung); aus.push(e); } }
  return aus;
}

const zelle = (s: string | undefined) => (s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** Stand in der festen Form speichern. */
export function standSchreiben(e: Eintrag[]): string {
  return e.map(x => [x.kennung, x.link, x.bezeichnung, x.wert, x.ort, x.status, x.notiz, x.seit].map(zelle).join(' | ')).join('\n');
}

const zahl = (w: string | undefined) => { const m = (w ?? '').replace(/\s/g, '').match(/-?\d[\d.,]*/); if (!m) return undefined; const n = Number(m[0].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(n) ? n : undefined; };
const verweis = (e: Eintrag) => (e.link ? `[${zelle(e.bezeichnung)}](${e.link})` : zelle(e.bezeichnung));
const WEG: Status[] = ['verkauft', 'weg'];

/**
 * Bericht nach fester Vorlage und neuer Stand. Einträge des alten Stands, die das Modell nicht mehr nennt: aktiv → „nicht prüfbar“
 * (bleiben im Stand); schon verkauft/weg → fallen heraus. Verkauft/weg bleibt genau einen Lauf im Stand (dann nicht erneut gemeldet).
 */
export function berichtBauen(o: { alt: Eintrag[]; neu: Eintrag[]; einschaetzung?: string; jetzt: Date }): { bericht: string; stand: Eintrag[] } {
  const heute = o.jetzt.toISOString().slice(0, 10);
  const alt = new Map(o.alt.map(e => [e.kennung, e]));
  const stand: Eintrag[] = [];
  const aenderungen: string[] = [];
  for (const n of o.neu) {
    const a = alt.get(n.kennung);
    const e: Eintrag = { ...n, link: n.link ?? a?.link, seit: a?.seit ?? n.seit ?? heute };
    if (a && WEG.includes(a.status) && WEG.includes(e.status)) continue; // schon gemeldet
    stand.push(e);
    if (!a) { if (!WEG.includes(e.status)) aenderungen.push(`🆕 **Neu:** ${verweis(e)}${e.wert ? ` — ${zelle(e.wert)}` : ''}${e.ort ? `, ${zelle(e.ort)}` : ''}`); continue; }
    if (e.status !== a.status) {
      if (WEG.includes(e.status)) aenderungen.push(`❌ **${e.status === 'verkauft' ? 'Verkauft' : 'Weg'}:** ${verweis(e)}${e.wert ? ` (${zelle(e.wert)})` : ''}`);
      else if (e.status === 'reserviert') aenderungen.push(`⏸ **Reserviert:** ${verweis(e)}`);
      else if (e.status === 'aktiv' && a.status !== 'nicht prüfbar') aenderungen.push(`↩️ **Wieder aktiv:** ${verweis(e)}`);
    }
    const za = zahl(a.wert); const zn = zahl(e.wert);
    if (za !== undefined && zn !== undefined && za !== zn && !WEG.includes(e.status)) aenderungen.push(`${zn < za ? '📉' : '📈'} **Preis ${zn < za ? 'gesenkt' : 'erhöht'}:** ${verweis(e)} — ${zelle(a.wert)} → **${zelle(e.wert)}**`);
  }
  const genannt = new Set(o.neu.map(e => e.kennung));
  for (const a of o.alt) {
    if (genannt.has(a.kennung) || WEG.includes(a.status)) continue;
    stand.push({ ...a, status: 'nicht prüfbar', notiz: 'in diesem Lauf nicht gemeldet' });
  }
  const aktuell = stand.filter(e => e.status === 'aktiv' || e.status === 'reserviert');
  const offen = stand.filter(e => e.status === 'nicht prüfbar');
  const wertKopf = aktuell.some(e => /EUR|€|USD|\$|CHF/i.test(e.wert ?? '')) ? 'Preis' : 'Wert';
  const teile: string[] = [
    '## Änderungen', '',
    ...(aenderungen.length ? aenderungen.map(z => `- ${z}`) : ['Keine Änderungen seit dem letzten Lauf.']), '',
    `## Aktuell (${aktuell.length})`, '',
  ];
  if (aktuell.length) {
    teile.push(`| Eintrag | ${wertKopf} | Ort | Hinweis | bekannt seit |`, '|---|---|---|---|---|');
    for (const e of aktuell) teile.push(`| ${verweis(e)}${e.status === 'reserviert' ? ' ⏸' : ''} | ${zelle(e.wert)} | ${zelle(e.ort)} | ${zelle(e.notiz)} | ${e.seit ? `${e.seit.slice(8, 10)}.${e.seit.slice(5, 7)}.` : ''} |`);
  } else teile.push('Keine aktiven Einträge.');
  if (offen.length) teile.push('', '## Nicht prüfbar', '', ...offen.map(e => `- ${verweis(e)}${e.notiz ? ` — ${zelle(e.notiz)}` : ''}`));
  const ein = (o.einschaetzung ?? '').trim();
  if (ein) teile.push('', '## Einschätzung', '', ein.length > 1500 ? `${ein.slice(0, 1497)}…` : ein);
  return { bericht: teile.join('\n'), stand };
}
