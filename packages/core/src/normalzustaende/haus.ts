/**
 * Jarvis Schicht 1/2 — Weltmodell „Haus": Anwesenheit, Öffnungen, Rauch/CO/Wasser, Alarm.
 *
 * Deterministische Deutung der Home-Assistant-Zustände, die für Ereignisse
 * zählen. Regeln statt Rohtabelle: Eine offene Tür ist normal, solange jemand
 * zu Hause ist; bei Abwesenheit ist sie das Signal. Rauch, CO und Wasser sind
 * immer Signal. Kameras (Doorbell/PTZ) zählen nicht als Innenraum-Bewegung.
 */

export interface HaZustand {
  entity_id: string;
  state: string;
  attributes?: { device_class?: string; friendly_name?: string; [k: string]: unknown };
  last_changed?: string;
}

export interface HausDeutung { zeilen: string[]; auffaellig: string[]; alleAbwesend: boolean; personen: Array<{ name: string; zuhause: boolean }> }

const OEFFNUNG = new Set(['door', 'window', 'opening', 'garage_door']);
const KAMERA = /doorbell|ptz|g4_|g5_|camera|kamera/i;

const zeitKurz = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const name = (s: HaZustand) => (s.attributes?.friendly_name as string | undefined)?.replace(/\s+/g, ' ').trim() || s.entity_id;

export function deuteHaus(zustaende: HaZustand[], now = new Date()): HausDeutung {
  const zeilen: string[] = []; const auffaellig: string[] = [];
  const gueltig = zustaende.filter(z => z.state !== 'unavailable' && z.state !== 'unknown');

  const personen = gueltig.filter(z => z.entity_id.startsWith('person.')).map(z => ({ name: z.entity_id.slice('person.'.length), zuhause: z.state === 'home' }));
  const alleAbwesend = personen.length > 0 && personen.every(p => !p.zuhause);
  if (personen.length) {
    zeilen.push(`**Anwesenheit:** ${personen.map(p => `${p.name}: ${p.zuhause ? 'zuhause' : 'abwesend'}`).join(', ')}${alleAbwesend ? ' ↳ niemand zu Hause' : ''}`);
  }

  const bin = gueltig.filter(z => z.entity_id.startsWith('binary_sensor.'));
  const dc = (z: HaZustand) => String(z.attributes?.device_class ?? '');

  for (const z of bin.filter(z => (dc(z) === 'smoke' || dc(z) === 'carbon_monoxide') && z.state === 'on')) {
    zeilen.push(`**⚠️ ${dc(z) === 'smoke' ? 'RAUCH' : 'CO'}:** ${name(z)} meldet ${dc(z) === 'smoke' ? 'Rauch' : 'Kohlenmonoxid'} seit ${zeitKurz(z.last_changed)} → SOFORT prüfen`);
    auffaellig.push(`haus:${dc(z) === 'smoke' ? 'rauch' : 'co'}:${z.entity_id}`);
  }
  for (const z of bin.filter(z => dc(z) === 'moisture' && z.state === 'on' && !/rain|regen|wetter/i.test(z.entity_id + name(z)))) {
    zeilen.push(`**⚠️ WASSER:** ${name(z)} meldet Feuchtigkeit seit ${zeitKurz(z.last_changed)} → prüfen`);
    auffaellig.push(`haus:wasser:${z.entity_id}`);
  }

  const offen = bin.filter(z => OEFFNUNG.has(dc(z)) && z.state === 'on');
  if (offen.length) {
    const teile = offen.map(z => `${name(z).replace(/ Tür$/, '')} (seit ${zeitKurz(z.last_changed)})`);
    if (alleAbwesend) {
      zeilen.push(`**⚠️ Offen bei Abwesenheit:** ${teile.join(', ')} → prüfen`);
      for (const z of offen) auffaellig.push(`haus:offen-bei-abwesenheit:${z.entity_id}`);
    } else {
      zeilen.push(`**Offen:** ${teile.join(', ')} ↳ NORMAL (jemand zu Hause)`);
    }
  } else if (bin.some(z => OEFFNUNG.has(dc(z)))) {
    zeilen.push('**Türen/Fenster:** alle geschlossen ↳ NORMAL');
  }

  const bewegung = bin.filter(z => (dc(z) === 'occupancy' || dc(z) === 'motion') && z.state === 'on' && !KAMERA.test(z.entity_id + name(z)));
  if (alleAbwesend && bewegung.length) {
    zeilen.push(`**⚠️ Bewegung bei Abwesenheit:** ${bewegung.map(z => `${name(z)} (${zeitKurz(z.last_changed)})`).join(', ')} → prüfen`);
    for (const z of bewegung) auffaellig.push(`haus:bewegung-bei-abwesenheit:${z.entity_id}`);
  }

  for (const z of gueltig.filter(z => z.entity_id.startsWith('alarm_control_panel.'))) {
    if (z.state === 'triggered') { zeilen.push(`**⚠️ ALARM:** ${name(z)} ausgelöst seit ${zeitKurz(z.last_changed)}`); auffaellig.push(`haus:alarm:${z.entity_id}`); }
    else zeilen.push(`**Alarmanlage:** ${name(z)} ${z.state.replace(/_/g, ' ')} ↳ ${alleAbwesend && z.state === 'disarmed' ? 'Hinweis: niemand zu Hause, nicht scharf' : 'NORMAL'}`);
  }
  void now;
  return { zeilen, auffaellig, alleAbwesend, personen };
}

/** Welche Zustandsänderung ist ein Ereignis? Rein, testbar. */
export type HausEreignisTyp = 'rauch' | 'co' | 'wasser' | 'alarm' | 'anwesenheit' | 'oeffnung' | 'bewegung';

export function klassifiziereHausEreignis(alt: HaZustand | undefined, neu: HaZustand): { typ: HausEreignisTyp; cooldownMin: number } | undefined {
  if (!neu || neu.state === 'unavailable' || neu.state === 'unknown') return undefined;
  if (alt && alt.state === neu.state) return undefined;
  const d = String(neu.attributes?.device_class ?? '');
  if (neu.entity_id.startsWith('person.')) return { typ: 'anwesenheit', cooldownMin: 30 };
  if (neu.entity_id.startsWith('alarm_control_panel.') && neu.state === 'triggered') return { typ: 'alarm', cooldownMin: 10 };
  if (!neu.entity_id.startsWith('binary_sensor.')) return undefined;
  if (d === 'smoke' && neu.state === 'on') return { typ: 'rauch', cooldownMin: 10 };
  if (d === 'carbon_monoxide' && neu.state === 'on') return { typ: 'co', cooldownMin: 10 };
  if (d === 'moisture' && neu.state === 'on' && !/rain|regen|wetter/i.test(neu.entity_id)) return { typ: 'wasser', cooldownMin: 30 };
  if (OEFFNUNG.has(d)) return { typ: 'oeffnung', cooldownMin: 30 };
  if ((d === 'occupancy' || d === 'motion') && neu.state === 'on' && !KAMERA.test(neu.entity_id)) return { typ: 'bewegung', cooldownMin: 60 };
  return undefined;
}
