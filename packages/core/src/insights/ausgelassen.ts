/**
 * v1489 — Bewusst Ausgelassenes (Owner 16.10.: „die Meldungen haben ihren Sinn, sind aber nicht für den User bestimmt“;
 * Freigabe „B und A wie empfohlen, Weglassbegründung nur im Protokoll“). Das Modell begründete zwischen den Insights, was es
 * nicht meldet und dass es sich an die Regeln hält; 39 von 293 Reasoning-Hinweisen (10.–16.10.) waren solche Sätze. Jetzt hat
 * es dafür einen eigenen Block nach den Insights. Was darin steht, geht nur ins Protokoll — nie in eine Meldung, nie in die
 * Hinweis-Sammlung.
 */
export const AUSGELASSEN_MARKER = '---AUSGELASSEN---';

/** Blockanfang: genauer Marker oder eine Überschrift „Ausgelassen“ (Modelle setzen Marker gern als Überschrift). */
const ANFANG = /^[ \t]*(?:-{3}[ \t]*AUSGELASSEN[ \t]*-{3}|#{1,4}[ \t]*\**[ \t]*ausgelassen[ \t]*:?[ \t]*\**|\*\*[ \t]*ausgelassen[ \t]*:?[ \t]*\*\*[ \t]*:?)[ \t]*$/im;
/** Blockende: der nächste Abschnitt (Aktionen, Topics) — der Block darf vor oder nach den Aktionen stehen. */
const ENDE = /^[ \t]*(?:-{3}[ \t]*[A-ZÄÖÜ]+[ \t]*-{3}|#{1,4}[ \t]*\**[ \t]*(?:🔧[ \t]*)?(?:aktionen|actions)\b.*|\*\*[ \t]*(?:aktionen|actions)[ \t]*:?[ \t]*\*\*.*)[ \t]*$/im;

/** Trennt den Block „Ausgelassen“ ab. `rest` ist die Antwort ohne ihn (Insights und Aktionen bleiben, wie sie waren). */
export function trenneAusgelassen(text: string): { rest: string; ausgelassen: string[] } {
  const a = ANFANG.exec(text);
  if (!a) return { rest: text, ausgelassen: [] };
  const start = a.index + a[0].length;
  const danach = text.slice(start);
  const e = ENDE.exec(danach);
  const block = e ? danach.slice(0, e.index) : danach;
  const rest = `${text.slice(0, a.index).trimEnd()}${e ? `\n\n${danach.slice(e.index).trimStart()}` : ''}`.trim();
  const ausgelassen = block.split('\n').map(z => z.replace(/^[\s\-*•\d.)]+/, '').replace(/\*\*/g, '').trim()).filter(z => z.length > 0);
  return { rest, ausgelassen };
}
