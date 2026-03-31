import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, KGEntity, KGRelation } from '@alfred/storage';
import type { ReasoningSection } from './reasoning-context-collector.js';

// ── Constants ────────────────────────────────────────────────

/** Known Austrian cities for location extraction. */
const KNOWN_LOCATIONS = [
  'Wien', 'Linz', 'Graz', 'Salzburg', 'Innsbruck', 'Klagenfurt',
  'Villach', 'Wels', 'St. Pölten', 'Dornbirn', 'Steyr', 'Wiener Neustadt',
  'Feldkirch', 'Bregenz', 'Leonding', 'Klosterneuburg', 'Baden', 'Leoben',
  'Krems', 'Traun', 'Amstetten', 'Lustenau', 'Kapfenberg', 'Mödling',
  'Hallein', 'Braunau', 'Schwechat', 'Stockerau', 'Saalfelden', 'Ansfelden',
  'Tulln', 'Hohenems', 'Ternitz', 'Perchtoldsdorf', 'Altlengbach',
];

const KNOWN_LOCATIONS_LOWER = new Set(KNOWN_LOCATIONS.map(l => l.toLowerCase()));

/** Approximate distances between Austrian cities (km, one-direction). */
const DISTANCE_TABLE: Record<string, Record<string, number>> = {
  'altlengbach': { 'wien': 45, 'linz': 150, 'graz': 200, 'salzburg': 250, 'st. pölten': 30 },
  'wien': { 'linz': 185, 'graz': 195, 'salzburg': 295, 'innsbruck': 475, 'klagenfurt': 310 },
  'linz': { 'graz': 210, 'salzburg': 130, 'innsbruck': 310, 'wels': 30, 'steyr': 35 },
  'graz': { 'klagenfurt': 150, 'salzburg': 280 },
  'salzburg': { 'innsbruck': 185, 'klagenfurt': 210 },
};

/** Person extraction patterns (German prepositions + capitalized name). */
const PERSON_PATTERNS = [
  /\bmit\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,
  /\bfür\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,
  /\bbei\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,
  /\bvon\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,
];

/** Max tokens for the connection map section. */
const MAX_MAP_TOKENS = 600;

// ── Service ──────────────────────────────────────────────────

export class KnowledgeGraphService {
  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Ingest: Extract entities and relations from collected reasoning sections.
   * Called on every reasoning pass. Entities are UPSERTed (confidence grows).
   */
  async ingest(userId: string, sections: ReasoningSection[]): Promise<void> {
    try {
      for (const section of sections) {
        if (!section.content || section.key === 'knowledge_graph') continue;
        switch (section.key) {
          case 'calendar': await this.extractFromCalendar(userId, section.content); break;
          case 'todos': await this.extractFromTodos(userId, section.content); break;
          case 'watches': await this.extractFromWatches(userId, section.content); break;
          case 'bmw': await this.extractFromVehicle(userId, section.content); break;
          case 'memories': await this.extractFromMemories(userId, section.content); break;
          case 'email': await this.extractFromEmail(userId, section.content); break;
          default: break;
        }
        // Generic extraction for all sections
        await this.extractLocations(userId, section.key, section.content);
        await this.extractPersons(userId, section.key, section.content);
      }
    } catch (err) {
      this.logger.warn({ err }, 'KG ingest failed');
    }
  }

  /**
   * Build a structured connection map for the reasoning prompt.
   * Returns formatted German text or empty string if too few connections.
   */
  async buildConnectionMap(userId: string): Promise<string> {
    try {
      const { entities, relations } = await this.kgRepo.getFullGraph(userId);
      if (entities.length < 2) return '';

      const entityMap = new Map(entities.map(e => [e.id, e]));
      const parts: string[] = [];

      // 1. Cross-Domain Entities: entities appearing in ≥2 different sources
      const crossDomain = entities
        .filter(e => e.sources.length >= 2)
        .sort((a, b) => b.sources.length - a.sources.length || b.mentionCount - a.mentionCount);

      if (crossDomain.length > 0) {
        parts.push('Cross-Domain Entities:');
        for (const e of crossDomain.slice(0, 10)) {
          const rels = relations.filter(r => r.sourceEntityId === e.id || r.targetEntityId === e.id);
          const bySource = this.groupRelationsBySource(rels, e.id, entityMap);
          const attrStr = this.formatAttributes(e.attributes);
          parts.push(`  ${e.name} [${e.entityType}]${attrStr}`);
          for (const [source, descriptions] of bySource) {
            parts.push(`    ${source}: ${descriptions.join(', ')}`);
          }
        }
      }

      // 2. Cross-Domain Relations: relations between entities from different sources
      const crossRelations = relations.filter(r => {
        const src = entityMap.get(r.sourceEntityId);
        const tgt = entityMap.get(r.targetEntityId);
        if (!src || !tgt) return false;
        return !src.sources.every(s => tgt.sources.includes(s));
      }).sort((a, b) => b.strength - a.strength);

      if (crossRelations.length > 0) {
        parts.push('Cross-Domain Verbindungen:');
        for (const r of crossRelations.slice(0, 15)) {
          const src = entityMap.get(r.sourceEntityId);
          const tgt = entityMap.get(r.targetEntityId);
          if (!src || !tgt) continue;
          parts.push(`  ${src.name} [${src.sources.join('+')}] →${r.relationType}→ ${tgt.name} [${tgt.sources.join('+')}]${r.context ? ` (${r.context})` : ''}`);
        }
      }

      // 3. Notable attributes: entities with actionable state (overdue, low battery, prices, urgent)
      const notable = entities.filter(e => {
        const a = e.attributes;
        return a?.overdue || a?.battery_pct !== undefined || a?.price !== undefined ||
          a?.priority === 'high' || a?.priority === 'urgent' || a?.range_km !== undefined;
      });

      if (notable.length > 0) {
        parts.push('Bemerkenswerte Attribute:');
        for (const e of notable.slice(0, 8)) {
          const attrs = this.formatAttributes(e.attributes);
          parts.push(`  ${e.name} [${e.entityType}, ${e.sources.join('+')}]${attrs}`);
        }
      }

      if (parts.length === 0) return '';

      let result = parts.join('\n');
      if (Math.ceil(result.length / 4) > MAX_MAP_TOKENS) {
        result = result.slice(0, MAX_MAP_TOKENS * 4) + '\n...(gekürzt)';
      }

      return result;
    } catch (err) {
      this.logger.warn({ err }, 'KG buildConnectionMap failed');
      return '';
    }
  }

  /** Group relations by their source section for structured display. */
  private groupRelationsBySource(
    relations: KGRelation[], entityId: string, entityMap: Map<string, KGEntity>,
  ): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const r of relations) {
      const otherId = r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId;
      const other = entityMap.get(otherId);
      if (!other) continue;
      const source = r.sourceSection ?? other.sources[0] ?? 'unknown';
      if (!grouped.has(source)) grouped.set(source, []);
      grouped.get(source)!.push(`${other.name} (${r.relationType})`);
    }
    return grouped;
  }

  /** Format entity attributes as compact string, skipping internal fields. */
  private formatAttributes(attrs: Record<string, unknown>): string {
    const entries = Object.entries(attrs).filter(([k]) => !['skillName', 'type', 'isHome'].includes(k));
    if (entries.length === 0) return '';
    return ' | ' + entries.map(([k, v]) => `${k}=${v}`).join(', ');
  }

  /**
   * Maintenance: decay old entities and prune weak ones.
   * Called weekly (alongside TemporalAnalyzer).
   */
  async maintenance(userId: string): Promise<void> {
    try {
      const decayed = await this.kgRepo.decayOldEntities(userId, 30, 0.1);
      const prunedEntities = await this.kgRepo.pruneWeakEntities(userId, 0.2);
      const prunedRelations = await this.kgRepo.pruneWeakRelations(userId, 0.2);
      if (decayed > 0 || prunedEntities > 0 || prunedRelations > 0) {
        this.logger.info({ decayed, prunedEntities, prunedRelations }, 'KG maintenance completed');
      }
    } catch (err) {
      this.logger.warn({ err }, 'KG maintenance failed');
    }
  }

  // ── Section-specific Extractors ─────────────────────────────

  private async extractFromCalendar(userId: string, content: string): Promise<void> {
    // Format: "- Mo 30.03 14:30: Meeting mit Müller (Linz)"
    const re = /^-\s+\S+\s+\S+\s+(\d{2}:\d{2}):\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const [, time, title, location] = match;
      const event = await this.kgRepo.upsertEntity(userId, title.trim(), 'event', { time }, 'calendar');

      if (location) {
        const loc = await this.kgRepo.upsertEntity(userId, location.trim(), 'location', {}, 'calendar');
        await this.kgRepo.upsertRelation(userId, event.id, loc.id, 'located_at', `${time}`, 'calendar');
      }
    }
  }

  private async extractFromTodos(userId: string, content: string): Promise<void> {
    // Format: "  - [high] Geschenk für Müller kaufen (fällig: 2026-03-29)"
    const re = /^\s+-\s+\[(\w+)\]\s+(.+?)(?:\s*\(fällig:\s*([^)]+)\))?\s*$/gm;
    const isOverdueSection = content.includes('Überfällig');
    let match;
    while ((match = re.exec(content)) !== null) {
      const [, priority, title, dueDate] = match;
      const overdue = isOverdueSection && content.indexOf(match[0]) < content.indexOf('Bald fällig');
      const event = await this.kgRepo.upsertEntity(userId, title.trim(), 'event',
        { priority, dueDate, overdue }, 'todos');

      // Extract person from "für <Name>" or "mit <Name>"
      for (const pattern of PERSON_PATTERNS) {
        pattern.lastIndex = 0;
        const personMatch = pattern.exec(title);
        if (personMatch) {
          const person = await this.kgRepo.upsertEntity(userId, personMatch[1].trim(), 'person', {}, 'todos');
          await this.kgRepo.upsertRelation(userId, event.id, person.id, 'involves', title.trim(), 'todos');
        }
      }
    }
  }

  private async extractFromWatches(userId: string, content: string): Promise<void> {
    // Format: '- "RTX 5090" (shopping, alle 60 Min) → ...\n  Letzter Wert: ...'
    const re = /^-\s+"([^"]+)"\s+\((\w+),\s+alle\s+\d+\s+Min\)/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const [, name, skillName] = match;
      // Find the lastValue line
      const afterMatch = content.slice(match.index + match[0].length);
      const valueMatch = afterMatch.match(/Letzter Wert:\s+(.+)/);
      let attributes: Record<string, unknown> = { skillName };

      if (valueMatch) {
        try {
          const parsed = JSON.parse(valueMatch[1]);
          if (typeof parsed === 'object' && parsed !== null) {
            attributes = { ...attributes, ...parsed };
          }
        } catch { /* not JSON */ }
      }

      const item = await this.kgRepo.upsertEntity(userId, name.trim(), 'item', attributes, 'watches');

      // Extract location from attributes (shop name, city)
      const valueStr = valueMatch?.[1] ?? '';
      for (const city of KNOWN_LOCATIONS) {
        if (valueStr.includes(city)) {
          const loc = await this.kgRepo.upsertEntity(userId, city, 'location', {}, 'watches');
          await this.kgRepo.upsertRelation(userId, item.id, loc.id, 'available_at', valueStr.slice(0, 100), 'watches');
        }
      }
    }
  }

  private async extractFromVehicle(userId: string, content: string): Promise<void> {
    const batteryMatch = content.match(/(?:Battery|Akku|SoC)[:\s]*(\d+)\s*%/i);
    const rangeMatch = content.match(/(?:Range|Reichweite)[:\s]*(\d+)\s*km/i);

    if (batteryMatch || rangeMatch) {
      const attrs: Record<string, unknown> = {};
      if (batteryMatch) attrs.battery_pct = parseInt(batteryMatch[1], 10);
      if (rangeMatch) attrs.range_km = parseInt(rangeMatch[1], 10);
      await this.kgRepo.upsertEntity(userId, 'BMW', 'vehicle', attrs, 'bmw');
    }
  }

  private async extractFromMemories(userId: string, content: string): Promise<void> {
    // Format: "- [type] key: value"
    const re = /^-\s+\[(\w+)\]\s+(.+?):\s+(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const [, type, key, value] = match;
      const keyLower = key.toLowerCase();

      // Extract addresses as locations
      if (keyLower.includes('adress') || keyLower.includes('address') || keyLower.includes('heim') || keyLower.includes('home')) {
        // Try to find a city in the value
        for (const city of KNOWN_LOCATIONS) {
          if (value.includes(city)) {
            await this.kgRepo.upsertEntity(userId, city, 'location', { isHome: keyLower.includes('heim') || keyLower.includes('home') }, 'memories');
          }
        }
      }

      // Extract entity-type memories as persons/organizations
      if (type === 'entity' || type === 'relationship') {
        // Simple heuristic: if key contains person-like terms
        if (keyLower.includes('partner') || keyLower.includes('frau') || keyLower.includes('mann') ||
            keyLower.includes('chef') || keyLower.includes('freund') || keyLower.includes('kollege')) {
          await this.kgRepo.upsertEntity(userId, value.trim().split(',')[0].trim(), 'person', { role: key }, 'memories');
        }
      }
    }
  }

  // ── Section-specific Extractors ─────────────────────────────

  private async extractFromEmail(userId: string, content: string): Promise<void> {
    // Format: "1. [acc::123][UNREAD] Subject\n   From: sender@example.com\n   Date: 2026-03-30T..."
    const re = /^\d+\.\s+\[[^\]]+\](?:\s*\[(?:UNREAD|ATT)\])*\s+(.+?)\n\s+From:\s+(\S+)\n\s+Date:\s+(\S+)/gm;

    let match;
    while ((match = re.exec(content)) !== null) {
      const [, subject, fromEmail, dateStr] = match;

      // Sender as person entity (skip generic addresses)
      const senderName = this.emailToName(fromEmail);
      if (senderName) {
        await this.kgRepo.upsertEntity(userId, senderName, 'person', { email: fromEmail }, 'email');
      }

      // Email subject as event entity
      const emailEntity = await this.kgRepo.upsertEntity(userId, subject.trim(), 'event',
        { type: 'email', date: dateStr, from: fromEmail }, 'email');

      // Sender → Email relation
      if (senderName) {
        const sender = await this.kgRepo.getEntityByName(userId, senderName, 'person');
        if (sender) {
          await this.kgRepo.upsertRelation(userId, sender.id, emailEntity.id, 'sent', fromEmail, 'email');
        }
      }
    }
  }

  /**
   * Extract a human name from an email address.
   * Returns null for generic addresses (info@, noreply@, support@, etc.).
   */
  private emailToName(email: string): string | null {
    const local = email.split('@')[0];
    if (/^(info|office|noreply|no-reply|support|admin|kontakt|contact|newsletter|buchhaltung|rechnung|service|hello|team|sales|marketing|billing)$/i.test(local)) {
      return null;
    }
    const name = local
      .replace(/[._-]/g, ' ')
      .split(' ')
      .filter(p => p.length > 1)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
    return name || null;
  }

  // ── Generic Extractors ──────────────────────────────────────

  private async extractLocations(userId: string, sectionKey: string, content: string): Promise<void> {
    for (const city of KNOWN_LOCATIONS) {
      if (content.includes(city)) {
        await this.kgRepo.upsertEntity(userId, city, 'location', {}, sectionKey);
      }
    }
  }

  private async extractPersons(userId: string, sectionKey: string, content: string): Promise<void> {
    for (const pattern of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1].trim();
        // Filter out common German words that might be capitalized after prepositions
        if (name.length < 2 || /^(Dem|Der|Das|Den|Die|Ein|Eine|Einer|Seinem|Seiner|Ihrem|Ihrer)$/i.test(name)) continue;
        await this.kgRepo.upsertEntity(userId, name, 'person', {}, sectionKey);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function estimateDistance(userId: string, targetNormalized: string, entities: KGEntity[]): number | undefined {
  // Find home location
  const homeEntity = entities.find(e =>
    e.entityType === 'location' && (e.attributes?.isHome === true),
  );
  const homeCity = homeEntity?.normalizedName;
  if (!homeCity) return undefined;

  return lookupDistance(homeCity, targetNormalized);
}

function lookupDistance(from: string, to: string): number | undefined {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (f === t) return 0;
  return DISTANCE_TABLE[f]?.[t] ?? DISTANCE_TABLE[t]?.[f];
}
