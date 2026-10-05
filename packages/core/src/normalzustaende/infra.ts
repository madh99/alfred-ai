/**
 * Jarvis Schicht 1 — Weltmodell, Quelle Infrastruktur (MikroTik).
 *
 * Korrektur des Owners (15.04.2026): „Die als down erkannten MikroTik-Interfaces
 * sind aktuell nicht kritisch und spielen für die IPv4-Konnektivität keine Rolle.
 * Down-Status dieser Interfaces nicht pauschal als IPv4-Problem oder kritischen
 * Incident interpretieren." Deterministisch heißt das: ein Interface, das seit
 * Tagen down ist, ist Bestand (bekannt, unkritisch); ein Interface, das HEUTE
 * down ging, ist das Signal. Die Historie liefert der Monitor-Job (messwerte,
 * Quelle mikrotik-down, ein Punkt je Lauf und Interface).
 */

export interface DownPunkt { entity: string; zeit: string }
export interface MikrotikDeutung { zeilen: string[]; auffaellig: string[] }

export const NEU_DOWN_STUNDEN = 24;
export const BESTAND_DOWN_TAGE = 7;

const zeitKurz = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Beginn der aktuellen Down-Phase: ältester Punkt der lückenlosen Kette (Lücke > 2 h = neue Phase). */
export function downSeit(punkte: DownPunkt[], jetzt: Date, maxLueckeStunden = 2): string | undefined {
  const sortiert = [...punkte].map(p => Date.parse(p.zeit)).filter(Number.isFinite).sort((a, b) => b - a);
  if (sortiert.length === 0) return undefined;
  if (jetzt.getTime() - sortiert[0] > maxLueckeStunden * 3600_000) return undefined; // aktuell nicht down
  let start = sortiert[0];
  for (let i = 1; i < sortiert.length; i++) {
    if (start - sortiert[i] > maxLueckeStunden * 3600_000) break;
    start = sortiert[i];
  }
  return new Date(start).toISOString();
}

export function deuteMikrotik(input: { aktuellDown: string[]; verlauf: DownPunkt[]; jetzt?: Date; routerText?: string }): MikrotikDeutung {
  const jetzt = input.jetzt ?? new Date();
  const zeilen: string[] = []; const auffaellig: string[] = [];
  if (input.aktuellDown.length === 0) {
    zeilen.push(`**Interfaces:** alle up${input.routerText ? ` · ${input.routerText}` : ''} ↳ NORMAL`);
    return { zeilen, auffaellig };
  }
  const teile: string[] = [];
  for (const iface of input.aktuellDown) {
    const seit = downSeit(input.verlauf.filter(p => p.entity === iface), jetzt) ?? jetzt.toISOString();
    const stunden = (jetzt.getTime() - Date.parse(seit)) / 3600_000;
    if (stunden < NEU_DOWN_STUNDEN) {
      teile.push(`⚠️ ${iface} NEU down seit ${zeitKurz(seit)} → prüfen`);
      auffaellig.push(`mikrotik:${iface}:neu-down`);
    } else if (stunden >= BESTAND_DOWN_TAGE * 24) {
      teile.push(`${iface} down seit ${Math.round(stunden / 24)} Tagen ↳ Bestand, laut Korrektur (15.04.) nicht kritisch für IPv4 — NICHT melden`);
    } else {
      teile.push(`${iface} down seit ${Math.round(stunden / 24)} Tagen ↳ bekannt, beobachten — kein neuer Incident`);
    }
  }
  zeilen.push(`**Interfaces down:** ${teile.join(' · ')}${input.routerText ? ` · ${input.routerText}` : ''}`);
  return { zeilen, auffaellig };
}
