/**
 * v1224 — Geräte-Protokoll (Spec docs/specs/2026-10-06-geraete-architektur.md).
 *
 * Ein Gerät (Satellit) verbindet sich von innen nach außen mit dem Gehirn, meldet sein
 * Manifest und bietet Aktionen an, die als Skill `geraet_<name>` im Gehirn erscheinen.
 * Diese Typen sind die einzige Quelle der Wahrheit für Server, CLI und später die Apps.
 */
export const GERAETE_PROTOKOLL_VERSION = 1;

export type GeraetPlattform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'raspberry';
export type GeraetAutonomie = 'auto' | 'bestaetigen' | 'nie';

export interface GeraetAktionDef {
  /** Kurzname, z. B. `oeffnen`, `shell`, `liste`, `hinweis` — [a-z_], 2–30 Zeichen. */
  name: string;
  beschreibung: string;
  autonomie: GeraetAutonomie;
  /** JSON-Schema-artige Parameterbeschreibung für das Modell. */
  parameter?: Record<string, { type: string; description?: string; required?: boolean; items?: Record<string, unknown> }>; // v1383 items für Arrays
}

export interface GeraetManifest {
  protokoll: 1;
  plattform: GeraetPlattform;
  hostname: string;
  satellitVersion: string;
  aktionen: GeraetAktionDef[];
  /** Sinne, die das Gerät liefert (Phase 3): z. B. `leerlauf`, `akku`, `zone`, `fenster`. */
  sinne: string[];
}

export interface GeraetRahmen { typ: string; id: string; zeit: string; version: 1 }

export interface GeraetHallo extends GeraetRahmen { typ: 'hallo'; geraetId: string; token: string; manifest: GeraetManifest }
export interface GeraetWillkommen extends GeraetRahmen { typ: 'willkommen'; geraetId: string; name: string; serverVersion: string; skillName: string; /** v1258 — öffentlicher Release-Schlüssel (PEM) für signierte Updates */ releaseKey?: string }
export interface GeraetPuls extends GeraetRahmen { typ: 'puls' }
export interface GeraetPulsOk extends GeraetRahmen { typ: 'puls_ok' }
export interface GeraetAktion extends GeraetRahmen { typ: 'aktion'; aktion: string; params: Record<string, unknown>; begruendung?: string; vorgangId?: string }
export interface GeraetAktionErgebnis extends GeraetRahmen { typ: 'aktion_ergebnis'; success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }
export interface GeraetSinne extends GeraetRahmen { typ: 'sinne'; werte: Record<string, unknown> }
export interface GeraetFehler extends GeraetRahmen { typ: 'fehler'; grund: string }
export interface GeraetAbgemeldet extends GeraetRahmen { typ: 'abgemeldet'; grund: string }

/** v1302 — Gehirn → Gerät: neue Bestätigung für den Owner (Sitzungen am Gerät zeigen sie sofort; Entscheidung weiter per HTTP). */
export interface GeraetBestaetigung extends GeraetRahmen { typ: 'bestaetigung'; bestaetigung: { id: string; description: string; source?: string; skillName?: string; createdAt?: string; expiresAt?: string } }

/** v1330 — Gehirn → Gerät: ein Owner-Gespräch (Hauptgespräch oder Faden) wurde auf einem anderen Kanal fortgeführt. */
export interface GeraetGespraech extends GeraetRahmen { typ: 'gespraech'; faden: string | null; von: string }

/** v1342 — Ereignis vom Gerät (Auftrag an Claude Code beendet); das Gehirn setzt in der anfragenden Sitzung fort. */
export interface GeraetEreignis extends GeraetRahmen { typ: 'ereignis'; art: 'auftrag'; auftragId: string; status: 'fertig' | 'fehler' | 'abgebrochen'; titel: string; projekt: string; text: string; dauerS?: number; kosten?: number; fehler?: string; dateien?: string[]; dateienAnzahl?: number; /** v1426 — CHANGELOG.md im Projekt seit Auftragsstart geändert (fehlt bei älteren Satelliten) */ changelogGeaendert?: boolean; /** v1432 — Claude-Code-Sitzung (für Folgefragen) */ sitzung?: string } // v1382 fehler/dateien

/** v1418 G2 — laufender Claude-Code-Auftrag: letzte Schritte (gekürzt, Geheimnisse geschwärzt), höchstens alle 5 s, Lebenszeichen jede Minute */
export interface GeraetFortschritt extends GeraetRahmen { typ: 'fortschritt'; auftragId: string; schritte: string[]; werkzeuge: number }

/** v1429 R4a — Gerät → Gehirn: Beobachtungen (nur Kopfdaten, gebündelt) zu Regeln, die das Gehirn mit `beobachten` geschickt hat. */
export interface GeraetBeobachtung extends GeraetRahmen { typ: 'beobachtung'; ereignisse: Array<{ regel: string; quelle: string; art: string; schluessel: string; zeit: string; kopf: Record<string, unknown> }> }
/** v1429 R4a — Gehirn → Gerät: aktive Beobachter-Regeln dieses Geräts (ersetzt die bisherigen). */
export interface GeraetBeobachten extends GeraetRahmen { typ: 'beobachten'; regeln: Array<Record<string, unknown>> }

export type GeraetNachricht =
  | GeraetHallo | GeraetWillkommen | GeraetPuls | GeraetPulsOk
  | GeraetAktion | GeraetAktionErgebnis | GeraetSinne | GeraetFehler | GeraetAbgemeldet | GeraetBestaetigung | GeraetGespraech | GeraetEreignis | GeraetFortschritt
  | GeraetBeobachtung | GeraetBeobachten;

/** Eintrag der Geräte-Registry (Gehirn). */
/** Phase 5 H2 (Spec Geräte §20.5 Punkt 3) — Push-Weg eines Handys: APNs (iOS), später FCM (Android). */
export interface GeraetPush {
  art: 'apns' | 'fcm';
  token: string;
  /** nur APNs: `sandbox` für Xcode-/Debug-Builds, `production` für TestFlight und App Store */
  umgebung?: 'sandbox' | 'production';
}

export interface GeraetEintrag {
  id: string;
  userId: string;
  name: string;
  plattform: GeraetPlattform;
  manifest: GeraetManifest;
  scopes: string[];
  status: 'aktiv' | 'widerrufen';
  zuletztGesehen?: string;
  erstellt: string;
}

/**
 * v1487 — Web-App des Owners: interne Kennung an Stelle einer Geräte-ID für die Owner-Ansichten (Vorgänge, Befunde, Regeln,
 * Hinweise, Aufgaben). Setzt nur die Web-Route /api/owner/* nach der Owner-Prüfung der Web-Anmeldung; nie aus einem Gerätetoken.
 */
export const WEB_OWNER_QUELLE = 'web:owner';
