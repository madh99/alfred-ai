/**
 * v1374 — Lernende Helfer L0 (Spec Jarvis „Lernende Helfer", Owner-Freigabe 12.10.): Lernsignal je Gesprächsanfrage.
 * Folgesignal der VORIGEN Anfrage aus der nächsten Nachricht im selben Chat (innerhalb von 5 Minuten): korrigiert (der Owner
 * widerspricht) oder wiederholt (fast dieselbe Frage noch einmal). Abbruch (Stopp-Knopf) setzt die Pipeline selbst.
 * Deterministisch; nichts entscheidet darauf — gemessen wird zwei Wochen, ausgewertet ~26.10.
 */
import { inhaltsWoerter } from '../insights/hinweis-pruefung.js';

export const FOLGE_FENSTER_MS = 5 * 60_000;

const KORREKTUR = /^\s*(nein\b|nö\b|falsch|stimmt nicht|das stimmt nicht|nicht richtig|so nicht|das ist (doch )?falsch|quatsch|ich meinte|eigentlich meinte|du hast (das |es )?(falsch|vergessen|nicht)|das war (nicht|falsch)|wieso (das|denn)\b|warum (sagst|machst) du)/i;

export function folgesignalFuer(vorher: string, neu: string): 'korrigiert' | 'wiederholt' | null {
  if (KORREKTUR.test(neu)) return 'korrigiert';
  const a = inhaltsWoerter(vorher), b = inhaltsWoerter(neu);
  if (a.size < 2 || b.size < 2) return null;
  const gemeinsam = [...a].filter(w => b.has(w)).length;
  return gemeinsam / Math.min(a.size, b.size) >= 0.7 ? 'wiederholt' : null;
}

/** Nachrichten, die keine Gesprächsanfrage sind (Knöpfe, Bestätigungen, interne Läufe). */
export function istProtokollAnfrage(text: string, chatId: string, metadata?: Record<string, unknown>): boolean {
  if (metadata?.scheduled || metadata?.callbackQuery) return false;
  if (/^(scheduled-|api-update)/.test(chatId)) return false;
  return !/^(hw|todo|reminder|content|confirm|insight):[0-9a-f-]{8,}/i.test((text ?? '').trim());
}

/** Werkzeugaufrufe einer Anfrage mit Ausgang (aus Tool-Calls und Tool-Ergebnissen). */
export function werkzeugeAus(
  aufrufe: Array<{ id: string; name: string; input?: unknown }>,
  ergebnisse: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>,
): Array<{ skill: string; aktion?: string; ok: boolean }> {
  const fehler = new Set(ergebnisse.filter(e => e.type === 'tool_result' && e.is_error).map(e => e.tool_use_id));
  return aufrufe.map(a => {
    const aktion = (a.input as { action?: unknown } | undefined)?.action;
    return { skill: a.name, ...(typeof aktion === 'string' ? { aktion } : {}), ok: !fehler.has(a.id) };
  });
}
