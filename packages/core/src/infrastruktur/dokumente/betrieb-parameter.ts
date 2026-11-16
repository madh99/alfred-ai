/**
 * Betriebsdokument nachziehen — Parameter einer Betriebs-Instanz: welche CMDB-Assets (und optional Vorhaben, Architektur-Dokument,
 * Jobs, Standard-Vorlagen, Restore-Change) ein bestehendes System bilden. Gespeichert als JSON in infra_bauplan_instanzen.parameter.
 */
export interface BetriebParameter {
  /** CMDB-Asset-IDs (beim Anlegen aufgelöst), ≥ 1, ≤ 40 */
  assets: string[];
  /** infra_vorhaben.id */
  vorhabenId?: string;
  /** cmdb_documents.id */
  architekturDocId?: string;
  /** jobKeys, z. B. 'pki-betrieb' */
  jobs?: string[];
  /** Vorlagen-Keys, z. B. 'k' */
  standardVorlagen?: string[];
  /** Change mit dem letzten Restore-Beweis */
  restoreChangeId?: string;
  /** ausdrücklich zugeordnete Tresor-Einträge (nur Namen; systemweite Geheimnisse ohne Asset-Namen) */
  tresor?: string[];
  /** kuratierte Aufbau-Changes für Kapitel 7, in dieser Reihenfolge (≤ 40, beim Anlegen aufgelöst) */
  aufbauChangeIds?: string[];
}

/** Bausteine (Namen) je System; ein Name kann mehrere Assets umfassen (VM und Server), gespeichert werden bis zu MAX_ASSET_IDS IDs */
export const MAX_ASSETS = 40;
export const MAX_ASSET_IDS = 80;
const MAX_LISTE = 40;
const SCHLUESSEL = /^[\w.-]{1,80}$/;
const ERLAUBT = new Set(['assets', 'vorhabenId', 'architekturDocId', 'jobs', 'standardVorlagen', 'restoreChangeId', 'tresor', 'aufbauChangeIds']);

function schluesselListe(feld: string, v: unknown): string[] | string {
  if (!Array.isArray(v)) return `${feld}: Liste erwartet`;
  if (v.length > MAX_LISTE) return `${feld}: höchstens ${MAX_LISTE} Einträge`;
  const aus: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !SCHLUESSEL.test(x)) return `${feld}: ungültiger Schlüssel „${String(x).slice(0, 40)}“ (nur Buchstaben, Ziffern, _ . -, höchstens 80 Zeichen)`;
    if (aus.includes(x)) return `${feld}: „${x}“ doppelt angegeben`;
    aus.push(x);
  }
  return aus;
}

function id(feld: string, v: unknown): string | undefined | { fehler: string } {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > 100) return { fehler: `${feld}: nichtleere ID (Text, höchstens 100 Zeichen) erwartet` };
  return v.trim();
}

/** string = Fehlertext */
export function pruefeBetriebParameter(p: unknown, maxAssets: number = MAX_ASSETS): BetriebParameter | string {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'parameter: Objekt erwartet';
  const o = p as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ERLAUBT.has(k)) return `parameter: unbekannter Schlüssel „${k}“`;
  if (!Array.isArray(o.assets) || o.assets.length < 1) return 'assets: mindestens ein Asset angeben';
  if (o.assets.length > maxAssets) return `assets: höchstens ${maxAssets} Assets`;
  const assets: string[] = [];
  for (const a of o.assets) {
    if (typeof a !== 'string' || !a.trim()) return 'assets: nur nichtleere Texte (ID)';
    if (assets.includes(a.trim())) return `assets: „${a.trim()}“ doppelt angegeben`;
    assets.push(a.trim());
  }
  const erg: BetriebParameter = { assets };
  for (const [feld, schl] of [['vorhabenId', 'vorhabenId'], ['architekturDocId', 'architekturDocId'], ['restoreChangeId', 'restoreChangeId']] as const) {
    const w = id(feld, o[schl]);
    if (typeof w === 'object') return w.fehler;
    if (w !== undefined) erg[feld] = w;
  }
  for (const feld of ['jobs', 'standardVorlagen', 'tresor', 'aufbauChangeIds'] as const) {
    if (o[feld] === undefined) continue;
    const l = schluesselListe(feld, o[feld]);
    if (typeof l === 'string') return l;
    erg[feld] = l;
  }
  return erg;
}
