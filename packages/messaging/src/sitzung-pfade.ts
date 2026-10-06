/**
 * v1232 — Welche Routen ein gekoppeltes Gerät mit seinem Gerätetoken erreichen darf (Sitzung):
 * Chat als Owner, Bestätigungen, Lebenszeichen, Geräteliste. Alles andere bleibt dem
 * API-Token und den Benutzer-Sitzungen vorbehalten — das Gerätetoken ist kein Generalschlüssel.
 */
const SITZUNG_PFADE = [
  /^\/api\/message$/,
  /^\/api\/confirmations\/pending$/,
  /^\/api\/confirmations\/[^/]+\/(approve|reject)$/,
  /^\/api\/lebenszeichen$/,
  /^\/api\/geraete$/,
  /^\/api\/health$/,
  // v1241 — Sprache in der Sitzung
  /^\/api\/transcribe$/,
  /^\/api\/sprich$/,
];

export function istSitzungsPfad(url: string | undefined): boolean {
  if (!url) return false;
  const pfad = url.split('?')[0];
  return SITZUNG_PFADE.some(r => r.test(pfad));
}
