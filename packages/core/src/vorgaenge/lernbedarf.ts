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

export function istAbsage(text: string): boolean {
  const t = (text ?? '').slice(0, 1500);
  return ABSAGE_MUSTER.some(p => p.test(t));
}

function schluessel(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4).sort().slice(0, 12).join(' ');
}

/** Lernbedarf aus einer Chat-Absage: Frage + Kern der Antwort. */
export function lernbedarfAusAbsage(frage: string, antwort: string): LernbedarfVorgang | undefined {
  const f = (frage ?? '').trim();
  if (f.length < 6 || !istAbsage(antwort)) return undefined;
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
