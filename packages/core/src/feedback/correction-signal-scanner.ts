/**
 * Correction Signal Scanner — pure function, ~1ms, no dependencies.
 * Detects user corrections and behavioral feedback in messages.
 * Bilingual: German + English patterns.
 */

export interface CorrectionSignalResult {
  level: 'high' | 'low';
}

/**
 * Sentence-start anchor: matches start-of-string OR after sentence terminator
 * (newline, period, exclam, etc.) optionally followed by whitespace.
 * Used to limit "in zukunft" etc. to actually meant-as-directive sentences.
 */
const S = String.raw`(?:^|[\n.!?]\s*)`;

const CORRECTION_PATTERNS: RegExp[] = [
  // German — direct corrections (always trigger, no anchor needed)
  /\b(nein,?\s*(nicht so|das ist falsch|das stimmt nicht|anders))\b/i,
  /\b(das war falsch|das ist falsch|das solltest du nicht)\b/i,
  /\b(ich meinte|ich wollte|ich habe gemeint)\b/i,
  /\b(tu das nicht|mach das nicht|lass das)\b/i,
  /\b(das will ich nicht|das brauche ich nicht)\b/i,
  /\b(falsche?r?\s+(antwort|ergebnis|aktion|reaktion))\b/i,
  /\b(zu (oft|viel|aggressiv|häufig|früh|spät))\b/i,
  // German — behavioral directives: only when at sentence-start AND followed by
  // an actual instruction. "Beim nächsten Mal anders machen" matches; "wir hatten
  // überlegt das in zukunft anders zu lösen" does NOT (no anchor + descriptive).
  // v606 K1: previously these triggered mid-sentence on any procedural text.
  new RegExp(S + String.raw`(beim nächsten mal|in zukunft|ab jetzt|ab sofort)\b`, 'i'),
  // German — exclusion conditions only when leading a sentence (not in nested
  // procedure bodies like "Wenn JA → melde X, nur wenn Y trifft")
  new RegExp(S + String.raw`(nicht wenn|nur wenn|nur falls|nur dann)\b`, 'i'),
  // Hör auf damit / stop damit — require object phrase
  /\b(hör auf|stop|stopp).*\b(damit|das|mit)\b/i,
  // Threshold-change directives — only when leading the sentence (avoids
  // matching descriptive technical text like "den Schwellenwert ändern darf")
  new RegExp(S + String.raw`(bitte )?(den\s+)?(schwellenwert|threshold|grenzwert)\s+(\w+\s+){0,2}(ändern|anpassen|erhöhen|senken)\b`, 'i'),
  // English — direct corrections
  /\b(no,?\s*(not like that|that's wrong|don't do that))\b/i,
  /\b(that was wrong|that's incorrect|that's not what I)\b/i,
  /\b(I meant|I wanted|what I meant was)\b/i,
  /\b(don't do that|stop doing|never do)\b/i,
  /\b(too (often|much|aggressive|frequent|early|late))\b/i,
  // English — sentence-start directives
  new RegExp(S + String.raw`(next time|from now on|in the future|going forward)\b`, 'i'),
  new RegExp(S + String.raw`(not when|only when|only if|only then)\b`, 'i'),
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
