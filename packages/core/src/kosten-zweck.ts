/**
 * v1506 D5 — Herkunft der LLM-Kosten (Owner 19.10.: „ab jetzt erfassen“). Die Einstiegspunkte setzen den Zweck im
 * Ausführungskontext; die Kostenzählung (setPersist) liest ihn beim Verbuchen. Aufrufe ohne Kontext zählen als
 * „sonstiges“ — so wird sichtbar, wo ein Einstiegspunkt fehlt.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const kontext = new AsyncLocalStorage<{ zweck: string }>();

/** Zweck für alles, was in [fn] läuft (überschreibt einen äußeren Zweck). */
export function mitKostenZweck<T>(zweck: string, fn: () => T): T {
  return kontext.run({ zweck }, fn);
}

/** Zweck nur setzen, wenn noch keiner gilt: eine geplante Aufgabe oder ein Hintergrund-Job, der intern durch die
 *  Nachrichtenverarbeitung läuft, bleibt Aufgabe bzw. Hintergrund und wird nicht zum Chat. */
export function mitKostenZweckWennLeer<T>(zweck: string, fn: () => T): T {
  return kontext.getStore() ? fn() : kontext.run({ zweck }, fn);
}

export function aktuellerKostenZweck(): string {
  return kontext.getStore()?.zweck ?? 'sonstiges';
}
