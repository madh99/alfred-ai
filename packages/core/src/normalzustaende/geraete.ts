/**
 * v1237 — Jarvis Schicht 1, Weltmodell-Quelle „Geräte" (Spec Geräte-Architektur, Abschnitt 6):
 * je Satellit online/offline, Leerlauf, aktives Fenster, Akku — gedeutet statt roh.
 * Rein und deterministisch: Eingabe sind die Zustände des Geräte-Gateways.
 *
 * Deutung: aktiv (Leerlauf unter 5 min) → der Owner ist an diesem Gerät (Anwesenheitssignal);
 * ⚠️ getrennt über 3 h; ⚠️ Akku unter 15 % ohne Netz. Schlüssel wie `geraet:PC-madh:getrennt`
 * werden über den Weltmodell-Beobachter zu Befunden mit Identität.
 */
export interface GeraetSinne {
  leerlaufSek?: number; fenster?: string; akkuProzent?: number; akkuLaedt?: boolean;
  /** v1239 — System: Laufzeit seit Start, RAM, CPU, GPU, Laufwerke */
  uptimeSek?: number; ramGesamtMb?: number; ramFreiMb?: number; cpuProzent?: number; gpuProzent?: number;
  laufwerke?: Array<{ name: string; gesamtGb: number; freiGb: number }>;
  /** v1520 — Handy (nur solange die App offen ist): Netzweg, Audio-Ausgang, Fokus, Modell und System */
  netz?: string; audio?: string; fokus?: boolean; modell?: string; system?: string;
  /** v1526 — Bewegung (auto, rad, laeuft, geht, still) */
  bewegung?: string;
}
/** v1520 — Klartext für Netzweg und Audio-Ausgang des Handys */
const NETZ_TEXT: Record<string, string> = { wlan: 'WLAN', mobil: 'Mobilfunk', vpn: 'VPN', keins: 'kein Netz' };
/** v1526 — Klartext der Bewegung; „still“ wird nicht eigens genannt */
export const BEWEGUNG_TEXT: Record<string, string> = { auto: 'im Auto', rad: 'auf dem Rad', laeuft: 'läuft', geht: 'zu Fuß' };
const AUDIO_TEXT: Record<string, string> = { kopfhoerer: 'Kopfhörer', bluetooth: 'Bluetooth-Audio', auto: 'im Auto (CarPlay/Auto-Audio)', lautsprecher: 'Lautsprecher' };
/** v1239 — Laufwerk unter diesem Anteil frei ist auffällig. */
export const LAUFWERK_KNAPP_ANTEIL = 0.1;
export interface GeraetZustand {
  name: string;
  plattform: string;
  online: boolean;
  verbundenSeit?: string;
  zuletztGesehen?: string;
  sinne?: GeraetSinne;
  sinneZeit?: string;
  /** v1522 — Standortzone des Handys (null = unterwegs), auch bei geschlossener App */
  zone?: { name: string | null; seit: string; bewegung?: string; gemeldet?: string };
}
export interface GeraeteDeutung { zeilen: string[]; auffaellig: string[]; aktiv?: { name: string; leerlaufSek: number } }

export const AKTIV_LEERLAUF_SEK = 5 * 60;
export const GETRENNT_AUFFAELLIG_MIN = 180;
export const AKKU_NIEDRIG_PROZENT = 15;
/** Phase 5 H1 — Handys trennen im Hintergrund (iOS/Android), das ist kein Befund. */
export const HANDY_PLATTFORMEN: ReadonlySet<string> = new Set(['ios', 'android']);
/** Sinne älter als das gelten als unbekannt (Satellit sendet jede Minute). */
export const SINNE_FRISCH_MS = 3 * 60_000;

/** v1522 — „zu Hause seit 18:05“ / „unterwegs seit 08:15“ (Uhrzeit lokal) */
export function zonenText(z: { name: string | null; seit: string; bewegung?: string; gemeldet?: string }, jetzt = Date.now()): string {
  const uhr = new Date(z.seit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  // v1526 — Bewegung bei der letzten Zonenmeldung, nur wenn frisch (≤ 60 min) und nicht „still“
  const frisch = z.gemeldet ? jetzt - Date.parse(z.gemeldet) <= 60 * 60_000 : false;
  const bew = frisch && z.bewegung ? BEWEGUNG_TEXT[z.bewegung] : undefined;
  return `${z.name ? `Zone „${z.name}“` : 'unterwegs'} seit ${uhr}${bew ? `, zuletzt ${bew}` : ''}`;
}

export function formatiereDauerKurz(ms: number): string {
  if (ms < 60_000) return 'unter 1 min';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60); const r = min % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function deuteGeraete(input: { geraete: GeraetZustand[]; jetzt?: Date }): GeraeteDeutung | undefined {
  if (input.geraete.length === 0) return undefined;
  const jetzt = (input.jetzt ?? new Date()).getTime();
  const zeilen: string[] = []; const auffaellig: string[] = [];
  let aktiv: GeraeteDeutung['aktiv'];
  for (const g of input.geraete) {
    const teile: string[] = [];
    let warn = false;
    if (!g.online) {
      const seit = g.zuletztGesehen ? jetzt - Date.parse(g.zuletztGesehen) : undefined;
      const minuten = seit !== undefined ? seit / 60_000 : undefined;
      // Phase 5 H1 (Spec Geräte §20.5 Punkt 2) — ein Handy ist nur verbunden, solange die App vorne ist: getrennt ist sein Normalzustand
      if (minuten !== undefined && minuten >= GETRENNT_AUFFAELLIG_MIN && !HANDY_PLATTFORMEN.has(g.plattform)) { warn = true; auffaellig.push(`geraet:${g.name}:getrennt`); }
      const handy = HANDY_PLATTFORMEN.has(g.plattform);
      if (handy && g.zone) teile.push(zonenText(g.zone, jetzt)); // v1522
      teile.push(seit !== undefined ? (handy ? `zuletzt verbunden vor ${formatiereDauerKurz(seit)}` : `getrennt seit ${formatiereDauerKurz(seit)}`) : (handy ? 'nicht verbunden' : 'getrennt'));
    } else {
      const frisch = g.sinneZeit ? jetzt - Date.parse(g.sinneZeit) <= SINNE_FRISCH_MS : false;
      const s = frisch ? g.sinne : undefined;
      if (s?.leerlaufSek !== undefined) {
        if (s.leerlaufSek < AKTIV_LEERLAUF_SEK) {
          teile.push(HANDY_PLATTFORMEN.has(g.plattform) ? 'in der App' : `aktiv (Leerlauf ${formatiereDauerKurz(s.leerlaufSek * 1000)})`); // v1520
          if (!aktiv || s.leerlaufSek < aktiv.leerlaufSek) aktiv = { name: g.name, leerlaufSek: s.leerlaufSek };
        } else {
          teile.push(`im Leerlauf seit ${formatiereDauerKurz(s.leerlaufSek * 1000)}`);
        }
        if (s.fenster && s.leerlaufSek < AKTIV_LEERLAUF_SEK) teile.push(`Fenster „${s.fenster.slice(0, 60)}"`);
      } else {
        teile.push(g.verbundenSeit ? `online seit ${formatiereDauerKurz(jetzt - Date.parse(g.verbundenSeit))}` : 'online');
      }
      // v1520 — Handy: in der App (Owner schaut aufs Handy), Netzweg, Audio, Fokus; v1522 Zone
      if (HANDY_PLATTFORMEN.has(g.plattform) && g.zone) teile.push(zonenText({ ...g.zone, bewegung: undefined }, jetzt));
      if (HANDY_PLATTFORMEN.has(g.plattform) && s) {
        if (s.netz) teile.push(s.netz.split('+').map(t => NETZ_TEXT[t] ?? t).join(' + '));
        if (s.bewegung && BEWEGUNG_TEXT[s.bewegung]) teile.push(BEWEGUNG_TEXT[s.bewegung]); // v1526 — live bei offener App
        if (s.audio && s.audio !== 'lautsprecher') teile.push(AUDIO_TEXT[s.audio] ?? s.audio);
        if (s.fokus === true) teile.push('Fokus an');
      }
      if (s?.akkuProzent !== undefined) {
        // v1520 — Handy: Akku nur Anzeige (gemessen nur bei offener App; ein Befund daraus wäre Zufall)
        const niedrig = s.akkuProzent <= AKKU_NIEDRIG_PROZENT && !s.akkuLaedt && !HANDY_PLATTFORMEN.has(g.plattform);
        if (niedrig) { warn = true; auffaellig.push(`geraet:${g.name}:akku`); }
        teile.push(`Akku ${s.akkuProzent} %${s.akkuLaedt ? ' (lädt)' : niedrig ? ' (nicht am Netz)' : ''}`);
      }
    }
    zeilen.push(`${warn ? '⚠️ ' : ''}${g.name} (${g.plattform}): ${teile.join(', ')}`);
    // v1239 — Systemzeile: Laufzeit, CPU, GPU, RAM, Laufwerke (knappe Laufwerke als Befund)
    if (g.online) {
      const s = g.sinne;
      const sys: string[] = [];
      let warnSys = false;
      if (s?.modell) sys.push(s.modell); // v1520 — Handy: Modell und System
      if (s?.system) sys.push(s.system);
      if (s?.uptimeSek !== undefined) sys.push(`läuft seit ${formatiereDauerKurz(s.uptimeSek * 1000)} (Start ${new Date(jetzt - s.uptimeSek * 1000).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`);
      if (s?.cpuProzent !== undefined) sys.push(`CPU ${s.cpuProzent} %`);
      if (s?.gpuProzent !== undefined) sys.push(`GPU ${s.gpuProzent} %`);
      if (s?.ramGesamtMb !== undefined && s.ramFreiMb !== undefined) sys.push(`RAM ${Math.round(s.ramFreiMb / 1024)} GB frei von ${Math.round(s.ramGesamtMb / 1024)}`);
      for (const l of s?.laufwerke ?? []) {
        if (!(l.gesamtGb > 0)) continue; // v1254 — Pseudo-Volumes (macOS /home) nicht zeigen
        const knapp = l.freiGb / l.gesamtGb < LAUFWERK_KNAPP_ANTEIL;
        if (knapp) { warnSys = true; auffaellig.push(`geraet:${g.name}:laufwerk:${l.name.replace(/[:\\/]+$/, '')}`); }
        sys.push(`${knapp ? '⚠️ ' : ''}${l.name} ${l.freiGb} GB frei von ${l.gesamtGb}`);
      }
      if (sys.length) zeilen.push(`${warnSys ? '⚠️ ' : ''}↳ ${g.name} System: ${sys.join(' · ')}`);
    }
  }
  return { zeilen, auffaellig, aktiv };
}
