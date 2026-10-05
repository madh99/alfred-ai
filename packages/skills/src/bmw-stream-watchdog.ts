/**
 * v1176 — Jarvis Schicht 0/1: Wächter-Entscheidung für den BMW-MQTT-Stream.
 *
 * Realfall 04.10.2026: 11:56 „Keepalive timeout" → Reconnect in 60 s geplant →
 * der Reconnect lief nie (Pfad hing vor dem Token-Refresh). Bis zum Restart um
 * 19:46 war der Stream tot — genau während einer 98-km-Fahrt. Die Entscheidung
 * ist rein und testbar; der Skill führt sie alle 10 Minuten aus.
 */
export interface StreamZustand {
  enabled: boolean;
  aktiv: boolean;
  /** Zeitpunkt, zu dem ein geplanter Reconnect fällig ist (undefined = keiner geplant). */
  reconnectFaelligAt?: number;
  /** Letztes Lebenszeichen des Clients (connect/close/data/error). */
  letztesEreignisAt?: number;
}

export type WatchdogUrteil = 'deaktiviert' | 'ok' | 'reconnect-ausstehend' | 'neustart';

/** Toleranz, um die ein geplanter Reconnect überfällig sein darf, bevor der Wächter eingreift. */
export const RECONNECT_TOLERANZ_MS = 2 * 60_000;
/** Ohne jedes Client-Ereignis so lange → Neustart (deckt Hänger ohne Reconnect-Planung ab). */
export const STILLE_SCHWELLE_MS = 15 * 60_000;

export function entscheideStreamWatchdog(z: StreamZustand, now = Date.now()): WatchdogUrteil {
  if (!z.enabled) return 'deaktiviert';
  if (z.aktiv) return 'ok';
  if (z.reconnectFaelligAt !== undefined) {
    if (now - z.reconnectFaelligAt <= RECONNECT_TOLERANZ_MS) return 'reconnect-ausstehend';
    return 'neustart'; // geplanter Reconnect ist überfällig → der Pfad hängt
  }
  if (z.letztesEreignisAt !== undefined && now - z.letztesEreignisAt < STILLE_SCHWELLE_MS) return 'reconnect-ausstehend';
  return 'neustart';
}
