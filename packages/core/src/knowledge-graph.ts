import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, KGEntity, KGRelation, MemoryRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { UserRepository } from '@alfred/storage';
import type { ReasoningSection } from './reasoning-context-collector.js';
import { buildSkillContext } from './context-factory.js';

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
const MAX_MAP_TOKENS = 1200;

// ── Service ──────────────────────────────────────────────────

export class KnowledgeGraphService {
  constructor(
    private readonly kgRepo: KnowledgeGraphRepository,
    private readonly logger: Logger,
    private readonly memoryRepo?: MemoryRepository,
    private readonly skillRegistry?: SkillRegistry,
    private readonly skillSandbox?: SkillSandbox,
    private readonly userRepo?: UserRepository,
    private readonly defaultChatId?: string,
    private readonly defaultPlatform?: string,
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
          case 'weather': await this.extractFromWeather(userId, section.content); break;
          case 'energy': await this.extractFromEnergy(userId, section.content); break;
          case 'smarthome': await this.extractFromSmartHome(userId, section.content); break;
          case 'crypto': await this.extractFromCrypto(userId, section.content); break;
          case 'feeds': await this.extractFromFeeds(userId, section.content); break;
          case 'charger': await this.extractFromCharger(userId, section.content); break;
          default: break;
        }
        // Generic extraction for all sections
        await this.extractLocations(userId, section.key, section.content);
        await this.extractPersons(userId, section.key, section.content);
      }
      // Sync Memory entities/relationships/connections/patterns/feedback into KG
      await this.syncMemoryEntities(userId);
      // Build cross-extractor relations (BMW↔Wallbox, Strompreis↔Batterie, etc.)
      await this.buildCrossExtractorRelations(userId);
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

      // 4. Graph Paths: multi-hop connection chains
      const paths = this.findGraphPaths(entities, relations, entityMap);
      if (paths.length > 0) {
        parts.push('Graph-Pfade (Verbindungsketten):');
        for (const path of paths.slice(0, 8)) parts.push(`  ${path}`);
      }

      if (parts.length === 0) return '';

      // KG → Memory Rückkanal: Entities mit ≥3 Sources als connection-Memories speichern
      if (this.memoryRepo) {
        const highCross = crossDomain.filter(e => e.sources.length >= 3);
        for (const e of highCross.slice(0, 5)) {
          try {
            await this.memoryRepo.saveWithMetadata(
              userId, `kg_connection_${e.normalizedName}`,
              `${e.name} erscheint in ${e.sources.join(', ')} — Cross-Domain-Verbindung`,
              'reasoning', 'connection', 0.7, 'auto',
            );
          } catch { /* skip duplicates */ }
        }
      }

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
    const entries = Object.entries(attrs).filter(([k]) => !['skillName', 'type', 'isHome', 'isWork', 'memoryKey', 'memoryConfidence', 'relationship'].includes(k));
    if (entries.length === 0) return '';
    return ' | ' + entries.map(([k, v]) => `${k}=${v}`).join(', ');
  }

  /** Find 2-hop graph paths through high-confidence entities. */
  private findGraphPaths(
    entities: KGEntity[], relations: KGRelation[], entityMap: Map<string, KGEntity>,
  ): string[] {
    if (relations.length === 0) return [];
    const paths: string[] = [];

    // Build adjacency list
    const adj = new Map<string, Array<{ targetId: string; relationType: string; strength: number }>>();
    for (const r of relations) {
      if (!adj.has(r.sourceEntityId)) adj.set(r.sourceEntityId, []);
      adj.get(r.sourceEntityId)!.push({ targetId: r.targetEntityId, relationType: r.relationType, strength: r.strength });
    }

    // Find 2-hop paths through entities with confidence > 0.4
    for (const [sourceId, edges] of adj) {
      const source = entityMap.get(sourceId);
      if (!source || source.confidence < 0.4) continue;

      for (const edge1 of edges) {
        const mid = entityMap.get(edge1.targetId);
        if (!mid) continue;
        const edge2s = adj.get(edge1.targetId) ?? [];

        for (const edge2 of edge2s) {
          if (edge2.targetId === sourceId) continue;
          const target = entityMap.get(edge2.targetId);
          if (!target) continue;

          const srcAttr = this.formatAttributes(source.attributes);
          const tgtAttr = this.formatAttributes(target.attributes);
          paths.push(
            `${source.name} [${source.entityType}]${srcAttr} →${edge1.relationType}→ ` +
            `${mid.name} [${mid.entityType}] →${edge2.relationType}→ ` +
            `${target.name} [${target.entityType}]${tgtAttr}`,
          );
        }
      }
    }

    // Deduplicate and sort by combined entity confidence
    const unique = [...new Set(paths)];
    return unique.slice(0, 10);
  }

  /**
   * Build a dynamic device/system context string from KG entities.
   * Used in both chat system prompt and reasoning prompts.
   * Returns user-specific device descriptions, not hardcoded.
   */
  async buildDeviceContext(userId: string): Promise<string> {
    try {
      const lines: string[] = [];

      // Vehicles (BMW, Tesla, etc.)
      const vehicles = await this.kgRepo.getEntitiesByType(userId, 'vehicle');
      for (const v of vehicles) {
        const attrs = Object.entries(v.attributes)
          .filter(([k]) => !['skillName', 'type'].includes(k))
          .map(([k, val]) => `${k}: ${val}`).join(', ');
        lines.push(`- ${v.name} [Fahrzeug, Skill: ${v.sources.join('/')}]${attrs ? ` — ${attrs}` : ''}`);
      }

      // Smart Home items (batteries, wallbox, lights, etc.)
      const items = await this.kgRepo.getEntitiesByType(userId, 'item');
      const smarthomeItems = items.filter(i => i.sources.includes('smarthome') || i.sources.includes('charger'));
      for (const item of smarthomeItems.slice(0, 10)) {
        const attrs = Object.entries(item.attributes)
          .filter(([k]) => !['skillName', 'type'].includes(k))
          .map(([k, val]) => `${k}: ${val}`).join(', ');
        lines.push(`- ${item.name} [Smart Home, Skill: ${item.sources.join('/')}]${attrs ? ` — ${attrs}` : ''}`);
      }

      // Metrics (energy price, weather)
      const metrics = await this.kgRepo.getEntitiesByType(userId, 'metric');
      for (const m of metrics.slice(0, 5)) {
        const attrs = Object.entries(m.attributes)
          .filter(([k]) => !['skillName', 'type'].includes(k))
          .map(([k, val]) => `${k}: ${val}`).join(', ');
        lines.push(`- ${m.name} [Messwert, Quelle: ${m.sources.join('/')}]${attrs ? ` — ${attrs}` : ''}`);
      }

      if (lines.length === 0) {
        // Fallback: generate from registered skills if KG is empty
        return this.buildDeviceContextFromSkills();
      }

      return lines.join('\n');
    } catch (err) {
      this.logger.debug({ err }, 'KG buildDeviceContext failed, using skill fallback');
      return this.buildDeviceContextFromSkills();
    }
  }

  /** Fallback when KG has no entities: describe available skills. */
  private buildDeviceContextFromSkills(): string {
    if (!this.skillRegistry) return '';
    const lines: string[] = [];
    const skillMap: Record<string, string> = {
      bmw: 'Fahrzeug (BMW Connected Drive)',
      homeassistant: 'Smart Home (Home Assistant)',
      goe_charger: 'Wallbox (go-e Charger)',
      energy_price: 'Strommarkt-Daten',
      weather: 'Wetterdaten',
      bitpanda: 'Crypto-Portfolio (Bitpanda)',
      sonos: 'Lautsprecher (Sonos)',
      spotify: 'Musik (Spotify)',
    };
    for (const [skill, desc] of Object.entries(skillMap)) {
      if (this.skillRegistry.has(skill)) {
        lines.push(`- ${desc} [Skill: ${skill}]`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : '';
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
    // BMW display format: "**Ladestand (SoC):** 60 %" / "**Elektrische Reichweite:** 212 km"
    const batteryMatch = content.match(/(?:Battery|Akku|SoC)\)?[*:\s]*(\d+)\s*%/i);
    const rangeMatch = content.match(/(?:Range|Reichweite)\)?[*:\s]*(\d+)\s*km/i);
    const chargingMatch = content.match(/(?:charging|lädt|connected|verbunden)/i);

    if (batteryMatch || rangeMatch) {
      const attrs: Record<string, unknown> = {};
      if (batteryMatch) attrs.battery_pct = parseInt(batteryMatch[1], 10);
      if (rangeMatch) attrs.range_km = parseInt(rangeMatch[1], 10);
      if (chargingMatch) attrs.charging = true;
      const vehicle = await this.kgRepo.upsertEntity(userId, 'BMW', 'vehicle', attrs, 'bmw');

      // Relation: User → owns → Vehicle
      const user = await this.kgRepo.upsertEntity(userId, 'User', 'person', {}, 'system');
      await this.kgRepo.upsertRelation(userId, user.id, vehicle.id, 'owns', undefined, 'bmw');
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

      // Sender as person entity — use smart resolution (KG → Memory → Contacts → Regex)
      const senderName = await this.resolveEmailToPerson(userId, fromEmail);
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

  // ── Additional Section Extractors ────────────────────────────

  private async extractFromWeather(userId: string, content: string): Promise<void> {
    // Extract temperature, condition, location
    const tempMatch = content.match(/(-?\d+(?:\.\d+)?)\s*°C/);
    const condMatch = content.match(/(sonnig|bewölkt|regn|schnee|wind|nebel|klar|wolkig|gewitter)/i);
    if (tempMatch) {
      const attrs: Record<string, unknown> = { temp_c: parseFloat(tempMatch[1]) };
      if (condMatch) attrs.condition = condMatch[1].toLowerCase();
      await this.kgRepo.upsertEntity(userId, 'Wetter aktuell', 'metric', attrs, 'weather');
    }
  }

  private async extractFromEnergy(userId: string, content: string): Promise<void> {
    // Try multiple formats: "Gesamt brutto | **XX.XX**", "XX.XX ct/kWh", "brutto: XX.XX"
    const bruttoMatch = content.match(/Gesamt\s*brutto\*?\*?\s*\|\s*\*?\*?(\d+[.,]\d+)/i)
      ?? content.match(/brutto[:\s]*(\d+[.,]\d+)\s*(?:ct|Cent)/i)
      ?? content.match(/(\d+[.,]\d+)\s*(?:ct|Cent)\/kWh/i);
    if (bruttoMatch) {
      const price = parseFloat(bruttoMatch[1].replace(',', '.'));
      const strompreis = await this.kgRepo.upsertEntity(userId, 'Strompreis', 'metric',
        { price_ct: price, cheap: price < 10 }, 'energy');
      // Relation: User → monitors → Strompreis
      const user = await this.kgRepo.upsertEntity(userId, 'User', 'person', {}, 'system');
      await this.kgRepo.upsertRelation(userId, user.id, strompreis.id, 'monitors', `${price}ct/kWh`, 'energy');
    }
  }

  private async extractFromSmartHome(userId: string, content: string): Promise<void> {
    // HA states come as pipe-delimited markdown table: | entity_id | state | friendly_name | unit |
    const tableRe = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;

    // Domains to skip (system entities, not real devices)
    const SKIP_DOMAINS = /^(sun\.|conversation\.|geo_location\.|weather\.|persistent_notification\.|zone\.)/;
    // States that are timestamps (not real device states)
    const IS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]/;

    let match;
    let count = 0;
    while ((match = tableRe.exec(content)) !== null && count < 50) {
      const [, entityId, state, friendlyName, unit] = match;
      const eid = entityId.trim();
      const st = state.trim();

      // Skip table header and separator rows
      if (eid === 'Entity ID' || eid.startsWith('---')) continue;

      // Skip system entities
      if (SKIP_DOMAINS.test(eid)) continue;

      // Skip entities where state is a timestamp (sun sensors, etc.)
      if (IS_TIMESTAMP.test(st)) continue;

      // Skip unavailable/unknown states
      if (st === 'unavailable' || st === 'unknown') continue;

      // Use friendly_name as entity name (human-readable)
      const fn = friendlyName.trim();
      // Skip entities with no useful name (just "-", hex IDs, or very short)
      if (fn === '-' || fn.length < 2) continue;
      if (/^0x[0-9a-f]+$/i.test(fn)) continue; // Zigbee hex ID
      const name = fn;

      const attrs: Record<string, unknown> = { entity_id: eid, state: st };
      if (unit.trim() !== '-' && unit.trim().length > 0) attrs.unit = unit.trim();

      await this.kgRepo.upsertEntity(userId, name, 'item', attrs, 'smarthome');
      count++;
    }
  }

  private async extractFromCrypto(userId: string, content: string): Promise<void> {
    const posRe = /\b(BTC|ETH|SOL|ADA|DOT|XRP|DOGE|LINK|AVAX|MATIC|Bitcoin|Ethereum)\b[*:\s]*([0-9.,]+)(?:\s*[×x€$]?\s*[€$]?\s*([0-9.,]+))?/gi;
    const user = await this.kgRepo.upsertEntity(userId, 'User', 'person', {}, 'system');
    let match;
    while ((match = posRe.exec(content)) !== null) {
      const [, coin, amount, value] = match;
      const attrs: Record<string, unknown> = { amount: amount.replace(',', '.') };
      if (value) attrs.value_eur = value.replace(',', '.');
      const coinEntity = await this.kgRepo.upsertEntity(userId, coin.toUpperCase(), 'item', attrs, 'crypto');
      // Relation: User → owns → Coin
      await this.kgRepo.upsertRelation(userId, user.id, coinEntity.id, 'owns', `${amount}`, 'crypto');
    }
  }

  private async extractFromFeeds(userId: string, content: string): Promise<void> {
    // RSS items: various formats (• Title\n  URL, - Title, ** Source ** Title)
    const feedRe = /(?:^[•\-]\s+|^\*\*.+?\*\*.*?\n[•\-]\s+)(.+?)(?:\n\s+https?:\/\/|\s*$)/gm;
    // Fallback: simpler line-based extraction
    const simpleFeedRe = /^[•\-]\s+(.{10,100})\s*$/gm;
    const titles: string[] = [];
    let match;
    while ((match = feedRe.exec(content)) !== null && titles.length < 8) {
      if (match[1].length > 10 && !match[1].startsWith('http')) titles.push(match[1].trim());
    }
    if (titles.length === 0) {
      while ((match = simpleFeedRe.exec(content)) !== null && titles.length < 8) {
        if (match[1].length > 10 && !match[1].startsWith('http')) titles.push(match[1].trim());
      }
    }

    // Load existing KG entities to find relevant_news matches
    let existingEntities: KGEntity[] = [];
    try {
      const graph = await this.kgRepo.getFullGraph(userId);
      existingEntities = graph.entities.filter(e => e.entityType !== 'event'); // Skip other feed articles
    } catch { /* skip matching */ }

    for (const title of titles) {
      const articleEntity = await this.kgRepo.upsertEntity(userId, title, 'event',
        { type: 'feed_article' }, 'feeds');

      // Match article title against existing KG entities (crypto coins, persons, locations, items)
      const titleLower = title.toLowerCase();
      for (const existing of existingEntities) {
        const nameLower = existing.normalizedName;
        if (nameLower.length >= 3 && titleLower.includes(nameLower)) {
          await this.kgRepo.upsertRelation(userId, articleEntity.id, existing.id,
            'relevant_to', title.slice(0, 80), 'feeds');
        }
      }
    }
  }

  private async extractFromCharger(userId: string, content: string): Promise<void> {
    const statusMatch = content.match(/(charging|idle|lädt|bereit|standby|aktiv)/i);
    const kwMatch = content.match(/(\d+(?:\.\d+)?)\s*kW/);
    const carMatch = content.match(/(?:car|auto|fahrzeug)[:\s]*(connected|verbunden|nicht|no|off|on)/i);
    const attrs: Record<string, unknown> = {};
    if (statusMatch) attrs.status = statusMatch[1].toLowerCase();
    if (kwMatch) attrs.power_kw = parseFloat(kwMatch[1]);
    if (carMatch) attrs.car_connected = /connected|verbunden|on/i.test(carMatch[1]);
    if (Object.keys(attrs).length > 0) {
      const wallbox = await this.kgRepo.upsertEntity(userId, 'Wallbox', 'item', attrs, 'charger');
      // Relation: User → owns → Wallbox
      const user = await this.kgRepo.upsertEntity(userId, 'User', 'person', {}, 'system');
      await this.kgRepo.upsertRelation(userId, user.id, wallbox.id, 'owns', undefined, 'charger');
    }
  }

  // ── Cross-Extractor Relation Builder ─────────────────────

  /**
   * After all extractors run, build semantic relations between entities from different sources.
   * This is the core of the KG — connecting BMW to Wallbox, Strompreis to Batterie, etc.
   */
  private async buildCrossExtractorRelations(userId: string): Promise<void> {
    try {
      const { entities } = await this.kgRepo.getFullGraph(userId);
      if (entities.length < 2) return;

      // Index by type
      const vehicles = entities.filter(e => e.entityType === 'vehicle');
      const items = entities.filter(e => e.entityType === 'item');
      const locations = entities.filter(e => e.entityType === 'location');
      const metrics = entities.filter(e => e.entityType === 'metric');
      const events = entities.filter(e => e.entityType === 'event');

      const chargers = items.filter(i => i.sources.includes('charger') || /wallbox|charger|go-e/i.test(i.normalizedName));
      const batteries = items.filter(i => /batter|victron|speicher|akku/i.test(i.normalizedName) && i.sources.includes('smarthome'));
      const cryptoItems = items.filter(i => i.sources.includes('crypto'));
      const feedArticles = events.filter(e => e.attributes?.type === 'feed_article');
      // Pick home location: prefer highest confidence among isHome=true, exclude isWork=true
      const homeLocation = locations
        .filter(l => l.attributes?.isHome === true && l.attributes?.isWork !== true)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      const energyMetric = metrics.find(m => m.normalizedName === 'strompreis');

      // Rule 1: Vehicle ↔ Charger
      for (const v of vehicles) {
        for (const c of chargers) {
          await this.kgRepo.upsertRelation(userId, v.id, c.id, 'charges_at', undefined, 'cross');
        }
      }

      // Rule 2: Vehicle + Charger → Home Location
      if (homeLocation) {
        for (const v of vehicles) {
          await this.kgRepo.upsertRelation(userId, v.id, homeLocation.id, 'home_location', undefined, 'cross');
        }
        for (const c of chargers) {
          await this.kgRepo.upsertRelation(userId, c.id, homeLocation.id, 'located_at', undefined, 'cross');
        }
      }

      // Rule 3: Strompreis → affects Charger + Batteries
      if (energyMetric) {
        for (const c of chargers) {
          await this.kgRepo.upsertRelation(userId, energyMetric.id, c.id, 'affects_cost',
            `${energyMetric.attributes?.price_ct ?? '?'}ct`, 'cross');
        }
        for (const b of batteries) {
          await this.kgRepo.upsertRelation(userId, energyMetric.id, b.id, 'affects_cost',
            `${energyMetric.attributes?.price_ct ?? '?'}ct`, 'cross');
        }
      }

      // Rule 4: Feed articles → relevant_to existing entities (crypto coins, persons, locations)
      // This catches "Bitcoin" article → BTC entity, "Wien" article → Wien location, etc.
      const matchableEntities = entities.filter(e =>
        e.entityType !== 'event' && e.normalizedName.length >= 3 && e.entityType !== 'metric',
      );
      for (const article of feedArticles.slice(0, 10)) {
        const titleLower = article.normalizedName;
        for (const existing of matchableEntities) {
          if (titleLower.includes(existing.normalizedName)) {
            await this.kgRepo.upsertRelation(userId, article.id, existing.id,
              'relevant_to', article.name.slice(0, 80), 'cross');
          }
        }
      }

      // Rule 5: SmartHome items → Home Location
      if (homeLocation) {
        const smItems = items.filter(i => i.sources.includes('smarthome')).slice(0, 5);
        for (const item of smItems) {
          await this.kgRepo.upsertRelation(userId, item.id, homeLocation.id, 'located_at', undefined, 'cross');
        }
      }
    } catch (err) {
      this.logger.debug({ err }, 'KG: cross-extractor relations partially failed');
    }
  }

  // ── Memory → KG Sync ──────────────────────────────────────

  /**
   * Sync existing Memory entities (type=entity/relationship/connection/fact)
   * into the KG as structured entities and relations.
   */
  private async syncMemoryEntities(userId: string): Promise<void> {
    if (!this.memoryRepo) return;
    try {
      // 1. Memory entities (persons, contacts) → KG person entities
      const entityMems = await this.memoryRepo.getByType(userId, 'entity', 30);
      for (const mem of entityMems) {
        const personName = mem.value.split(',')[0].split('(')[0].trim();
        if (personName.length >= 2) {
          await this.kgRepo.upsertEntity(userId, personName, 'person',
            { memoryKey: mem.key, memoryConfidence: mem.confidence }, 'memories');
        }
      }

      // 2. Memory relationships → KG person entities + relations
      const relMems = await this.memoryRepo.getByType(userId, 'relationship', 30);
      for (const mem of relMems) {
        // Extract person name from value using existing PERSON_PATTERNS
        for (const pattern of PERSON_PATTERNS) {
          pattern.lastIndex = 0;
          const m = pattern.exec(mem.value);
          if (m) {
            await this.kgRepo.upsertEntity(userId, m[1].trim(), 'person',
              { relationship: mem.key }, 'memories');
          }
        }
      }

      // 3. Memory facts with addresses → KG location entities
      for (const query of ['adress', 'address', 'heim', 'home', 'büro', 'office', 'wohn']) {
        const facts = await this.memoryRepo.search(userId, query);
        for (const fact of facts.slice(0, 5)) {
          const matchedCities = KNOWN_LOCATIONS.filter(c => fact.value.includes(c));
          for (const city of matchedCities) {
            // Find the sentence containing this city and check for home/work + negation
            const sentences = fact.value.split(/[.!]\s+/);
            const citySentence = sentences.find(s => s.includes(city)) ?? '';
            const lower = citySentence.toLowerCase();
            const hasHomeWord = /heim|home|wohn|zuhause|privat/i.test(lower);
            const hasWorkWord = /büro|office|arbeit|firma|work/i.test(lower);
            const hasNegation = /nicht|kein|never|no\s|!=|niemals/i.test(lower);
            // "Wien ist die Büroadresse, nicht der Wohnort" → hasHomeWord + hasNegation → isHome=false
            // "Altlengbach ist der Wohnort" → hasHomeWord, no negation → isHome=true
            const isHome = hasHomeWord && !hasNegation;
            const isWork = hasWorkWord && !hasNegation;
            await this.kgRepo.upsertEntity(userId, city, 'location',
              { isHome, isWork, address: fact.value }, 'memories');
          }
        }
      }
      // 4. Memory patterns → KG (behavioral patterns like "abends aktiv")
      const patternMems = await this.memoryRepo.getByType(userId, 'pattern', 10);
      const user = await this.kgRepo.upsertEntity(userId, 'User', 'person', {}, 'system');
      for (const mem of patternMems) {
        if (mem.key.startsWith('temporal_') || mem.key.startsWith('action_feedback_')) continue; // handled below
        const pattern = await this.kgRepo.upsertEntity(userId, mem.key, 'metric',
          { type: 'pattern', value: mem.value.slice(0, 100) }, 'patterns');
        await this.kgRepo.upsertRelation(userId, user.id, pattern.id, 'has_pattern', mem.value.slice(0, 80), 'patterns');
      }

      // 5. Action feedback → KG (user prefers/dislikes skills)
      const feedbackMems = await this.memoryRepo.search(userId, 'action_feedback_');
      for (const mem of feedbackMems.slice(0, 10)) {
        const skillName = mem.key.replace('action_feedback_', '');
        if (skillName === 'summary') continue;
        const rateMatch = mem.value.match(/(\d+)%/);
        const rate = rateMatch ? parseInt(rateMatch[1], 10) / 100 : undefined;
        if (rate !== undefined) {
          const skillEntity = await this.kgRepo.upsertEntity(userId, skillName, 'item',
            { type: 'skill', acceptanceRate: rate }, 'feedback');
          const relType = rate >= 0.7 ? 'prefers' : rate < 0.3 ? 'dislikes' : 'neutral_on';
          await this.kgRepo.upsertRelation(userId, user.id, skillEntity.id, relType, `${Math.round(rate * 100)}%`, 'feedback');
        }
      }

      // 6. Memory connections → KG relations (cross-context insights from Active Learning)
      const connMems = await this.memoryRepo.getByType(userId, 'connection', 20);
      for (const mem of connMems) {
        await this.kgRepo.upsertEntity(userId, mem.key, 'event',
          { type: 'connection', value: mem.value.slice(0, 150) }, 'connections');
      }
    } catch (err) {
      this.logger.debug({ err }, 'KG: memory sync partially failed');
    }
  }

  // ── Email Resolution ───────────────────────────────────────

  /**
   * Resolve an email address to a person name using:
   * 1. Existing KG entities (email attribute)
   * 2. Memory facts
   * 3. ContactsSkill (if available)
   * 4. Fallback: emailToName() regex
   */
  private async resolveEmailToPerson(userId: string, email: string): Promise<string | null> {
    // 1. Check KG for existing entity with this email
    try {
      const existing = await this.kgRepo.searchEntities(userId, email, 5);
      const withEmail = existing.find(e => (e.attributes?.email as string) === email);
      if (withEmail) return withEmail.name;
    } catch { /* continue */ }

    // 2. Check memories for this email
    if (this.memoryRepo) {
      try {
        const memResult = await this.memoryRepo.search(userId, email);
        if (memResult.length > 0) {
          const name = memResult[0].value.split(',')[0].split('(')[0].trim();
          if (name.length >= 2) return name;
        }
      } catch { /* continue */ }
    }

    // 3. ContactsSkill (if available)
    if (this.skillRegistry?.has('contacts') && this.skillSandbox && this.userRepo && this.defaultChatId && this.defaultPlatform) {
      try {
        const skill = this.skillRegistry.get('contacts');
        if (skill) {
          const { context } = await buildSkillContext(this.userRepo, {
            userId: this.defaultChatId,
            platform: this.defaultPlatform as any,
            chatId: this.defaultChatId,
            chatType: 'dm',
          });
          const result = await Promise.race([
            this.skillSandbox.execute(skill, { action: 'search', query: email }, context),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
          ]);
          if (result.success && result.display) {
            const nameMatch = result.display.match(/(?:Name|Display):\s*(.+)/i);
            if (nameMatch) return nameMatch[1].trim();
          }
        }
      } catch { /* continue to fallback */ }
    }

    // 4. Fallback: regex
    return this.emailToName(email);
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
    // Skip person extraction from feeds/RSS (article titles contain no reliable person-preposition patterns)
    if (sectionKey === 'feeds' || sectionKey === 'infra' || sectionKey === 'activity' || sectionKey === 'skillHealth') return;

    for (const pattern of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1].trim();
        // Filter out common German words, articles, and non-person nouns
        if (name.length < 3) continue;
        if (/^(Dem|Der|Das|Den|Die|Ein|Eine|Einer|Seinem|Seiner|Ihrem|Ihrer|Allem|Allen|Anderen|Beiden|Dieser|Diesem|Diesen|Jeder|Jedem|Jeden|Keinem|Keinen|Seiner)$/i.test(name)) continue;
        // Filter plural nouns and abstract concepts (end in -en, -ung, -keit, -heit, -tion, -mus)
        if (/(?:en|ung|keit|heit|tion|mus|nen|ngen|ffen|sten|ssen)$/i.test(name) && name.length > 5) continue;
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
