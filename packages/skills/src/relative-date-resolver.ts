/**
 * Resolves relative date expressions ("morgen", "Montag", "nächste Woche", ...) to
 * absolute ISO dates. Annotates the original text with "(=YYYY-MM-DD)" after each match
 * so both human readers and the LLM see the original phrasing AND the fixed date.
 *
 * Idempotent: an expression already followed by "(=..." is not re-annotated.
 */

const WEEKDAYS_DE: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
};
const WEEKDAYS_EN: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const ALL_WEEKDAYS = { ...WEEKDAYS_DE, ...WEEKDAYS_EN };

/** Format a Date as YYYY-MM-DD in the given timezone (or local). */
function formatDate(d: Date, timezone?: string): string {
  if (timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const day = parts.find(p => p.type === 'day')!.value;
    return `${y}-${m}-${day}`;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Get the date object for "now" in a specific timezone — used to compute "today" correctly. */
function nowInTimezone(now: Date, timezone?: string): { year: number; month: number; day: number; weekday: number } {
  if (timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    }).formatToParts(now);
    const year = parseInt(parts.find(p => p.type === 'year')!.value, 10);
    const month = parseInt(parts.find(p => p.type === 'month')!.value, 10);
    const day = parseInt(parts.find(p => p.type === 'day')!.value, 10);
    const weekdayName = parts.find(p => p.type === 'weekday')!.value.toLowerCase();
    const weekday = ({
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
    } as Record<string, number>)[weekdayName] ?? now.getDay();
    return { year, month, day, weekday };
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), weekday: now.getDay() };
}

/** Build a Date from year/month/day at midnight UTC — used as a reference point for arithmetic. */
function dateFromYMD(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)); // noon UTC to avoid DST edge cases
}

/** Add days to a Date (returns new Date). */
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Compute the next occurrence of a target weekday strictly AFTER today (today is excluded). */
function nextWeekday(todayWeekday: number, targetWeekday: number): number {
  const diff = ((targetWeekday - todayWeekday) + 7) % 7;
  return diff === 0 ? 7 : diff;
}

/**
 * Unicode-aware word boundary helpers — JS \b is ASCII only, so it fails on words
 * starting/ending with umlauts ("übermorgen", "fällig"). We use Unicode property
 * lookarounds instead.
 */
const UNI_LB = '(?<![\\p{L}\\p{N}_])'; // not preceded by letter/number/underscore
const UNI_LA = '(?![\\p{L}\\p{N}_])';  // not followed by letter/number/underscore

/** Replace a match in text only if it is not already followed by an "(=..." annotation. */
function annotateIfNew(text: string, regex: RegExp, computeAnnotation: (match: RegExpMatchArray) => string): string {
  // Build a new string by walking through matches; skip matches already followed by "(="
  return text.replace(regex, (...args) => {
    const matchStr = args[0] as string;
    const offset = args[args.length - 2] as number;
    const fullText = args[args.length - 1] as string;
    // Look ahead: is the next non-whitespace chunk already an "(=" annotation?
    const tail = fullText.slice(offset + matchStr.length, offset + matchStr.length + 4);
    if (/^\s*\(=/.test(tail)) return matchStr;
    const m = args.slice(0, args.length - 2) as unknown as RegExpMatchArray;
    return `${matchStr} (=${computeAnnotation(m)})`;
  });
}

/**
 * Resolve relative date expressions in `text` to absolute YYYY-MM-DD annotations.
 * Pure function. Idempotent (re-running on annotated text is a no-op).
 */
export function resolveRelativeDates(text: string, now: Date = new Date(), timezone?: string): string {
  if (!text || text.length < 3) return text;

  const today = nowInTimezone(now, timezone);
  const todayDate = dateFromYMD(today.year, today.month, today.day);
  let out = text;

  // Build a unicode-aware regex to avoid ASCII-only \b failing on umlauts.
  const u = (body: string) => new RegExp(`${UNI_LB}(?:${body})${UNI_LA}`, 'giu');

  // 1. heute / today
  out = annotateIfNew(out, u('heute|today'), () => formatDate(todayDate, timezone));

  // 2. morgen / tomorrow
  out = annotateIfNew(out, u('morgen|tomorrow'), () => formatDate(addDays(todayDate, 1), timezone));

  // 3. übermorgen / day after tomorrow
  out = annotateIfNew(out, u('übermorgen|uebermorgen|overmorrow'), () => formatDate(addDays(todayDate, 2), timezone));

  // 4. gestern / yesterday
  out = annotateIfNew(out, u('gestern|yesterday'), () => formatDate(addDays(todayDate, -1), timezone));

  // 5. vorgestern / day before yesterday
  out = annotateIfNew(out, u('vorgestern'), () => formatDate(addDays(todayDate, -2), timezone));

  // 6. in X Tagen/Wochen/Monaten
  out = annotateIfNew(
    out,
    new RegExp(`${UNI_LB}in\\s+(\\d{1,3})\\s+(tag(?:e[nm]?)?|days?|woche(?:[nm])?|weeks?|monat(?:e[nm]?)?|months?|jahre?[nm]?|years?)${UNI_LA}`, 'giu'),
    (m) => {
      const num = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      let days = num;
      if (/woche|week/.test(unit)) days = num * 7;
      else if (/monat|month/.test(unit)) days = num * 30; // approximation
      else if (/jahr|year/.test(unit)) days = num * 365; // approximation
      return formatDate(addDays(todayDate, days), timezone);
    },
  );

  // 7. nächste/r/n/s Woche/Monat/Jahr
  out = annotateIfNew(
    out,
    new RegExp(`${UNI_LB}n(?:ä|ae)chste[rsnm]?\\s+(woche|monat|jahr)${UNI_LA}`, 'giu'),
    (m) => {
      const unit = m[1].toLowerCase();
      if (unit === 'woche') {
        // Start of next week (Monday)
        const daysToNextMonday = nextWeekday(today.weekday, 1);
        return formatDate(addDays(todayDate, daysToNextMonday), timezone);
      }
      if (unit === 'monat') {
        const next = new Date(Date.UTC(today.year, today.month, 1, 12, 0, 0));
        return formatDate(next, timezone);
      }
      // jahr
      const next = new Date(Date.UTC(today.year + 1, 0, 1, 12, 0, 0));
      return formatDate(next, timezone);
    },
  );

  // 8. next week/month/year (English)
  out = annotateIfNew(
    out,
    new RegExp(`${UNI_LB}next\\s+(week|month|year)${UNI_LA}`, 'giu'),
    (m) => {
      const unit = m[1].toLowerCase();
      if (unit === 'week') {
        const daysToNextMonday = nextWeekday(today.weekday, 1);
        return formatDate(addDays(todayDate, daysToNextMonday), timezone);
      }
      if (unit === 'month') {
        const next = new Date(Date.UTC(today.year, today.month, 1, 12, 0, 0));
        return formatDate(next, timezone);
      }
      const next = new Date(Date.UTC(today.year + 1, 0, 1, 12, 0, 0));
      return formatDate(next, timezone);
    },
  );

  // 9. Wochentage (Montag, Dienstag, ..., Sonntag, monday, ...)
  // Resolve to the NEXT future occurrence (today excluded — same weekday → +7 days).
  out = annotateIfNew(
    out,
    u('sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sunday|monday|tuesday|wednesday|thursday|friday|saturday'),
    (m) => {
      const name = m[0].toLowerCase();
      const targetWeekday = ALL_WEEKDAYS[name];
      if (targetWeekday === undefined) return formatDate(todayDate, timezone);
      const daysAhead = nextWeekday(today.weekday, targetWeekday);
      return formatDate(addDays(todayDate, daysAhead), timezone);
    },
  );

  return out;
}

/**
 * Extract the latest date (YYYY-MM-DD) from a memory value's `(=YYYY-MM-DD)` annotations.
 * Returns the MAXIMUM date — a memory remains relevant until ALL its referenced dates pass.
 *
 * Returns undefined if no annotated dates are present.
 */
export function extractRelevantUntil(text: string): string | undefined {
  const matches = [...text.matchAll(/\(=(\d{4}-\d{2}-\d{2})\)/g)];
  if (matches.length === 0) return undefined;
  const dates = matches.map(m => m[1]).sort();
  return dates[dates.length - 1]; // ISO dates sort lexicographically
}

/**
 * Extract source-event identifiers from text. Heuristic patterns for common ID formats:
 * - Invoice numbers: INV-2026-04-001, RE-12345, RG2026-001
 * - Email message-ids in angle brackets: <abc@example.com>
 * - ISO dates: 2026-04-15 (used as fallback ref)
 * - Calendar/event ids prefixed with "evt:" / "event:"
 *
 * Returns prefixed refs like "invoice:INV-...", "email:msg-id", "date:2026-04-15".
 */
export function extractSourceEventRefs(text: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();

  // Invoice/Receipt numbers (German + English)
  for (const m of text.matchAll(/\b(?:INV|RE|RG|RECH|INVOICE|RECEIPT)[-\s]?(\d{2,4}[-\s]?\d{2,5}[-\s]?\d{0,5})\b/gi)) {
    refs.add(`invoice:${m[0].replace(/\s+/g, '').toUpperCase()}`);
  }

  // Email message-ids: <foo@bar.com>
  for (const m of text.matchAll(/<([^>\s]+@[^>\s]+)>/g)) {
    refs.add(`email:${m[1]}`);
  }

  // Calendar/event explicit refs
  for (const m of text.matchAll(/\b(?:evt|event|cal|kal):([\w-]{4,})\b/gi)) {
    refs.add(`event:${m[1]}`);
  }

  // ISO dates as last-resort identifier (helps "Email vom 2026-04-15" match itself later)
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    refs.add(`date:${m[1]}`);
  }

  return [...refs];
}
