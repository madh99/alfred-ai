/**
 * v1372 — Nachforschen vor dem Melden, N1 (Spec Jarvis „Nachforschen vor dem Melden", Prüfung 12.10., Owner-Freigabe 12.10.).
 *
 * Prüfrezept = feste Leseschritte für eine Art Befund (Quelle + Gegenstand). Die Schritte führt der Code ohne Modell aus;
 * nur der Lese-Katalog ist erlaubt — durchgesetzt hier (vor dem Lauf) und im Läufer (bei jedem Aufruf), nicht im Prompt.
 * Referenzrezepte für Haus und Licht nutzen die verdichteten HA-Aktionen aus v1357/v1358 (history_summary, relations) statt
 * Rohverlauf; das Logbuch nur mit Entität und kurzem Zeitraum (Lektion 12.10.: ungefiltert 34 MB am Tag).
 */

export interface RezeptSchritt { werkzeug: string; aktion: string; params: Record<string, string | number>; zweck: string }

export interface Rezept {
  id: string;
  muster: { quelle: string; gegenstand: RegExp };
  schritte: RezeptSchritt[];
  deutungsfragen: string[];
  /** Was Alfred selbst tun darf (nur Lesen/Beobachten) — die Deutung darf nur diese nennen. */
  eigeneSchritte: string[];
  herkunft: 'referenz' | 'dynamisch' | 'chat' | 'owner';
}

export interface BefundKurz { id: string; quelle: string; gegenstand: string; titel: string; detail?: string; entstanden: string; vorgangId?: string }

/** Erlaubte Leseaktionen je Werkzeug; Prüfer liefert einen Fehlertext oder null. */
const PERIODE_TAGE = (p: string | undefined): number => {
  const m = /^(\d+)\s*([hd])$/.exec((p ?? '').trim());
  return m ? (m[2] === 'd' ? Number(m[1]) : Number(m[1]) / 24) : NaN;
};
export const LESE_KATALOG: Record<string, Record<string, (p: Record<string, unknown>) => string | null>> = {
  homeassistant: {
    state: p => (p.entityId ? null : 'state braucht entityId'),
    relations: p => (p.entityId || p.match ? null : 'relations braucht entityId oder match'),
    history_summary: p => (!(p.entities || p.entityId || p.area || (p.domain && p.match)) ? 'history_summary braucht entities, entityId, area oder domain mit match'
      : PERIODE_TAGE(String(p.period ?? '24h')) > 10 ? 'history_summary höchstens 10 Tage' : null),
    history: p => (!p.entityId ? 'history nur mit entityId' : PERIODE_TAGE(String(p.period ?? '24h')) > 7 ? 'history höchstens 7 Tage' : null),
    logbook: p => (!p.entityId ? 'logbook nur mit entityId (ungefiltert 34 MB/Tag)' : PERIODE_TAGE(String(p.period ?? '24h')) > 3 ? 'logbook höchstens 3 Tage' : null),
    areas: () => null,
  },
  // v1376 — Infra (Owner-Reihenfolge 12.10.: Haus/HA, dann Infra); nur Lesen, Listen begrenzt
  unifi: {
    list_devices: () => null,
    device_info: p => (p.mac ? null : 'device_info braucht mac'),
    site_stats: () => null,
    list_networks: () => null,
    list_alerts: p => (Number(p.limit ?? 0) > 0 && Number(p.limit) <= 50 ? null : 'list_alerts mit limit 1–50'),
    list_events: p => (Number(p.limit ?? 0) > 0 && Number(p.limit) <= 50 ? null : 'list_events mit limit 1–50'),
  },
  // v1380 — Wetter am Ort des Owners (PV-Rezept); der Skill liest nur (Open-Meteo)
  weather: {
    aktuell: p => (p.location ? null : 'Wetter braucht location'),
  },
  proxmox: {
    cluster_status: () => null,
    list_nodes: () => null,
    node_stats: () => null,
    list_vms: () => null,
    list_storage: () => null,
  },
};

export function pruefeSchritt(werkzeug: string, aktion: string, params: Record<string, unknown>): string | null {
  const w = LESE_KATALOG[werkzeug];
  if (!w) return `Werkzeug ${werkzeug} ist nicht im Lese-Katalog`;
  const a = w[aktion];
  if (!a) return `${werkzeug}.${aktion} ist keine erlaubte Leseaktion`;
  return a(params);
}

/**
 * Platzhalter aus dem Befund: {entity} (das Segment des Gegenstands, das eine Entität ist — „sensorbatterie:sensor.x:offline"
 * → sensor.x), {raum} (aus „Titel (Raum): …").
 */
export function platzhalterAus(b: BefundKurz): Record<string, string> {
  const p: Record<string, string> = {};
  const entitaet = b.gegenstand.split(':').reverse().find(s => /^[a-z_]+\.[a-z0-9_]+$/i.test(s));
  if (entitaet) p.entity = entitaet;
  const raum = /\(([^()]{2,40})\)\s*:/.exec(b.titel)?.[1];
  if (raum) p.raum = raum.trim();
  return p;
}

export function fuelleParams(params: Record<string, string | number>, platz: Record<string, string>): { params: Record<string, string | number>; fehlt: string[] } {
  const fehlt: string[] = [];
  const aus: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number') { aus[k] = v; continue; }
    aus[k] = v.replace(/\{(\w+)\}/g, (_, n: string) => { if (platz[n] === undefined) { fehlt.push(n); return ''; } return platz[n]!; });
  }
  return { params: aus, fehlt };
}

/** Prüfung vor dem Lauf (deterministisch): ≤ 12 Schritte, alle im Lese-Katalog, Platzhalter auflösbar. */
export function pruefeRezept(r: Rezept, platz: Record<string, string>): string[] {
  const fehler: string[] = [];
  if (r.schritte.length === 0 || r.schritte.length > 12) fehler.push(`${r.schritte.length} Schritte (1–12 erlaubt)`);
  for (const s of r.schritte) {
    const { params, fehlt } = fuelleParams(s.params, platz);
    if (fehlt.length) fehler.push(`${s.werkzeug}.${s.aktion}: Platzhalter fehlt (${fehlt.join(', ')})`);
    const f = pruefeSchritt(s.werkzeug, s.aktion, params);
    if (f) fehler.push(f);
  }
  return fehler;
}

const BEOBACHTEN = 'Befund weiter beobachten und schließen, sobald er nicht mehr auffällig ist';

/** Referenzrezepte (Messlatte für N3, dynamische Rezepte). */
export const REFERENZ_REZEPTE: Rezept[] = [
  {
    id: 'licht-lange-an', herkunft: 'referenz',
    muster: { quelle: 'licht', gegenstand: /^licht:lange-an:(light|switch)\./ }, // v1373 auch Shelly-Schalter
    schritte: [
      { werkzeug: 'homeassistant', aktion: 'relations', params: { entityId: '{entity}' }, zweck: 'Schalter, Melder und Automationen dieses Lichts, letzte Auslösung' },
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { entityId: '{entity}', period: '3d', compareWith: '7d' }, zweck: 'Einschaltdauer und lange Phasen, Ursachen laut Logbuch' },
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { area: '{raum}', period: '3d', compareWith: '7d' }, zweck: 'Melder und Schalter im selben Raum: melden sie noch?' },
    ],
    deutungsfragen: [
      'Meldet der zuständige Bewegungsmelder noch (letzte Auslösung, nie ausgelöst)?',
      'Hat die Ausschalt-Automation zuletzt ausgelöst — wann?',
      'Wurde das Licht von Hand/über einen Schalter eingeschaltet (Ursachen)?',
      'Ist es ein Einzelfall oder betrifft es weitere Geräte derselben Integration?',
    ],
    eigeneSchritte: [BEOBACHTEN, 'Melder und Automation täglich weiter prüfen'],
  },
  {
    id: 'haus-offen-bei-abwesenheit', herkunft: 'referenz',
    muster: { quelle: 'haus', gegenstand: /^haus:(offen|bewegung)-bei-abwesenheit:binary_sensor\./ },
    schritte: [
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { entityId: '{entity}', period: '24h' }, zweck: 'seit wann offen bzw. aktiv, wie oft heute' },
      { werkzeug: 'homeassistant', aktion: 'relations', params: { entityId: '{entity}' }, zweck: 'Raum, Gerät und Automationen des Sensors' },
    ],
    deutungsfragen: ['Seit wann ist der Zustand so, und war es vor dem Weggehen schon so?', 'Kann es eine Fehlmeldung des Sensors sein (Aussetzer, unbekannt)?'],
    eigeneSchritte: [BEOBACHTEN],
  },
  {
    id: 'haus-sicherheit', herkunft: 'referenz',
    muster: { quelle: 'haus', gegenstand: /^haus:(rauch|co|wasser|alarm):/ },
    schritte: [
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { entityId: '{entity}', period: '24h' }, zweck: 'Verlauf des Melders: seit wann, wie oft' },
      { werkzeug: 'homeassistant', aktion: 'relations', params: { entityId: '{entity}' }, zweck: 'Raum und Gerät des Melders' },
    ],
    deutungsfragen: ['Seit wann meldet der Melder, und gab es heute schon Fehlalarme dieses Melders?'],
    eigeneSchritte: [BEOBACHTEN],
  },
  {
    id: 'sensorbatterie', herkunft: 'referenz',
    muster: { quelle: 'sensorbatterien', gegenstand: /^sensorbatterie:sensor\./ },
    schritte: [
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { entityId: '{entity}', period: '10d' }, zweck: 'Verlauf des Batteriestands: sinkend oder Sprung, seit wann unverändert' },
      { werkzeug: 'homeassistant', aktion: 'relations', params: { entityId: '{entity}' }, zweck: 'Gerät und Raum des Sensors' },
    ],
    deutungsfragen: ['Ist die Batterie wirklich leer (stetig gefallen) oder meldet das Gerät nicht mehr (Wert eingefroren)?'],
    eigeneSchritte: [BEOBACHTEN],
  },
];

REFERENZ_REZEPTE.push(
  {
    // v1380 — Realfall 12.10.: Vorgang „PV deutlich unter der Baseline" ohne Kontext; der Owner musste selbst herausfinden,
    // ob es nur bewölkt war. Das Rezept liest Wetter und die PV-/Wechselrichter-Sensoren gegen die Woche davor.
    id: 'pv-unter-baseline', herkunft: 'referenz',
    muster: { quelle: 'energie', gegenstand: /^pv:/ },
    schritte: [
      { werkzeug: 'weather', aktion: 'aktuell', params: { location: '{ort}' }, zweck: 'Wetter jetzt am Haus (Bewölkung, Sonne)' },
      { werkzeug: 'homeassistant', aktion: 'history_summary', params: { domain: 'sensor', match: 'pv,solar,dtu,hoymiles,wechselrichter,inverter,forecast', period: '24h', compareWith: '7d' }, zweck: 'PV-, Wechselrichter- und Prognose-Sensoren: letzte 24 h gegen die Woche davor' },
    ],
    deutungsfragen: ['Erklärt das Wetter (Bewölkung) den geringen Ertrag?', 'Liefern alle Wechselrichter bzw. Strings, oder fällt einer aus (nicht verfügbar, 0 W bei Sonne)?', 'Lag auch die Prognose (Forecast.Solar) niedrig?'],
    eigeneSchritte: [BEOBACHTEN],
  },
  {
    id: 'unifi-geraet-getrennt', herkunft: 'referenz',
    muster: { quelle: 'infra', gegenstand: /^unifi:device:/ },
    schritte: [
      { werkzeug: 'unifi', aktion: 'list_devices', params: {}, zweck: 'alle UniFi-Geräte mit Zustand, Uplink, letzter Meldung' },
      // v1379 — list_alerts (HTTP 400) und list_events (Network 8.x) liefern auf dem Controller nichts (Realfall 12.10. 15:09)
      { werkzeug: 'unifi', aktion: 'site_stats', params: {}, zweck: 'Zustand der Site: Subsysteme, WAN, Geräte online/offline' },
    ],
    deutungsfragen: ['Seit wann ist das Gerät getrennt, und was geschah unmittelbar davor (Neustart, Upgrade, Stromausfall)?', 'Sind weitere Geräte am selben Uplink betroffen, oder nur dieses?', 'Hängt das Gerät per Funk (Mesh) oder per Kabel?'],
    eigeneSchritte: [BEOBACHTEN],
  },
  {
    id: 'proxmox-ressource', herkunft: 'referenz',
    muster: { quelle: 'infra', gegenstand: /^proxmox:/ },
    schritte: [
      { werkzeug: 'proxmox', aktion: 'list_vms', params: {}, zweck: 'VMs und Container mit Zustand, Speicher und CPU' },
      { werkzeug: 'proxmox', aktion: 'node_stats', params: {}, zweck: 'Auslastung des Hosts' },
    ],
    deutungsfragen: ['Ist die Auslastung dauerhaft hoch oder eine Spitze?', 'Ist der Speicher der VM zu knapp bemessen oder belegt ein Prozess ungewöhnlich viel?'],
    eigeneSchritte: [BEOBACHTEN],
  },
);

export function rezeptFuer(b: BefundKurz, rezepte: Rezept[] = REFERENZ_REZEPTE): Rezept | null {
  return rezepte.find(r => r.muster.quelle === b.quelle && r.muster.gegenstand.test(b.gegenstand)) ?? null;
}
