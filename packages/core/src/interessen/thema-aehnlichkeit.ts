/**
 * v1366 — Interessen bereinigen (Owner 12.10.: „konsolidieren, wenn es sonst nichts beeinträchtigt").
 *
 * Der Interest-Detector (05:15) legte Themen nur dann nicht an, wenn der Name exakt gleich war. Das Modell formuliert
 * jeden Tag neu („Markttrends und technologische Fortschritte bei bidirektionalen Ladelösungen (V2…)") — so entstanden
 * bis 12.10. rund 12 Varianten zu V2G/V2H, 7 zu Krypto, 5 zu dynamischen Stromtarifen. Jede sammelt stündlich per
 * Web-Suche (2 300 Suchen am Tag) und bekommt täglich ein Dossier.
 *
 * Ähnlich = drei gemeinsame Stichwörter (oder zwei, wenn das die Hälfte der kleineren Liste ist), oder der Name besteht überwiegend aus Wörtern des bestehenden
 * Themas. Gilt NUR für Themen, die Alfred selbst vorschlägt oder anlegt — die Anlage durch den Owner bleibt exakt
 * (v952: unscharfer Abgleich verweigerte „Panini-Sammelalbum WM 2026" wegen eines Themas mit Stichwort „Panini").
 */

export interface ThemaKurz { id: string; name: string; keywords: string[] }

/** Füllwörter der Modell-Namen („Entwicklungen im Bereich …", „Markttrends und …") tragen keine Bedeutung. */
const FUELL = new Set([
  'entwicklungen', 'entwicklung', 'bereich', 'markttrends', 'marktentwicklungen', 'innovationen', 'fortschritte',
  'technologische', 'technologieentwicklungen', 'regulatorische', 'änderungen', 'fokus', 'neue', 'insbesondere',
  'integration', 'markt', 'trends', 'news', 'management', 'technologien', 'mit', 'und', 'für', 'bei', 'der', 'die',
  'das', 'den', 'des', 'im', 'in', 'auf', 'von', 'zu', 'österreich', 'österreichische', 'österreichischen',
]);

export function bedeutungsWoerter(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').split(' ').filter(w => w.length >= 3 && !FUELL.has(w)));
}

function stichwoerter(k: string[]): Set<string> {
  return new Set(k.map(x => x.toLowerCase().trim()).filter(Boolean));
}

/** Bestehendes Thema, dem ein neues (name, keywords) zu ähnlich ist — oder null. */
export function aehnlichesThema(name: string, keywords: string[], bestand: ThemaKurz[]): { thema: ThemaKurz; grund: string } | null {
  const kn = stichwoerter(keywords);
  const wn = bedeutungsWoerter(name);
  let best: { thema: ThemaKurz; grund: string; wert: number } | null = null;
  for (const t of bestand) {
    const kt = stichwoerter(t.keywords);
    const gemeinsam = [...kn].filter(k => kt.has(k));
    const wt = new Set([...bedeutungsWoerter(t.name), ...[...kt].flatMap(k => [...bedeutungsWoerter(k)])]);
    const namensTreffer = [...wn].filter(w => wt.has(w)).length;
    const anteil = wn.size > 0 ? namensTreffer / wn.size : 0;
    let wert = 0; let grund = '';
    const quote = gemeinsam.length / Math.max(1, Math.min(kn.size, kt.size));
    if (gemeinsam.length >= 3 || (gemeinsam.length >= 2 && quote >= 0.5)) { wert = gemeinsam.length; grund = `gemeinsame Stichwörter: ${gemeinsam.slice(0, 4).join(', ')}`; }
    else if (wn.size >= 2 && anteil >= 0.6) { wert = anteil; grund = `Name überwiegend aus „${t.name}"`; }
    if (wert > 0 && (!best || wert > best.wert)) best = { thema: t, grund, wert };
  }
  return best ? { thema: best.thema, grund: best.grund } : null;
}
