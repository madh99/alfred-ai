/**
 * v1449 — Wiederkehrende Prüfungen mit Vergleich (Owner 14.10.: „ich habe Alfred die Aufgabe gegeben, die Ergebnisse der ersten
 * Anfrage täglich zu prüfen — er hätte im Auftrag speichern müssen, womit er vergleicht“; „wenn man Alfred das nächste Mal so
 * etwas fragt, muss es funktionieren“). Generisch für jede geplante Aufgabe im Prüfmodus:
 *
 *  - Der Auftrag besitzt seinen Stand (scheduled_actions.stand) — beim Einplanen aus dem Gespräch befüllt, danach von jedem Lauf
 *    fortgeschrieben. Der Scheduler gibt ihn fest mit und übernimmt den neuen Stand selbst (kein Notizen-Suchen, keine Doppel-Notizen).
 *  - Feste Lauf-Vorgaben: jeden Eintrag des letzten Stands einzeln einstufen; „in einer Suche nicht gefunden“ ist nicht „weg“.
 *  - Vollständigkeit deterministisch: ohne Bericht oder ohne neuen Stand → einmal nachfordern, sonst als unvollständig melden.
 */

export const STAND_ANFANG = '<<<STAND';
export const STAND_ENDE = 'STAND>>>';
const STAND_MAX = 12_000;
export const BERICHT_MIN = 150;

/** Prüfmodus: ausdrücklicher Ausgangsstand oder ein Auftrag, der vergleichen/überwachen/prüfen will. */
export function istPruefAuftrag(prompt: string | undefined, ausgangsstand?: string): boolean {
  if (ausgangsstand && ausgangsstand.trim()) return true;
  return !!prompt && /\b(vergleich\w*|ver(ä|ae)nder\w*|neue (treffer|angebote|eintr(ä|ae)ge|inserate)|preis(ä|ae)nderung\w*|pr(ü|ue)fe\w* (t(ä|ae)glich|regelm(ä|ae)(ß|ss)ig)|(ü|ue)berwach\w*|beobacht\w* .*(preis|angebot|status))/i.test(prompt);
}

/** Rahmen, der jedem Lauf vorangestellt wird (fest, modellunabhängig). */
export function standRahmen(name: string, stand: string, standZeit?: string): string {
  const letzter = stand.trim()
    ? `Letzter Stand (${standZeit ? `vom ${new Date(standZeit).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Ausgangsstand beim Einplanen'}):\n${stand.trim().slice(0, STAND_MAX)}`
    : 'Letzter Stand: noch keiner — dieser Lauf legt ihn an.';
  return [
    `[Geplante Prüfung „${name}“ — läuft bereits automatisch nach Plan. Nicht anbieten, sie einzuplanen.]`,
    letzter,
    'Vorgaben für diesen Lauf:',
    '1. Prüfe JEDEN Eintrag des letzten Stands einzeln (direkt, z. B. über seine Kennung/Adresse) und stufe ihn ein: unverändert, geändert (was genau, alter → neuer Wert), weg/verkauft (nur wenn direkt bestätigt) oder nicht prüfbar. „In einer Suche nicht gefunden“ ist NICHT „weg“.',
    '2. Suche danach nach neuen passenden Einträgen.',
    '3. Antworte mit dem vollständigen Bericht für den Owner (Änderungen zuerst, dann die Übersicht). Kein „Notiz gespeichert“ als Antwort; lege für den Vergleich keine Notizen an — den Stand führt der Auftrag selbst.',
    `4. Schließe die Antwort IMMER mit dem neuen Stand ab, genau so (eine Zeile je Eintrag mit Kennung und den verglichenen Werten):\n${STAND_ANFANG}\n…\n${STAND_ENDE}`,
  ].join('\n');
}

/** Bericht und neuen Stand trennen (letzter Block zählt). */
export function standAus(text: string): { bericht: string; stand?: string } {
  const t = text ?? '';
  const i = t.lastIndexOf(STAND_ANFANG);
  if (i < 0) return { bericht: t.trim() };
  const j = t.indexOf(STAND_ENDE, i + STAND_ANFANG.length);
  const roh = j < 0 ? t.slice(i + STAND_ANFANG.length) : t.slice(i + STAND_ANFANG.length, j);
  const stand = roh.replace(/^[^\n]*\n/, '').trim().slice(0, STAND_MAX);
  // leere Codeblock-Hülle um den Stand-Block entfernen
  const bericht = (t.slice(0, i) + (j < 0 ? '' : t.slice(j + STAND_ENDE.length))).replace(/```[a-z]*\s*```/g, '').replace(/\n```\s*$/, '').trim();
  return { bericht, ...(stand ? { stand } : {}) };
}

export function laufVollstaendig(r: { bericht: string; stand?: string }): { ok: boolean; fehlt: string[] } {
  const fehlt: string[] = [];
  if (r.bericht.trim().length < BERICHT_MIN) fehlt.push('Bericht');
  if (!r.stand) fehlt.push('neuer Stand');
  return { ok: fehlt.length === 0, fehlt };
}

export const NACHFORDERUNG = 'Hinweis: Der vorige Versuch dieses Laufs lieferte keinen vollständigen Bericht bzw. keinen Stand-Block. Führe die Prüfung vollständig aus und halte dich genau an die Vorgaben 1–4.';
