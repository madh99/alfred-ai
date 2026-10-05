/**
 * Jarvis Schicht 1 — Weltmodell, Quelle BMW.
 *
 * Deterministische Deutungsschicht: aus zwei Roh-Snapshots (MQTT-Stream, REST-
 * Abruf) und dem Kilometer-Verlauf werden ZUSTÄNDE MIT DEUTUNG, nicht Rohzahlen.
 *
 * Realfall (v1148–v1152): „BMW MQTT offline / Daten 6 h alt" wurde wochenlang
 * gemeldet, obwohl der Stream nur bei aktivem Fahrzeug sendet. Die Korrektur
 * stand als Prompt-Block da und wurde von jedem Modell ignoriert — Rohdaten
 * („Daten 2.100 Min alt") standen daneben, und Nähe schlägt Ferne. Hier wird
 * das Wissen zur REGEL: steht das Fahrzeug, ist ein stiller Stream normal; fuhr
 * es seit der letzten Stream-Meldung, ist der stille Stream das echte Signal.
 *
 * Zweiter Fund (05.10.): „MQTT gewinnt bei gemeinsamen Feldern" lieferte bei
 * 34 h altem MQTT-Snapshot den alten Ladestand (56 %) statt des frischen REST-
 * Werts (30 %). Jetzt gewinnt je Feld der jüngere Zeitstempel.
 */

export interface BmwFeld { value: string; unit?: string; timestamp?: string }
export interface BmwSnapshot { source: 'mqtt' | 'rest'; createdAt: string; data: Record<string, BmwFeld> }
/** Ein Punkt des Kilometer-Verlaufs (aus bmw_telematic_log). */
export interface BmwVerlaufPunkt { createdAt: string; km?: number; kmZeit?: string }

export interface BmwZustand {
  kilometer?: number;
  steht: boolean;
  /** Ende der letzten Fahrt (Fahrzeugzeit, sonst Abrufzeit). */
  letzteFahrtEnde?: string;
  letzteFahrtKm?: { von: number; bis: number };
  /** Verlauf deckt den ganzen Beobachtungszeitraum ohne Bewegung ab. */
  stehtMindestensSeit?: string;
  mqttAlterMin?: number;
  restAlterMin?: number;
  /** Fahrzeug fuhr nach der letzten MQTT-Meldung → Stream lieferte nicht. */
  streamVerdacht: boolean;
  restAusgefallen: boolean;
  /** v1176 — Stream-Verbindung getrennt ohne geplanten Reconnect (Pfad hängt). */
  streamGetrennt?: boolean;
  soc?: number;
  socZiel?: number;
  reichweiteKm?: number;
  laedt: boolean;
  angesteckt: boolean;
  verriegelt?: boolean;
  offen: string[];
  reifenAbweichung: string[];
}

export interface BmwDeutung { zeilen: string[]; zustand: BmwZustand }

/** v1176 — Zustand der MQTT-Verbindung (aus BMWSkill.streamingStatus()). */
export interface BmwStreamStatus { enabled: boolean; aktiv: boolean; letzterConnectAt?: string; letzteDatenAt?: string; letzterFehlerAt?: string; letzterFehler?: string; reconnectFaelligAt?: string }

/** Erwarteter REST-Takt (Kollektor pollt alle 30 min); ab 3× Takt gilt der Abruf als ausgefallen. */
export const REST_TAKT_MIN = 30;
export const REST_AUSFALL_MIN = 3 * REST_TAKT_MIN;
/** Unverriegelt im Stand ab dieser Dauer auffällig. */
export const UNVERRIEGELT_SCHWELLE_MIN = 60;
export const SOC_NIEDRIG_PROZENT = 20;
export const REIFEN_ABWEICHUNG_PROZENT = 12;

const ALIAS: Record<string, string[]> = {
  soc: ['vehicle.drivetrain.batteryManagement.header', 'vehicle.powertrain.electric.battery.stateOfCharge.displayed', 'vehicle.drivetrain.electricEngine.charging.level'],
  socZiel: ['vehicle.powertrain.electric.battery.stateOfCharge.target'],
  reichweite: ['vehicle.drivetrain.electricEngine.remainingElectricRange', 'vehicle.drivetrain.lastRemainingRange', 'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange'],
  km: ['vehicle.vehicle.travelledDistance'],
  ladeStatus: ['vehicle.drivetrain.electricEngine.charging.status'],
  port: ['vehicle.body.chargingPort.status', 'vehicle.powertrain.tractionBattery.charging.port.anyPosition.isPlugged'],
  verriegelt: ['vehicle.access.centralLocking.isLocked', 'vehicle.cabin.door.lock.status', 'vehicle.cabin.door.status'],
};

/** Je Feld gewinnt der jüngere Zeitstempel (Feld-Zeitstempel, sonst Snapshot-Zeit). */
export function verschmelzeSnapshots(mqtt?: BmwSnapshot, rest?: BmwSnapshot): Record<string, BmwFeld & { quelle: 'mqtt' | 'rest'; zeit: string }> {
  const out: Record<string, BmwFeld & { quelle: 'mqtt' | 'rest'; zeit: string }> = {};
  for (const snap of [rest, mqtt]) {
    if (!snap) continue;
    for (const [k, f] of Object.entries(snap.data)) {
      if (f?.value === undefined || f.value === null || f.value === '') continue;
      const zeit = f.timestamp && !Number.isNaN(Date.parse(f.timestamp)) ? f.timestamp : snap.createdAt;
      const alt = out[k];
      if (!alt || Date.parse(zeit) >= Date.parse(alt.zeit)) out[k] = { ...f, quelle: snap.source, zeit };
    }
  }
  return out;
}

function wert(m: Record<string, BmwFeld>, aliasKey: keyof typeof ALIAS): string | undefined {
  for (const k of ALIAS[aliasKey]) if (m[k]?.value !== undefined) return String(m[k].value);
  return undefined;
}
function zahl(s?: string): number | undefined { if (s === undefined) return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; }

export function formatiereZeit(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function formatiereDauerMin(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} Tagen`;
}
const kmFmt = (n: number) => n.toLocaleString('de-AT');

/** Letzte Bewegung aus dem Kilometer-Verlauf: Ende der letzten Fahrt = Zeit des ersten Punkts mit dem neuen Stand. */
export function letzteBewegung(verlauf: BmwVerlaufPunkt[]): { ende?: string; von?: number; bis?: number; keineBewegungSeit?: string } {
  const punkte = verlauf.filter(p => typeof p.km === 'number').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (punkte.length === 0) return {};
  for (let i = punkte.length - 1; i > 0; i--) {
    if (punkte[i].km !== punkte[i - 1].km) {
      return { ende: punkte[i].kmZeit ?? punkte[i].createdAt, von: punkte[i - 1].km, bis: punkte[i].km };
    }
  }
  return { keineBewegungSeit: punkte[0].kmZeit ?? punkte[0].createdAt };
}

export function deuteBmw(input: { mqtt?: BmwSnapshot; rest?: BmwSnapshot; verlauf: BmwVerlaufPunkt[]; now?: Date; stream?: BmwStreamStatus }): BmwDeutung | undefined {
  const { mqtt, rest } = input;
  if (!mqtt && !rest) return undefined;
  const now = input.now ?? new Date();
  const m = verschmelzeSnapshots(mqtt, rest);
  const minSeit = (iso?: string) => iso ? Math.max(0, (now.getTime() - Date.parse(iso)) / 60_000) : undefined;

  const z: BmwZustand = { steht: true, streamVerdacht: false, restAusgefallen: false, laedt: false, angesteckt: false, offen: [], reifenAbweichung: [] };
  z.kilometer = zahl(wert(m, 'km'));
  z.soc = zahl(wert(m, 'soc'));
  z.socZiel = zahl(wert(m, 'socZiel'));
  z.reichweiteKm = zahl(wert(m, 'reichweite'));
  const lade = (wert(m, 'ladeStatus') ?? '').toUpperCase();
  z.laedt = lade !== '' && lade !== 'NOCHARGING' && lade !== 'NOT_CHARGING' && lade !== 'INVALID';
  const port = (wert(m, 'port') ?? '').toUpperCase();
  z.angesteckt = port === 'CONNECTED' || port === 'TRUE' || port === 'PLUGGED';
  const lock = (wert(m, 'verriegelt') ?? '').toUpperCase();
  z.verriegelt = ['TRUE', 'LOCKED', 'SECURED'].includes(lock) ? true : ['FALSE', 'UNLOCKED', 'OPEN'].includes(lock) ? false : undefined;
  for (const [k, f] of Object.entries(m)) {
    const v = String(f.value).toUpperCase();
    if (/\.(door|window|hood|trunk)[.a-z0-9]*\.(isOpen|status)$/i.test(k) && (v === 'TRUE' || v === 'OPEN')) {
      z.offen.push(k.replace(/^vehicle\.(cabin|body)\./, '').replace(/\.(isOpen|status)$/, ''));
    }
    const reifen = k.match(/^vehicle\.chassis\.axle\.(row\d)\.wheel\.(left|right)\.tire\.pressure$/);
    if (reifen) {
      const ist = zahl(String(f.value)); const soll = zahl(m[`${k}Target`]?.value as string | undefined);
      if (ist !== undefined && soll && Math.abs(ist - soll) / soll * 100 > REIFEN_ABWEICHUNG_PROZENT) {
        z.reifenAbweichung.push(`${reifen[1]} ${reifen[2]}: ${ist} statt ${soll}`);
      }
    }
  }
  z.mqttAlterMin = minSeit(mqtt?.createdAt);
  z.restAlterMin = minSeit(rest?.createdAt);
  z.restAusgefallen = rest !== undefined && (z.restAlterMin ?? 0) > REST_AUSFALL_MIN;

  // Bewegung
  const verlauf = [...input.verlauf];
  if (z.kilometer !== undefined) {
    const kmFeld = ALIAS.km.map(k => m[k]).find(Boolean);
    verlauf.push({ createdAt: kmFeld?.zeit ?? now.toISOString(), km: z.kilometer, kmZeit: kmFeld?.zeit });
  }
  const bew = letzteBewegung(verlauf);
  if (bew.ende) {
    z.letzteFahrtEnde = bew.ende;
    z.letzteFahrtKm = { von: bew.von!, bis: bew.bis! };
    // „fährt gerade": Fahrtende jünger als ein REST-Takt
    z.steht = (minSeit(bew.ende) ?? Infinity) > REST_TAKT_MIN;
  } else {
    z.stehtMindestensSeit = bew.keineBewegungSeit;
  }
  if (mqtt && z.letzteFahrtEnde && Date.parse(z.letzteFahrtEnde) - Date.parse(mqtt.createdAt) > 5 * 60_000) {
    z.streamVerdacht = true;
  }

  // Zeilen mit Deutung
  const zeilen: string[] = [];
  {
    const teile: string[] = [];
    if (!z.steht) teile.push('fährt gerade (Kilometerstand ändert sich)');
    else if (z.letzteFahrtEnde) teile.push(`steht seit ${formatiereZeit(z.letzteFahrtEnde)} (${formatiereDauerMin(minSeit(z.letzteFahrtEnde)!)}), letzte Fahrt ${kmFmt(z.letzteFahrtKm!.von)} → ${kmFmt(z.letzteFahrtKm!.bis)} km`);
    else if (z.stehtMindestensSeit) teile.push(`steht ohne Bewegung mindestens seit ${formatiereZeit(z.stehtMindestensSeit)}`);
    else teile.push('Bewegungsstatus unbekannt (kein Kilometer-Verlauf)');
    if (z.kilometer !== undefined) teile.push(`Kilometerstand ${kmFmt(z.kilometer)} km`);
    zeilen.push(`**Fahrzeug:** ${teile.join(' · ')}`);
  }
  if (z.soc !== undefined) {
    const teile = [`${z.soc} %${z.socZiel ? ` (Ladeziel ${z.socZiel} %)` : ''}`];
    if (z.reichweiteKm !== undefined) teile.push(`Reichweite ${z.reichweiteKm} km`);
    // Wortwahl bewusst ohne „lädt": der KG-Extraktor (extractFromVehicle) liest
    // „(SoC) NN %", „Reichweite NN km" und wertet „lädt/charging" als Ladevorgang.
    teile.push(z.laedt ? 'Ladevorgang aktiv (charging)' : z.angesteckt ? 'angesteckt, kein Ladevorgang' : 'nicht angesteckt — kein Ladevorgang');
    if (z.soc < SOC_NIEDRIG_PROZENT) teile.push(`↳ niedrig (< ${SOC_NIEDRIG_PROZENT} %)`);
    else teile.push('↳ NORMAL — kein Ladebedarf gemeldet');
    zeilen.push(`**Ladestand (SoC):** ${teile.join(' · ')}`);
  }
  {
    const teile: string[] = [];
    if (z.verriegelt === true) teile.push('verriegelt');
    else if (z.verriegelt === false) {
      const stehtMin = z.letzteFahrtEnde ? minSeit(z.letzteFahrtEnde)! : (z.stehtMindestensSeit ? minSeit(z.stehtMindestensSeit)! : 0);
      teile.push(z.steht && stehtMin > UNVERRIEGELT_SCHWELLE_MIN ? `⚠️ UNVERRIEGELT seit ${formatiereDauerMin(stehtMin)} im Stand` : 'unverriegelt (kürzlich benutzt — normal)');
    }
    teile.push(z.offen.length ? `⚠️ offen: ${z.offen.join(', ')}` : 'Türen/Fenster/Klappen geschlossen');
    teile.push(z.reifenAbweichung.length ? `⚠️ Reifendruck abweichend: ${z.reifenAbweichung.join('; ')}` : 'Reifendruck im Soll');
    zeilen.push(`**Zustand:** ${teile.join(' · ')}`);
  }
  {
    const teile: string[] = [];
    if (rest) {
      teile.push(z.restAusgefallen
        ? `⚠️ REST-Abruf ausgefallen: letzter vor ${formatiereDauerMin(z.restAlterMin!)} (erwartet alle ${REST_TAKT_MIN} min) → Datenquelle prüfen`
        : `REST-Abruf aktuell (vor ${formatiereDauerMin(z.restAlterMin!)}, Takt ${REST_TAKT_MIN} min)`);
    } else teile.push('kein REST-Abruf vorhanden');
    if (mqtt) {
      if (z.streamVerdacht) {
        teile.push(`⚠️ MQTT-Stream lieferte NICHTS, obwohl das Fahrzeug nach der letzten Stream-Meldung (${formatiereZeit(mqtt.createdAt)}) gefahren ist (${kmFmt(z.letzteFahrtKm!.von)} → ${kmFmt(z.letzteFahrtKm!.bis)} km, Fahrtende ${formatiereZeit(z.letzteFahrtEnde!)}) → bmw-streaming prüfen`);
      } else {
        teile.push(`MQTT-Stream still seit ${formatiereZeit(mqtt.createdAt)} (${formatiereDauerMin(z.mqttAlterMin!)}) ↳ NORMAL: der Stream sendet nur bei aktivem Fahrzeug; im Stand sind alte Stream-Daten KEIN Fehler und NICHT zu melden`);
      }
    } else teile.push('kein MQTT-Stream-Snapshot vorhanden');
    // v1176 — Verbindungszustand des Streams (Realfall 04.10.: 8 h ohne Reconnect)
    if (input.stream?.enabled) {
      const st = input.stream;
      if (st.aktiv) teile.push(`Stream-Verbindung aktiv${st.letzteDatenAt ? ` (letzte Daten ${formatiereZeit(st.letzteDatenAt)})` : ''}`);
      else if (st.reconnectFaelligAt) teile.push(`Stream-Verbindung getrennt, Reconnect ${formatiereZeit(st.reconnectFaelligAt)} ↳ NORMAL (BMW schließt Leerlauf-Verbindungen nach 60 s)`);
      else { teile.push(`⚠️ Stream-Verbindung getrennt OHNE geplanten Reconnect${st.letzterFehler ? ` (letzter Fehler: ${st.letzterFehler.slice(0, 60)})` : ''} → Wächter startet neu`); z.streamGetrennt = true; }
    }
    zeilen.push(`**Datenlage:** ${teile.join(' · ')}`);
  }
  return { zeilen, zustand: z };
}
