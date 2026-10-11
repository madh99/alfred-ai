/**
 * v1214 — Fakten-Gegenprobe vor dem Anlegen eines Vorgangs.
 *
 * Realfall 06.10.: Dreimal forderte ein Vorgang „BMW-OAuth-Flow neu starten, sonst keine
 * Fahrzeugdaten", während der stündliche BMW-Abruf sechsmal fehlerfrei lief und der Stream
 * verbunden war. Das Modell hatte eine alte Erinnerung weitergetragen. Behauptet ein
 * Vorgang den Ausfall einer Quelle, deren Datenlage das Weltmodell als NORMAL führt, wird
 * er nicht angelegt, sondern als Widerspruch protokolliert. Deterministisch, ohne Modell.
 */

/**
 * v1360 — Ausfall-Wörter für Modell-Anbieter: zusätzlich „deaktiviert/gesperrt/suspendiert". Nur für diese Quellen —
 * global würde „Automation X deaktiviert" (Home Assistant) fälschlich als Ausfall-Behauptung gelten.
 * Realfall 11.10.: „Claude-API-Zugang deaktiviert" neunmal gemeldet, während Claude-Aufrufe fehlerfrei liefen.
 */
export const AUSFALL_ANBIETER = /\b(deaktiviert|gesperrt|suspendiert|zugang (entzogen|verloren)|ausgefallen|nicht (mehr )?(erreichbar|nutzbar|verfügbar)|offline)\b/i;

/** Quelle im Weltmodell (Sektionsschlüssel des Kollektors), die Wörter, mit denen Vorgänge sie nennen, und optional eigene Ausfall-Wörter. */
export const QUELLEN_WOERTER: Array<[sektion: string, muster: RegExp, ausfall?: RegExp]> = [
  ['bmw', /\b(bmw|fahrzeug|auto|cardata|mqtt-stream)\b/i],
  ['smarthome', /\b(home ?assistant|smart ?home|hausautomation)\b/i],
  ['energy', /\b(strompreis|energiepreis|awattar-preis|epex)\b/i],
  // v1360 — Modell-Anbieter; Datenlage aus dem Provider-Puls (Schicht 0), siehe anbieterDatenlage
  // nur Anbieter und API — „Claude-Code-Auftrag … nicht erreichbar" (Satellit) ist keine Anbieter-Behauptung
  ['llm-anthropic', /\b(anthropic|claude[- ]?(api|console))/i, AUSFALL_ANBIETER],
  ['llm-openai', /\b(openai|chatgpt)\b/i, AUSFALL_ANBIETER],
  ['llm-mistral', /\bmistral\b/i, AUSFALL_ANBIETER],
];

/** Puls-Eintrag je Tier (Auszug aus lebenszeichen/provider-puls TierPuls). */
export interface AnbieterPuls { tier: string; provider: string; letzterErfolg?: string; gestoertSeit?: string }

/**
 * v1360 — Datenlage eines Modell-Anbieters aus dem Provider-Puls: NORMAL, wenn kein Tier des Anbieters seit seinem
 * letzten Erfolg durchgehend fehlschlägt und der letzte Erfolg höchstens 6 h zurückliegt. Ohne Puls-Daten: unbekannt.
 */
export function anbieterDatenlage(puls: AnbieterPuls[], provider: string, jetzt = new Date()): string | undefined {
  const e = puls.filter(p => p.provider === provider);
  if (e.length === 0) return undefined;
  const gestoert = e.filter(p => p.gestoertSeit && (!p.letzterErfolg || p.letzterErfolg < p.gestoertSeit));
  const letzter = e.map(p => p.letzterErfolg).filter((x): x is string => !!x).sort().pop();
  const zeit = letzter ? new Date(letzter).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
  if (gestoert.length === 0 && letzter && jetzt.getTime() - Date.parse(letzter) <= 6 * 3_600_000) {
    return `Datenlage: NORMAL — ${provider}: letzter erfolgreicher Aufruf ${zeit}, alle Tiers in Ordnung`;
  }
  return `Datenlage: STÖRUNG — ${provider}: ${gestoert.map(p => p.tier).join(', ') || 'kein Erfolg in 6 h'} (letzter Erfolg ${zeit})`;
}

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
  if (!text) return null;
  const hole = typeof inhalte === 'function' ? inhalte : (k: string) => inhalte.get(k);
  for (const [sektion, muster, ausfall] of QUELLEN_WOERTER) {
    if (!(ausfall ?? AUSFALL_MUSTER).test(text) || !muster.test(text)) continue;
    const inhalt = hole(sektion);
    if (datenlageNormal(inhalt)) {
      const zeile = (inhalt ?? '').split('\n').find(z => /datenlage/i.test(z))?.replace(/\*\*/g, '').trim().slice(0, 160) ?? 'Datenlage NORMAL';
      return { sektion, grund: `Weltmodell ${sektion}: ${zeile}` };
    }
  }
  return null;
}
