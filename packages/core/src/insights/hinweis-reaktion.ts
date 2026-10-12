/**
 * v1364 — Auf Hinweise reagieren (Spec Jarvis „Auf Hinweise reagieren", K1, freigegeben 12.10.).
 *
 * Ein Hinweis ist Information, kein Auftrag: Reagieren ist freiwillig, Ablauf ohne Reaktion bleibt neutral.
 * Reaktionen sind Lernsignal (Schicht 4). „Erledigt" wurde als „gelesen" benutzt (68 von 69 am 11.10. in einem
 * Durchgang) — deshalb getrennt: „nützlich" (Signal) und „gelesen" (neutral). Nicht nützlich mit optionalem Grund.
 * K1 erfasst nur; gedrosselt wird nichts. „Schon bekannt" wird zwei Wochen beobachtet (wäre gesperrt, Tag n,
 * Inhalt gleich oder geändert), bevor eine Sperrdauer festgelegt wird.
 */
import { istThemenWiederholung, punkteAus } from './hinweis-pruefung.js';
import { knappesInsight } from '../interaktion/knapp.js';

export type HinweisReaktion = 'nuetzlich' | 'gelesen' | 'nicht_nuetzlich' | 'bekannt' | 'falsch' | 'kein_interesse' | 'zu_oft' | 'besprochen';

/** Gründe für „nicht nützlich" mit Anzeigetext (App, Telegram). */
export const GRUENDE: Record<'bekannt' | 'falsch' | 'kein_interesse' | 'zu_oft', string> = {
  bekannt: 'schon bekannt', falsch: 'falsch', kein_interesse: 'interessiert mich nicht', zu_oft: 'zu oft',
};

const NEGATIV = new Set<string>(['nicht_nuetzlich', 'bekannt', 'falsch', 'kein_interesse', 'zu_oft']);

/** Präzisions-Signal einer Reaktion: nützlich positiv, nicht nützlich (mit/ohne Grund) negativ; gelesen/besprochen neutral. */
export function signalAus(reaktion: string | undefined): 'positiv' | 'negativ' | null {
  if (reaktion === 'nuetzlich') return 'positiv';
  return reaktion && NEGATIV.has(reaktion) ? 'negativ' : null;
}

/**
 * Geräte-Aktion → Reaktion und neuer Status (null = Status bleibt). „erledigt"/„verwerfen" sind die Knöpfe der
 * App bis 1.13 — sie werden wie „gelesen" bzw. „nicht nützlich" behandelt.
 */
export function reaktionAus(aktion: string): { reaktion: HinweisReaktion; status: 'acted' | 'dismissed' | null } | null {
  switch (aktion) {
    case 'nuetzlich': return { reaktion: 'nuetzlich', status: 'acted' };
    case 'gelesen': case 'erledigt': return { reaktion: 'gelesen', status: 'acted' };
    case 'nicht_nuetzlich': case 'verwerfen': return { reaktion: 'nicht_nuetzlich', status: 'dismissed' };
    case 'bekannt': case 'falsch': case 'kein_interesse': case 'zu_oft': return { reaktion: aktion, status: 'dismissed' };
    case 'besprochen': return { reaktion: 'besprochen', status: null };
    default: return null;
  }
}

// ── Telegram ────────────────────────────────────────────────────────────────

export interface Knopf { text: string; callbackData: string }

const KURZ: Record<string, HinweisReaktion> = { gut: 'nuetzlich', schlecht: 'nicht_nuetzlich', bekannt: 'bekannt', falsch: 'falsch', kein: 'kein_interesse', oft: 'zu_oft' };
const HINWEIS_CALLBACK = /^hw:([0-9a-fA-F-]{8,40}):(gut|schlecht|bekannt|falsch|kein|oft)$/;

/** Callback-Daten eines Hinweis-Knopfs (`hw:<id>:gut|schlecht|bekannt|falsch|kein|oft`). */
export function hinweisCallback(text: string): { id: string; reaktion: HinweisReaktion } | null {
  const m = HINWEIS_CALLBACK.exec((text ?? '').trim());
  return m ? { id: m[1]!, reaktion: KURZ[m[2]!]! } : null;
}

/**
 * Knöpfe unter einer gebündelten Meldung: je gezeigtem Hinweis 👍 und 👎 — bei mehreren nummeriert in zwei Zeilen
 * („1 👍 2 👍 …" / „1 👎 2 👎 …"), bei einem ausgeschrieben. Ohne gespeicherte Hinweise keine Knöpfe.
 */
export function hinweisKnoepfe(ids: Array<string | undefined>): Knopf[][] {
  const mit = ids.map((id, i) => ({ id, nr: i + 1 })).filter((x): x is { id: string; nr: number } => !!x.id);
  if (mit.length === 0) return [];
  if (ids.length === 1) return [[{ text: '👍 Nützlich', callbackData: `hw:${mit[0]!.id}:gut` }, { text: '👎 Nicht nützlich', callbackData: `hw:${mit[0]!.id}:schlecht` }]];
  return [
    mit.map(x => ({ text: `${x.nr} 👍`, callbackData: `hw:${x.id}:gut` })),
    mit.map(x => ({ text: `${x.nr} 👎`, callbackData: `hw:${x.id}:schlecht` })),
  ];
}

/** Nach 👎: freiwilliger Grund. */
export function grundKnoepfe(id: string): Knopf[][] {
  return [
    [{ text: GRUENDE.bekannt, callbackData: `hw:${id}:bekannt` }, { text: GRUENDE.falsch, callbackData: `hw:${id}:falsch` }],
    [{ text: GRUENDE.kein_interesse, callbackData: `hw:${id}:kein` }, { text: GRUENDE.zu_oft, callbackData: `hw:${id}:oft` }],
  ];
}

/**
 * Hinweis-IDs in der Reihenfolge der knappen Fassung (v1203): leere Kurzzeilen fallen dort heraus, gezeigt werden
 * die ersten `gezeigt`. So passt Knopf „2" zu Zeile „2.".
 */
export function gezeigteIds(insights: string[], ids: Array<string | undefined>, gezeigt: number): Array<string | undefined> {
  return insights.map((t, i) => ({ t, id: ids[i] })).filter(x => knappesInsight(x.t)).slice(0, Math.max(0, gezeigt)).map(x => x.id);
}

// ── Beobachtung „schon bekannt" ─────────────────────────────────────────────

export const BEKANNT_BEOBACHTUNG_TAGE = 14;

function zahlenAus(s: string): Set<string> {
  return new Set((s.match(/\d+(?:[.,]\d+)?/g) ?? []).map(z => z.replace(',', '.')));
}

export interface BekanntTreffer { gegen: string; tag: number; inhalt: 'gleich' | 'geändert' }

/**
 * Würde ein neuer Hinweis-Punkt unter „schon bekannt" fallen? Gleiches Thema wie die Wiederholungssperre (v1360,
 * Anker + Wortüberlappung) gegen Hinweise, die der Owner in den letzten 14 Tagen als bekannt markiert hat.
 * „geändert" = der neue Punkt nennt Zahlen, die im bekannten nicht vorkamen (Wert, Datum, Anzahl).
 */
export function bekanntTreffer(punkt: string, bekannte: Array<{ text: string; am: string }>, jetzt: number): BekanntTreffer | null {
  for (const b of bekannte) {
    const am = Date.parse(b.am);
    if (!Number.isFinite(am) || jetzt - am > BEKANNT_BEOBACHTUNG_TAGE * 86_400_000) continue;
    const w = istThemenWiederholung(punkt, punkteAus(b.text));
    if (!w) continue;
    const alt = zahlenAus(b.text);
    const neu = [...zahlenAus(punkt)].some(z => !alt.has(z));
    return { gegen: w.gegen, tag: Math.floor((jetzt - am) / 86_400_000), inhalt: neu ? 'geändert' : 'gleich' };
  }
  return null;
}
