import type { Logger } from 'pino';

/**
 * Jarvis Schicht 2 — Ereignisgetriebene Wahrnehmung, Teil 1: Zustandswechsel.
 *
 * Nicht jede Beobachtung ist ein Ereignis. Ein Ereignis ist, wenn das Weltmodell
 * (Schicht 1) ein Objekt NEU als auffällig einstuft — oder eine Auffälligkeit
 * verschwindet. Der erste Lauf je Quelle bildet die Baseline (kein Ereignis;
 * Bestand ist Bestand). Auf ein Ereignis folgt ein Mini-Pass: ein LLM-Aufruf
 * mit dem betroffenen Ausschnitt des Weltmodells, nicht der Vollkontext.
 */

export interface Zustandswechsel { quelle: string; neu: string[]; weg: string[] }

export class ZustandsWechselErkenner {
  private readonly vorher = new Map<string, Set<string>>();

  /** Liefert den Wechsel gegenüber dem letzten Lauf; beim ersten Lauf je Quelle undefined (Baseline). */
  vergleiche(quelle: string, auffaellig: string[]): Zustandswechsel | undefined {
    const jetzt = new Set(auffaellig);
    const alt = this.vorher.get(quelle);
    this.vorher.set(quelle, jetzt);
    if (!alt) return undefined;
    const neu = [...jetzt].filter(x => !alt.has(x));
    const weg = [...alt].filter(x => !jetzt.has(x));
    if (neu.length === 0 && weg.length === 0) return undefined;
    return { quelle, neu, weg };
  }

  hatBaseline(quelle: string): boolean { return this.vorher.has(quelle); }
}

export interface WeltmodellEreignis {
  quelle: string;
  typ: 'zustandswechsel';
  beschreibung: string;
  /** Der betroffene Ausschnitt des Weltmodells (gedeutete Zeilen der Quelle). */
  ausschnitt: string[];
  /** Objekt-Schlüssel, die neu auffällig sind (setzen generische Korrekturen aus). */
  objekte: string[];
}

/** Objekt-Schlüssel der Deutungen → Gate-Objekte (DIREKT_OBJEKTE-Vokabular), z. B. „mqtt". */
export function gateObjekteAus(auffaellig: string[]): string[] {
  const out = new Set<string>();
  for (const a of auffaellig) {
    const l = a.toLowerCase();
    if (l.includes('mqtt') || l.startsWith('stream')) out.add('mqtt');
    if (l.startsWith('mikrotik:')) out.add('mikrotik');
    if (l.startsWith('pv:') || l.startsWith('hausbatterie:')) out.add('victron');
  }
  return [...out];
}

/** Beobachtet Deutungen je Quelle und meldet neue Auffälligkeiten als Ereignis. */
export class WeltmodellBeobachter {
  private readonly erkenner = new ZustandsWechselErkenner();
  constructor(private readonly logger: Logger, private readonly melde: (e: WeltmodellEreignis) => Promise<void>) {}

  async beobachte(quelle: string, deutung: { zeilen: string[]; auffaellig: string[] } | undefined): Promise<Zustandswechsel | undefined> {
    if (!deutung) return undefined;
    const w = this.erkenner.vergleiche(quelle, deutung.auffaellig);
    if (!w) return undefined;
    this.logger.info({ quelle, neu: w.neu, weg: w.weg }, 'v1175 Zustandswechsel im Weltmodell');
    if (w.neu.length > 0) {
      try {
        await this.melde({
          quelle, typ: 'zustandswechsel',
          beschreibung: `Neu auffällig in ${quelle}: ${w.neu.join(', ')}${w.weg.length ? ` · wieder normal: ${w.weg.join(', ')}` : ''}`,
          ausschnitt: deutung.zeilen,
          objekte: [...new Set([...w.neu, ...gateObjekteAus(w.neu)])],
        });
      } catch (err) { this.logger.warn({ err: (err as Error).message, quelle }, 'v1175 Mini-Pass konnte nicht ausgelöst werden'); }
    }
    return w;
  }
}

/** Prompt des Mini-Passes — nur Ausschnitt, Ereignis, Datum und Korrekturen. Rein, testbar. */
export function baueMiniPassPrompt(e: { beschreibung: string; quelle: string; ausschnitt: string[]; datum: string; korrekturen: string[] }): string {
  const korr = e.korrekturen.length ? `\nUSER-KORREKTUREN (gelten absolut):\n${e.korrekturen.map(k => `- ${k}`).join('\n')}\n` : '';
  return `Du bist Alfreds Denk-Modul. Das Weltmodell meldet einen ZUSTANDSWECHSEL.

DATUM/ZEIT: ${e.datum}
QUELLE: ${e.quelle}
EREIGNIS: ${e.beschreibung}

GEDEUTETER ZUSTAND (deterministisch, bereits bewertet — Zeilen mit „NORMAL" sind kein Thema):
${e.ausschnitt.map(z => `- ${z}`).join('\n')}
${korr}
Aufgabe: Formuliere höchstens 2 Stichpunkte für den Owner — NUR zu den als ⚠️ markierten Punkten,
mit konkreter Handlung (prüfen / tauschen / planen). Keine Wiederholung von NORMAL-Zeilen,
keine Vermutungen über Ursachen, keine Rohzahlen ohne Bedeutung.
Wenn nichts Handlungsrelevantes übrig bleibt: antworte exakt KEINE_INSIGHTS.`;
}
