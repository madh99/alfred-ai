/**
 * Spec Stufe ultra U2.2 — Gegenprüfung vor der Freigabe: Ein Change mit Risiko high oder critical wird vor der ersten
 * Freigabe-Frage einmal von der Stufe ultra gelesen. ultra schreibt nichts um, es liefert nur Befunde (fehlender Rückweg,
 * falsche Reihenfolge, Prüfung passt nicht zur Aktion, Risiko unterschätzt, …). Befunde werden zu Einwänden mit Quelle
 * „ultra“: der Change geht in den Entwurf, das planende Modell muss jeden beantworten (umgesetzt / abgelehnt, weil …),
 * die Antworten stehen in der Freigabe-Frage. Feste Prüfungen im Code laufen vorher; ultra ist für das, was sich nicht als
 * Regel fassen lässt. Deterministisch ist nur der Auslöser (Risiko), nie eine Einschätzung des Modells.
 */

export const GEGENPRUEFUNG_RISIKEN = new Set(['high', 'critical']);
export const ULTRA_QUELLE = 'ultra';
const MAX_BEFUNDE = 8;

export interface UltraBefund { bezug: string; text: string }

/** Systemprompt: schlank (nur Rolle, Prüfliste, bekannte Fehlerbilder, Ausgabeform) — nicht der volle Chat-Prompt. */
export const GEGENPRUEFUNG_SYSTEM = [
  'Du prüfst als zweite, unabhängige Instanz den Ausführungsplan eines Infrastruktur-Changes, bevor der Owner ihn freigibt.',
  'Ein Ausführungsmotor arbeitet die Schritte der Reihe nach ab: jeder Schritt ruft einen Baustein (skill.aktion mit Parametern) auf,',
  'danach läuft seine Prüfung (Erwartungstext = case-sensitives Teilstück der Ausgabe bzw. Datenwert). Scheitert ein Schritt, gilt „bei Fehler“',
  '(anhalten oder Rückweg). Formale Regeln (Schema, bekannte feste Ausgaben, Verweise, Zugänge, Tresor-Namen) hat der Code bereits geprüft — wiederhole sie nicht.',
  '',
  'Suche nur echte, konkrete Mängel, die den Change scheitern lassen oder Schaden anrichten können:',
  '- ein ändernder Schritt ohne passenden Rückweg, oder ein Rückweg, der den Zustand nicht wirklich wiederherstellt',
  '- falsche Reihenfolge (etwas wird benutzt, bevor es angelegt, freigegeben oder erreichbar ist; Abbau vor der Sicherung)',
  '- eine Prüfung, die nicht belegt, was der Schritt bewirken soll, oder die trotz Erfolg nie zutreffen kann',
  '- ein unterschätztes Risiko oder ein fehlender Ausfall-/Sicherungshinweis für produktive Systeme',
  '- Werte, die nicht zusammenpassen (Namen, Adressen, IDs, Ports zwischen Schritten)',
  'Bekannte Fehlerbilder aus dem Betrieb: Erwartungstexte in anderer Schreibweise als die Ausgabe; Warte- und Prüfschritte mit zu kurzer Zeitgrenze',
  'für lange Vorgänge; ein frisch geklontes Windows ohne Online-Aktivierung; Schritte, die einen Dienst neu starten, ohne danach seine Erreichbarkeit zu prüfen.',
  '',
  'Keine Stilfragen, keine Vorschläge „wäre schön“, keine Wiederholung des Plans. Ein guter Plan hat keine Befunde.',
  `Antworte NUR mit JSON: {"befunde":[{"bezug":"Schritt N" oder "gesamt","text":"Mangel und Folge in 1–2 Sätzen"}]} — höchstens ${MAX_BEFUNDE}, leere Liste, wenn nichts zu beanstanden ist.`,
].join('\n');

export function gegenpruefungNoetig(risiko: string | undefined): boolean {
  return GEGENPRUEFUNG_RISIKEN.has(String(risiko ?? '').toLowerCase());
}

export function gegenpruefungFrage(c: { id: string; title: string; riskLevel: string }, plan: Record<string, unknown>): string {
  return `Change ${c.id.slice(0, 8)} „${c.title}“ (Risiko ${c.riskLevel}). Gespeicherter Plan:\n\n${JSON.stringify(plan, null, 1)}`;
}

/**
 * Antwort lesen. Unlesbar → undefined (fail-closed: der Aufrufer stellt dann keine Freigabe-Frage).
 * Akzeptiert JSON auch innerhalb eines Code-Blocks oder mit Text davor/danach.
 */
export function leseBefunde(antwort: string): UltraBefund[] | undefined {
  const t = antwort.trim();
  const start = t.indexOf('{'); const ende = t.lastIndexOf('}');
  if (start < 0 || ende <= start) return undefined;
  let roh: unknown;
  try { roh = JSON.parse(t.slice(start, ende + 1)); } catch { return undefined; }
  const liste = (roh as { befunde?: unknown })?.befunde;
  if (!Array.isArray(liste)) return undefined;
  const aus: UltraBefund[] = [];
  for (const b of liste) {
    const o = (b ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (text.length < 5) continue;
    const bezug = typeof o.bezug === 'string' && o.bezug.trim() ? o.bezug.trim().slice(0, 60) : 'gesamt';
    aus.push({ bezug, text: text.slice(0, 600) });
    if (aus.length >= MAX_BEFUNDE) break;
  }
  return aus;
}

/**
 * Vermerk je Change: gilt nur für den geprüften Plan (Fingerabdruck). Ändert sich der Plan danach (z. B. Befund umgesetzt),
 * wird neu geprüft — höchstens MAX_GEGENPRUEFUNGEN-mal je Change; danach sagt die Freigabe-Frage offen, dass die letzte
 * Fassung nicht gegengeprüft ist (der Owner entscheidet mit diesem Wissen).
 */
export interface GegenpruefungVermerk { fingerabdruck: string; befunde: number; modell?: string; zeit: string; pruefungen?: number }
export const MAX_GEGENPRUEFUNGEN = 3;

export function vermerkText(v: GegenpruefungVermerk): string {
  const nr = (v.pruefungen ?? 1) > 1 ? ` (${v.pruefungen}. Prüfung, nach Überarbeitung)` : '';
  return v.befunde === 0 ? `Von ultra gegengeprüft${nr}: keine Befunde.` : `Von ultra gegengeprüft${nr}: ${v.befunde} ${v.befunde === 1 ? 'Befund' : 'Befunde'} (Antworten unten).`;
}

export function grenzeText(v: GegenpruefungVermerk): string {
  return `⚠️ Von ultra ${v.pruefungen ?? 1}× gegengeprüft, der Plan wurde danach noch einmal geändert — Grenze von ${MAX_GEGENPRUEFUNGEN} Prüfungen je Change erreicht, diese Fassung ist NICHT gegengeprüft.`;
}
