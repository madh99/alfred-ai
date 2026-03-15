/**
 * Correction Signal Scanner — pure function, ~1ms, no dependencies.
 * Detects user corrections and behavioral feedback in messages.
 * Bilingual: German + English patterns.
 */

export interface CorrectionSignalResult {
  level: 'high' | 'low';
}

const CORRECTION_PATTERNS: RegExp[] = [
  // German corrections
  /\b(nein,?\s*(nicht so|das ist falsch|das stimmt nicht|anders))\b/i,
  /\b(das war falsch|das ist falsch|das solltest du nicht)\b/i,
  /\b(ich meinte|ich wollte|ich habe gemeint)\b/i,
  /\b(tu das nicht|mach das nicht|lass das)\b/i,
  /\b(beim nächsten [Mm]al|in [Zz]ukunft|ab jetzt|ab sofort)\b/i,
  /\b(nicht wenn|nur wenn|nur falls|nur dann)\b/i,
  /\b(hör auf|stop|stopp).*\b(damit|das|mit)\b/i,
  /\b(das will ich nicht|das brauche ich nicht)\b/i,
  /\b(falsche?r?\s+(antwort|ergebnis|aktion|reaktion))\b/i,
  /\b(zu (oft|viel|aggressiv|häufig|früh|spät))\b/i,
  /\b(schwellenwert|threshold|grenzwert).*(ändern|anpassen|erhöhen|senken)\b/i,
  // English corrections
  /\b(no,?\s*(not like that|that's wrong|don't do that))\b/i,
  /\b(that was wrong|that's incorrect|that's not what I)\b/i,
  /\b(I meant|I wanted|what I meant was)\b/i,
  /\b(don't do that|stop doing|never do)\b/i,
  /\b(next time|from now on|in the future|going forward)\b/i,
  /\b(not when|only when|only if|only then)\b/i,
  /\b(too (often|much|aggressive|frequent|early|late))\b/i,
];

/**
 * Scan a user message for correction/feedback signals.
 * Pure function, no side effects, ~0.1ms execution.
 */
export function scanCorrectionSignal(message: string): CorrectionSignalResult {
  const trimmed = message.trim();
  if (trimmed.length < 8) return { level: 'low' };

  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: 'high' };
    }
  }

  return { level: 'low' };
}
