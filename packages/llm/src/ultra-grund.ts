/**
 * Spec Stufe ultra U3 — Auslöser einer ultra-Nutzung. Der Einstiegspunkt (Nachricht mit ausdrücklicher Stufe, Gegenprüfung
 * eines Changes, Eskalation nach Fehlschlag) setzt ihn im Ausführungskontext; der Router liest ihn beim Verbuchen jedes
 * Aufrufs, der ultra angefordert hat. Ein ultra-Aufruf ohne Auslöser wird als `ohne-ausloeser` verbucht und gewarnt —
 * so fällt ein Einstiegspunkt auf, der ultra ohne Grund wählt (Architektur-Grundsatz: nie aus Modell-Einschätzung).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface UltraAusloeser {
  /** `ausdrücklich` | `gegenpruefung:<change>` | `eskalation:<grund>` */
  grund: string;
  /** Faden oder Gespräch, in dem ultra lief */
  ort?: string;
}

const kontext = new AsyncLocalStorage<UltraAusloeser>();

export const ULTRA_OHNE_AUSLOESER = 'ohne-ausloeser';

/** Auslöser für alles, was in [fn] läuft. */
export function mitUltraAusloeser<T>(a: UltraAusloeser, fn: () => T): T {
  return kontext.run({ grund: a.grund.slice(0, 120), ...(a.ort ? { ort: a.ort } : {}) }, fn);
}

export function aktuellerUltraAusloeser(): UltraAusloeser | undefined {
  return kontext.getStore();
}
