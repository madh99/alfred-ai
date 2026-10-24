/**
 * Shared cron expression utilities.
 * Supports: *, N, * /N, N-M, N-M/S, N,M,O (comma-separated lists with optional ranges).
 */

/** Check whether a cron expression matches at a given date. */
export function matchesCron(cronExpr: string, date: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    matchCronField(parts[0], minute) &&
    matchCronField(parts[1], hour) &&
    matchCronField(parts[2], dayOfMonth) &&
    matchCronField(parts[3], month) &&
    matchCronField(parts[4], dayOfWeek)
  );
}

/**
 * Calculate the next Date matching a cron expression within the given horizon.
 * v1654 — Realfall 25.10.2026: der Horizont war 24 h; am Tag der Zeitumstellung (25 h) fand eine tägliche Aufgabe keinen
 * Termin mehr und wurde deaktiviert (Wochen- und Monats-Crons nie). Jetzt ein Jahr; Tage und Stunden ohne Treffer werden
 * übersprungen, Schritte laufen über den Zeitstempel (stabil bei Zeitumstellungen).
 */
export function getNextCronDate(cronExpr: string, from: Date, horizonMs = 366 * 24 * 60 * 60_000): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const end = from.getTime() + horizonMs;
  // Round up to the next whole minute
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  while (t <= end) {
    const c = new Date(t);
    if (!(matchCronField(parts[2], c.getDate()) && matchCronField(parts[3], c.getMonth() + 1) && matchCronField(parts[4], c.getDay()))) {
      const mitternacht = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1, 0, 0, 0, 0).getTime();
      t = mitternacht > t ? mitternacht : t + 60_000;
      continue;
    }
    if (!matchCronField(parts[1], c.getHours())) { t += (60 - c.getMinutes()) * 60_000; continue; }
    if (matchCronField(parts[0], c.getMinutes())) return c;
    t += 60_000;
  }
  return null;
}

/**
 * Match a single cron field against a value.
 * Supports: * | N | * /N | N-M | N-M/S | comma-separated combinations.
 */
function matchCronField(field: string, value: number): boolean {
  // Comma-separated list: evaluate each part
  if (field.includes(',')) {
    return field.split(',').some(part => matchCronField(part.trim(), value));
  }

  // Wildcard
  if (field === '*') return true;

  // */N — every N
  const globalStep = /^\*\/(\d+)$/.exec(field);
  if (globalStep) {
    const step = parseInt(globalStep[1], 10);
    return step > 0 && value % step === 0;
  }

  // Range with optional step: N-M or N-M/S
  const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(field);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
    if (value < start || value > end) return false;
    return step > 0 && (value - start) % step === 0;
  }

  // Specific number
  const num = parseInt(field, 10);
  if (!isNaN(num)) return value === num;

  return false;
}
