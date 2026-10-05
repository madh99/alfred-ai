/**
 * v1203 — Jarvis Interaktion: „Standard knapp."
 *
 * Proaktive Meldungen kamen bisher in voller Modell-Länge (Absätze, Unterpunkte,
 * Erklärungen). Die knappe Fassung ist deterministisch: je Insight die Titelzeile
 * plus höchstens ein Folgesatz, höchstens fünf Insights, Gesamtlänge begrenzt.
 * Volltext und Details bleiben im Vorgang (Kachel Vorgänge) und sind per „warum?"
 * erklärbar — der Chat bekommt die Kurzfassung.
 */
export const KNAPP_MAX_INSIGHTS = 5;
export const KNAPP_MAX_ZEICHEN_JE_INSIGHT = 240;
export const KNAPP_MAX_GESAMT = 1400;

function saeubereZeile(z: string): string {
  return z
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*→\s*/, '')
    .trim();
}

/** Erster Satz eines Textes (bis . ! ? oder Zeilenende), maximal `max` Zeichen. */
function ersterSatz(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const satz = (m ? m[1] : t).trim();
  return satz.length > max ? `${satz.slice(0, max - 1).trimEnd()}…` : satz;
}

/** Ein Insight → Titel + höchstens ein Folgesatz. */
export function knappesInsight(insight: string, maxZeichen = KNAPP_MAX_ZEICHEN_JE_INSIGHT): string {
  const zeilen = insight.split('\n').map(saeubereZeile).filter(z => z.length > 0);
  if (zeilen.length === 0) return '';
  const titel = zeilen[0].replace(/\[(?:HIGH|URGENT|NORMAL|LOW|MEDIUM|KRITISCH|DRINGEND)\]\s*/gi, '').trim();
  const rest = zeilen.slice(1).join(' ');
  const folge = rest ? ersterSatz(rest, Math.max(40, maxZeichen - titel.length - 3)) : '';
  const text = folge ? `${titel} — ${folge}` : titel;
  return text.length > maxZeichen ? `${text.slice(0, maxZeichen - 1).trimEnd()}…` : text;
}

/** Nachrichtentext für den Chat: nummerierte Kurzzeilen, Hinweis auf Details. */
export function knappeFassung(insights: string[], opts: { maxInsights?: number; maxZeichen?: number } = {}): { text: string; weggelassen: number } {
  const maxInsights = opts.maxInsights ?? KNAPP_MAX_INSIGHTS;
  const maxGesamt = opts.maxZeichen ?? KNAPP_MAX_GESAMT;
  const kurz = insights.map(i => knappesInsight(i)).filter(Boolean);
  const gezeigt = kurz.slice(0, maxInsights);
  let weggelassen = kurz.length - gezeigt.length;
  const zeilen: string[] = [];
  let laenge = 0;
  for (const [i, z] of gezeigt.entries()) {
    const zeile = gezeigt.length > 1 ? `${i + 1}. ${z}` : z;
    if (laenge + zeile.length + 1 > maxGesamt && zeilen.length > 0) { weggelassen += gezeigt.length - i; break; }
    zeilen.push(zeile);
    laenge += zeile.length + 1;
  }
  if (weggelassen > 0) zeilen.push(`… und ${weggelassen} weitere (Kachel Vorgänge)`);
  return { text: zeilen.join('\n'), weggelassen };
}
