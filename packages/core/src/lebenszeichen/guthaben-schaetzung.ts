/**
 * v1726 — Guthaben-Schätzung der LLM-Konten (Owner 01.11.: „funktioniert, da E-Mails mit dem aufgeladenen Betrag kommen“).
 * Weder OpenAI noch Anthropic liefern den Kontostand per API. Ausgangspunkt ist deshalb ein bekannter Stand: das letzte Ereignis
 * „Guthaben leer“ (Stand 0) oder — v1727 — ein vom Owner genannter Kontostand. Danach: Ladungen minus gemessene Kosten × Faktor.
 * Ohne Ausgangspunkt zählt vorsichtig nur die letzte Ladung. Rein und ohne Modell; Erkennung der Ladungen über feste Muster.
 *
 * v1727 (Owner 01.11., Abgleich mit der Konsole: OpenAI geschätzt 4,39 $, tatsächlich 2,07 $; Anthropic 15,39 $ / 13,94 $):
 * Alfred sieht nicht jeden Verbrauch (Claude Code und Playground teilen sich das Anthropic-Guthaben). Jeder genannte Kontostand
 * liefert deshalb einen Korrekturfaktor tatsächlicher/gemessener Verbrauch. Euro-Anzeige brutto (MwSt.) zum EZB-Kurs.
 */

export type GuthabenAnbieter = 'openai' | 'anthropic';
export interface Ladung { anbieter: GuthabenAnbieter; guthaben: number; zeit: string; mailId: string }
/** Bekannter Stand: „leer“ (Guthaben-Fehler, Betrag 0) oder vom Owner genannt */
export interface Anker { art: 'leer' | 'stand'; betrag: number; zeit: string }

/** MwSt. auf Ladungen (Österreich 20 %); OpenAI nennt nur den Kartenbetrag („We charged $24.00“ = 20 $ Guthaben) */
export const MWST = 0.2;
export const OPENAI_MWST = MWST;

const betrag = (s: string) => Number.parseFloat(s.replace(/,/g, ''));

/** Erkennt eine Guthaben-Ladung (keine Abo-Rechnung) und liefert den Guthabenbetrag in USD ohne Steuer */
export function leseLadung(m: { id: string; from: string; subject: string; body: string; date: string }, mwstOpenai = OPENAI_MWST): Ladung | undefined {
  const von = m.from.toLowerCase();
  if (von.includes('@tm.openai.com') && /openai api account has been funded/i.test(m.subject)) {
    const t = /we charged \$\s?([\d.,]+)/i.exec(m.body);
    if (!t) return undefined;
    return { anbieter: 'openai', guthaben: Math.round((betrag(t[1]!) / (1 + mwstOpenai)) * 100) / 100, zeit: m.date, mailId: m.id };
  }
  // v1728 — Gratis-Guthaben (z. B. 9 $ nach Verknüpfung von ChatGPT-Konto und API-Organisation): voller Betrag, keine MwSt.
  if (von.includes('@tm.openai.com') && /api credits are ready/i.test(m.subject)) {
    const t = /you received \$\s?([\d.,]+) in api credits/i.exec(m.body.replace(/\s+/g, ' '));
    if (!t) return undefined;
    return { anbieter: 'openai', guthaben: betrag(t[1]!), zeit: m.date, mailId: m.id };
  }
  if (/receipt from anthropic/i.test(m.subject) && (von.includes('stripe.com') || von.includes('anthropic.com'))) {
    // nur Einmal-Guthaben; Abo-Rechnungen (Max plan, Team …) sind keine API-Ladung
    const t = /one-time credit purchase[^\n$€]*?\$\s?([\d.,]+)/i.exec(m.body.replace(/\s+/g, ' '));
    if (!t) return undefined;
    return { anbieter: 'anthropic', guthaben: betrag(t[1]!), zeit: m.date, mailId: m.id };
  }
  return undefined;
}

export const anbieterVonModell = (modell: string): GuthabenAnbieter | undefined =>
  /^(gpt-|o\d|text-embedding|chatgpt)/i.test(modell) ? 'openai' : /^claude-/i.test(modell) ? 'anthropic' : undefined;

export interface Schaetzung { anbieter: GuthabenAnbieter; rest: number; geladen: number; verbraucht: number; seit: string; grundlage: 'leer-ereignis' | 'kontostand' | 'letzte-ladung'; start: number; faktor: number; stundenRest?: number }

const ladungenZwischen = (l: Ladung[], a: GuthabenAnbieter, von: number, bis = Infinity) =>
  l.filter(x => x.anbieter === a && Date.parse(x.zeit) >= von && Date.parse(x.zeit) <= bis).reduce((s, x) => s + x.guthaben, 0);

/**
 * @param anker letzter bekannter Stand (leer oder genannt) oder undefined
 * @param kostenSeit gemessene Kosten (USD) des Anbieters ab einem Zeitpunkt
 * @param verbrauchProStunde gemessener Durchschnitt der letzten 24 h (USD/h), wird mit dem Faktor hochgerechnet
 * @param faktor tatsächlicher/gemessener Verbrauch (≥ 1)
 */
export function schaetze(anbieter: GuthabenAnbieter, ladungen: Ladung[], anker: Anker | undefined, kostenSeit: (iso: string) => number, verbrauchProStunde: number, faktor = 1): Schaetzung | undefined {
  const eigene = ladungen.filter(l => l.anbieter === anbieter).sort((a, b) => Date.parse(a.zeit) - Date.parse(b.zeit));
  let seit: string; let geladen: number; let start: number; let grundlage: Schaetzung['grundlage'];
  if (anker) {
    geladen = ladungenZwischen(ladungen, anbieter, Date.parse(anker.zeit));
    if (anker.art === 'leer' && geladen === 0) return undefined; // leer und noch nicht aufgeladen — meldet der Wächter
    seit = anker.zeit; start = anker.betrag; grundlage = anker.art === 'leer' ? 'leer-ereignis' : 'kontostand';
  } else {
    const letzte = eigene[eigene.length - 1];
    if (!letzte) return undefined;
    seit = letzte.zeit; geladen = letzte.guthaben; start = 0; grundlage = 'letzte-ladung';
  }
  const verbraucht = Math.round(kostenSeit(seit) * faktor * 100) / 100;
  const rest = Math.round((start + geladen - verbraucht) * 100) / 100;
  const proStunde = verbrauchProStunde * faktor;
  return { anbieter, rest, geladen, verbraucht, seit, grundlage, start, faktor, ...(proStunde > 0 ? { stundenRest: Math.max(0, rest) / proStunde } : {}) };
}

/**
 * v1727 — Korrekturfaktor aus zwei bekannten Ständen: tatsächlicher Verbrauch (Start + Ladungen − neuer Stand) geteilt durch den
 * gemessenen. Nur bei genug Verbrauch (≥ 2 $), begrenzt auf 1…2; mit dem bisherigen Faktor geglättet.
 */
export function neuerFaktor(vorher: Anker, neu: { betrag: number; zeit: string }, ladungen: Ladung[], anbieter: GuthabenAnbieter, gemessen: number, alterFaktor = 1): number {
  const tatsaechlich = vorher.betrag + ladungenZwischen(ladungen, anbieter, Date.parse(vorher.zeit), Date.parse(neu.zeit)) - neu.betrag;
  if (gemessen < 2 || tatsaechlich <= 0) return alterFaktor;
  const f = Math.min(2, Math.max(1, tatsaechlich / gemessen));
  return Math.round(((alterFaktor === 1 ? f : (f + alterFaktor) / 2)) * 1000) / 1000;
}

/** Warnen, wenn das Guthaben beim aktuellen Verbrauch weniger als `stunden` reicht oder unter `mindestUsd` liegt */
export function warnen(s: Schaetzung, stunden = 12, mindestUsd = 3): boolean {
  return s.rest < mindestUsd || (s.stundenRest !== undefined && s.stundenRest < stunden);
}

/** USD netto → Euro brutto (MwSt.) zum Kurs USD je EUR (EZB) */
export function bruttoEur(usd: number, usdJeEur: number, mwst = MWST): number {
  return Math.round((usd * (1 + mwst) / usdJeEur) * 100) / 100;
}

export function warnText(s: Schaetzung, usdJeEur?: number): string {
  const name = s.anbieter === 'openai' ? 'OpenAI' : 'Anthropic';
  const reicht = s.stundenRest !== undefined ? `, reicht beim Verbrauch der letzten 24 h noch etwa ${s.stundenRest < 1 ? 'unter 1' : Math.round(s.stundenRest)} h` : '';
  const basis = s.grundlage === 'kontostand' ? `ab deinem genannten Stand ${s.start.toFixed(2)} $` : s.grundlage === 'leer-ereignis' ? 'seit dem letzten leeren Stand' : 'nur aus der letzten Ladung (früherer Rest unbekannt)';
  const faktor = s.faktor > 1 ? `, Verbrauch inkl. Korrektur ×${s.faktor.toFixed(2)} für nicht gemessene Nutzung` : '';
  const eur = usdJeEur ? ` (Aufladen z. B. 50 $ ≈ ${bruttoEur(50, usdJeEur).toFixed(2)} € brutto)` : '';
  return `💳 ${name}-Guthaben geschätzt noch ${s.rest.toFixed(2)} $${reicht} — geladen ${s.geladen.toFixed(2)} $, verbraucht ${s.verbraucht.toFixed(2)} $ (${basis}${faktor}). Bitte aufladen oder Auto-Aufladung prüfen${eur}. Aktuellen Stand nennen mit z. B. „${name} Guthaben 12,34“.`;
}

/** v1727 — „OpenAI Guthaben 2,07“ / „Guthaben Anthropic: 13.94 $“ → Kontostand (deterministisch, ohne Modell) */
export function guthabenEingabe(text: string): { anbieter: GuthabenAnbieter; betrag: number } | undefined {
  const t = (text ?? '').trim();
  const m = /^(?:guthaben\s+(openai|anthropic)|(openai|anthropic)[\s-]*guthaben)\s*[:=]?\s*\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:\$|usd)?\.?$/i.exec(t);
  if (!m) return undefined;
  return { anbieter: (m[1] ?? m[2])!.toLowerCase() as GuthabenAnbieter, betrag: Number.parseFloat(m[3]!.replace(',', '.')) };
}

/** v1727 — EZB-Referenzkurs USD je EUR aus eurofxref-daily.xml */
export function leseEzbKurs(xml: string): number | undefined {
  const m = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml);
  const k = m ? Number.parseFloat(m[1]!) : NaN;
  return Number.isFinite(k) && k > 0.5 && k < 3 ? k : undefined;
}
