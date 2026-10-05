import { bewerteGegenBaseline, trendProStunde, type Stichprobe } from './baseline.js';

/**
 * Jarvis Schicht 1 — Weltmodell, Quelle Energie & Haus (Home-Assistant-Entitäten).
 *
 * Aus den konfigurierten Entitäten (Memory `briefing_ha_entities`) und ihrem
 * Verlauf (Tabelle `messwerte`) entstehen Zustände mit Deutung. Die manuellen
 * Normalzustände des Owners sind hier Regel, nicht Prompt-Text:
 * - „15 % bei der ESS-Batterie ist der konfigurierte Mindest-SoC, nicht der
 *   aktuelle Ladestand" (Korrektur 16.08.)
 * - „Lademanagement: wurde in den letzten 30 Tagen 100 % erreicht?" (Regel 18.05.)
 * - „Hausbatterie ist nicht Teil der BMW-Fahrtplanung" (17.04.)
 * Baselines (Median je Tagesstunde) bleiben beobachtend, bis ≥ 10 Stichproben vorliegen.
 */

export interface EnergieMesswert { entity: string; name?: string; wert?: number; text?: string; einheit?: string; zeit: string }
export interface EnergieEingabe { aktuell: EnergieMesswert[]; verlauf: EnergieMesswert[]; jetzt?: Date }
export interface EnergieDeutung { zeilen: string[]; auffaellig: string[] }

export const SOC_NIEDRIG = 20;
export const VOLLLADUNG_PROZENT = 99;
export const VOLLLADUNG_REGEL_TAGE = 30;

type Rolle = 'soc' | 'minSoc' | 'power' | 'state' | 'plan' | 'allowed' | 'pvPower' | 'pvToday' | 'consumptionToday' | 'temperature' | 'sonst';

export function rolleVon(m: Pick<EnergieMesswert, 'entity' | 'einheit'>): Rolle {
  const e = m.entity.toLowerCase();
  if (/min(imum)?_?soc|soc_min|minimum_soc/.test(e)) return 'minSoc';
  if (/battery_soc|(^|[._])soc$/.test(e)) return 'soc';
  if (/battery_power/.test(e)) return 'power';
  if (/battery_state/.test(e)) return 'state';
  if (/charge_plan/.test(e)) return 'plan';
  if (/^input_boolean\..*charg/.test(e)) return 'allowed';
  if (/pv_power/.test(e)) return 'pvPower';
  if (/pv_prod|daily_pv/.test(e)) return 'pvToday';
  if (/daily_energy|energie_bedarf|energy_kwh/.test(e)) return 'consumptionToday';
  if ((m.einheit ?? '').includes('°')) return 'temperature';
  return 'sonst';
}

const fmt = (n: number, stellen = 1) => n.toLocaleString('de-AT', { maximumFractionDigits: stellen });
const zeitKurz = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dauer = (ms: number) => { const h = ms / 3600_000; return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} Tagen`; };
const nameVon = (m: EnergieMesswert) => m.name ?? m.entity.split('.').pop()!.replace(/_/g, ' ');

function proben(verlauf: EnergieMesswert[], entity: string): Stichprobe[] {
  return verlauf.filter(v => v.entity === entity && typeof v.wert === 'number').map(v => ({ wert: v.wert!, zeit: v.zeit }));
}

function baselineText(wert: number, zeit: string, p: Stichprobe[], einheit: string): { text: string; auffaellig: boolean } {
  const b = bewerteGegenBaseline(wert, zeit, p);
  if (b.urteil === 'im-aufbau') return { text: `Baseline im Aufbau (${b.n} Stichproben zur Stunde)`, auffaellig: false };
  const richtung = (b.z ?? 0) > 0 ? 'über' : 'unter';
  if (b.urteil === 'auffaellig') return { text: `⚠️ deutlich ${richtung} der Baseline dieser Stunde (Median ${fmt(b.median!)} ${einheit}, n=${b.n})`, auffaellig: true };
  return { text: `NORMAL zur Stunde (Median ${fmt(b.median!)} ${einheit}, n=${b.n})`, auffaellig: false };
}

/** Ladeplan-Text: „… Sat, 18.07. 15:00 – 15:30 …" → Datum in der Vergangenheit? */
export function ladeplanLiegtZurueck(text: string, jetzt: Date): boolean | undefined {
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(?:\s*(\d{4}))?/);
  if (!m) return undefined;
  const tag = Number(m[1]); const monat = Number(m[2]) - 1;
  const jahr = m[3] ? Number(m[3]) : jetzt.getFullYear();
  const d = new Date(jahr, monat, tag, 23, 59);
  // ohne Jahr: liegt das Datum > 60 Tage zurück, ist es trotzdem „vergangen" (nicht nächstes Jahr unterstellen)
  return d.getTime() < jetzt.getTime() - 24 * 3600_000;
}

export function deuteEnergie(e: EnergieEingabe): EnergieDeutung | undefined {
  if (e.aktuell.length === 0) return undefined;
  const jetzt = e.jetzt ?? new Date();
  const zeilen: string[] = []; const auffaellig: string[] = [];
  const byRolle = new Map<Rolle, EnergieMesswert[]>();
  for (const m of e.aktuell) { const r = rolleVon(m); byRolle.set(r, [...(byRolle.get(r) ?? []), m]); }
  const first = (r: Rolle) => byRolle.get(r)?.[0];

  // Hausbatterie
  const soc = first('soc');
  if (soc && typeof soc.wert === 'number') {
    const teile = [`SoC ${fmt(soc.wert, 0)} %`];
    const power = first('power');
    const p = proben(e.verlauf, soc.entity);
    const trend = trendProStunde([...p, { wert: soc.wert, zeit: soc.zeit }], jetzt);
    if (power && typeof power.wert === 'number') {
      teile.push(power.wert < -20 ? `entlädt ${fmt(Math.abs(power.wert), 0)} W` : power.wert > 20 ? `lädt ${fmt(power.wert, 0)} W` : 'Ruhe (±0 W)');
    } else { const st = first('state'); if (st?.text) teile.push(st.text.toLowerCase()); }
    if (trend !== undefined && Math.abs(trend) >= 0.5) teile.push(`${trend > 0 ? '+' : '−'}${fmt(Math.abs(trend))} %/h`);
    const heute = p.filter(x => new Date(x.zeit).toDateString() === jetzt.toDateString()).map(x => x.wert);
    if (heute.length >= 2) teile.push(`heute ${fmt(Math.min(...heute), 0)}–${fmt(Math.max(...heute), 0)} %`);
    const voll = [...p].filter(x => x.wert >= VOLLLADUNG_PROZENT).sort((a, b) => Date.parse(b.zeit) - Date.parse(a.zeit))[0];
    const aeltesteProbe = p.length ? Math.min(...p.map(x => Date.parse(x.zeit))) : undefined;
    const abgedeckteTage = aeltesteProbe ? (jetzt.getTime() - aeltesteProbe) / 86_400_000 : 0;
    if (voll) teile.push(`Vollladung zuletzt ${zeitKurz(voll.zeit)} (vor ${dauer(jetzt.getTime() - Date.parse(voll.zeit))})`);
    else if (abgedeckteTage >= VOLLLADUNG_REGEL_TAGE) { teile.push(`⚠️ seit über ${VOLLLADUNG_REGEL_TAGE} Tagen keine Vollladung (Regel Lademanagement)`); auffaellig.push('hausbatterie:vollladung'); }
    else if (p.length) teile.push(`keine Vollladung in den beobachteten ${Math.max(1, Math.round(abgedeckteTage))} Tagen (Regel prüft 30 Tage — Beobachtung läuft)`);
    const b = baselineText(soc.wert, soc.zeit, p, '%');
    if (soc.wert <= SOC_NIEDRIG) { teile.push(`⚠️ niedrig (≤ ${SOC_NIEDRIG} %)`); auffaellig.push('hausbatterie:niedrig'); }
    else { teile.push(`↳ ${b.text}`); if (b.auffaellig) auffaellig.push('hausbatterie:baseline'); }
    teile.push('nicht Teil der BMW-Fahrtplanung');
    zeilen.push(`**Hausbatterie:** ${teile.join(' · ')}`);
  }
  const minSoc = first('minSoc');
  if (minSoc && typeof minSoc.wert === 'number') {
    zeilen.push(`**Mindest-SoC:** ${fmt(minSoc.wert, 0)} % — Konfiguration (ESS-Untergrenze), KEIN aktueller Ladestand, NICHT als Batteriealarm melden`);
  }

  // Netzladung
  const allowed = first('allowed'); const plan = first('plan');
  if (allowed || plan) {
    const teile: string[] = [];
    if (allowed) teile.push(`Netzladung erlaubt: ${(allowed.text ?? '').toLowerCase() === 'on' ? 'ja' : 'nein'} (setzt die Automation)`);
    if (plan?.text) {
      teile.push(`Ladeplan: „${plan.text}"`);
      const zurueck = ladeplanLiegtZurueck(plan.text, jetzt);
      if (zurueck === true) teile.push('↳ Fenster liegt in der Vergangenheit — derzeit KEIN geplantes Ladefenster, kein Handlungsbedarf');
    }
    zeilen.push(`**Netzladung:** ${teile.join(' · ')}`);
  }

  // PV & Verbrauch
  const pv = first('pvPower');
  if (pv && typeof pv.wert === 'number') {
    const teile = [`PV ${fmt(pv.wert, 0)} W`];
    const pvToday = first('pvToday'); const cons = first('consumptionToday');
    if (pvToday && typeof pvToday.wert === 'number') teile.push(`Ertrag heute ${fmt(pvToday.wert, 2)} kWh`);
    if (cons && typeof cons.wert === 'number') teile.push(`Verbrauch heute ${fmt(cons.wert, 2)} kWh`);
    const h = jetzt.getHours();
    if (pv.wert <= 0 && (h >= 20 || h < 7)) teile.push('↳ nachts 0 W NORMAL');
    else {
      const b = baselineText(pv.wert, pv.zeit, proben(e.verlauf, pv.entity), 'W');
      teile.push(`↳ ${b.text}`); if (b.auffaellig) auffaellig.push('pv:baseline');
    }
    zeilen.push(`**PV:** ${teile.join(' · ')}`);
  }

  // Temperaturen und sonstige Zahlen: Baseline je Stunde
  for (const r of ['temperature', 'sonst'] as Rolle[]) {
    for (const m of byRolle.get(r) ?? []) {
      if (typeof m.wert === 'number') {
        const b = baselineText(m.wert, m.zeit, proben(e.verlauf, m.entity), m.einheit ?? '');
        zeilen.push(`**${nameVon(m)}:** ${fmt(m.wert)} ${m.einheit ?? ''} ↳ ${b.text}`.replace(/\s+↳/, ' ↳'));
        if (b.auffaellig) auffaellig.push(`${m.entity}:baseline`);
      } else if (m.text) {
        zeilen.push(`**${nameVon(m)}:** ${m.text}`);
      }
    }
  }
  return { zeilen, auffaellig };
}
