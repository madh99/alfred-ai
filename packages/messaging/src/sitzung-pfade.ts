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
  /^\/api\/geraete\/faeden(\/[a-z0-9-]{1,40}(\/(abzweigen|aufgabe|zusammenfassung|lesezeichen|bewertung))?)?$/, // v1328 — Gesprächsfäden der eigenen Sitzung (Liste, Löschen); v1500 abzweigen, geplante Aufgabe
  /^\/api\/geraete\/spiegelung$/, // v1334 — Spiegel-Schalter (nur Geräte des Owners)
  /^\/api\/geraete\/hinweise(\/[A-Za-z0-9-]{1,64})?$/, // v1343 — Sammlung „Hinweise" (nur Geräte des Owners): Liste, Entscheidung
  /^\/api\/geraete\/anhang\/[0-9a-f]{32}$/, // v1349 — abgelegte Anhänge aus dem Verlauf (v1347 fehlte hier → 401)
  /^\/api\/geraete\/(suche|anhaenge)$/, // v1350 — Suche im Verlauf, Übersicht der Anhänge
  /^\/api\/geraete\/stufen$/, // v1510 D6b — Stufen mit Modell und Gründlichkeit
  /^\/api\/geraete\/kopplungscode$/, // v1535 — neues Gerät aus der App koppeln (nur Owner-Geräte, Owner bekommt eine Meldung)
  /^\/api\/geraete\/konto$/, // v1506 D5 — Kontomenü (Kosten, Geräte); nur Owner-Geräte
  /^\/api\/geraete\/push$/, // v1518 H2 — Push-Token des Handys, Schalter „Telegram stumm“
  /^\/api\/geraete\/ablage(\/[0-9a-f-]{36}(\/datei)?)?$/, // v1520 Zwischenablage, v1521 Datei des Handys
  /^\/api\/geraete\/zone$/, // v1522 — Standortzone des Handys
  /^\/api\/geraete\/fokus$/, // v1528 — iOS-Fokus des Handys
  /^\/api\/geraete\/zonen\/vorschlag$/, // v1522 — Vorschlag „Zuhause“ aus Home Assistant
  /^\/api\/geraete\/datei$/, // v1505 — eigene hochgeladene Datei (Vorschau im Verlauf), Schlüssel als ?key=
  /^\/api\/geraete\/meldung$/, // v1351 — Fehlermeldungen der Desktop-App ins Server-Log
  /^\/api\/geraete\/abbrechen$/, // v1352 — laufende Antwort der eigenen Sitzung abbrechen
  /^\/api\/geraete\/(aufgaben|erinnerungen|gedaechtnis|vorgaenge|befunde|regeln|projekte|beobachter)(\/[A-Za-z0-9_-]{1,64})?$/, // v1353 — native Ansichten (nur Geräte des Owners); v1359 befunde; v1362 regeln; v1401 projekte
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
