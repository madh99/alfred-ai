/**
 * v1369 — Sichtbarkeit des Verworfenen (Owner 12.10., Analyse „aWATTar-Rechnung kam nicht"): Alfred verwarf fertige Ergebnisse
 * an mehreren Stellen, und der Owner sah davon nichts — weder die verschluckte Rechnung noch 55 Korrektur-Sperren in einer
 * Woche. Jetzt zählt jede Verwerf-Stelle hier mit Grund, und die Lage (App-Kachel und Chat-Kontext) nennt die letzten 24 h.
 * Prozessweit, deterministisch; die Einzelheiten stehen weiter in den Logzeilen der jeweiligen Stelle.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type ZustellGrund = 'korrektur' | 'aufgabe' | 'abgelaufen' | 'widerspruch' | 'vorrede' | 'wiederholung';

/** Reihenfolge = Bedeutung für den Owner: was echte Inhalte gekostet haben kann, zuerst. */
const TEXT: Record<ZustellGrund, string> = {
  korrektur: 'durch deine Korrekturen',
  aufgabe: 'geplante Aufgabe ohne Neues',
  abgelaufen: 'aufgeschoben und abgelaufen (in der App unter „Hinweise")',
  widerspruch: 'widersprachen Live-Daten',
  vorrede: 'Vorreden des Modells',
  wiederholung: 'Wiederholungen',
};

const FENSTER_MS = 24 * 3_600_000;

export class ZustellProtokoll {
  private eintraege: Array<{ am: number; grund: ZustellGrund; n: number }> = [];
  private datei?: string;

  /** v1428 — Lage zeigte nach jedem Neustart 0 („24 h" stimmte nicht): Einträge in einer kleinen Datei halten. Idempotent. */
  dauerhaft(datei: string, jetzt = Date.now()): void {
    if (this.datei) return;
    this.datei = datei;
    try {
      const alt = JSON.parse(readFileSync(datei, 'utf8')) as Array<{ am: number; grund: ZustellGrund; n: number }>;
      if (Array.isArray(alt)) this.eintraege = [...alt.filter(e => typeof e?.am === 'number' && e.grund in TEXT && typeof e.n === 'number'), ...this.eintraege];
    } catch { /* keine Datei */ }
    this.eintraege = this.eintraege.filter(e => jetzt - e.am < FENSTER_MS);
    this.sichere();
  }

  private sichere(): void {
    if (!this.datei) return;
    try { mkdirSync(path.dirname(this.datei), { recursive: true }); writeFileSync(this.datei, JSON.stringify(this.eintraege)); } catch { /* Zähler ist Anzeige */ }
  }

  merke(grund: ZustellGrund, n = 1, jetzt = Date.now()): void {
    if (n <= 0) return;
    this.eintraege.push({ am: jetzt, grund, n });
    this.eintraege = this.eintraege.filter(e => jetzt - e.am < FENSTER_MS);
    this.sichere();
  }

  zaehlung24h(jetzt = Date.now()): Partial<Record<ZustellGrund, number>> {
    const z: Partial<Record<ZustellGrund, number>> = {};
    for (const e of this.eintraege) if (jetzt - e.am < FENSTER_MS) z[e.grund] = (z[e.grund] ?? 0) + e.n;
    return z;
  }
}

/** Eine Lage-Zeile, oder null wenn nichts verworfen wurde. */
export function nichtZugestelltZeile(z: Partial<Record<ZustellGrund, number>>): string | null {
  const teile = (Object.keys(TEXT) as ZustellGrund[]).filter(g => (z[g] ?? 0) > 0).map(g => `${z[g]} ${TEXT[g]}`);
  return teile.length ? `Nicht zugestellt (24 h): ${teile.join(', ')} — Einzelheiten im Log.` : null;
}

/** Prozessweites Protokoll (Reasoning, Scheduler, Lage teilen sich eine Instanz). */
export const zustellProtokoll = new ZustellProtokoll();
