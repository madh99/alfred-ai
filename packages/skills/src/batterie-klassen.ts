/**
 * Jarvis Schicht 1 — gemeinsame Batterie-Klassifikation für Schreiber UND Leser.
 *
 * Realfall Mai–August 2026: der Monitor meldete „Low battery: settings ess
 * batterylife soclimit at 15%" (ein Konfigurationswert) und Handy-Akkus als
 * Incidents; die Deutungsschicht im Reasoning sortierte später aus. Lektion aus
 * v1141/v1157: Fix am SCHREIBER, nicht nur am Konsumenten — deshalb liegt die
 * Klassifikation hier im Skills-Paket, wo Monitor und Reasoning sie teilen.
 */
export type BatterieKlasse = 'mobilgeraet' | 'konfiguration' | 'hausbatterie' | 'sensor';

export function klassifiziereBatterie(entity: string, name = ''): BatterieKlasse {
  const e = `${entity} ${name}`.toLowerCase();
  if (/soclimit|minimumsoc|minimum_soc|soc_min|min_soc/.test(e)) return 'konfiguration';
  if (/iphone|i_phone|ipad|watch|sm_s9|sm-s9|galaxy|pixel|handy|phone|_battery_level$/.test(e)) return 'mobilgeraet';
  if (/(^|[._\s])soc([._\s]|$)|battery_soc|vebus/.test(e)) return 'hausbatterie';
  return 'sensor';
}

/** Entitäten von Mobilgeräten (Companion-App): ihre „unavailable"-Zustände sind Alltag, kein Ausfall. */
export function istMobilgeraeteEntity(entityId: string, name = ''): boolean {
  return /iphone|i_phone|ipad|watch|sm_s9|sm-s9|galaxy|pixel|handy|phone/.test(`${entityId} ${name}`.toLowerCase());
}
