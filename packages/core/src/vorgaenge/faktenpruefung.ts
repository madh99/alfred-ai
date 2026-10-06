/**
 * v1214 — Fakten-Gegenprobe vor dem Anlegen eines Vorgangs.
 *
 * Realfall 06.10.: Dreimal forderte ein Vorgang „BMW-OAuth-Flow neu starten, sonst keine
 * Fahrzeugdaten", während der stündliche BMW-Abruf sechsmal fehlerfrei lief und der Stream
 * verbunden war. Das Modell hatte eine alte Erinnerung weitergetragen. Behauptet ein
 * Vorgang den Ausfall einer Quelle, deren Datenlage das Weltmodell als NORMAL führt, wird
 * er nicht angelegt, sondern als Widerspruch protokolliert. Deterministisch, ohne Modell.
 */

/** Quelle im Weltmodell (Sektionsschlüssel des Kollektors) und die Wörter, mit denen Vorgänge sie nennen. */
export const QUELLEN_WOERTER: Array<[sektion: string, muster: RegExp]> = [
  ['bmw', /\b(bmw|fahrzeug|auto|cardata|mqtt-stream)\b/i],
  ['smarthome', /\b(home ?assistant|smart ?home|hausautomation)\b/i],
  ['energy', /\b(strompreis|energiepreis|awattar-preis|epex)\b/i],
];

/** Behauptungen, dass eine Quelle gestört ist oder neu verbunden werden muss. */
export const AUSFALL_MUSTER = /\b(ausgefallen|nicht (mehr )?(erreichbar|abrufbar|verfügbar)|keine (fahrzeug|sensor|haus)?daten|token (erneuern|abgelaufen|ungültig)|oauth|neu (starten|anmelden|verbinden)|verbindung (verloren|unterbrochen|getrennt)|offline|re-?authentifizier)/i;

/** Datenlage-Zeile einer Sektion: „normal", wenn sie NORMAL meldet und keine Störung nennt. */
export function datenlageNormal(sektionsInhalt: string | undefined): boolean {
  if (!sektionsInhalt) return false;
  const zeile = sektionsInhalt.split('\n').find(z => /datenlage/i.test(z)) ?? sektionsInhalt;
  if (!/\bNORMAL\b/.test(zeile)) return false;
  return !/(überfällig|ausgefallen|fehlgeschlagen|gestört|abgelaufen|fehler\b)/i.test(zeile);
}

export interface Widerspruch { sektion: string; grund: string }

/**
 * Widerspricht der Vorgangstext dem Weltmodell? Nur wenn er eine bekannte Quelle nennt,
 * deren Ausfall behauptet UND die Datenlage dieser Quelle NORMAL ist.
 */
export function widersprichtWeltmodell(text: string, inhalte: ReadonlyMap<string, string> | ((sektion: string) => string | undefined)): Widerspruch | null {
  if (!text || !AUSFALL_MUSTER.test(text)) return null;
  const hole = typeof inhalte === 'function' ? inhalte : (k: string) => inhalte.get(k);
  for (const [sektion, muster] of QUELLEN_WOERTER) {
    if (!muster.test(text)) continue;
    const inhalt = hole(sektion);
    if (datenlageNormal(inhalt)) {
      const zeile = (inhalt ?? '').split('\n').find(z => /datenlage/i.test(z))?.replace(/\*\*/g, '').trim().slice(0, 160) ?? 'Datenlage NORMAL';
      return { sektion, grund: `Weltmodell ${sektion}: ${zeile}` };
    }
  }
  return null;
}
