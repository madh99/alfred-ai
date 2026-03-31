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
const MAX_MAP_TOKENS = 400;

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

      // 1. Persons appearing in multiple sources
      const multiSourcePersons = entities.filter(e => e.entityType === 'person' && e.sources.length >= 2);
      if (multiSourcePersons.length > 0) {
        parts.push('Personen (mehrere Quellen):');
        for (const p of multiSourcePersons.slice(0, 5)) {
          const rels = relations.filter(r => r.sourceEntityId === p.id || r.targetEntityId === p.id);
          const contexts = rels.map(r => r.context).filter(Boolean).slice(0, 3);
          parts.push(`  ${p.name} → ${p.sources.join(', ')}${contexts.length > 0 ? ': ' + contexts.join('; ') : ''}`);
        }
      }

      // 2. Locations with connected events/items
      const locations = entities.filter(e => e.entityType === 'location');
      if (locations.length > 0) {
        parts.push('Orte:');
        for (const loc of locations.slice(0, 5)) {
          const connectedRels = relations.filter(r => r.targetEntityId === loc.id);
          const connectedNames = connectedRels.map(r => {
            const source = entityMap.get(r.sourceEntityId);
            return source ? `${source.name} (${r.relationType}${r.context ? ', ' + r.context : ''})` : null;
          }).filter(Boolean);

          // Check vehicle range constraint
          const vehicle = entities.find(e => e.entityType === 'vehicle');
          let rangeWarning = '';
          if (vehicle?.attributes?.range_km) {
            const dist = estimateDistance(userId, loc.normalizedName, entities);
            if (dist && (vehicle.attributes.range_km as number) < dist) {
              rangeWarning = ` ⚠ BMW ${vehicle.attributes.battery_pct ?? '?'}% (${vehicle.attributes.range_km}km) < ${dist}km`;
            }
          }

          parts.push(`  ${loc.name} → ${connectedNames.slice(0, 4).join(', ')}${rangeWarning}`);
        }
      }

      // 3. Conflicts: overdue todos mentioning a person who has upcoming events
      const conflicts: string[] = [];
      const events = entities.filter(e => e.entityType === 'event');
      const persons = entities.filter(e => e.entityType === 'person');
      for (const person of persons) {
        const personRels = relations.filter(r =>
          (r.sourceEntityId === person.id || r.targetEntityId === person.id),
        );
        const hasOverdueTodo = personRels.some(r => {
          const entity = entityMap.get(r.sourceEntityId === person.id ? r.targetEntityId : r.sourceEntityId);
          return entity?.entityType === 'event' && entity.sources.includes('todos') && entity.attributes?.overdue;
        });
        const hasUpcomingEvent = personRels.some(r => {
          const entity = entityMap.get(r.sourceEntityId === person.id ? r.targetEntityId : r.sourceEntityId);
          return entity?.entityType === 'event' && entity.sources.includes('calendar');
        });
        if (hasOverdueTodo && hasUpcomingEvent) {
          conflicts.push(`⚠ Überfälliges Todo für ${person.name} — bevorstehender Termin mit ${person.name}`);
        }
      }

      // Vehicle range conflicts
      const vehicle = entities.find(e => e.entityType === 'vehicle');
      if (vehicle?.attributes?.range_km) {
        for (const loc of locations) {
          const dist = estimateDistance(userId, loc.normalizedName, entities);
          if (dist && (vehicle.attributes.range_km as number) < dist) {
            conflicts.push(`⚠ BMW Reichweite ${vehicle.attributes.range_km}km reicht nicht für ${loc.name} (~${dist}km)`);
          }
        }
      }

      if (conflicts.length > 0) {
        parts.push('Konflikte:');
        for (const c of conflicts.slice(0, 5)) parts.push(`  ${c}`);
      }

      // 4. Opportunities: same location for event + item
      const opportunities: string[] = [];
      for (const loc of locations) {
        const atLocation = relations
          .filter(r => r.targetEntityId === loc.id)
          .map(r => entityMap.get(r.sourceEntityId))
          .filter(Boolean) as KGEntity[];
        const hasEvent = atLocation.some(e => e.entityType === 'event');
        const hasItem = atLocation.some(e => e.entityType === 'item');
        if (hasEvent && hasItem) {
          const item = atLocation.find(e => e.entityType === 'item');
          const event = atLocation.find(e => e.entityType === 'event');
          if (item && event) {
            opportunities.push(`💡 ${item.name} in ${loc.name} + ${event.name} → Abholung möglich`);
          }
        }
      }

      if (opportunities.length > 0) {
        parts.push('Gelegenheiten:');
        for (const o of opportunities.slice(0, 3)) parts.push(`  ${o}`);
      }

      // 5. Recommendations: actionable cross-domain suggestions
      const recommendations = this.generateRecommendations(entities, relations, entityMap);
      if (recommendations.length > 0) {
        parts.push('Empfehlungen:');
        for (const r of recommendations) parts.push(`  ${r}`);
      }

      if (parts.length === 0) return '';

      // Token cap
      let result = parts.join('\n');
      const tokenEst = Math.ceil(result.length / 4);
      if (tokenEst > MAX_MAP_TOKENS) {
        result = result.slice(0, MAX_MAP_TOKENS * 4) + '\n...(gekürzt)';
      }

      return result;
    } catch (err) {
      this.logger.warn({ err }, 'KG buildConnectionMap failed');
      return '';
    }
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

  // ── Recommendation Engine ────────────────────────────────────

  /**
   * Generate actionable cross-domain recommendations from KG entities and relations.
   * Pure rule-based logic — no LLM calls.
   */
  private generateRecommendations(
    entities: KGEntity[],
    relations: KGRelation[],
    entityMap: Map<string, KGEntity>,
  ): string[] {
    const recs: string[] = [];
    this.recommendCharging(entities, recs);
    this.recommendTodoTiming(entities, recs);
    this.recommendPickup(entities, relations, entityMap, recs);
    this.recommendOverduePriority(entities, relations, entityMap, recs);
    return recs.slice(0, 5);
  }

  /** Energie + Fahrzeug + Ziel-Distanz → Lade-Empfehlung */
  private recommendCharging(entities: KGEntity[], recs: string[]): void {
    const vehicle = entities.find(e => e.entityType === 'vehicle');
    if (!vehicle?.attributes?.battery_pct) return;
    const battery = vehicle.attributes.battery_pct as number;
    if (battery > 50) return;

    const rangeKm = (vehicle.attributes.range_km as number) ?? 0;
    const homeCity = entities.find(e => e.entityType === 'location' && e.attributes?.isHome)?.normalizedName;

    // Check if any calendar location exceeds range
    const locations = entities.filter(e => e.entityType === 'location' && !e.attributes?.isHome);
    for (const loc of locations) {
      if (!homeCity) continue;
      const dist = lookupDistance(homeCity, loc.normalizedName);
      if (dist && rangeKm < dist * 1.2) {
        recs.push(`🔋 BMW ${battery}% (${rangeKm}km) — Laden empfohlen für ${loc.name} (~${dist}km nötig).`);
        return;
      }
    }

    if (battery < 30) {
      recs.push(`🔋 BMW nur ${battery}% — Laden empfohlen.`);
    }
  }

  /** Kalender-Last + offene Todos → Zeitmanagement */
  private recommendTodoTiming(entities: KGEntity[], recs: string[]): void {
    const calendarEvents = entities.filter(e => e.entityType === 'event' && e.sources.includes('calendar'));
    const overdueTodos = entities.filter(e => e.entityType === 'event' && e.sources.includes('todos') && e.attributes?.overdue);
    const upcomingTodos = entities.filter(e => e.entityType === 'event' && e.sources.includes('todos') && !e.attributes?.overdue && e.attributes?.dueDate);
    const totalTodos = overdueTodos.length + upcomingTodos.length;

    if (calendarEvents.length >= 4 && totalTodos >= 2) {
      const overdueHint = overdueTodos.length > 0 ? `${overdueTodos.length} überfällige + ` : '';
      recs.push(`📋 Voller Kalender (${calendarEvents.length} Termine) + ${overdueHint}${upcomingTodos.length} fällige Todos — Todos heute Abend erledigen.`);
    } else if (overdueTodos.length >= 3) {
      recs.push(`📋 ${overdueTodos.length} überfällige Todos — dringend aufarbeiten.`);
    }
  }

  /** Shopping-Item + Kalender-Event am selben Ort → Abholung kombinieren */
  private recommendPickup(
    entities: KGEntity[], relations: KGRelation[], entityMap: Map<string, KGEntity>, recs: string[],
  ): void {
    const locations = entities.filter(e => e.entityType === 'location');
    for (const loc of locations) {
      const atLocation = relations.filter(r => r.targetEntityId === loc.id)
        .map(r => entityMap.get(r.sourceEntityId)).filter(Boolean) as KGEntity[];
      const items = atLocation.filter(e => e.entityType === 'item');
      const calEvents = atLocation.filter(e => e.entityType === 'event' && e.sources.includes('calendar'));
      if (items.length > 0 && calEvents.length > 0) {
        recs.push(`🛍️ ${items[0].name} in ${loc.name} — ${calEvents[0].name} dort geplant. Abholung kombinieren?`);
      }
    }
  }

  /** Überfälliges Todo für Person X + bevorstehendes Meeting mit X → Dringlichkeit */
  private recommendOverduePriority(
    entities: KGEntity[], relations: KGRelation[], entityMap: Map<string, KGEntity>, recs: string[],
  ): void {
    const persons = entities.filter(e => e.entityType === 'person');
    for (const person of persons) {
      const rels = relations.filter(r => r.sourceEntityId === person.id || r.targetEntityId === person.id);
      const connected = rels.map(r => {
        const otherId = r.sourceEntityId === person.id ? r.targetEntityId : r.sourceEntityId;
        return entityMap.get(otherId);
      }).filter(Boolean) as KGEntity[];

      const overdueTodo = connected.find(e => e.sources.includes('todos') && e.attributes?.overdue);
      const hasMeeting = connected.some(e => e.sources.includes('calendar'));

      if (overdueTodo && hasMeeting) {
        recs.push(`⚡ "${overdueTodo.name}" für ${person.name} überfällig — Meeting mit ${person.name} steht bevor!`);
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
