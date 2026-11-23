/**
 * v1937 — L1 erster Helfer (Owner 23.11., Auswertung Block 26.10.): zwei häufige Change-Befehle ohne Sprachmodell.
 * Nur der ganze Satz zählt (kein Beiwerk), nur „wiederholen“ und „Status“ — abbrechen, Rückweg und überspringen bleiben
 * beim Modell, weil sie die ausdrücklichen Worte des Owners als Wortlaut brauchen.
 */
export type ChangeBefehl = { art: 'wiederholen' | 'status'; id: string };

const ID = '([0-9a-f]{8})';
const WIEDERHOLEN = new RegExp(`^change\\s+${ID}\\s+(?:schritt\\s+(?:\\d+\\s+)?)?wiederholen[.!]?$`, 'i');
const STATUS_VORN = new RegExp(`^(?:status|stand)\\s+(?:von\\s+|des\\s+)?change\\s+${ID}\\s*\\??$`, 'i');
const STATUS_HINTEN = new RegExp(`^change\\s+${ID}\\s+(?:status|stand)\\s*\\??$`, 'i');

export function changeBefehl(text: string): ChangeBefehl | null {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  if (t.length > 80) return null;
  const w = t.match(WIEDERHOLEN);
  if (w) return { art: 'wiederholen', id: w[1]!.toLowerCase() };
  const s = t.match(STATUS_VORN) ?? t.match(STATUS_HINTEN);
  if (s) return { art: 'status', id: s[1]!.toLowerCase() };
  return null;
}
