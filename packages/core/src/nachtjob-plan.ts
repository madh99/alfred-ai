/**
 * v1158 — Fälligkeit täglicher Nachtjobs, restart-fest.
 *
 * Befund 28.09.: KG-Wartung (04:30) und Pattern-Analyse (03:30) liefen seit
 * dem 12.09. nicht mehr. Der Stunden-Timer prüfte „Stunde == 4 UND Minute ≥ 30",
 * feuert aber immer zur Start-Minute des Prozesses — nach Restarts um :04 bzw.
 * :28 war die Bedingung NIE wahr (letzter kg-maintenance-Slot: 11.09.).
 *
 * Neue Regel (10-Minuten-Raster): fällig, sobald die Zielzeit des Tages
 * erreicht oder überschritten ist und der Job heute noch nicht lief — damit
 * holt ein Restart nach der Zielzeit den Lauf einmalig nach. Doppelläufe im
 * Cluster verhindert der Tages-Slot in reasoning_slots.
 */
export function lokalesDatum(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Liefert das heutige Datum, wenn der Job jetzt fällig ist, sonst null. */
export function istNachtjobFaellig(now: Date, stunde: number, minute: number, zuletztGelaufenAm: string): string | null {
  const heute = lokalesDatum(now);
  if (zuletztGelaufenAm === heute) return null;
  const erreicht = now.getHours() > stunde || (now.getHours() === stunde && now.getMinutes() >= minute);
  return erreicht ? heute : null;
}
