/**
 * v1229 — Regeln der Browser-Hand (deterministisch, geteilt zwischen Gehirn, Satellit und Tests):
 * Kauf, Bestellung, Zahlung und Anmeldung bleiben beim Owner; die Element-Karte ist das
 * Vokabular, mit dem das Modell klickt und tippt.
 */
export const BROWSER_GESPERRT_URL = /checkout|payment|zahlung|kasse|\/buy\b|\/gp\/buy|bestell|order\b|signin|sign-in|login|anmeld|password|passwort|\bbank|paypal|kreditkarte|credit-?card/i;
export const BROWSER_GESPERRT_TEXT = /^(jetzt kaufen|buy now|kaufen|bestellung aufgeben|place (your )?order|zur kasse|proceed to checkout|checkout|jetzt bezahlen|pay now|anmelden|sign in|log ?in|einloggen|registrieren|register)$/i;

export interface BrowserElement { i: number; tag: string; text: string; href?: string; typ?: string }

export function istGesperrteUrl(url: string): boolean {
  const roh = url ?? '';
  if (BROWSER_GESPERRT_URL.test(roh)) return true;
  // Prozent-Kodierung und mehrfache Kodierung auflösen (Parser-Differenz Browser vs. Regex)
  let dekodiert = roh;
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(dekodiert); if (d === dekodiert) break; dekodiert = d; } catch { break; } }
  return BROWSER_GESPERRT_URL.test(dekodiert);
}
export function istGesperrteBeschriftung(text: string): boolean { return BROWSER_GESPERRT_TEXT.test((text ?? '').trim().replace(/\s+/g, ' ')); }

export function formatiereSeite(s: { url: string; titel: string; text: string; elemente?: BrowserElement[]; geklickt?: string }): string {
  const zeilen = [`${s.titel || '(ohne Titel)'} — ${s.url}`];
  if (s.geklickt) zeilen.push(`Geklickt: „${s.geklickt}"`);
  if (s.text) zeilen.push('', s.text);
  if (s.elemente && s.elemente.length) {
    zeilen.push('', `Elemente (${s.elemente.length}, zum Klicken/Tippen die Nummer verwenden):`);
    for (const e of s.elemente.slice(0, 80)) zeilen.push(`[${e.i}] ${e.tag}${e.typ ? ':' + e.typ : ''} ${e.text}${e.href ? ' → ' + e.href.slice(0, 60) : ''}`);
  }
  return zeilen.join('\n');
}
