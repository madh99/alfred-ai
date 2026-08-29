/**
 * v1146 — S1/S2/S4: Der Wissens-Kern bekommt ein Schema.
 *
 * Diagnose (29.08.): `attributes` war ein freier JSON-Sack — jeder Schreiber
 * durfte beliebige Schlüssel erfinden. So landeten `wohnort: Zürich`,
 * `insurance: Zürich Versicherung`, `expertise: sachverständiger` und
 * `relation_to_linus: friend` an einem Kind, Log-Sätze als „address" an
 * Orten und `birth_year: 2008` neben `birthdate: 2014`. Jede bisherige
 * Absicherung war eine Blacklist an EINEM Konsumenten — dieses Modul ist die
 * POSITIVLISTE an EINER Stelle (zentraler Repo-Upsert) plus täglicher
 * Wächter, der den Bestand selbst heilt.
 */

/** Universell erlaubte Schlüssel (alle Typen). `_prov` trägt die Herkunft (S2). */
const UNIVERSAL = ['alias', 'note', 'memoryKey', 'memoryConfidence', '_prov'];

/**
 * Positivlisten je Entitätstyp. Typen OHNE Eintrag (und der CMDB-Infra-Layer)
 * bleiben unangetastet — das Schema wächst mit, statt Unbekanntes zu zerstören.
 */
export const ENTITY_SCHEMATA: Record<string, ReadonlySet<string>> = {
  person: new Set([...UNIVERSAL,
    'birthdate', 'fullName', 'relation_to_user', 'gender', 'geschlecht',
    'sport', 'interessen', 'hobbys', 'hobbies', 'email', 'phone',
    'realName', 'entity_id', 'state',
  ]),
  location: new Set([...UNIVERSAL,
    'type', 'city', 'state', 'region', 'country', 'postalCode', 'postal_code',
    'street', 'address', 'isHome', 'isWork', 'isUserHome',
    'detectedBy', 'geocodeValidated', 'lat', 'lon',
  ]),
  organization: new Set([...UNIVERSAL,
    'role', 'url', 'website', 'industry', 'branche',
  ]),
  vehicle: new Set([...UNIVERSAL,
    'model', 'battery_pct', 'range_km', 'charging', 'plate',
  ]),
  item: new Set([...UNIVERSAL, 'entity_id', 'state', 'unit', 'type', 'value']),
  metric: new Set([...UNIVERSAL, 'type', 'value', 'unit', 'price_ct', 'temp_c']),
  event: new Set([...UNIVERSAL, 'type', 'time', 'date', 'location']),
};

/**
 * S1 — Attribute gegen das Typ-Schema bereinigen. Liefert die bereinigten
 * Attribute plus die Liste entfernter Schlüssel (fürs Wächter-Log).
 */
export function bereinigeAttributeNachSchema(
  entityType: string,
  attrs: Record<string, unknown>,
): { bereinigt: Record<string, unknown>; entfernt: string[] } {
  const schema = ENTITY_SCHEMATA[entityType];
  if (!schema) return { bereinigt: attrs, entfernt: [] };
  const bereinigt: Record<string, unknown> = {};
  const entfernt: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (schema.has(k)) bereinigt[k] = v;
    else entfernt.push(k);
  }
  return { bereinigt, entfernt };
}

/** Rollen-Wörter, die als Namens-Präfix auftreten („Tochter Lena", „Nichte Emma"). */
const ROLLEN_PRAEFIXE: Record<string, string> = {
  sohn: 'Sohn', tochter: 'Tochter', stiefsohn: 'Stiefsohn', stieftochter: 'Stieftochter',
  nichte: 'Nichte', neffe: 'Neffe', schwester: 'Schwester', bruder: 'Bruder',
  mutter: 'Mutter', vater: 'Vater', mama: 'Mutter', papa: 'Vater',
  oma: 'Großmutter', opa: 'Großvater', großmutter: 'Großmutter', großvater: 'Großvater',
  tante: 'Tante', onkel: 'Onkel', cousin: 'Cousin', cousine: 'Cousine',
  ehemann: 'Ehemann', ehefrau: 'Ehefrau', partnerin: 'Partnerin', partner: 'Partner',
  enkel: 'Enkel', enkelin: 'Enkelin', schwager: 'Schwager', schwägerin: 'Schwägerin',
};

/**
 * S4 — „Nichte Emma" ist kein Name: Rollen-Präfix wird Beziehung, der Rest der
 * Name. Liefert null, wenn kein Präfix vorliegt oder kein plausibler Name bleibt.
 */
export function normalisierePersonenName(roh: string): { name: string; beziehung: string } | null {
  const m = roh.trim().match(/^([A-Za-zÄÖÜäöüß]+)\s+(.+)$/);
  if (!m) return null;
  const beziehung = ROLLEN_PRAEFIXE[m[1].toLowerCase()];
  if (!beziehung) return null;
  const rest = m[2].trim();
  if (!/^[A-ZÄÖÜ][\wäöüß-]+(\s+[A-ZÄÖÜ][\wäöüß-]+)*$/.test(rest)) return null;
  return { name: rest, beziehung };
}

/** S2 — Herkunfts-Eintrag für ein Stammdaten-Attribut. */
export interface ProvEintrag { q: string; c: number; t: string }

export function provEintrag(quelle: string, konfidenz: number): ProvEintrag {
  return { q: quelle, c: konfidenz, t: new Date().toISOString() };
}

/** Herkunfts-Klasse → Rang: explizite User-Aussage schlägt Extraktion schlägt LLM. */
export function provRang(quelle: string | undefined): number {
  if (!quelle) return 0;
  if (quelle.startsWith('user') || quelle.startsWith('manual') || quelle.startsWith('chat')) return 3;
  if (quelle.startsWith('memory') || quelle.startsWith('skill') || quelle.startsWith('calendar')) return 2;
  if (quelle.startsWith('llm')) return 1;
  return 0;
}

/**
 * S2 — darf ein neuer Wert einen bestehenden überschreiben? Nur wenn die neue
 * Herkunft mindestens gleichrangig ist (Widersprüche werden entscheidbar,
 * statt dass „der letzte Schreiber gewinnt").
 */
export function darfUeberschreiben(
  bestehendeProv: ProvEintrag | undefined,
  neueQuelle: string,
): boolean {
  if (!bestehendeProv) return true;
  return provRang(neueQuelle) >= provRang(bestehendeProv.q);
}

/**
 * S4 — Heilungs-Plan für Rollen-Präfix-Namen im Bestand: fullName gewinnt,
 * sonst der Rest-Name; der alte Name wird Alias, die Rolle Beziehung.
 * Pure Funktion (testbar) — die Wartung wendet den Plan an.
 */
export function planePersonenNamensHeilung(
  personen: Array<{ id: string; name: string; attributes?: Record<string, unknown> }>,
): Array<{ id: string; alterName: string; neuerName: string; beziehung?: string }> {
  const vorhandeneNamen = new Set(personen.map(p => p.name.toLowerCase()));
  const plan: Array<{ id: string; alterName: string; neuerName: string; beziehung?: string }> = [];
  for (const p of personen) {
    if (p.name === 'User') continue;
    const norm = normalisierePersonenName(p.name);
    if (!norm) continue;
    const fullName = p.attributes?.fullName as string | undefined;
    const neuerName = (fullName && fullName !== p.name) ? fullName : norm.name;
    if (neuerName.toLowerCase() === p.name.toLowerCase()) continue;
    // Kollision mit existierender Person → nicht umbenennen (Merge ist Sache
    // der Duplikat-Heilung), nur loggen lassen.
    if (vorhandeneNamen.has(neuerName.toLowerCase())) continue;
    vorhandeneNamen.add(neuerName.toLowerCase());
    plan.push({ id: p.id, alterName: p.name, neuerName, beziehung: norm.beziehung });
  }
  return plan;
}
