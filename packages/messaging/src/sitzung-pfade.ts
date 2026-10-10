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
  // v1249 — blockweiser Dateitransfer des Satelliten
  /^\/api\/geraete\/dateien(\/[^/]+(\/fertig)?)?$/,
  // v1258 — Satelliten-Autoupdate
  /^\/api\/geraete\/update(\/datei)?$/,
  /^\/api\/geraete\/abmelden$/, // v1274
  /^\/api\/geraete\/verlauf$/, // v1314
  /^\/api\/app\/update(\/datei)?$/, // v1322 — Desktop-App holt ihr eigenes Update (M6) — Verlauf der eigenen Sitzung für die Desktop-App
  /^\/api\/vorgaenge$/, // v1313 — Kachel „Vorgänge" der Desktop-App (nur Liste; Entscheidungen bleiben beim API-Token)
  /^\/api\/geraete\/faeden(\/[a-z0-9-]{1,40})?$/, // v1328 — Gesprächsfäden der eigenen Sitzung (Liste, Löschen)
  /^\/api\/geraete\/spiegelung$/, // v1334 — Spiegel-Schalter (nur Geräte des Owners)
  /^\/api\/geraete\/hinweise(\/[A-Za-z0-9-]{1,64})?$/, // v1343 — Sammlung „Hinweise" (nur Geräte des Owners): Liste, Entscheidung
];

export function istSitzungsPfad(url: string | undefined): boolean {
  if (!url) return false;
  const pfad = url.split('?')[0];
  return SITZUNG_PFADE.some(r => r.test(pfad));
}

/**
 * v1328 — Gesprächsfäden je Gerät (Redesign Stufe 2): chatId `sitzung:<geraetId>` (Hauptgespräch) oder
 * `sitzung:<geraetId>:<faden>` mit faden aus [a-z0-9-]{1,40}. Ein Gerätetoken darf nur Chats seiner eigenen Sitzung
 * ansprechen — vorher wurde eine mitgeschickte chatId ungeprüft übernommen.
 */
const FADEN = /^[a-z0-9-]{1,40}$/;

export function zerlegeSitzungsChat(chatId: string): { geraetId: string; faden?: string } | undefined {
  if (!chatId.startsWith('sitzung:')) return undefined;
  const rest = chatId.slice('sitzung:'.length);
  const i = rest.indexOf(':');
  if (i < 0) return rest ? { geraetId: rest } : undefined;
  const geraetId = rest.slice(0, i); const faden = rest.slice(i + 1);
  return geraetId && FADEN.test(faden) ? { geraetId, faden } : undefined;
}

export function sitzungsChat(geraetId: string, faden?: string): string {
  return faden && FADEN.test(faden) ? `sitzung:${geraetId}:${faden}` : `sitzung:${geraetId}`;
}

export function sitzungsChatErlaubt(chatId: string, geraetId: string): boolean {
  const z = zerlegeSitzungsChat(chatId);
  return !!z && z.geraetId === geraetId;
}

export function istFaden(s: unknown): s is string { return typeof s === 'string' && FADEN.test(s); }
