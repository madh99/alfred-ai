/**
 * v1368 — Wann meldet eine geplante Aufgabe ihr Ergebnis? (Owner 12.10.: aWATTar-Rechnung kam nicht.)
 *
 * Bisher (März 2026): Stand im Prompt irgendwo „nichts", galt die Aufgabe als „still" und meldete nur Texte mit Fehlerwörtern
 * oder ⚠️/❌. Der aWATTar-Prompt enthält „… bereits verarbeitet: nichts erneut verarbeiten, nur kurz melden" — gemeint war
 * der Doppelschutz. Am 11.10. wurde die Rechnung 09/2026 vollständig verarbeitet, die Zusammenfassung aber verworfen; dass es
 * vorher klappte, lag an zufälligen Alarmwörtern in den (viermal täglichen) Statusmeldungen.
 *
 * Jetzt deterministisch:
 *  - Fehler des Laufs → melden.
 *  - Ausdrückliche Stille-Anweisung („antworte nichts, wenn …", „sonst keine Nachricht", „silent") → nur bei Alarm.
 *  - Sonst: melden, wenn der Text etwas NEUES enthält — Kennungen (Nummern ab 5 Stellen, Beträge in €), die in keiner
 *    gemeldeten Aufgabe der letzten 60 Tage vorkamen; ohne Kennungen wie bisher melden. „Keine neue Rechnung, letzte ist
 *    2026714680" wiederholt nur Bekanntes → still; eine neue Rechnungsnummer → immer gemeldet. Alarm wird immer gemeldet.
 */

/** Ausdrückliche Stille-Anweisung — nicht jedes „nichts" (Realfall: „nichts erneut verarbeiten"). */
const STILLE = /\b(antworte|antwort|melde|sende|schreibe?|gib)\b[^.\n]{0,40}\b(nichts|keine (antwort|nachricht|meldung|ausgabe))\b|\bsonst (nichts|keine (antwort|nachricht|meldung|ausgabe))\b|\b(silent|no\s*output|don'?t\s*respond|do\s*not\s*respond)\b|\bnur (bei|wenn)\b[^.\n]{0,60}\b(melden|antworten|benachrichtig\w*)\b/i;

export function istStilleAnweisung(prompt: string): boolean {
  return STILLE.test(prompt ?? '');
}

/** Problem-Anzeichen (Liste von März 2026, v1368 um „fehlgeschlagen" und „gescheitert" ergänzt). */
export function hatAlarm(text: string): boolean {
  return /offline|down|fehler|fehlgeschlagen|gescheitert|error|warn|critical|alert|fail|nicht\s+(erreichbar|verf[uü]gbar|gefunden|online)|ausgefallen|stopped|unreachable|unavailable|⚠|❌|🚨|🔴/i.test(text)
    && !/keine\s+(probleme|fehler|auff[aä]lligkeiten)/i.test(text);
}

const STARKER_ALARM = /fehlgeschlagen|failed|\berror\b|\bfehler\b|nicht\s+(erreichbar|verf[uü]gbar|online)|ausgefallen|unreachable|unavailable|🚨|🔴/i;

/** Kennungen eines Ergebnisses: Nummern ab 5 Stellen (Rechnung, Vertrag, Bestellung) und Beträge in Euro. */
export function kennungenAus(text: string): string[] {
  const k = new Set<string>();
  for (const m of text.matchAll(/(?<![\d.,])\d{5,}(?![\d.,])/g)) k.add(`n:${m[0]}`);
  for (const m of text.matchAll(/(\d{1,3}(?:[.\s]\d{3})*|\d+),(\d{2})\s?€|€\s?(\d{1,3}(?:[.\s]\d{3})*|\d+),(\d{2})/g)) {
    const euro = (m[1] ?? m[3] ?? '').replace(/[.\s]/g, ''); const cent = m[2] ?? m[4] ?? '';
    k.add(`€:${euro},${cent}`);
  }
  return [...k];
}

export interface MeldeEntscheidung { senden: boolean; grund: string; neu: string[] }

export function entscheideMeldung(e: { text: string; prompt: string; istFehler: boolean; bekannt: ReadonlySet<string> }): MeldeEntscheidung {
  const t = (e.text ?? '').trim();
  if (t.length < 3) return { senden: false, grund: 'leer', neu: [] };
  if (e.istFehler) return { senden: true, grund: 'Fehler des Laufs', neu: [] };
  const alarm = hatAlarm(t);
  if (istStilleAnweisung(e.prompt)) return { senden: alarm, grund: alarm ? 'still: Alarm' : 'still: kein Alarm', neu: [] };
  const kennungen = kennungenAus(t);
  if (kennungen.length === 0) return { senden: true, grund: 'ohne Kennungen', neu: [] };
  const neu = kennungen.filter(k => !e.bekannt.has(k));
  if (neu.length > 0) return { senden: true, grund: 'neue Kennungen', neu };
  // Ohne Neues nur ein echtes Problem melden — „❌ keine neue Rechnung gefunden" ist kein Problem (sonst täglich dieselbe Zeile)
  if (alarm && STARKER_ALARM.test(t)) return { senden: true, grund: 'Alarm', neu: [] };
  return { senden: false, grund: 'nichts Neues (alle Kennungen schon gemeldet)', neu: [] };
}
