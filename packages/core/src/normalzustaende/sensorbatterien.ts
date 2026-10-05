/**
 * Jarvis Schicht 1 — Weltmodell, Quelle Sensorbatterien.
 *
 * Realfall Mai–August 2026: „KRITISCHE BATTERIE-WARNUNGEN – SOFORT HANDELN!" —
 * Handys, Zigbee-Sensoren und der ESS-Mindest-SoC (15 %, Konfiguration) landeten
 * in einem Topf, als Insights, Incidents und Erinnerungen, wochenlang. Hier wird
 * deterministisch getrennt: Mobilgeräte laden sich selbst (Korrektur SM-S928B),
 * Konfigurationswerte sind keine Ladestände, Hausbatterie-SoC gehört zur
 * Energie-Deutung. Bewertet werden nur echte Sensorbatterien — mit Trend aus
 * dem Verlauf statt Panik aus einer Momentaufnahme.
 */

export interface SensorBatterie { entity: string; name?: string; wert?: number; zeit: string; verfuegbar?: boolean }
export interface BatterieVerlaufPunkt { entity: string; wert?: number; zeit: string }
export interface SensorbatterienDeutung { zeilen: string[]; auffaellig: string[] }

import { klassifiziereBatterie, type BatterieKlasse } from '@alfred/skills';
export type { BatterieKlasse };

export const LEER_PROZENT = 5;
export const NIEDRIG_PROZENT = 20;
export const EINZELN_AB_PROZENT = 50;

/** v1172 — gemeinsame Klassifikation mit dem Monitor-Skill (Schreiber und Leser urteilen gleich). */
export const klassifiziere = klassifiziereBatterie;

const zeitKurz = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const tage = (ms: number) => Math.round(ms / 86_400_000);
const fmt = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 1 });

/** Linearer Trend in %/Tag über den Verlauf (mindestens 2 Punkte, ≥ 2 Tage Abstand). */
export function trendProTag(punkte: BatterieVerlaufPunkt[]): number | undefined {
  const p = punkte.filter(x => typeof x.wert === 'number').sort((a, b) => Date.parse(a.zeit) - Date.parse(b.zeit));
  if (p.length < 2) return undefined;
  const a = p[0]; const b = p[p.length - 1];
  const dTage = (Date.parse(b.zeit) - Date.parse(a.zeit)) / 86_400_000;
  if (dTage < 2) return undefined;
  return (b.wert! - a.wert!) / dTage;
}

export function deuteSensorbatterien(input: { sensoren: SensorBatterie[]; verlauf: BatterieVerlaufPunkt[]; jetzt?: Date }): SensorbatterienDeutung | undefined {
  if (input.sensoren.length === 0) return undefined;
  const jetzt = input.jetzt ?? new Date();
  const zeilen: string[] = []; const auffaellig: string[] = [];
  const gruppen: Record<BatterieKlasse, SensorBatterie[]> = { mobilgeraet: [], konfiguration: [], hausbatterie: [], sensor: [] };
  for (const s of input.sensoren) gruppen[klassifiziere(s.entity, s.name)].push(s);

  const sensoren = gruppen.sensor;
  if (sensoren.length > 0) {
    const teile: string[] = [`${sensoren.length} Sensoren`];
    const einzeln: string[] = [];
    let minOk: number | undefined;
    for (const s of [...sensoren].sort((a, b) => (a.wert ?? 101) - (b.wert ?? 101))) {
      const name = s.name ?? s.entity;
      if (s.verfuegbar === false || s.wert === undefined) {
        einzeln.push(`⚠️ ${name}: nicht erreichbar (zuletzt ${zeitKurz(s.zeit)}) → Sensor prüfen`);
        auffaellig.push(`sensorbatterie:${s.entity}:offline`);
        continue;
      }
      if (s.wert > EINZELN_AB_PROZENT) { minOk = minOk === undefined ? s.wert : Math.min(minOk, s.wert); continue; }
      const verlauf = input.verlauf.filter(v => v.entity === s.entity);
      const trend = trendProTag([...verlauf, { entity: s.entity, wert: s.wert, zeit: s.zeit }]);
      const alterTage = tage(jetzt.getTime() - Date.parse(s.zeit));
      if (s.wert <= LEER_PROZENT) {
        const stillSeit = alterTage >= 3 ? ` — Wert unverändert seit ${alterTage} Tagen, vermutlich meldet der Sensor nicht mehr` : '';
        einzeln.push(`⚠️ ${name}: ${fmt(s.wert)} % leer → Batterie tauschen${stillSeit}`);
        auffaellig.push(`sensorbatterie:${s.entity}:leer`);
      } else if (s.wert <= NIEDRIG_PROZENT) {
        const eta = trend !== undefined && trend < -0.05 ? ` (−${fmt(Math.abs(trend) * 7)} %/Woche → leer in ~${Math.max(1, Math.round((s.wert - LEER_PROZENT) / Math.abs(trend) / 7))} Wochen)` : '';
        einzeln.push(`⚠️ ${name}: ${fmt(s.wert)} % niedrig${eta} → Ersatz bereitlegen`);
        auffaellig.push(`sensorbatterie:${s.entity}:niedrig`);
      } else {
        const t = trend === undefined ? 'Trend im Aufbau' : Math.abs(trend) < 0.05 ? 'stabil' : `${trend > 0 ? '+' : '−'}${fmt(Math.abs(trend) * 7)} %/Woche`;
        einzeln.push(`${name}: ${fmt(s.wert)} % (${t}) ↳ NORMAL, kein Handlungsbedarf`);
      }
    }
    teile.push(...einzeln);
    if (minOk !== undefined) teile.push(`übrige ≥ ${fmt(minOk)} % ↳ NORMAL`);
    zeilen.push(`**Sensorbatterien:** ${teile.join(' · ')}`);
  }
  if (gruppen.mobilgeraet.length > 0) {
    zeilen.push(`**Mobilgeräte:** ${gruppen.mobilgeraet.length} Handys/Watches erfasst — laden sich selbst, NICHT bewerten und NICHT melden (Korrektur SM-S928B)`);
  }
  for (const k of gruppen.konfiguration) {
    if (k.wert !== undefined) zeilen.push(`**Konfiguration:** ${k.name ?? k.entity} ${fmt(k.wert)} % — Einstellwert (ESS-Untergrenze), KEIN Ladestand, nicht melden`);
  }
  return { zeilen, auffaellig };
}
