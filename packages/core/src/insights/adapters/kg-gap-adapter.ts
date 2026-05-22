import type { DomainAdapter, AdapterContext } from '../insight-engine.js';
import type { InsightCandidate } from '@alfred/storage';

interface KgEntity {
  id: string;
  name: string;
  entityType: string;
  mentionCount: number;
  confidence: number;
  attributes: Record<string, unknown>;
}

interface MemoryRow {
  value: string;
}

interface KgRelation {
  relationType: string;
  sourceEntityId: string;
  targetEntityId: string;
}

export interface KgFacade {
  /** v694 — accepts array (owner master + linked + legacy data-uids).
   *  Implementation MUST canonical-merge identical entities across uids by
   *  (entity_type + normalized_name): attributes union (first-non-null wins),
   *  mention_count = max, stable id (lowest alphabetical) — to prevent
   *  insight-spam when the user fills the gap on a different uid-twin. */
  listEntities(userIds: string[]): Promise<KgEntity[]>;
}

/** v695 — Existenz-Check-Adapter:
 *  - listMemoryValues: gibt ALLE memory.value-Strings für die uids (für LIKE-Filter in-memory)
 *  - listRelationsForEntity: holt KG-Edges für eine Entity über alle uids
 *
 *  Beides muss canonical/dedup nicht behandelt werden — wir machen nur Existenz-Tests. */
export interface KgGapDataFacade {
  listMemoryValues(userIds: string[]): Promise<MemoryRow[]>;
  listRelationsForEntity(userIds: string[], entityId: string): Promise<KgRelation[]>;
}

// v695 — Regex-Helper für ehrliche Existenz-Checks.
// Wenn der Name das Wissen schon enthält ODER Memory/KG-Relation es liefert → KEIN Insight.

const RELATION_PREFIX_RE = /^(sohn|tochter|mutter|vater|mama|papa|mami|papi|schwester|bruder|oma|opa|großmutter|großvater|grossmutter|grossvater|tante|onkel|cousin\w*|cousine\w*|nichte|neffe|enkel\w*|mann|frau|partner\w*|freund\w*|freundin\w*|kollege\w*|kollegin\w*|chef\w*|chefin\w*|nachbar\w*|schwiegermutter|schwiegervater|schwager|schwägerin|schwiegersohn|schwiegertochter)\s+/i;

const RELATION_KEYWORDS_RE = /\b(schwester|bruder|tochter|sohn|mutter|vater|mama|papa|frau|mann|partner|partnerin|freund|freundin|cousin|cousine|tante|onkel|nichte|neffe|enkel|oma|opa|nachbar|kollege|kollegin|chef|chefin|schwager|schwägerin|verwandt|familie|verheiratet|ehefrau|ehemann|geschwister)\b/i;

const BIRTHDAY_KEYWORDS_RE = /\b(geburtstag|geboren\s+(am|im)|birthday|birthdate|bday|jahre\s+alt|geb\.\s*\d|am\s+\d{1,2}\.\d{1,2}\.|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})\b/i;

const STREET_IN_NAME_RE = /\b\w+(straße|strasse|gasse|platz|weg|allee|ring|brücke|bruecke|stieg|gang|hof|markt|chaussee|promenade|ufer|kai|zeile|steig)\b/i;
const STREET_WITH_NUMBER_RE = /\b\w*(straße|strasse|gasse|platz|weg|allee|ring|stieg|gang|hof|chaussee)\s*\d+/i;

// Erkennt Städte/Orte am Namen — ohne Straßen-Suffix UND ohne Hausnummer.
// Wenn das Entity einen klaren Ort-Charakter hat, nervt eine Adress-Frage nicht.
const PLACE_NAME_RE = /^(?:[A-ZÄÖÜ][\wäöüß-]+\.?\s?)+$/;

const ADDRESS_KEYWORDS_RE = /\b(straße|strasse|gasse|adresse|wohnt|liegt\s+in|plz|postleitzahl|\b\d{4,5}\b\s+\w+|str\.)\b/i;

const ORG_INFO_KEYWORDS_RE = /\b(website|webseite|url|http|www\.|branche|industrie|tätigkeit|geschäftsfeld|firma|gmbh|ag|kg|gehört\s+zu)\b/i;

/**
 * v695 — Reichere Existenz-Checks BEVOR ein Gap-Insight erzeugt wird.
 * Verhindert Spam für Beziehungen/Geburtstage/Adressen die der KG/Memory schon kennt
 * oder die im Namen selbst stehen.
 */
function personHasKnownRelation(entity: KgEntity, memoryHaystack: string, relations: KgRelation[]): boolean {
  // (1) Name beginnt mit Beziehungs-Wort → "Tochter Hannah", "Sohn Noah"
  if (RELATION_PREFIX_RE.test(entity.name)) return true;
  // (2) KG-Relation-Edge existiert mit family/relation-typ
  for (const r of relations) {
    const t = r.relationType.toLowerCase();
    if (t === 'sibling' || t === 'parent_of' || t === 'child_of' || t === 'spouse' || t === 'spouse_of'
      || t === 'friend' || t === 'colleague' || t === 'relates_to_owner' || t === 'family_of'
      || t === 'partner_of' || t === 'married_to' || t === 'parent' || t === 'child') return true;
  }
  // (3) Memory enthält Name + Beziehungs-Keyword in derselben Zeile
  const nameLower = entity.name.toLowerCase();
  for (const line of memoryHaystack.split('\n')) {
    if (line.includes(nameLower) && RELATION_KEYWORDS_RE.test(line)) return true;
  }
  return false;
}

function personHasKnownBirthday(entity: KgEntity, memoryHaystack: string, relations: KgRelation[]): boolean {
  // attributes (legacy check, redundant aber sicher)
  const a = entity.attributes ?? {};
  if (a.birthday || a.birth_date || a.bday) return true;
  // KG-Relation auf birthday-Event
  for (const r of relations) {
    const t = r.relationType.toLowerCase();
    if (t === 'birthday' || t === 'born_on' || t === 'has_birthday') return true;
  }
  // Memory mit Name + Birthday-Keywords
  const nameLower = entity.name.toLowerCase();
  for (const line of memoryHaystack.split('\n')) {
    if (line.includes(nameLower) && BIRTHDAY_KEYWORDS_RE.test(line)) return true;
  }
  return false;
}

function locationHasKnownAddress(entity: KgEntity, memoryHaystack: string): boolean {
  const a = entity.attributes ?? {};
  if (a.address || a.location || a.coordinates || a.lat || a.lng || a.plz || a.postal_code) return true;
  // Name IST eine Adresse — "Alleestraße 6", "Viktor Kaplan Straße 12"
  if (STREET_WITH_NUMBER_RE.test(entity.name)) return true;
  // Name ist eine Straße ohne Hausnummer — auch okay, kein Insight
  if (STREET_IN_NAME_RE.test(entity.name) && !/\d+\s*$/.test(entity.name)) {
    // street ohne Hausnummer → die Hausnummer fehlt, aber das ist nicht "Adresse fehlt komplett"
    return true;
  }
  // Name ist ein Ort/Stadt — kein Sinn, eine Adresse zu suchen
  // Heuristik: kein straßen-Keyword + keine Hausnummer + nur Wörter mit Großbuchstabe
  const hasStreet = STREET_IN_NAME_RE.test(entity.name);
  const hasNumber = /\d/.test(entity.name);
  if (!hasStreet && !hasNumber && PLACE_NAME_RE.test(entity.name) && entity.name.length <= 30) return true;
  // attributes.type sagt 'city' / 'town' / 'village' / 'country'
  const t = String(a.type ?? a.location_type ?? '').toLowerCase();
  if (t === 'city' || t === 'town' || t === 'village' || t === 'country' || t === 'region' || t === 'state') return true;
  // Memory enthält Name + Adresse-Keyword
  const nameLower = entity.name.toLowerCase();
  for (const line of memoryHaystack.split('\n')) {
    if (line.includes(nameLower) && ADDRESS_KEYWORDS_RE.test(line)) return true;
  }
  return false;
}

function orgHasKnownInfo(entity: KgEntity, memoryHaystack: string): boolean {
  const nameLower = entity.name.toLowerCase();
  for (const line of memoryHaystack.split('\n')) {
    if (line.includes(nameLower) && ORG_INFO_KEYWORDS_RE.test(line)) return true;
  }
  return false;
}

/**
 * v638 / v695 — Findet KG-Lücken die durch häufige Erwähnung wertvoll wären:
 *  - Personen ohne `birthday` mit mentionCount ≥ 5
 *  - Organisationen ohne `url`/`industry`/`address` mit mentionCount ≥ 5
 *  - Locations ohne `address` mit mentionCount ≥ 3
 *
 * v695: VOR jeder Insight-Erzeugung wird geprüft ob die Antwort woanders steht
 * (Name selbst, KG-Relations-Edge, Memory). Wenn ja → kein Insight (kein Spam).
 */
export class KgGapAdapter implements DomainAdapter {
  readonly name = 'kg-gap';

  constructor(
    private readonly kg: KgFacade,
    /** v695 — optional: wenn nicht gesetzt, fällt der Adapter auf rein attributes-basierte Checks zurück (legacy behavior). */
    private readonly data?: KgGapDataFacade,
  ) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    let entities: KgEntity[] = [];
    try { entities = await this.kg.listEntities(ctx.linkedUserIds); } catch { return []; }

    // v695 — Memory einmal pro Sweep laden (LIKE-Filter passiert in-memory)
    let memoryHaystack = '';
    if (this.data) {
      try {
        const memories = await this.data.listMemoryValues(ctx.linkedUserIds);
        memoryHaystack = memories.map(m => (m.value ?? '').toLowerCase()).join('\n');
      } catch { /* skip — fallback: nur attributes-Check */ }
    }

    const out: InsightCandidate[] = [];

    for (const e of entities) {
      const attrs = e.attributes ?? {};
      const mentions = e.mentionCount ?? 0;

      if (e.entityType === 'person' && mentions >= 5) {
        // v695 — Relations einmal pro Person laden (nur wenn data-facade verfügbar)
        let relations: KgRelation[] = [];
        if (this.data) {
          try { relations = await this.data.listRelationsForEntity(ctx.linkedUserIds, e.id); } catch { /* skip */ }
        }

        if (!attrs.birthday && !attrs.birth_date) {
          const skipBirthday = this.data && personHasKnownBirthday(e, memoryHaystack, relations);
          if (!skipBirthday) {
            out.push({
              category: 'kg-gap',
              title: `Geburtstag für ${e.name} fehlt`,
              body: `**${e.name}** wurde ${mentions}× erwähnt aber hat noch keinen Geburtstag im Knowledge-Graph.\n\nWenn du den Geburtstag ergänzt, kann Alfred dich rechtzeitig vor dem Datum erinnern.`,
              confidence: Math.min(0.9, 0.4 + mentions * 0.05),
              sourceData: { entityId: e.id, mentions, attrType: 'birthday' },
              actionSkill: 'memory',
              actionParams: { action: 'add', text: `Geburtstag von ${e.name} ist YYYY-MM-DD (bitte ergänzen)` },
              dedupeKey: `kg-gap:person-birthday:${e.id}`,
            });
          }
        }
        if (!attrs.relation_to_owner && !attrs.relation) {
          const skipRelation = this.data && personHasKnownRelation(e, memoryHaystack, relations);
          if (!skipRelation) {
            out.push({
              category: 'kg-gap',
              title: `Beziehung zu ${e.name} unklar`,
              body: `**${e.name}** wird häufig erwähnt (${mentions}×) — wie steht ihr zueinander? (Familie, Freund, Kollege, …)\n\nDas hilft Alfred bei Familien-Reminders, Geburtstags-Cascades und Kontext-Verständnis in Chats.`,
              confidence: 0.55 + Math.min(0.3, mentions * 0.02),
              sourceData: { entityId: e.id, mentions, attrType: 'relation' },
              dedupeKey: `kg-gap:person-relation:${e.id}`,
            });
          }
        }
      }

      if (e.entityType === 'organization' && mentions >= 5) {
        const missing: string[] = [];
        if (!attrs.url && !attrs.website) missing.push('Website');
        if (!attrs.industry && !attrs.branche) missing.push('Branche');
        if (!attrs.address && !attrs.location) missing.push('Adresse');
        const skipOrg = this.data && orgHasKnownInfo(e, memoryHaystack);
        if (missing.length >= 2 && !skipOrg) {
          out.push({
            category: 'kg-gap',
            title: `Org-Daten zu ${e.name} unvollständig`,
            body: `**${e.name}** wurde ${mentions}× erwähnt, aber Felder fehlen: ${missing.join(', ')}.\n\nSinnvoll für Kontext-Verständnis in Chats und Routing-/Termin-Logik.`,
            confidence: 0.5 + Math.min(0.3, mentions * 0.02),
            sourceData: { entityId: e.id, mentions, missingFields: missing },
            dedupeKey: `kg-gap:org-incomplete:${e.id}`,
          });
        }
      }

      if (e.entityType === 'location' && mentions >= 3 && !attrs.address) {
        const skipLocation = this.data && locationHasKnownAddress(e, memoryHaystack);
        if (!skipLocation) {
          out.push({
            category: 'kg-gap',
            title: `Adresse für ${e.name} fehlt`,
            body: `**${e.name}** wurde ${mentions}× erwähnt, hat aber noch keine Adresse — Routing/Termin-Logik kann's so nicht nutzen.`,
            confidence: 0.5,
            sourceData: { entityId: e.id, mentions, attrType: 'address' },
            dedupeKey: `kg-gap:location-address:${e.id}`,
          });
        }
      }
    }

    return out;
  }
}
