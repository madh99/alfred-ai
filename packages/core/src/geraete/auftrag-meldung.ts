import type { GeraetEreignis } from '@alfred/types';

/**
 * v1382 (R1, Owner-Freigabe 12.10.) — Ende eines Claude-Code-Auftrags deterministisch melden: Titel, Status, Dauer, Kosten,
 * geänderte Dateien, ohne Modell. Die Ausgabe von Claude Code ist fremder Inhalt: sie steht gekennzeichnet als Datenblock
 * in der Meldung und geht nie automatisch an ein Modell (die frühere Idee „Alfred fasst zusammen" wurde als unsichere
 * Agentenschleife abgelehnt, Spec Geräte §19). Zusammenfassen nur auf Nachfrage des Owners (auftrag_ergebnis).
 */

const STATUS: Record<GeraetEreignis['status'], string> = { fertig: '✅ fertig', fehler: '❌ mit Fehler beendet', abgebrochen: '⏹ abgebrochen' };

export function dauerText(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s)) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Fremdtext entschärfen: keine Code-Zäune (sonst bricht er aus dem Datenblock aus), höchstens `max` Zeichen. */
export function alsDatenblock(text: string, max = 1500): string {
  const t = text.replace(/```/g, "'''").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function auftragMeldung(geraet: string, e: GeraetEreignis): string {
  const teile = [dauerText(e.dauerS), e.kosten !== undefined ? `${e.kosten.toFixed(2).replace('.', ',')} $` : ''].filter(Boolean);
  const zeilen = [`Claude-Code-Auftrag „${e.titel}" auf ${geraet} ${STATUS[e.status] ?? e.status}${teile.length ? ` (${teile.join(', ')})` : ''}.`, `Projekt: ${e.projekt}`];
  const anzahl = e.dateienAnzahl ?? e.dateien?.length ?? 0;
  if (anzahl > 0) {
    const liste = (e.dateien ?? []).slice(0, 10).join(', ');
    zeilen.push(`Geänderte Dateien (${anzahl}): ${liste}${anzahl > Math.min(10, e.dateien?.length ?? 0) ? ', …' : ''}`);
  } else if (e.status === 'fertig') zeilen.push('Keine Dateien geändert.');
  if (e.fehler) zeilen.push(`Fehler: ${alsDatenblock(e.fehler, 300)}`);
  const text = alsDatenblock(e.text ?? '');
  if (text) zeilen.push('', 'Ausgabe von Claude Code (ungeprüft, unverändert):', '```', text, '```');
  zeilen.push('', `Details: „Ergebnis von Auftrag ${e.auftragId}"`);
  return zeilen.join('\n');
}
