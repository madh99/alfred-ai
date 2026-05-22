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

export interface KgFacade {
  /** v694 — accepts array (owner master + linked + legacy data-uids).
   *  Implementation MUST canonical-merge identical entities across uids by
   *  (entity_type + normalized_name): attributes union (first-non-null wins),
   *  mention_count = max, stable id (lowest alphabetical) — to prevent
   *  insight-spam when the user fills the gap on a different uid-twin. */
  listEntities(userIds: string[]): Promise<KgEntity[]>;
}

/**
 * v638 — Findet KG-Lücken die durch häufige Erwähnung wertvoll wären:
 *  - Personen ohne `birthday` mit mentionCount ≥ 5
 *  - Organisationen ohne `url` ODER `industry` mit mentionCount ≥ 5
 *  - Locations ohne `address` mit mentionCount ≥ 3
 *
 * Erzeugt einen Insight pro Lücke mit Vorschlag der entsprechenden Memory-Skill-Action.
 */
export class KgGapAdapter implements DomainAdapter {
  readonly name = 'kg-gap';

  constructor(private readonly kg: KgFacade) {}

  async generate(ctx: AdapterContext): Promise<InsightCandidate[]> {
    let entities: KgEntity[] = [];
    try { entities = await this.kg.listEntities(ctx.linkedUserIds); } catch { return []; }

    const out: InsightCandidate[] = [];

    for (const e of entities) {
      const attrs = e.attributes ?? {};
      const mentions = e.mentionCount ?? 0;

      if (e.entityType === 'person' && mentions >= 5) {
        if (!attrs.birthday && !attrs.birth_date) {
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
        if (!attrs.relation_to_owner && !attrs.relation) {
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

      if (e.entityType === 'organization' && mentions >= 5) {
        const missing: string[] = [];
        if (!attrs.url && !attrs.website) missing.push('Website');
        if (!attrs.industry && !attrs.branche) missing.push('Branche');
        if (!attrs.address && !attrs.location) missing.push('Adresse');
        if (missing.length >= 2) {
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

    return out;
  }
}
