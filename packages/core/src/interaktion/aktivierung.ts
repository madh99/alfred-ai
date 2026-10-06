/**
 * v1252 — Aktivierungswort für das Zuhören ohne Taste (Owner-Wunsch 07.10., wie Alexa/Siri).
 *
 * Rein und deterministisch auf dem transkribierten Text: Beginnt die Äußerung mit dem Wort (tolerant gegen
 * Transkriptionsvarianten wie „Alfried", „Alfred,"), gilt der Rest als Nachricht. Innerhalb eines Gesprächsfensters
 * nach einer Antwort braucht es kein Wort. Ein Stoppwort („Alfred, stopp") bricht die Wiedergabe ab.
 */
export interface AktivierungsErgebnis {
  art: 'nachricht' | 'nur_wort' | 'stopp' | 'ignoriert';
  text: string;
}

export const STOPPWOERTER = ['stopp', 'stop', 'halt', 'ruhe', 'sei still', 'danke das reicht'];

function normalisiere(s: string): string {
  return s.toLowerCase().replace(/[„“"'’.,!?;:…]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Levenshtein-Abstand, klein und ausreichend für Wortvergleiche. */
export function abstand(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function passtWort(token: string, wort: string): boolean {
  if (token === wort) return true;
  const toleranz = wort.length >= 6 ? 2 : wort.length >= 4 ? 1 : 0;
  return abstand(token, wort) <= toleranz;
}

export function pruefeAktivierung(transkript: string, aktivierungswort: string, imGespraechsfenster: boolean): AktivierungsErgebnis {
  const norm = normalisiere(transkript);
  if (!norm) return { art: 'ignoriert', text: '' };
  const wort = normalisiere(aktivierungswort) || 'alfred';
  const tokens = norm.split(' ');
  let rest = norm;
  let mitWort = false;
  // Wort darf an Position 1 stehen, oder an Position 2 nach einem Füllwort („hey alfred", „ok alfred")
  if (passtWort(tokens[0], wort)) { mitWort = true; rest = tokens.slice(1).join(' '); }
  else if (tokens.length > 1 && ['hey', 'he', 'hallo', 'ok', 'okay', 'du'].includes(tokens[0]) && passtWort(tokens[1], wort)) { mitWort = true; rest = tokens.slice(2).join(' '); }
  if (!mitWort && !imGespraechsfenster) return { art: 'ignoriert', text: transkript.trim() };
  const restNorm = rest.trim();
  if (STOPPWOERTER.some(w => restNorm === w || restNorm.startsWith(w + ' '))) return { art: 'stopp', text: restNorm };
  if (mitWort && !restNorm) return { art: 'nur_wort', text: '' };
  // Originaltext ohne das Wort am Anfang (Groß-/Kleinschreibung und Satzzeichen bleiben erhalten)
  let original = transkript.trim();
  if (mitWort) {
    const m = /^(?:(?:hey|he|hallo|ok|okay|du)[\s,]+)?[^\s,.!?]+[\s,.!?]*/i.exec(original);
    if (m) original = original.slice(m[0].length);
    original = original.replace(/^[\s,.!?]+/, '');
    if (original) original = original[0].toUpperCase() + original.slice(1);
  }
  return { art: 'nachricht', text: original };
}
