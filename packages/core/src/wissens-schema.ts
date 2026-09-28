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

// ── v1157 — Namens-Schema je Typ ──────────────────────────────────────────
//
// Befund 16.09.: Der Memory→KG-Extraktor nahm das erste großgeschriebene Wort
// JEDES Entity-Memories als Personenname („Mistral", „Sportverein" aus
// organization_*-Memories) und Satzanfänge als Organisation („Erinnerung aktiv
// seit"). Jeder Reasoning-Tick zählte diese Leichen hoch (+48 Mentions/Tag),
// bis sie die Frage-Auswahl dominierten („Wann hat Mistral Geburtstag?").
// Wie beim Attribut-Schema gilt: EINE Positiv-Definition, von allen Schreibern
// UND der Nacht-Wartung benutzt — kein Konsumenten-Pflaster.

/** Namen von Systemen/Diensten/Rollen, die nie eine Person sind. */
const SYSTEM_NAMEN = new Set([
  'mistral', 'openai', 'anthropic', 'claude', 'gemini', 'google', 'microsoft', 'alfred',
  'chatgpt', 'gpt', 'ollama', 'admin', 'system', 'bot', 'api', 'telegram', 'discord',
  'whatsapp', 'matrix', 'signal', 'proxmox', 'unifi', 'mikrotik', 'commvault', 'bmw',
]);

/** Gattungswörter, die als Personenname durchrutschten (Großschreibung ≠ Eigenname). */
const GATTUNGSWOERTER = new Set([
  'sportverein', 'verein', 'projekt', 'team', 'firma', 'kunde', 'kundin', 'familie',
  'mannschaft', 'schule', 'kindergarten', 'trainer', 'lehrer', 'lehrerin', 'nachbar',
  'nachbarin', 'kollege', 'kollegin', 'freund', 'freundin', 'person', 'mitarbeiter',
  'mitarbeiterin', 'chef', 'chefin', 'arzt', 'ärztin', 'werkstatt', 'bank', 'versicherung',
  'erinnerung', 'termin', 'nachricht', 'insight', 'hinweis', 'aufgabe', 'todo', 'notiz',
]);

/** Titel-Tokens, die vor einem Personennamen stehen dürfen („Dr. Alfred Steindl"). */
const TITEL_TOKENS = /^(dr|prof|mag|ing|dipl|med|univ|dr\.med|bakk|msc|bsc|mba)\.?$/i;

/** Satz-Wörter, die in einem Organisationsnamen nichts verloren haben. */
const SATZ_WOERTER = /\b(seit|aktiv|wurde|wird|ist|sind|hat|haben|kann|soll|muss|für|mit|bei|nach|vom|und|oder|bis|ab|am|im|zum|zur|auf|über|unter|wegen|dass|wenn|weil)\b/i;

/**
 * Personenname: 1–3 Namens-Wörter (Titel und Rollen-Präfix erlaubt), jedes
 * beginnt mit Großbuchstabe, keine Ziffern, kein System-/Gattungswort.
 * „User" ist die Owner-Entität und immer gültig.
 */
export function istPlausiblerPersonenName(name: string): boolean {
  const roh = name.trim();
  if (roh === 'User') return true;
  if (roh.length < 2 || roh.length > 60 || /[0-9_@#:/\\]/.test(roh)) return false;
  let tokens = roh.split(/\s+/);
  if (tokens.length > 0 && ROLLEN_PRAEFIXE[tokens[0].toLowerCase()]) tokens = tokens.slice(1);
  tokens = tokens.filter(t => !TITEL_TOKENS.test(t));
  if (tokens.length === 0 || tokens.length > 3) return false;
  for (const t of tokens) {
    if (!/^[A-ZÄÖÜ][a-zäöüßA-ZÄÖÜ'-]+$/.test(t)) return false;
    const l = t.toLowerCase();
    if (GATTUNGSWOERTER.has(l) || ARTIKEL_PRONOMEN.has(l)) return false;
  }
  // Systemnamen nur als GANZER Name ausschließen: „Mistral" ist keine Person,
  // „Dr. Alfred Steindl" (Vorname Alfred) sehr wohl.
  if (tokens.length === 1 && SYSTEM_NAMEN.has(tokens[0].toLowerCase())) return false;
  return true;
}

/** Großgeschriebene Artikel/Pronomen am Satzanfang („Der", „Dieser") sind keine Namen. */
const ARTIKEL_PRONOMEN = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen',
  'dieser', 'diese', 'dieses', 'jeder', 'jede', 'keiner', 'keine', 'seiner', 'seine', 'ihrer', 'ihre',
  'alle', 'allen', 'beide', 'beiden', 'andere', 'anderen', 'wer', 'was', 'wie', 'wann', 'wo',
]);

/**
 * Organisationsname: beginnt groß, max. 6 Wörter, keine Satz-Wörter
 * („aktiv seit"), beginnt nicht mit einem Gattungswort („Erinnerung …"),
 * keine Doppelpunkte/Klammern (= Satzfragment).
 */
export function istPlausiblerOrgName(name: string): boolean {
  const roh = name.trim();
  if (roh.length < 2 || roh.length > 60) return false;
  if (/[:()\[\]{}"]/.test(roh)) return false;
  const tokens = roh.split(/\s+/);
  if (tokens.length > 6) return false;
  // Mindestens ein Wort muss einen Großbuchstaben oder eine Ziffer enthalten
  // („aWATTar GmbH", „KSV 1919", „go-e GmbH" bleiben erlaubt; „wurde gestern
  // bezahlt" nicht).
  if (!tokens.some(t => /[A-ZÄÖÜ0-9]/.test(t))) return false;
  if (SATZ_WOERTER.test(roh)) return false;
  if (GATTUNGSWOERTER.has(tokens[0].toLowerCase())) return false;
  if (SYSTEM_NAMEN.has(roh.toLowerCase()) && roh.toLowerCase() === 'alfred') return false;
  return true;
}

/** Systemname (LLM-Anbieter, Dienste, Rollen) — für Fragen-Ausschluss bei Organisationen. */
export function istSystemName(name: string): boolean {
  return SYSTEM_NAMEN.has(name.trim().toLowerCase());
}

/** Länder, Bundesländer und Großstädte, nach deren „Adresse" nie gefragt werden darf. */
const GROSSRAUM_ORTE = new Set([
  'österreich', 'deutschland', 'schweiz', 'italien', 'europa',
  'wien', 'niederösterreich', 'oberösterreich', 'steiermark', 'kärnten', 'salzburg', 'tirol',
  'vorarlberg', 'burgenland', 'bayern', 'graz', 'linz', 'innsbruck', 'klagenfurt', 'bregenz',
  'eisenstadt', 'st. pölten', 'villach', 'wels', 'steyr', 'kapfenberg', 'münchen', 'berlin',
  'hamburg', 'köln', 'zürich', 'altlengbach',
]);

/**
 * v1158 — Ort ist Region/Stadt statt konkreter Adresse: kein Kandidat für
 * „Wo liegt X genau? (Adresse)". Realfall 27.09.: „Wo liegt Niederösterreich genau?".
 */
export function istGrossraumOrt(name: string, attrs: Record<string, unknown> = {}): boolean {
  const l = name.trim().toLowerCase();
  if (GROSSRAUM_ORTE.has(l)) return true;
  const typ = String(attrs.type ?? '').toLowerCase();
  if (/^(city|stadt|region|state|bundesland|country|land|district|bezirk)$/.test(typ)) return true;
  if (/^(st\.|sankt)\s/i.test(name)) return true;
  // Einzelwort ohne Ziffer = Ortsname (Venues/Adressen sind mehrwortig oder nummeriert)
  return !/\d/.test(name) && name.trim().split(/\s+/).length === 1;
}

/** Typ-Dispatch für Schreiber und Wartung; andere Typen bleiben unangetastet. */
export function istPlausiblerEntitaetsName(entityType: string, name: string): boolean {
  if (entityType === 'person') return istPlausiblerPersonenName(name);
  if (entityType === 'organization') return istPlausiblerOrgName(name);
  return true;
}

/**
 * Memory-Schlüssel, aus denen NIE eine Person abgeleitet werden darf
 * (Organisationen, Erinnerungen, Skills, interne Marker).
 */
export const KEIN_PERSONEN_MEMORY_KEY = /^(organization|org|company|firma|club|verein|aktiv|reminder|erinnerung|project|projekt|skill|tool|insight|todo|watch|workflow)_/i;

/** Memory-Schlüssel, aus denen NIE eine Organisation abgeleitet werden darf. */
export const KEIN_ORG_MEMORY_KEY = /^(aktiv|reminder|erinnerung|insight|todo|watch|workflow|child|son|daughter|mother|father|sister|brother|friend)_/i;

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
