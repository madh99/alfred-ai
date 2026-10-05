/**
 * Jarvis Schicht 1 — Baselines aus Stichproben.
 *
 * Für numerische Zeitreihen: Median und Streuung (MAD) je Tagesstunde über die
 * letzten Tage. Robust gegen Ausreißer, keine Modellannahmen. Die Deutung
 * bleibt beobachtend, solange zu wenige Stichproben vorliegen (Spec: Baselines
 * erst beobachtend).
 */

export interface Stichprobe { wert: number; zeit: string }

export interface BaselineErgebnis {
  /** Anzahl der Stichproben im Stundenfenster (±1 h) */
  n: number;
  median?: number;
  mad?: number;
  /** robuste z-Abweichung des aktuellen Werts, wenn Baseline tragfähig */
  z?: number;
  urteil: 'im-aufbau' | 'normal' | 'auffaellig';
}

export const BASELINE_MIN_STICHPROBEN = 10;
export const BASELINE_Z_SCHWELLE = 3;

export function median(werte: number[]): number | undefined {
  if (werte.length === 0) return undefined;
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median der absoluten Abweichungen (skaliert auf Normalverteilungs-Sigma). */
export function mad(werte: number[], med: number): number | undefined {
  if (werte.length === 0) return undefined;
  const abw = werte.map(w => Math.abs(w - med));
  const m = median(abw);
  return m === undefined ? undefined : m * 1.4826;
}

/** Stichproben im Stundenfenster ±1 h um `stunde` (lokale Zeit), ohne den aktuellen Wert selbst. */
export function stundenfenster(proben: Stichprobe[], stunde: number, ausschlussZeit?: string): number[] {
  return proben
    .filter(p => p.zeit !== ausschlussZeit)
    .filter(p => { const h = new Date(p.zeit).getHours(); const d = Math.min(Math.abs(h - stunde), 24 - Math.abs(h - stunde)); return d <= 1; })
    .map(p => p.wert);
}

export function bewerteGegenBaseline(wert: number, zeit: string, proben: Stichprobe[]): BaselineErgebnis {
  const stunde = new Date(zeit).getHours();
  const fenster = stundenfenster(proben, stunde, zeit);
  const n = fenster.length;
  if (n < BASELINE_MIN_STICHPROBEN) return { n, urteil: 'im-aufbau' };
  const med = median(fenster)!;
  const streuung = mad(fenster, med) ?? 0;
  // Keine Streuung (konstanter Wert): jede Abweichung > 0 ist auffällig, aber
  // mit Mindestabstand 1 Einheit, damit Rundungsrauschen nicht alarmiert.
  const z = streuung > 0 ? (wert - med) / streuung : (Math.abs(wert - med) >= 1 ? Math.sign(wert - med) * BASELINE_Z_SCHWELLE : 0);
  return { n, median: med, mad: streuung, z, urteil: Math.abs(z) >= BASELINE_Z_SCHWELLE ? 'auffaellig' : 'normal' };
}

/** Trend über die letzten `minuten`: Differenz je Stunde (positiv = steigend). */
export function trendProStunde(proben: Stichprobe[], jetzt: Date, minuten = 120): number | undefined {
  const seit = jetzt.getTime() - minuten * 60_000;
  const fenster = proben.filter(p => Date.parse(p.zeit) >= seit).sort((a, b) => Date.parse(a.zeit) - Date.parse(b.zeit));
  if (fenster.length < 2) return undefined;
  const a = fenster[0]; const b = fenster[fenster.length - 1];
  const dtH = (Date.parse(b.zeit) - Date.parse(a.zeit)) / 3600_000;
  if (dtH < 0.25) return undefined;
  return (b.wert - a.wert) / dtH;
}
