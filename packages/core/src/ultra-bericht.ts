/**
 * Spec Stufe ultra U3 — Tagesbericht der Stufe ultra: Anzahl, Auslöser und Kosten. Nur an Tagen mit ultra-Nutzung
 * (kein Bericht ohne Inhalt). Das Tagesbudget gilt weiter gesamt; ultra ist darin enthalten.
 */
export interface UltraSumme { grund: string; aufrufe: number; kostenUsd: number; rueckfaelle: number }

const usd = (n: number) => `${n.toFixed(2).replace('.', ',')} $`;

/** Lesbarer Auslöser: `gegenpruefung:<id>` → „Gegenprüfung <id8>“, `eskalation:<grund>` → „Eskalation (<grund>)“ */
export function ausloeserText(grund: string): string {
  if (grund === 'ausdrücklich') return 'ausdrücklich gewählt';
  if (grund.startsWith('gegenpruefung:')) return `Gegenprüfung ${grund.slice('gegenpruefung:'.length).slice(0, 8)}`;
  if (grund.startsWith('eskalation:')) {
    const g = grund.slice('eskalation:'.length);
    // Spec ultra U4 — lesbar auch in der App-Anzeige „Modell · Gründlichkeit · Auslöser“
    const text = g === 'einwand' ? 'Einwand' : g === 'planpruefung' ? 'Planprüfung 2× abgelehnt' : g.startsWith('korrektur:') ? `Korrektur ${g.slice('korrektur:'.length)}` : g;
    return `Eskalation (${text})`;
  }
  if (grund === 'ohne-ausloeser') return 'ohne Auslöser (Fehler im Einstiegspunkt)';
  return grund;
}

export function ultraKennzahlen(s: UltraSumme[]): { ultraAufrufe: number; ultraKostenUsd: number; ultraRueckfaelle: number } {
  return {
    ultraAufrufe: s.reduce((a, b) => a + b.aufrufe, 0),
    ultraKostenUsd: Math.round(s.reduce((a, b) => a + b.kostenUsd, 0) * 10_000) / 10_000,
    ultraRueckfaelle: s.reduce((a, b) => a + b.rueckfaelle, 0),
  };
}

/** Text des Tagesberichts oder undefined, wenn ultra an diesem Tag nicht lief. */
export function ultraTagesbericht(tag: string, s: UltraSumme[]): string | undefined {
  const k = ultraKennzahlen(s);
  if (k.ultraAufrufe === 0) return undefined;
  const posten = [...s].sort((a, b) => b.kostenUsd - a.kostenUsd)
    .map(x => `- ${ausloeserText(x.grund)}: ${x.aufrufe} ${x.aufrufe === 1 ? 'Aufruf' : 'Aufrufe'}, ${usd(x.kostenUsd)}`);
  return [
    `Stufe ultra am ${tag}: ${k.ultraAufrufe} ${k.ultraAufrufe === 1 ? 'Aufruf' : 'Aufrufe'}, ${usd(k.ultraKostenUsd)}`,
    ...posten,
    ...(k.ultraRueckfaelle > 0 ? [`Rückfall auf eine andere Stufe: ${k.ultraRueckfaelle}×`] : []),
  ].join('\n');
}
