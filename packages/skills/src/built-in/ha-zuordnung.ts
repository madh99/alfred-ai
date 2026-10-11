/**
 * v1358 — Zuordnung Melder → Automation → Licht/Schalter aus den Home-Assistant-Konfigurationen.
 *
 * Realfall 11.10. 23:53: history_summary mit Namensfilter „licht" fand nur das Waschkammerl — die übrigen Lichtschalter
 * heißen technisch (shelly1pmminig3_…), Alfred delegierte darum eine Tiefensuche (17 Opus-Runden, ssh, MQTT).
 * Die Zuordnung steht aber in den Automationen selbst. Sie wird hier nicht als Fakt gemerkt, sondern bei Bedarf aus
 * Home Assistant gelesen (höchstens alle 30 min) und mit dem letzten Stand verglichen: Sensortausch, stillgelegte oder
 * geänderte Automationen und Verweise auf nicht mehr vorhandene Entitäten werden als Änderung festgehalten.
 * Reine Funktionen — das Laden steckt im Skill.
 */

export interface Bezug { entity?: string; geraet?: string; domain?: string; typ?: string }

const ENTITAET = /^[a-z_]+\.[a-z0-9_]+$/;
const IM_TEXT = /\b([a-z_]+)\.([a-z0-9_]+)\b/g;

/** Alle Entitäts- und Geräteverweise eines Konfigurationsteils (Trigger, Bedingungen oder Aktionen), rekursiv. */
export function bezuegeAus(teil: unknown, domains: Set<string>, out: Bezug[] = []): Bezug[] {
  if (Array.isArray(teil)) { for (const x of teil) bezuegeAus(x, domains, out); return out; }
  if (!teil || typeof teil !== 'object') {
    if (typeof teil === 'string') for (const m of teil.matchAll(IM_TEXT)) if (domains.has(m[1])) out.push({ entity: `${m[1]}.${m[2]}` });
    return out;
  }
  const o = teil as Record<string, unknown>;
  const geraeteBezug = typeof o.device_id === 'string';
  if (geraeteBezug) out.push({ geraet: o.device_id as string, domain: typeof o.domain === 'string' ? o.domain : undefined, typ: typeof o.type === 'string' ? o.type : undefined });
  for (const [k, v] of Object.entries(o)) {
    // Dienstnamen („switch.turn_off") und Trigger-Arten sind keine Entitäten
    if ((k === 'service' || k === 'action' || k === 'trigger' || k === 'platform' || k === 'condition') && typeof v === 'string') continue;
    if (k === 'device_id' || k === 'alias' || k === 'description' || k === 'id') continue;
    // bei Geräte-Triggern/-Aktionen ist entity_id eine Registry-ID, kein Name
    if (k === 'entity_id' && geraeteBezug) continue;
    if (k === 'entity_id') {
      for (const e of Array.isArray(v) ? v : [v]) {
        if (typeof e !== 'string') continue;
        for (const x of e.split(',')) { const t = x.trim(); if (ENTITAET.test(t) && domains.has(t.split('.')[0])) out.push({ entity: t }); }
      }
      continue;
    }
    bezuegeAus(v, domains, out);
  }
  return out;
}

export interface EntitaetInfo { state: string; deviceClass?: string; name?: string }
/** Geräte-ID → Entitäten (aus device_entities) */
export type GeraeteEntitaeten = Map<string, string[]>;

const BEWEGUNG_TYP = /motion|occup|presence|moving/i;
const BEWEGUNG_KLASSE = new Set(['occupancy', 'motion', 'presence', 'moving']);

/** Geräteverweis → konkrete Entitäten: nach Domain, bei Bewegungs-Typen nach Melder-Klasse. */
export function loeseGeraetAuf(b: Bezug, geraete: GeraeteEntitaeten, info: Map<string, EntitaetInfo>): string[] {
  let k = geraete.get(b.geraet ?? '') ?? [];
  if (b.domain) k = k.filter(e => e.startsWith(`${b.domain}.`));
  if (b.typ && BEWEGUNG_TYP.test(b.typ)) {
    const m = k.filter(e => BEWEGUNG_KLASSE.has(info.get(e)?.deviceClass ?? ''));
    if (m.length > 0) k = m;
  }
  return k.slice(0, 3);
}

export interface AutoZuordnung {
  entityId: string;
  name: string;
  aktiv: boolean;
  letzteAusloesung?: string;
  ausloeser: string[];
  bedingungen: string[];
  ziele: string[];
  /** verwiesen, aber in Home Assistant nicht (mehr) vorhanden — Sensortausch? */
  fehlend: string[];
  /** Konfiguration nicht lesbar (z. B. YAML ohne id) */
  ohneKonfig?: boolean;
}
export interface HaZuordnung { stand: string; automationen: AutoZuordnung[] }

export interface AutoQuelle { entityId: string; name: string; aktiv: boolean; letzteAusloesung?: string; konfig?: Record<string, unknown> }

export function baueZuordnung(quellen: AutoQuelle[], geraete: GeraeteEntitaeten, info: Map<string, EntitaetInfo>, jetzt = new Date()): HaZuordnung {
  const domains = new Set([...info.keys()].map(e => e.split('.')[0]));
  const automationen: AutoZuordnung[] = [];
  for (const q of quellen) {
    const fehlend = new Set<string>();
    const teil = (...schluessel: string[]): string[] => {
      const out = new Set<string>();
      for (const s of schluessel) {
        for (const b of bezuegeAus(q.konfig?.[s], domains)) {
          if (b.entity) { if (b.entity === q.entityId) continue; out.add(b.entity); if (!info.has(b.entity)) fehlend.add(b.entity); continue; }
          const aufgeloest = loeseGeraetAuf(b, geraete, info);
          if (aufgeloest.length === 0) fehlend.add(`Gerät ${b.geraet}${b.domain ? ` (${b.domain})` : ''}`);
          for (const e of aufgeloest) out.add(e);
        }
      }
      return [...out].sort();
    };
    automationen.push({
      entityId: q.entityId, name: q.name, aktiv: q.aktiv, letzteAusloesung: q.letzteAusloesung,
      ausloeser: teil('trigger', 'triggers'), bedingungen: teil('condition', 'conditions'), ziele: teil('action', 'actions'),
      fehlend: [...fehlend].sort(), ...(q.konfig ? {} : { ohneKonfig: true }),
    });
  }
  automationen.sort((a, b) => a.entityId.localeCompare(b.entityId));
  return { stand: jetzt.toISOString(), automationen };
}

/** Automationen, die die Entität schalten bzw. von ihr ausgelöst werden. */
export const steuerndeAutomationen = (z: HaZuordnung, entityId: string) => z.automationen.filter(a => a.ziele.includes(entityId));
export const ausgeloesteAutomationen = (z: HaZuordnung, entityId: string) => z.automationen.filter(a => a.ausloeser.includes(entityId));

/** Unterschiede zwischen zwei Ständen — in Worten, für Änderungsprotokoll und Logzeile. */
export function zuordnungsAenderungen(alt: HaZuordnung, neu: HaZuordnung): string[] {
  const a = new Map(alt.automationen.map(x => [x.entityId, x]));
  const n = new Map(neu.automationen.map(x => [x.entityId, x]));
  const out: string[] = [];
  const diff = (was: string, vorher: string[], nachher: string[]) => {
    const weg = vorher.filter(x => !nachher.includes(x)), dazu = nachher.filter(x => !vorher.includes(x));
    return weg.length || dazu.length ? [`${was}${weg.length ? ` − ${weg.join(', ')}` : ''}${dazu.length ? ` + ${dazu.join(', ')}` : ''}`] : [];
  };
  for (const [id, x] of n) {
    const y = a.get(id);
    if (!y) { out.push(`neue Automation „${x.name}" (${id})`); continue; }
    const teile = [
      ...(y.aktiv !== x.aktiv ? [x.aktiv ? 'wieder aktiviert' : 'deaktiviert'] : []),
      ...(y.name !== x.name ? [`umbenannt von „${y.name}"`] : []),
      ...diff('Auslöser', y.ausloeser, x.ausloeser), ...diff('Bedingungen', y.bedingungen, x.bedingungen), ...diff('Ziele', y.ziele, x.ziele),
      ...x.fehlend.filter(f => !y.fehlend.includes(f)).map(f => `verweist jetzt auf fehlende ${f}`),
    ];
    if (teile.length) out.push(`Automation „${x.name}": ${teile.join('; ')}`);
  }
  for (const [id, y] of a) if (!n.has(id)) out.push(`Automation „${y.name}" (${id}) entfernt`);
  return out;
}

/** Zeilen für Entitätsdetails: wer schaltet sie, was löst sie aus, kaputte Verweise. */
export function zuordnungsZeilen(z: HaZuordnung, entityId: string, name: (e: string) => string): string[] {
  const out: string[] = [];
  const zustand = (a: AutoZuordnung) => (a.aktiv ? '' : ' [DEAKTIVIERT]');
  for (const a of steuerndeAutomationen(z, entityId).slice(0, 6)) {
    out.push(`geschaltet von Automation „${a.name}"${zustand(a)}${a.ausloeser.length ? ` (Auslöser: ${a.ausloeser.slice(0, 3).map(name).join(', ')})` : ''}${a.fehlend.length ? ` — VERWEIST AUF FEHLENDE ${a.fehlend.join(', ')}` : ''}`);
  }
  for (const a of ausgeloesteAutomationen(z, entityId).slice(0, 6)) {
    out.push(`löst Automation „${a.name}"${zustand(a)} aus${a.ziele.length ? ` → ${a.ziele.slice(0, 3).map(name).join(', ')}` : ''}`);
  }
  return out;
}
