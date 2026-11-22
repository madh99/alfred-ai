/**
 * Spec Stufe ultra U2.2 — Gegenprüfung vor der Freigabe: Ein Change mit Risiko high oder critical wird vor der ersten
 * Freigabe-Frage einmal von der Stufe ultra gelesen. ultra schreibt nichts um, es liefert nur Befunde (fehlender Rückweg,
 * falsche Reihenfolge, Prüfung passt nicht zur Aktion, Risiko unterschätzt, …). Befunde werden zu Einwänden mit Quelle
 * „ultra“: der Change geht in den Entwurf, das planende Modell muss jeden beantworten (umgesetzt / abgelehnt, weil …),
 * die Antworten stehen in der Freigabe-Frage. Feste Prüfungen im Code laufen vorher; ultra ist für das, was sich nicht als
 * Regel fassen lässt. Deterministisch ist nur der Auslöser (Risiko), nie eine Einschätzung des Modells.
 */

import { aktionsArt } from './change-schritte.js';

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

/**
 * Owner-Freigabe 22.11. (G1) — zusätzliche feste Auslöser, unabhängig vom Risiko, das das planende Modell selbst einträgt:
 * ein ändernder Schritt eines Skills der kritischen Systemklassen oder an einem ausdrücklich produktiven Asset — außer alle
 * betroffenen Assets sind ausdrücklich lab/test/development. Die Liste steht im Code, nie im Prompt.
 */
export const KRITISCHE_SKILLS = new Set(['windows_ad', 'windows_pki', 'windows_cluster', 'sql_server', 'linux_sql', 'linux_ha', 'proxmox', 'unifi', 'pfsense', 'mikrotik']);
/** pki_lab arbeitet selbst nur auf Lab-Rechnern (prüft das vor jedem Baustein) */
const NIE_KRITISCH = new Set(['pki_lab']);
const NICHT_PRODUKTIV = new Set(['lab', 'test', 'development']);

/** K1 (fail-closed) — produktiv ist alles, was nicht ausdrücklich lab/test/development ist; fehlende Einordnung zählt als produktiv. */
export function istProduktiv(environment: string | undefined | null): boolean {
  return !NICHT_PRODUKTIV.has(String(environment ?? '').trim().toLowerCase());
}

export interface AuslöserAsset { id: string; name: string; environment?: string | null }

/** Grund der Gegenprüfung (für Log und Freigabe-Frage) oder undefined, wenn keine nötig ist. */
export function gegenpruefungAusloeser(
  c: { riskLevel?: string; schritte?: unknown[]; affectedAssetIds?: string[] },
  assets: AuslöserAsset[],
): string | undefined {
  const risiko = String(c.riskLevel ?? '').toLowerCase();
  if (GEGENPRUEFUNG_RISIKEN.has(risiko)) return `Risiko ${risiko}`;
  // unbekannte IDs (Asset fehlt in der CMDB) zählen wie fehlende Einordnung als produktiv
  const betroffen: AuslöserAsset[] = (c.affectedAssetIds ?? []).map(id => assets.find(a => a.id === id) ?? { id, name: id.slice(0, 8) });
  const produktiv = betroffen.filter(a => istProduktiv(a.environment));
  if (betroffen.length > 0 && produktiv.length === 0) return undefined; // alle ausdrücklich lab/test/development
  const namen = (l: AuslöserAsset[]) => l.slice(0, 3).map(a => a.name).join(', ') + (l.length > 3 ? ` (+${l.length - 3})` : '');
  const ziel = produktiv.length ? `${namen(produktiv)} (produktiv)` : 'Ziel ohne Asset-Angabe (gilt als produktiv)';
  const ausdruecklich = produktiv.filter(a => String(a.environment ?? '').toLowerCase() === 'production');
  for (const roh of c.schritte ?? []) {
    const s = (roh ?? {}) as { art?: string; skill?: string; aktion?: string; parameter?: Record<string, unknown>; einordnung?: string };
    if (s.art !== 'aktion' || !s.skill || !s.aktion || NIE_KRITISCH.has(s.skill)) continue;
    const art = s.einordnung ?? aktionsArt(s.skill, s.aktion, s.parameter);
    if (art !== 'aendern' && art !== 'loeschen') continue;
    if (KRITISCHE_SKILLS.has(s.skill)) return `ändernder Schritt ${s.skill}.${s.aktion} an ${ziel}`;
    if (ausdruecklich.length) return `ändernder Schritt ${s.skill}.${s.aktion} an ${namen(ausdruecklich)} (production)`;
  }
  return undefined;
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
export interface GegenpruefungVermerk { fingerabdruck: string; befunde: number; modell?: string; zeit: string; pruefungen?: number; grund?: string }
export const MAX_GEGENPRUEFUNGEN = 3;

export function vermerkText(v: GegenpruefungVermerk): string {
  // G2 — Anlass der Prüfung in der Freigabe-Frage
  const teile = [...((v.pruefungen ?? 1) > 1 ? [`${v.pruefungen}. Prüfung, nach Überarbeitung`] : []), ...(v.grund ? [`Anlass: ${v.grund}`] : [])];
  const nr = teile.length ? ` (${teile.join('; ')})` : '';
  return v.befunde === 0 ? `Von ultra gegengeprüft${nr}: keine Befunde.` : `Von ultra gegengeprüft${nr}: ${v.befunde} ${v.befunde === 1 ? 'Befund' : 'Befunde'} (Antworten unten).`;
}

export function grenzeText(v: GegenpruefungVermerk): string {
  return `⚠️ Von ultra ${v.pruefungen ?? 1}× gegengeprüft, der Plan wurde danach noch einmal geändert — Grenze von ${MAX_GEGENPRUEFUNGEN} Prüfungen je Change erreicht, diese Fassung ist NICHT gegengeprüft.`;
}
