/**
 * v1207 — Jarvis Schleife 3: Lücke → Fähigkeit.
 *
 * Wenn Alfred eine Frage nicht beantworten kann (Absage im Chat) oder ein Skill
 * wiederholt scheitert (Skill-Failure-Reflektor), legt er sich selbst einen Vorgang
 * „Lernbedarf" an: was fehlte, was der nächste Schritt ist. Der Owner sieht die
 * Lücken in der Kachel Vorgänge und entscheidet; aus wiederkehrenden Lücken
 * entstehen die Szenarien von selbst, nicht aus einer vorgegebenen Liste.
 */
import { kategorieAus } from './kategorie.js';

export interface LernbedarfVorgang {
  titel: string;
  ziel: string;
  naechsterSchritt: string;
  dedupeKey: string;
  kategorie: string;
  begruendung: string;
}

/** Absage-Marker (gleiche Liste wie der Refusal-Correction-Reflektor). */
export const ABSAGE_MUSTER = [
  /\b(kann ich nicht|kann ich leider nicht|nicht möglich|geht nicht|funktioniert nicht|nicht implementiert|keine möglichkeit|habe keine möglichkeit|habe keinen zugriff|keinen? zugriff|fehlt mir|nicht verfügbar)\b/i,
  /\b(i can'?t|i cannot|not possible|not implemented|no way to|no access)\b/i,
];

/** v1215 — Eine Absage steht am Anfang. Lange Antworten mit einem Störwort tief im Text sind Inhalt, keine Absage. */
export const ABSAGE_KOPF_ZEICHEN = 300;
export const ABSAGE_KURZ_ZEICHEN = 500;

export function istAbsage(text: string): boolean {
  const t = text ?? '';
  // Realfall 06.10. 11:09: Die Antwort auf „zu der Gesamtlage?" war ein 1.300-Zeichen-Lagebericht; weit hinten
  // stand „Outlook-Account ist nicht verfügbar" → fälschlich ein Lernbedarf-Vorgang. Jetzt zählt nur, was im
  // Kopf der Antwort steht, oder die ganze Antwort, wenn sie kurz ist.
  const pruef = t.length <= ABSAGE_KURZ_ZEICHEN ? t : t.slice(0, ABSAGE_KOPF_ZEICHEN);
  return ABSAGE_MUSTER.some(p => p.test(pruef));
}

function schluessel(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4).sort().slice(0, 12).join(' ');
}

/**
 * v1335 — Rückfragen und Befehle sind keine Lücken. Realfall 09.10. (Owner-Review): „warum setzt du es nicht um ?",
 * „dann mach doch weiter !", „ich warte", „/verlauf" wurden als Lernbedarf angelegt — Rauschen in der Vorgangsliste.
 */
export const RUECKFRAGE_MUSTER = /^(warum|wieso|weshalb|dann|und|also|ok|okay|na|aha|ich warte|mach doch|mach weiter|weiter|noch ?mal|nochmal|bitte)\b/i;

export function istRueckfrageOderBefehl(frage: string): boolean {
  const f = (frage ?? '').trim();
  if (!f || f.startsWith('/')) return true;
  const woerter = f.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (woerter.length <= 4) return true;
  return RUECKFRAGE_MUSTER.test(f);
}

/** Lernbedarf aus einer Chat-Absage: Frage + Kern der Antwort. */
export function lernbedarfAusAbsage(frage: string, antwort: string): LernbedarfVorgang | undefined {
  const f = (frage ?? '').trim();
  if (f.length < 6 || !istAbsage(antwort)) return undefined;
  if (istRueckfrageOderBefehl(f)) return undefined; // v1335
  const kurzFrage = f.replace(/\s+/g, ' ').slice(0, 120);
  const absatz = antwort.split('\n').find(z => ABSAGE_MUSTER.some(p => p.test(z)))?.trim().slice(0, 200) ?? '';
  return {
    titel: `Lernbedarf: „${kurzFrage}" konnte ich nicht beantworten`,
    ziel: `Frage: ${f.slice(0, 500)}\nAntwort (Absage): ${absatz}`,
    naechsterSchritt: 'Fehlende Quelle, Watch oder Skill-Konfiguration benennen und freigeben',
    dedupeKey: `lernbedarf:absage:${schluessel(kurzFrage)}`,
    kategorie: kategorieAus(f),
    begruendung: 'Chat-Antwort enthielt eine Absage (Schleife 3: Lücke → Fähigkeit)',
  };
}

/** Lernbedarf aus einem erkannten Skill-Fehlermuster (Skill-Failure-Reflektor). */
export function lernbedarfAusSkillFehler(p: { failedSkill: string; errorClass: string; scope?: string; workaroundSteps: string[]; finalSuccess: boolean }): LernbedarfVorgang {
  const ort = p.scope ? ` bei ${p.scope}` : '';
  return {
    titel: `Lernbedarf: Skill „${p.failedSkill}" scheitert ${p.errorClass}${ort}`,
    ziel: p.workaroundSteps.length ? `Beobachteter Umweg: ${p.workaroundSteps.slice(0, 5).join(' → ')}` : 'Kein Umweg beobachtet',
    naechsterSchritt: p.finalSuccess ? 'Umweg als Runbook bestätigen (Vorschlag liegt in der Bestätigungs-Queue)' : 'Ursache klären: Konfiguration, Zugang oder Zuständigkeit des Skills',
    dedupeKey: `lernbedarf:skill:${p.failedSkill}:${(p.scope ?? '').replace(/[^a-z0-9]/gi, '_').slice(0, 30)}:${p.errorClass}`.toLowerCase(),
    kategorie: 'alfred',
    begruendung: `Skill-Failure-Reflektor: ${p.errorClass}${ort}`,
  };
}
