/**
 * v1726 — Guthaben-Schätzung der LLM-Konten (Owner 01.11.: „funktioniert, da E-Mails mit dem aufgeladenen Betrag kommen“).
 * Weder OpenAI noch Anthropic liefern den Kontostand per API. Ausgangspunkt ist deshalb das letzte Ereignis „Guthaben leer“
 * (Stand dort nachweislich 0): Ladungen danach minus die von Alfred gemessenen Kosten seither. Ohne bekanntes Leer-Ereignis zählt
 * vorsichtig nur die letzte Ladung. Rein und ohne Modell; Erkennung der Ladungen über feste Absender-/Betreffmuster.
 */

export type GuthabenAnbieter = 'openai' | 'anthropic';
export interface Ladung { anbieter: GuthabenAnbieter; guthaben: number; zeit: string; mailId: string }

/** MwSt. auf OpenAI-Ladungen: die Mail nennt nur den Kartenbetrag („We charged $24.00“ = 20 $ Guthaben + 20 % MwSt., Österreich) */
export const OPENAI_MWST = 0.2;

const betrag = (s: string) => Number.parseFloat(s.replace(/,/g, ''));

/** Erkennt eine Guthaben-Ladung (keine Abo-Rechnung) und liefert den Guthabenbetrag in USD ohne Steuer */
export function leseLadung(m: { id: string; from: string; subject: string; body: string; date: string }, mwstOpenai = OPENAI_MWST): Ladung | undefined {
  const von = m.from.toLowerCase();
  if (von.includes('@tm.openai.com') && /openai api account has been funded/i.test(m.subject)) {
    const t = /we charged \$\s?([\d.,]+)/i.exec(m.body);
    if (!t) return undefined;
    return { anbieter: 'openai', guthaben: Math.round((betrag(t[1]!) / (1 + mwstOpenai)) * 100) / 100, zeit: m.date, mailId: m.id };
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

export interface Schaetzung { anbieter: GuthabenAnbieter; rest: number; geladen: number; verbraucht: number; seit: string; grundlage: 'leer-ereignis' | 'letzte-ladung'; stundenRest?: number }

/**
 * @param leerSeit Zeitpunkt des letzten Guthaben-Fehlers (Stand 0) oder undefined
 * @param kostenSeit Kosten (USD) des Anbieters ab einem Zeitpunkt
 * @param verbrauchProStunde Durchschnitt der letzten 24 h (USD/h)
 */
export function schaetze(anbieter: GuthabenAnbieter, ladungen: Ladung[], leerSeit: string | undefined, kostenSeit: (iso: string) => number, verbrauchProStunde: number): Schaetzung | undefined {
  const eigene = ladungen.filter(l => l.anbieter === anbieter).sort((a, b) => Date.parse(a.zeit) - Date.parse(b.zeit));
  let seit: string; let geladen: number; let grundlage: Schaetzung['grundlage'];
  if (leerSeit) {
    const danach = eigene.filter(l => Date.parse(l.zeit) >= Date.parse(leerSeit));
    if (!danach.length) return undefined; // leer und noch nicht aufgeladen — meldet der Wächter
    seit = leerSeit; geladen = danach.reduce((s, l) => s + l.guthaben, 0); grundlage = 'leer-ereignis';
  } else {
    const letzte = eigene[eigene.length - 1];
    if (!letzte) return undefined;
    seit = letzte.zeit; geladen = letzte.guthaben; grundlage = 'letzte-ladung';
  }
  const verbraucht = Math.round(kostenSeit(seit) * 100) / 100;
  const rest = Math.round((geladen - verbraucht) * 100) / 100;
  return { anbieter, rest, geladen, verbraucht, seit, grundlage, ...(verbrauchProStunde > 0 ? { stundenRest: Math.max(0, rest) / verbrauchProStunde } : {}) };
}

/** Warnen, wenn das Guthaben beim aktuellen Verbrauch weniger als `stunden` reicht oder unter `mindestUsd` liegt */
export function warnen(s: Schaetzung, stunden = 12, mindestUsd = 3): boolean {
  return s.rest < mindestUsd || (s.stundenRest !== undefined && s.stundenRest < stunden);
}

export function warnText(s: Schaetzung): string {
  const name = s.anbieter === 'openai' ? 'OpenAI' : 'Anthropic';
  const reicht = s.stundenRest !== undefined ? `, reicht beim Verbrauch der letzten 24 h noch etwa ${s.stundenRest < 1 ? 'unter 1' : Math.round(s.stundenRest)} h` : '';
  const basis = s.grundlage === 'leer-ereignis' ? 'seit dem letzten leeren Stand' : 'nur aus der letzten Ladung (früherer Rest unbekannt)';
  return `💳 ${name}-Guthaben geschätzt noch ${s.rest.toFixed(2)} $${reicht} — geladen ${s.geladen.toFixed(2)} $, verbraucht ${s.verbraucht.toFixed(2)} $ (${basis}). Bitte aufladen oder Auto-Aufladung prüfen.`;
}
