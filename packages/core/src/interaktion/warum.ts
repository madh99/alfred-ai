/**
 * Jarvis — Interaktion, Teil 1: „Warum?"
 *
 * Spezifikation: „Standard knapp, ‚Warum?' liefert die Kette Daten → Deutung →
 * Entscheidung." Jede proaktive Meldung bekommt eine deterministische Begründung,
 * die NICHT vom Modell stammt: welcher Pass (Vollpass/Mini-Pass/Ereignis), welcher
 * Auslöser (geänderte Sektion mit erster abweichender Zeile, Zustandswechsel),
 * welche Gate-Aussetzungen, welche Zustellung. Der Owner fragt „warum?" und bekommt
 * die letzte Begründung — ohne LLM-Aufruf.
 */
export type PassArt = 'vollpass' | 'minipass' | 'ereignis';
export type Zustellung = 'gesendet' | 'aufgeschoben' | 'still';

export interface PassBegruendung {
  zeit: string;
  art: PassArt;
  /** z. B. „cmdb: 2 offen → 0 offen", „haus: Tür Terrasse offen", „erster Lauf nach Start" */
  ausloeser: string[];
  /** Korrektur-Schlüssel, deren Gate durch das Weltmodell ausgesetzt wurde */
  gateAusgesetzt: string[];
  /** Titel der zugestellten Insights (erste Zeile, ohne Markdown) */
  insights: string[];
  zustellung: Zustellung;
  /** v1198 — Grund der Zustellentscheidung (Chat aktiv, Ruhefenster, Bewegung im Haus, Profil …) */
  grund?: string;
  dauerMs?: number;
}

export const WARUM_RING_GROESSE = 20;

export class WarumSpeicher {
  private readonly ring: PassBegruendung[] = [];
  merke(b: PassBegruendung): void {
    this.ring.push(b);
    while (this.ring.length > WARUM_RING_GROESSE) this.ring.shift();
  }
  /** Jüngste zuerst. */
  letzte(n = 1): PassBegruendung[] {
    return this.ring.slice(-n).reverse();
  }
}

/** „warum?", „wieso das?", „warum diese meldung" — kurz und ohne weiteren Inhalt. */
export function istWarumFrage(text: string): boolean {
  return /^(warum|wieso|weshalb)(\s+(das|denn|jetzt|diese\s+meldung|diese\s+nachricht|der\s+hinweis))?\s*\?*\s*$/i.test((text ?? '').trim());
}

/** Erste Zeile eines Insights ohne Nummer, Markdown, Emoji und Schweregrad. */
export function insightTitel(insight: string): string {
  return insight.split('\n')[0]
    .replace(/\*\*|__|`/g, '')
    .replace(/\[(?:HIGH|URGENT|NORMAL|LOW|MEDIUM|KRITISCH|DRINGEND)\]\s*/gi, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim().slice(0, 120);
}

const ART_TEXT: Record<PassArt, string> = {
  vollpass: 'Vollpass (30-min-Rundgang mit fachlicher Änderung)',
  minipass: 'Mini-Pass (Zustandswechsel im Weltmodell)',
  ereignis: 'Ereignis-Pass (Watch, Kalender, Todo oder Skill-Ergebnis)',
};
const ZUSTELLUNG_TEXT: Record<Zustellung, string> = { gesendet: 'sofort gesendet', aufgeschoben: 'aufgeschoben (du warst nicht aktiv)', still: 'still abgelegt (unter der Schwelle)' };

function zeitKurz(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatiereWarum(b: PassBegruendung | undefined): string {
  if (!b) return 'Dazu habe ich keine Begründung gespeichert — seit dem letzten Neustart wurde noch nichts proaktiv gemeldet.';
  const zeilen = [`**Warum die Meldung von ${zeitKurz(b.zeit)}?**`, `Art: ${ART_TEXT[b.art]}`];
  zeilen.push(b.ausloeser.length ? `Auslöser: ${b.ausloeser.join(' · ')}` : 'Auslöser: keine einzelne Quelle (Vollpass nach Zeitablauf)');
  if (b.gateAusgesetzt.length) zeilen.push(`Gate ausgesetzt (Weltmodell meldete Auffälligkeit): ${b.gateAusgesetzt.join(', ')}`);
  if (b.insights.length) zeilen.push(`Gemeldet (${b.insights.length}): ${b.insights.map(t => `„${t}"`).join(', ')}`);
  zeilen.push(`Zustellung: ${ZUSTELLUNG_TEXT[b.zustellung]}${b.grund ? ` — Grund: ${b.grund}` : ''}${b.dauerMs ? ` · Dauer ${(b.dauerMs / 1000).toFixed(1)} s` : ''}`);
  zeilen.push('Die Deutung selbst stammt aus dem Weltmodell (Normalzustände je Quelle); die Formulierung vom Modell.');
  return zeilen.join('\n');
}
