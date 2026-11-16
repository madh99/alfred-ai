/**
 * Final-Welle I2 — mitgelieferte Bauplan-Vorlagen: bauplan_speichern mit eingebaut "<key>" speichert die Vorlage deterministisch,
 * ohne dass das Modell ~75 KB JSON abschreibt. Inhalt geht durch dieselbe volle Validierung wie jede Vorlage.
 */
import PKI_LAB from './pki_lab.js';

export const EINGEBAUTE_VORLAGEN: Readonly<Record<string, unknown>> = Object.freeze({ pki_lab: PKI_LAB });

/** Tiefe Kopie der eingebauten Vorlage (nie das geteilte Objekt herausgeben) oder undefined */
export function eingebauteVorlage(key: string): unknown {
  return Object.prototype.hasOwnProperty.call(EINGEBAUTE_VORLAGEN, key) ? structuredClone(EINGEBAUTE_VORLAGEN[key]) : undefined;
}
