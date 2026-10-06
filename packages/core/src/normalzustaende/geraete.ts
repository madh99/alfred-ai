/**
 * v1237 — Jarvis Schicht 1, Weltmodell-Quelle „Geräte" (Spec Geräte-Architektur, Abschnitt 6):
 * je Satellit online/offline, Leerlauf, aktives Fenster, Akku — gedeutet statt roh.
 * Rein und deterministisch: Eingabe sind die Zustände des Geräte-Gateways.
 *
 * Deutung: aktiv (Leerlauf unter 5 min) → der Owner ist an diesem Gerät (Anwesenheitssignal);
 * ⚠️ getrennt über 3 h; ⚠️ Akku unter 15 % ohne Netz. Schlüssel wie `geraet:PC-madh:getrennt`
 * werden über den Weltmodell-Beobachter zu Befunden mit Identität.
 */
export interface GeraetSinne { leerlaufSek?: number; fenster?: string; akkuProzent?: number; akkuLaedt?: boolean }
export interface GeraetZustand {
  name: string;
  plattform: string;
  online: boolean;
  verbundenSeit?: string;
  zuletztGesehen?: string;
  sinne?: GeraetSinne;
  sinneZeit?: string;
}
export interface GeraeteDeutung { zeilen: string[]; auffaellig: string[]; aktiv?: { name: string; leerlaufSek: number } }

export const AKTIV_LEERLAUF_SEK = 5 * 60;
export const GETRENNT_AUFFAELLIG_MIN = 180;
export const AKKU_NIEDRIG_PROZENT = 15;
/** Sinne älter als das gelten als unbekannt (Satellit sendet jede Minute). */
export const SINNE_FRISCH_MS = 3 * 60_000;

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
      if (minuten !== undefined && minuten >= GETRENNT_AUFFAELLIG_MIN) { warn = true; auffaellig.push(`geraet:${g.name}:getrennt`); }
      teile.push(seit !== undefined ? `getrennt seit ${formatiereDauerKurz(seit)}` : 'getrennt');
    } else {
      const frisch = g.sinneZeit ? jetzt - Date.parse(g.sinneZeit) <= SINNE_FRISCH_MS : false;
      const s = frisch ? g.sinne : undefined;
      if (s?.leerlaufSek !== undefined) {
        if (s.leerlaufSek < AKTIV_LEERLAUF_SEK) {
          teile.push(`aktiv (Leerlauf ${formatiereDauerKurz(s.leerlaufSek * 1000)})`);
          if (!aktiv || s.leerlaufSek < aktiv.leerlaufSek) aktiv = { name: g.name, leerlaufSek: s.leerlaufSek };
        } else {
          teile.push(`im Leerlauf seit ${formatiereDauerKurz(s.leerlaufSek * 1000)}`);
        }
        if (s.fenster && s.leerlaufSek < AKTIV_LEERLAUF_SEK) teile.push(`Fenster „${s.fenster.slice(0, 60)}"`);
      } else {
        teile.push(g.verbundenSeit ? `online seit ${formatiereDauerKurz(jetzt - Date.parse(g.verbundenSeit))}` : 'online');
      }
      if (s?.akkuProzent !== undefined) {
        const niedrig = s.akkuProzent <= AKKU_NIEDRIG_PROZENT && !s.akkuLaedt;
        if (niedrig) { warn = true; auffaellig.push(`geraet:${g.name}:akku`); }
        teile.push(`Akku ${s.akkuProzent} %${s.akkuLaedt ? ' (lädt)' : niedrig ? ' (nicht am Netz)' : ''}`);
      }
    }
    zeilen.push(`${warn ? '⚠️ ' : ''}${g.name} (${g.plattform}): ${teile.join(', ')}`);
  }
  return { zeilen, auffaellig, aktiv };
}
