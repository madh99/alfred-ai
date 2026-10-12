/**
 * v1362 — Spec „Entscheiden statt Abhaken" (E1/E2, Owner 12.10. „ok wie empfohlen"): reine Regeln ohne Datenbank.
 *
 * - Vorgang ↔ Befund: Befund-Vorgänge tragen den Schlüssel `befund:<quelle>:<gegenstand>` (v1217).
 * - Nie stummschaltbar (Owner-Entscheidung 5): Rauch, CO, Wasser/Leck, Alarm, Einbruch/Sabotage, Alfreds eigener Ausfall.
 * - Haltefristen (Owner-Entscheidung 2), in E2 nur BEOBACHTEND: Sicherheit sofort, Ausfall 2 h, Batterie 24 h,
 *   Abweichung vom üblichen Wert 24 h, Haus-Check kein Vorgang.
 * - Regelvorschlag (Owner-Entscheidung 4 + „übernehmen können"): ab dem dritten „kein Problem" zum selben Befund.
 */

export interface BefundSchluessel { quelle: string; gegenstand: string }

/** `befund:energie:hausbatterie:baseline` → { quelle: energie, gegenstand: hausbatterie:baseline } */
export function befundSchluesselAus(dedupeKey: string | undefined): BefundSchluessel | null {
  if (!dedupeKey?.startsWith('befund:')) return null;
  const rest = dedupeKey.slice('befund:'.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { quelle: rest.slice(0, i), gegenstand: rest.slice(i + 1) };
}

const SICHERHEIT = /(rauch|smoke|carbon_monoxide|(^|[:._])co([:._]|$)|wasser|moisture|leck|leak|alarm|einbruch|sabotage|tamper|intrusion)/i;

/**
 * v1368 — dieselben Kategorien für Hinweis-Texte (Prosa): nie durch eine Korrektur unterdrückbar (Owner 12.10.: „nie
 * stummschaltbar: Rauch, CO, Wasser/Leck, Alarm, Einbruch/Sabotage"). Realfall 06.10.: „BMW steht seit 15:40 unverriegelt"
 * wurde von der Korrektur „BMW-Token erledigt" geschluckt. Fahrzeug/Haus offen oder unverriegelt gehört dazu.
 */
const SICHERHEIT_TEXT = /\b(unverriegelt|entriegelt|nicht (ab|ver)geschlossen|aufgebrochen|rauch\w*|kohlenmonoxid|co-?(melder|alarm)|wasser(alarm|schaden|leck|austritt)|leck\w*|einbruch\w*|sabotage|alarm(anlage)? (ausgelöst|löst aus)|alarm ausgelöst)\b/i;
export function istSicherheitsText(text: string): boolean {
  return SICHERHEIT_TEXT.test(text);
}

/** Owner-Entscheidung 5 — hier darf keine Regel eine echte Gefahr oder Alfreds eigenen Ausfall verdecken. */
export function nieStummschaltbar(s: BefundSchluessel): boolean {
  return s.quelle === 'lebenszeichen' || SICHERHEIT.test(`${s.quelle}:${s.gegenstand}`);
}

/** Haltefrist in Minuten, bis aus einem Befund ein Vorgang würde; null = nie ein Vorgang (Haus-Check). */
export function haltefristMin(s: BefundSchluessel): number | null {
  if (s.quelle === 'haus-check') return null;
  if (nieStummschaltbar(s)) return 0;
  const g = s.gegenstand.toLowerCase();
  if (/baseline/.test(g)) return 24 * 60;
  if (/batter|akku|:leer|niedrig|low/.test(g) || s.quelle === 'sensorbatterien') return 24 * 60;
  if (/offline|ausgefallen|nicht.?verbunden|unavailable|down|stream|erreichbar/.test(g)) return 120;
  return 120;
}

export const REGEL_VORSCHLAG_AB = 3;
export const STUMM_TAGE = [7, 30, 90] as const;
export const STUMM_STANDARD_TAGE = 30;

/** Regel in einem Satz (App, Lage, Logzeile). */
export function regelText(r: { titel: string; wirkung: 'stumm' | 'immer_fragen'; bis?: string }, jetzt = new Date()): string {
  if (r.wirkung === 'immer_fragen') return `${r.titel}: jedes Mal fragen`;
  if (!r.bis) return `${r.titel}: nicht melden`;
  const bis = new Date(r.bis);
  const datum = `${String(bis.getDate()).padStart(2, '0')}.${String(bis.getMonth() + 1).padStart(2, '0')}.`;
  return bis.getTime() > jetzt.getTime() ? `${r.titel}: nicht melden bis ${datum}` : `${r.titel}: abgelaufen am ${datum}`;
}
