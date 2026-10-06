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
  parameter?: Record<string, { type: string; description?: string; required?: boolean }>;
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
export interface GeraetWillkommen extends GeraetRahmen { typ: 'willkommen'; geraetId: string; name: string; serverVersion: string; skillName: string }
export interface GeraetPuls extends GeraetRahmen { typ: 'puls' }
export interface GeraetPulsOk extends GeraetRahmen { typ: 'puls_ok' }
export interface GeraetAktion extends GeraetRahmen { typ: 'aktion'; aktion: string; params: Record<string, unknown>; begruendung?: string; vorgangId?: string }
export interface GeraetAktionErgebnis extends GeraetRahmen { typ: 'aktion_ergebnis'; success: boolean; data?: unknown; display?: string; error?: string; dauerMs: number }
export interface GeraetSinne extends GeraetRahmen { typ: 'sinne'; werte: Record<string, unknown> }
export interface GeraetFehler extends GeraetRahmen { typ: 'fehler'; grund: string }
export interface GeraetAbgemeldet extends GeraetRahmen { typ: 'abgemeldet'; grund: string }

export type GeraetNachricht =
  | GeraetHallo | GeraetWillkommen | GeraetPuls | GeraetPulsOk
  | GeraetAktion | GeraetAktionErgebnis | GeraetSinne | GeraetFehler | GeraetAbgemeldet;

/** Eintrag der Geräte-Registry (Gehirn). */
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
