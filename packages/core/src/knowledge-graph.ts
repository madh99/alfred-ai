import type { Logger } from 'pino';
import type { KnowledgeGraphRepository, KGEntity, KGRelation, MemoryRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { UserRepository } from '@alfred/storage';
import type { ReasoningSection } from './reasoning-context-collector.js';
import { buildSkillContext } from './context-factory.js';

// ── Constants ────────────────────────────────────────────────

/** Seed locations for cold start — merged with dynamically learned locations from KG. */
const SEED_LOCATIONS = [
  'Wien', 'Linz', 'Graz', 'Salzburg', 'Innsbruck', 'Klagenfurt',
  'Villach', 'Wels', 'St. Pölten', 'Dornbirn', 'Steyr', 'Wiener Neustadt',
  'Feldkirch', 'Bregenz', 'Leonding', 'Klosterneuburg', 'Baden', 'Leoben',
  'Krems', 'Traun', 'Amstetten', 'Lustenau', 'Kapfenberg', 'Mödling',
  'Hallein', 'Braunau', 'Schwechat', 'Stockerau', 'Saalfelden', 'Ansfelden',
  'Tulln', 'Hohenems', 'Ternitz', 'Perchtoldsdorf', 'Altlengbach',
];

/** PLZ pattern: "3033 Altlengbach" or "80331 München" → extracts city name */
const PLZ_CITY_REGEX = /\b(\d{4,5})\s+([A-ZÄÖÜ][a-zäöüß]{2,}(?:[\s-][A-ZÄÖÜ][a-zäöüß]+)?)\b/g;

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

/** Words that are NOT person names — generic terms, brands, products, events. */
const PERSON_BLACKLIST = new Set([
  // Generic German words
  'plan', 'haupt', 'nacht', 'radio', 'doorbell', 'user', 'apple', 'code',
  'supreme', 'amazon', 'google', 'microsoft', 'tesla', 'meta', 'nvidia',
  // Events/Products
  'gamescom', 'comic', 'messe', 'festival', 'konferenz', 'conference',
  // Technical terms
  'webhook', 'backup', 'server', 'cluster', 'docker', 'proxy', 'gateway',
  'switch', 'router', 'sensor', 'adapter', 'plugin', 'module', 'service',
  'update', 'upgrade', 'release', 'version', 'config', 'setup', 'status',
  // Chat/UI fragments that get extracted as persons
  'chat', 'betrag', 'favicon', 'abfahrt', 'ankunft', 'strecke', 'route',
  'zuhause', 'tech', 'online', 'datum', 'budget', 'inbox', 'ordner',
  'angebot', 'rechnung', 'zahlung', 'beleg', 'dokument', 'notiz',
  'kalender', 'termin', 'aufgabe', 'erinnerung', 'warnung', 'fehler',
  'wichtig', 'dringend', 'erledigt', 'offen', 'aktiv', 'fertig',
  'damit', 'also', 'hier', 'dort', 'noch', 'schon', 'jetzt',
  // Common German "in X" false-positive locations
  'stunden', 'tagen', 'wochen', 'monaten', 'minuten', 'sekunden',
  'absprache', 'abstimmung', 'anlehnung', 'aussicht', 'betracht', 'bezug',
  'eile', 'folge', 'frage', 'kürze', 'ruhe', 'sachen', 'sicht',
  'kraft', 'anspruch', 'verbindung', 'zukunft', 'wahrheit',
  // Tech products mistaken as locations
  'home assistant', 'homeassistant', 'proxmox', 'docker', 'kubernetes',
]);

/** Company suffixes — if name contains these, it's an organization not a person. */
const ORG_SUFFIXES = /\b(gmbh|ag|kg|inc|corp|ltd|llc|se|sarl|ict|ohg|og|co)\b/i;

/** Domain-specific org keywords — standalone words that indicate an organization. */
const ORG_KEYWORDS = /\b(versicherung\w*|bank\w*|sparkasse\w*|kreditanstalt\w*|genossenschaft\w*|stiftung\w*|verband\w*|verein\w*|versorger\w*|stadtwerk\w*|energi\w*|holding\w*|group\w*|consulting\w*|solutions\w*|systems?\w*|technologies\w*|services?\w*|partners?\w*|ventures?\w*|capital\w*|invest\w*|logisti\w*|pharma\w*|airlines?\w*|airways\w*|telecom\w*|medien\w*|verlag\w*)\b/i;

/** Known brand/company names. */
const KNOWN_BRANDS = new Set(['axians', 'apple', 'google', 'microsoft', 'tesla', 'nvidia', 'meta', 'amazon', 'anthropic', 'openai', 'mistral', 'aws', 'ibm', 'oracle', 'sap', 'siemens', 'bosch', 'a1', 'drei', 'magenta', 'raiffeisen', 'erste', 'bawag', 'uniqa', 'generali', 'allianz', 'awattar', 'willhaben', 'geizhals', 'cloudflare', 'docker', 'gitlab', 'github', 'spotify', 'sonos', 'proxmox', 'unifi', 'ubiquiti', 'bmw', 'audi', 'volkswagen', 'mercedes', 'porsche']);

/** Check if a name is likely an organization. */
function isLikelyOrganization(name: string): boolean {
  if (ORG_SUFFIXES.test(name)) return true;
  if (ORG_KEYWORDS.test(name)) return true;
  const lower = name.toLowerCase();
  return KNOWN_BRANDS.has(lower);
}

/** Check if a name should be rejected as a person. */
function isInvalidPersonName(name: string, knownLocations?: Set<string>): boolean {
  const lower = name.toLowerCase();
  if (PERSON_BLACKLIST.has(lower)) return true;
  if (knownLocations?.has(lower)) return true;
  if (name.length < 3) return true;
  // Plural nouns / abstract concepts
  if (/(?:en|ung|keit|heit|tion|mus|nen|ngen|ffen|sten|ssen)$/i.test(name) && name.length > 5) return true;
  // German articles / pronouns
  if (/^(Dem|Der|Das|Den|Die|Ein|Eine|Einer|Seinem|Seiner|Ihrem|Ihrer|Allem|Allen|Anderen|Beiden|Dieser|Diesem|Diesen|Jeder|Jedem|Jeden|Keinem|Keinen|Seiner)$/i.test(name)) return true;
  // Contains digits or special chars (Shelly IDs, hex)
  if (/[0-9_]/.test(name)) return true;
  // All lowercase (not a proper name)
  if (name === lower) return true;
  return false;
}

/** Max tokens for the connection map section. */
const MAX_MAP_TOKENS = 1200;

// ── Service ──────────────────────────────────────────────────

export class KnowledgeGraphService {
  private llmLinker?: import('./llm-entity-linker.js').LLMEntityLinker;
  /** Names of CMDB-managed assets — excluded from text extraction to avoid double-creation. */
  private cmdbEntityNames = new Set<string>();
  /** Dynamically learned location names (lowercase) — seeded from SEED_LOCATIONS + KG entities of type 'location'. */
  private knownLocationsLower = new Set(SEED_LOCATIONS.map(l => l.toLowerCase()));
  /** Original-case map for location names (lowercase → display name). */
  private knownLocationsMap = new Map(SEED_LOCATIONS.map(l => [l.toLowerCase(), l]));
  /** Cached user real name from profile (resolved once). */
  private userRealName?: string;

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

  /** Refresh the dynamic location set from KG entities of type 'location'. */
  /** German noun suffixes that never appear in city names. */
  private static readonly NOUN_SUFFIXES = /(?:ung|heit|keit|schaft|tion|tät|nis|ment|tag|zeit|stück)$/i;

  /** Words that disqualify a location candidate (tech, cloud, generic terms). */
  private static readonly LOCATION_DISQUALIFIERS = /\b(cloud|stack|platform|service|engine|server|cluster|virtual|online|digital|smart|hub|lab|edge|node|zone|tier|core|base|space|net)\b/i;

  /** Check if a name looks like a valid geographic location. */
  private static isPlausibleLocation(name: string): boolean {
    if (name.length < 4) return false; // "Ort", "See" — too short for a city
    if (/[\n\r\t/|]/.test(name)) return false;
    if (PERSON_BLACKLIST.has(name.toLowerCase())) return false;
    if (KnowledgeGraphService.NOUN_SUFFIXES.test(name)) return false;
    if (KnowledgeGraphService.LOCATION_DISQUALIFIERS.test(name)) return false;
    return true;
  }

  private async refreshKnownLocations(userId: string): Promise<void> {
    try {
      const graph = await this.kgRepo.getFullGraph(userId);
      for (const e of graph.entities) {
        if (e.entityType !== 'location') continue;
        if (!KnowledgeGraphService.isPlausibleLocation(e.name)) continue;
        this.knownLocationsLower.add(e.name.toLowerCase());
        this.knownLocationsMap.set(e.name.toLowerCase(), e.name);
      }
    } catch { /* keep seed list on error */ }
  }

  /** Add a newly discovered location to the dynamic set (with quality gate). */
  private registerLocation(name: string): void {
    if (!KnowledgeGraphService.isPlausibleLocation(name)) return;
    this.knownLocationsLower.add(name.toLowerCase());
    this.knownLocationsMap.set(name.toLowerCase(), name);
  }

  /** Get the known locations as an iterable of display names. */
  getKnownLocations(): string[] {
    return [...this.knownLocationsMap.values()];
  }

  // ── Query-aware KG Context (Tier 2: on-demand per chat message) ──

  /** German/English stop words to skip when extracting query keywords. */
  private static readonly STOP_WORDS = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen',
    'ist', 'hat', 'war', 'wird', 'kann', 'soll', 'muss', 'darf', 'mag', 'bin', 'bist',
    'und', 'oder', 'aber', 'weil', 'wenn', 'dass', 'als', 'wie', 'was', 'wer', 'wann',
    'von', 'mit', 'für', 'auf', 'aus', 'bei', 'nach', 'über', 'vor', 'unter', 'zwischen',
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'has', 'not', 'are',
    'ich', 'mir', 'mich', 'mein', 'meine', 'dein', 'deine', 'sich', 'wir', 'uns',
    'noch', 'schon', 'jetzt', 'hier', 'dort', 'auch', 'nur', 'sehr', 'ganz', 'bitte',
    'kannst', 'könntest', 'würdest', 'hast', 'wann', 'warum', 'welche', 'welcher',
  ]);

  /**
   * Query-aware KG context: extract keywords from user message,
   * find matching entities + 1-hop relations, format as compact context block.
   * Returns empty string if nothing relevant found.
   */
  async queryRelevantContext(userId: string, message: string, personalContext?: string): Promise<string> {
    try {
      // Extract keywords: capitalized words + words ≥4 chars, skip stop words
      const words = message.split(/[\s,.!?;:()]+/).filter(Boolean);
      const keywords: string[] = [];
      for (const w of words) {
        const clean = w.replace(/[^a-zA-ZäöüÄÖÜß-]/g, '');
        if (clean.length < 3) continue;
        if (KnowledgeGraphService.STOP_WORDS.has(clean.toLowerCase())) continue;
        // Prioritize capitalized words (proper nouns)
        if (/^[A-ZÄÖÜ]/.test(clean)) keywords.unshift(clean);
        else if (clean.length >= 4) keywords.push(clean);
      }

      if (keywords.length === 0) return '';

      // Search top 3 keywords, max 5 entities total
      const seen = new Set<string>();
      const results: Array<{ entity: any; relations: any[] }> = [];
      for (const kw of keywords.slice(0, 3)) {
        const hits = await this.kgRepo.searchEntitiesWithRelations(userId, kw, 3);
        for (const hit of hits) {
          if (seen.has(hit.entity.id)) continue;
          seen.add(hit.entity.id);
          // Skip CMDB infrastructure entities (irrelevant for chat)
          const INFRA_TYPES = new Set(['network_device', 'certificate', 'server', 'container', 'dns_record', 'proxy_host', 'firewall_rule', 'cluster', 'storage']);
          if (INFRA_TYPES.has(hit.entity.entityType)) continue;
          if (hit.entity.sources?.length === 1 && hit.entity.sources[0] === 'cmdb') continue;
          // Deduplicate: skip if entity name already in personalContext (case-insensitive, word boundary)
          if (personalContext) {
            const pcLower = personalContext.toLowerCase();
            const nameLower = hit.entity.name.toLowerCase();
            // Check if any word of the entity name (≥3 chars) appears in personalContext
            const nameWords = nameLower.split(/\s+/).filter(w => w.length >= 3);
            if (nameWords.some(w => pcLower.includes(w))) continue;
          }
          results.push(hit);
          if (results.length >= 5) break;
        }
        if (results.length >= 5) break;
      }

      if (results.length === 0) return '';

      // Format compact context
      const lines: string[] = [];
      for (const { entity, relations } of results) {
        const attrs: string[] = [];
        for (const [k, v] of Object.entries(entity.attributes ?? {})) {
          if (['skillName', 'type', 'detectedBy', 'memoryKey', 'memoryConfidence'].includes(k)) continue;
          const val = String(v);
          if (val.length > 60) continue; // skip long text blobs
          attrs.push(`${k}: ${val}`);
        }
        const relStrs = relations.slice(0, 5).map(r =>
          r.direction === 'out' ? `→${r.relationType}→ ${r.relatedName}` : `${r.relatedName} →${r.relationType}→`,
        );
        const parts = [`${entity.name} [${entity.entityType}]`];
        if (attrs.length) parts.push(attrs.join(', '));
        if (relStrs.length) parts.push(relStrs.join(', '));
        lines.push(parts.join(' | '));
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /** Check if a name looks like a full name (not just initials like "M D"). */
  private isFullName(name: string): boolean {
    const tokens = name.trim().split(/\s+/);
    return tokens.length >= 2 && tokens.every(t => t.length >= 3);
  }

  /** Upsert the User entity with realName from profile/memories (cached). */
  private async upsertUserEntity(userId: string): Promise<import('@alfred/storage').KGEntity> {
    if (!this.userRealName) {
      // 1. Try profile displayName (if it's a full name, not just initials)
      if (this.userRepo) {
        try {
          const profile = await (this.userRepo as any).getProfile?.(userId);
          const candidate = profile?.displayName || profile?.username;
          if (candidate && this.isFullName(candidate)) this.userRealName = candidate;
        } catch { /* skip */ }
      }

      // 2. Search memories for full name (multiple keys)
      if (!this.userRealName && this.memoryRepo) {
        const nameKeys = ['personal_name', 'user_name', 'full_name', 'name', 'real_name', 'owner_name'];
        for (const key of nameKeys) {
          try {
            const mem = await this.memoryRepo.recall(userId, key);
            if (mem?.value && this.isFullName(mem.value)) { this.userRealName = mem.value; break; }
          } catch { /* skip */ }
        }

        // 3. Search memories by keyword if specific keys didn't work
        if (!this.userRealName) {
          try {
            const results = await this.memoryRepo.search(userId, 'name');
            for (const mem of results.slice(0, 20)) {
              if (!/name/i.test(mem.key)) continue;
              // If value IS a full name (just "Markus Dohnal"), use directly
              if (this.isFullName(mem.value) && mem.value.split(/\s+/).length <= 3) {
                this.userRealName = mem.value;
                break;
              }
              // If value is a sentence, try to extract the name from it
              const namePatterns = [
                /(?:name|heißt|heisse|bin)\s+(?:ist\s+)?([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/i,
                /(?:vollständiger?\s+name\s+(?:ist\s+)?)([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/i,
              ];
              for (const p of namePatterns) {
                const m = mem.value.match(p);
                if (m && this.isFullName(m[1].trim())) { this.userRealName = m[1].trim(); break; }
              }
              if (this.userRealName) break;
            }
          } catch { /* skip */ }
        }
        // Also check key 'user_full_name' explicitly (common memory key from "Merke dir: Mein Name ist...")
        if (!this.userRealName) {
          try {
            const fullNameMem = await this.memoryRepo.recall(userId, 'user_full_name');
            if (fullNameMem?.value) {
              // Try explicit patterns first: "Name ist X Y", "heißt X Y"
              const explicit = fullNameMem.value.match(/(?:name\s+ist|heißt|bin)\s+([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/i);
              if (explicit && this.isFullName(explicit[1])) {
                this.userRealName = explicit[1].trim();
              } else {
                // Fallback: take the LAST two capitalized words (most likely the actual name at end of sentence)
                const words = fullNameMem.value.split(/\s+/);
                for (let i = words.length - 2; i >= 0; i--) {
                  const pair = words[i] + ' ' + words[i + 1];
                  if (/^[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+$/.test(pair) && this.isFullName(pair)) {
                    this.userRealName = pair;
                    break;
                  }
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    }

    const attrs: Record<string, unknown> = {};
    if (this.userRealName) attrs.realName = this.userRealName;
    return this.kgRepo.upsertEntity(userId, 'User', 'person', attrs, 'system');
  }

  /** Set optional LLM-based entity linker. */
  setLLMLinker(linker: import('./llm-entity-linker.js').LLMEntityLinker): void {
    this.llmLinker = linker;
  }

  /** Get the LLM linker (for weekly chat analysis). */
  getLLMLinker(): import('./llm-entity-linker.js').LLMEntityLinker | undefined {
    return this.llmLinker;
  }

  /**
   * Sync CMDB assets into the Knowledge Graph as entities.
   * One-way: CMDB → KG. Creates/updates KG entities with source='cmdb'.
   */
  async syncFromCmdb(userId: string, assets: Array<{ id: string; name: string; assetType: string; ipAddress?: string; sourceSkill?: string; status?: string; attributes?: Record<string, unknown> }>, relations: Array<{ sourceEntityName: string; targetEntityName: string; relationType: string }>): Promise<void> {
    const kgTypeMap: Record<string, string> = {
      server: 'server', vm: 'server', lxc: 'server', cluster: 'server', storage: 'server',
      container: 'container', service: 'service', application: 'service',
      dns_record: 'service', proxy_host: 'service', certificate: 'certificate',
      network: 'network_device', network_device: 'network_device',
      firewall_rule: 'service', automation: 'service', iot_device: 'network_device',
    };

    // Rebuild blacklist atomically (collect then swap)
    const newNames = new Set<string>();

    for (const asset of assets) {
      const kgType = kgTypeMap[asset.assetType] ?? 'service';
      const attrs: Record<string, unknown> = {
        cmdb_id: asset.id,
        ip_address: asset.ipAddress,
        source_skill: asset.sourceSkill,
        cmdb_status: asset.status,
        ...(asset.attributes ?? {}),
      };

      try {
        await this.kgRepo.upsertEntity(userId, asset.name, kgType as any, attrs, 'cmdb');
        newNames.add(asset.name.toLowerCase());
      } catch {
        // Constraint violation — skip
      }
    }

    for (const rel of relations) {
      try {
        const allEntities = await this.kgRepo.getAllEntities(userId);
        const src = allEntities.find(e => e.name.toLowerCase() === rel.sourceEntityName.toLowerCase());
        const tgt = allEntities.find(e => e.name.toLowerCase() === rel.targetEntityName.toLowerCase());
        if (src && tgt) {
          await this.kgRepo.upsertRelation(userId, src.id, tgt.id, rel.relationType, 'cmdb');
        }
      } catch {
        // Skip
      }
    }

    // Atomic swap of blacklist
    this.cmdbEntityNames = newNames;
    this.logger.info({ count: assets.length }, 'CMDB → KG sync complete');
  }

  /**
   * Ingest: Extract entities and relations from collected reasoning sections.
   * Called on every reasoning pass. Entities are UPSERTed (confidence grows).
   */
  /**
   * Lightweight entity extraction from chat messages.
   * Called on every user message (fire-and-forget). No LLM, no relations — just entity detection.
   */
  async extractFromChat(userId: string, chatText: string): Promise<void> {
    try {
      await this.extractEntitiesFromText(userId, 'chat', chatText);
      await this.extractLocations(userId, 'chat', chatText);
    } catch { /* non-critical */ }
  }

  async ingest(userId: string, sections: ReasoningSection[]): Promise<void> {
    try {
      // Refresh dynamic location list from KG (learned locations from previous runs)
      await this.refreshKnownLocations(userId);

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
          case 'notes': await this.extractFromNotes(userId, section.content); break;
          case 'documents': await this.extractFromDocuments(userId, section.content); break;
          case 'reminders': await this.extractFromReminders(userId, section.content); break;
          default: break;
        }
        // Generic extraction for all sections
        await this.extractLocations(userId, section.key, section.content);
        await this.extractEntitiesFromText(userId, section.key, section.content);
      }
      // Sync Memory entities/relationships/connections/patterns/feedback into KG
      await this.syncMemoryEntities(userId);
      // Build cross-extractor relations (BMW↔Wallbox, Strompreis↔Batterie, etc.)
      await this.buildCrossExtractorRelations(userId);
      // Family inference: derive transitive relations (grandparent, sibling, aunt/uncle)
      await this.buildFamilyInference(userId);
      // Generic entity linking: match every entity against all others by name
      await this.buildGenericEntityLinks(userId);
      // Optional LLM-based semantic linking (runs on schedule, not every pass)
      if (this.llmLinker?.shouldRun()) {
        try {
          await this.llmLinker.run(userId);
        } catch (err) {
          this.logger.info({ err }, 'KG: LLM entity linking failed (non-critical)');
        }
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
      if (entities.length >= 5000) {
        this.logger.warn({ count: entities.length }, 'KG: Entity cap reached (5000) — some entities excluded from connection map');
      }
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

  // ── Personal Context (Tier 1: always in chat prompt) ──────

  private personalContextCache?: { text: string; ts: number; userId: string; kgVersion: string };

  /** Mark the personal context cache as stale (called after KG ingest). */
  markPersonalContextDirty(): void { /* no-op — cache invalidation is now DB-based (cross-node safe) */ }

  /**
   * Build a compact personal context for the chat system prompt.
   * Tier 1 only: immediate family, employer, home/work locations, vehicle.
   * Cached for 5min + DB-based staleness check (cross-node safe in HA).
   */
  async buildPersonalContext(userId: string): Promise<string> {
    const now = Date.now();
    // Short TTL (5min) + check if KG has newer data than our cache (cross-node safe)
    if (this.personalContextCache && this.personalContextCache.userId === userId
      && now - this.personalContextCache.ts < 300_000) {
      return this.personalContextCache.text;
    }

    try {
      const graph = await this.kgRepo.getFullGraph(userId);
      const { entities, relations } = graph;
      const entityMap = new Map(entities.map(e => [e.id, e]));

      // Find User entity
      const userEntity = entities.find(e => e.name === 'User' && e.entityType === 'person');
      if (!userEntity) return this.buildDeviceContext(userId); // fallback

      // Collect Tier 1 relations from User (memory-sourced family + work)
      const TIER1_TYPES = new Set(['spouse', 'parent_of', 'family', 'works_at', 'owns', 'lives_at']);
      const userRelations = relations.filter(r =>
        (r.sourceEntityId === userEntity.id || r.targetEntityId === userEntity.id)
        && TIER1_TYPES.has(r.relationType),
      );

      // Build sections
      const family: string[] = [];
      const work: string[] = [];
      const locations: string[] = [];
      const devices: string[] = [];

      for (const rel of userRelations) {
        const otherId = rel.sourceEntityId === userEntity.id ? rel.targetEntityId : rel.sourceEntityId;
        const other = entityMap.get(otherId);
        if (!other) continue;

        if (rel.relationType === 'spouse') {
          family.push(`${other.name} (Ehepartner)`);
        } else if (rel.relationType === 'parent_of') {
          const bday = other.attributes?.birthday as string | undefined;
          const extras: string[] = [];
          // Find child-specific relations (plays_at, etc.)
          const childRels = relations.filter(r => r.sourceEntityId === other.id && r.relationType === 'plays_at');
          for (const cr of childRels) {
            const club = entityMap.get(cr.targetEntityId);
            if (club) extras.push(club.name);
          }
          if (bday) extras.push(`Geb. ${bday}`);
          family.push(`${other.name}${extras.length ? ` (${extras.join(', ')})` : ''}`);
        } else if (rel.relationType === 'family') {
          // Determine role from memory key or relation context
          const role = rel.context?.match(/mutter|mother/i) ? 'Mutter'
            : rel.context?.match(/vater|father/i) ? 'Vater'
            : rel.context?.match(/schwester|sister/i) ? 'Schwester'
            : rel.context?.match(/bruder|brother/i) ? 'Bruder'
            : 'Familie';
          family.push(`${other.name} (${role})`);
        } else if (rel.relationType === 'works_at' && other.entityType === 'organization') {
          const role = other.attributes?.role as string | undefined;
          work.push(`${other.name}${role ? ` (${role})` : ''}`);
        } else if (rel.relationType === 'lives_at' && other.entityType === 'location') {
          locations.push(`Wohnsitz: ${other.name}`);
        } else if (rel.relationType === 'owns') {
          if (other.entityType === 'vehicle') {
            const range = other.attributes?.range_km;
            const soc = other.attributes?.battery_pct;
            const extras = [range ? `${range}km` : '', soc ? `${soc}%` : ''].filter(Boolean).join(', ');
            devices.push(`${other.name}${extras ? ` (${extras})` : ''}`);
          }
        }
      }

      // Locations from location entities with isHome/isWork
      const locs = entities.filter(e => e.entityType === 'location');
      for (const loc of locs) {
        if (loc.attributes?.isHome) locations.push(`Wohnsitz: ${loc.name}`);
        else if (loc.attributes?.isWork) locations.push(`Büro: ${loc.name}`);
      }

      // Smart Home items (compact — just names)
      const smItems = entities.filter(e => e.entityType === 'item' && (e.sources.includes('smarthome') || e.sources.includes('charger')));
      if (smItems.length > 0) {
        devices.push(`Smart Home: ${smItems.length} Geräte`);
      }

      // Metrics
      const metrics = entities.filter(e => e.entityType === 'metric');
      for (const m of metrics.slice(0, 3)) {
        const val = m.attributes?.value ?? m.attributes?.price_ct ?? m.attributes?.temp_c;
        if (val !== undefined) devices.push(`${m.name}: ${val}`);
      }

      // Assemble
      const sections: string[] = [];
      if (family.length) sections.push(`Familie: ${family.join(' | ')}`);
      if (work.length) sections.push(`Arbeit: ${work.join(' | ')}`);
      if (locations.length) sections.push(locations.join(' | '));
      if (devices.length) sections.push(devices.join(' | '));

      const text = sections.length > 0 ? sections.join('\n') : '';

      this.personalContextCache = { text, ts: now, userId, kgVersion: '' };
      return text;
    } catch (err) {
      this.logger.info({ err }, 'KG buildPersonalContext failed, using device fallback');
      return this.buildDeviceContext(userId);
    }
  }

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
      this.logger.info({ err }, 'KG buildDeviceContext failed, using skill fallback');
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
  /**
   * Generic entity linking: match every entity's text content (name, attributes.value)
   * against all other entity names. Creates `relates_to` relations for matches.
   * This catches ALL cross-references automatically — no domain-specific rules needed.
   */
  /**
   * Universal family inference: derive transitive relations from existing family facts.
   * Runs every pass — upsertRelation handles dedup.
   */
  private async buildFamilyInference(userId: string): Promise<void> {
    try {
      const graph = await this.kgRepo.getFullGraph(userId);
      const { entities, relations } = graph;

      const entityById = new Map(entities.map(e => [e.id, e]));
      const user = entities.find(e => e.name === 'User' && e.entityType === 'person');
      if (!user) return;

      // Collect User's direct relations
      const children: string[] = []; // entity IDs
      let spouseId: string | undefined;
      let motherId: string | undefined;
      let fatherId: string | undefined;
      const siblings: string[] = [];

      for (const r of relations) {
        if (r.sourceEntityId !== user.id) continue;
        if (r.relationType === 'parent_of') children.push(r.targetEntityId);
        if (r.relationType === 'spouse') spouseId = r.targetEntityId;
        if (r.relationType === 'family') {
          const target = entityById.get(r.targetEntityId);
          if (target) {
            const key = (target.attributes?.memoryKey as string ?? '').toLowerCase();
            if (key.includes('mother') || key.includes('mutter')) motherId = r.targetEntityId;
            if (key.includes('father') || key.includes('vater')) fatherId = r.targetEntityId;
            if (key.includes('sister') || key.includes('schwester') || key.includes('brother') || key.includes('bruder')) {
              siblings.push(r.targetEntityId);
            }
          }
        }
      }

      // Rule 1: Spouse is also parent of children
      if (spouseId && children.length > 0) {
        for (const childId of children) {
          await this.kgRepo.upsertRelation(userId, spouseId, childId, 'parent_of', undefined, 'inference');
        }
      }

      // Rule 2: Children are siblings of each other
      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          await this.kgRepo.upsertRelation(userId, children[i], children[j], 'sibling', undefined, 'inference');
        }
      }

      // Rule 3: User's mother/father → grandparent of children
      for (const gpId of [motherId, fatherId].filter(Boolean) as string[]) {
        for (const childId of children) {
          await this.kgRepo.upsertRelation(userId, gpId, childId, 'grandparent_of', undefined, 'inference');
        }
        // Also: mother/father is parent_of User (reverse direction)
        await this.kgRepo.upsertRelation(userId, gpId, user.id, 'parent_of', undefined, 'inference');
      }

      // Rule 4: User's siblings → aunt/uncle of children
      for (const sibId of siblings) {
        for (const childId of children) {
          await this.kgRepo.upsertRelation(userId, sibId, childId, 'aunt_uncle_of', undefined, 'inference');
        }
        // Sibling is also child of User's parents
        if (motherId) await this.kgRepo.upsertRelation(userId, motherId, sibId, 'parent_of', undefined, 'inference');
        if (fatherId) await this.kgRepo.upsertRelation(userId, fatherId, sibId, 'parent_of', undefined, 'inference');
      }

      // Rule 5: Spouse knows all family members
      if (spouseId) {
        if (motherId) await this.kgRepo.upsertRelation(userId, spouseId, motherId, 'knows', undefined, 'inference');
        if (fatherId) await this.kgRepo.upsertRelation(userId, spouseId, fatherId, 'knows', undefined, 'inference');
        for (const sibId of siblings) {
          await this.kgRepo.upsertRelation(userId, spouseId, sibId, 'knows', undefined, 'inference');
        }
      }
    } catch (err) {
      this.logger.info({ err }, 'KG: family inference failed');
    }
  }

  private async buildGenericEntityLinks(userId: string): Promise<void> {
    try {
      const rawEntities = await this.kgRepo.getAllEntities(userId);
      // Filter out CMDB-only entities to avoid O(n²) explosion with 2000+ infra assets
      const allEntities = rawEntities.filter(e => {
        const sources = e.sources ?? [];
        return !(sources.length === 1 && sources[0] === 'cmdb');
      });
      if (allEntities.length < 2) return;

      // Build a lookup: normalized name → entity + word-boundary regex
      // Skip short names (<4 chars) to avoid false positives (SOL in "also", ETH in "Elisabeth")
      const nameIndex = new Map<string, { entity: KGEntity; regex: RegExp }>();
      for (const e of allEntities) {
        if (e.normalizedName.length >= 4 && e.name !== 'User') {
          const escaped = e.normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          nameIndex.set(e.normalizedName, { entity: e, regex: new RegExp(`\\b${escaped}\\b`, 'i') });
          // For persons: also register first name as additional match key
          // "Sohn Linus" → also match "linus" alone
          if (e.entityType === 'person') {
            const firstName = e.normalizedName.split(/\s+/).find(w =>
              w.length >= 4 && !['sohn', 'tochter', 'frau', 'herr', 'schwester'].includes(w),
            );
            if (firstName && !nameIndex.has(firstName)) {
              const fnEscaped = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              nameIndex.set(firstName, { entity: e, regex: new RegExp(`\\b${fnEscaped}\\b`, 'i') });
            }
          }
        }
      }

      let linked = 0;
      for (const entity of allEntities) {
        // Collect all text content from this entity
        const texts: string[] = [];
        if (entity.attributes?.value) texts.push(String(entity.attributes.value));
        if (entity.name.includes('_')) texts.push(entity.name.replace(/_/g, ' '));
        if (entity.attributes?.memoryKey) texts.push(String(entity.attributes.memoryKey).replace(/_/g, ' '));
        if (entity.attributes?.address) texts.push(String(entity.attributes.address));
        if (entity.attributes?.relationship) texts.push(String(entity.attributes.relationship).replace(/_/g, ' '));
        // For documents/notes: split filename into words for matching
        if (entity.sources.includes('documents') || entity.sources.includes('notes')) {
          texts.push(entity.name.replace(/[._\-/]/g, ' ').replace(/\.(pdf|docx?|xlsx?|txt|csv)$/i, ''));
        }
        if (entity.attributes?.preview) texts.push(String(entity.attributes.preview));

        if (texts.length === 0) continue;
        const combined = texts.join(' ');

        // Match against all other entity names using word-boundary regex
        for (const [, { entity: targetEntity, regex }] of nameIndex) {
          if (targetEntity.id === entity.id) continue;
          if (entity.entityType === targetEntity.entityType && entity.entityType === 'event') continue;

          if (regex.test(combined)) {
            await this.kgRepo.upsertRelation(
              userId, entity.id, targetEntity.id,
              'mentioned_with', undefined, 'generic',
            );
            linked++;
          }
        }
      }

      if (linked > 0) {
        this.logger.info({ linked }, 'KG: generic entity links created');
      }
    } catch (err) {
      this.logger.info({ err }, 'KG: generic entity linking partially failed');
    }
  }

  async maintenance(userId: string): Promise<void> {
    try {
      const decayed = await this.kgRepo.decayOldEntities(userId, 30, 0.1);
      const decayedRelations = await this.kgRepo.decayOldRelations(userId, 30, 0.1);
      const prunedEntities = await this.kgRepo.pruneWeakEntities(userId, 0.2);
      const prunedRelations = await this.kgRepo.pruneWeakRelations(userId, 0.2);

      // Prune stale connection events (past dates > 30 days, low value)
      const staleEvents = await this.kgRepo.getEntitiesByType(userId, 'event');
      let prunedEvents = 0;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      for (const event of staleEvents) {
        // Events with past dates in their value and not seen recently
        if (event.lastSeenAt < thirtyDaysAgo && event.confidence < 0.8) {
          await this.kgRepo.deleteEntity(event.id);
          prunedEvents++;
        }
      }

      // Deduplicate: merge entities with same normalized_name + entity_type but different IDs
      const allEntities = await this.kgRepo.getAllEntities(userId);
      const seen = new Map<string, string>(); // "type:normalizedName" → id
      let mergedDupes = 0;
      for (const e of allEntities) {
        const key = `${e.entityType}:${e.normalizedName}`;
        const existingId = seen.get(key);
        if (existingId && existingId !== e.id) {
          // Keep the one with higher mention count, delete the other
          const existing = allEntities.find(x => x.id === existingId);
          if (existing && existing.mentionCount >= e.mentionCount) {
            await this.kgRepo.deleteEntity(e.id);
          } else if (existing) {
            await this.kgRepo.deleteEntity(existingId);
            seen.set(key, e.id);
          }
          mergedDupes++;
        } else {
          seen.set(key, e.id);
        }
      }

      // Fuzzy person merge: HA person entities (Alexandra) → Memory persons (Frau Alex)
      const persons = (await this.kgRepo.getAllEntities(userId)).filter(e => e.entityType === 'person');
      const haPersons = persons.filter(e => e.sources.includes('smarthome'));
      const memPersons = persons.filter(e => e.sources.includes('memories') && !e.sources.includes('smarthome'));
      for (const ha of haPersons) {
        for (const mem of memPersons) {
          // Check if one name contains the other (Alexandra ↔ Frau Alex, Noah ↔ Sohn Noah)
          const haLower = ha.normalizedName;
          const memWords = mem.normalizedName.split(/\s+/);
          if (memWords.some(w => w.length >= 4 && haLower.includes(w)) ||
              memWords.some(w => w.length >= 4 && w.includes(haLower))) {
            // Link HA person to memory person (same real person)
            await this.kgRepo.upsertRelation(userId, ha.id, mem.id, 'same_as', undefined, 'maintenance');
          }
        }
      }

      // Aggressive event dedup: events with very similar keys (Levenshtein ≤ 2 edits apart)
      const events = (await this.kgRepo.getAllEntities(userId)).filter(e => e.entityType === 'event');
      for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
          const a = events[i].normalizedName.replace(/connection_/, '').replace(/_/g, '');
          const b = events[j].normalizedName.replace(/connection_/, '').replace(/_/g, '');
          if (a === b || (a.length > 10 && b.length > 10 && (a.includes(b) || b.includes(a)))) {
            const keep = events[i].mentionCount >= events[j].mentionCount ? events[i] : events[j];
            const drop = keep === events[i] ? events[j] : events[i];
            await this.kgRepo.deleteEntity(drop.id);
            mergedDupes++;
          }
        }
      }

      if (decayed > 0 || prunedEntities > 0 || prunedRelations > 0 || prunedEvents > 0 || mergedDupes > 0) {
        // Phantom user-name detection: find person entities whose name contains
        // all tokens of the User entity's realName → migrate relations to User
        let phantomsMerged = 0;
        try {
          const allPersons = await this.kgRepo.getEntitiesByType(userId, 'person' as any);
          const userEntity = allPersons.find(e => e.name === 'User');
          const realName = userEntity?.attributes?.realName as string | undefined;
          this.logger.info({ realName, personCount: allPersons.length, userFound: !!userEntity }, 'KG phantom detection: start');
          if (userEntity && realName && realName.length >= 3) {
            const nameTokens = realName.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
            this.logger.info({ nameTokens }, 'KG phantom detection: tokens');
            for (const person of allPersons) {
              if (person.id === userEntity.id) continue;
              if (person.name === 'User') continue;
              const personLower = person.normalizedName;
              const allMatch = nameTokens.length >= 2 && nameTokens.every(t => personLower.includes(t));
              if (allMatch) {
                this.logger.info({ phantom: person.name, personLower, nameTokens }, 'KG: Phantom detected, merging...');
                const migrated = await this.kgRepo.migrateEntityRelations(userId, person.id, userEntity.id);
                this.logger.info({ phantom: person.name, migrated }, 'KG: Phantom user entity merged into User');
                phantomsMerged++;
              }
            }
          }
        } catch { /* non-critical */ }

        // Org variant dedup: merge orgs that share a prefix (e.g., "Axians" + "Axians ICT Austria GmbH")
        let orgsMerged = 0;
        try {
          const allOrgs = (await this.kgRepo.getEntitiesByType(userId, 'organization' as any))
            .sort((a, b) => b.mentionCount - a.mentionCount); // most-mentioned first = canonical
          const stripSuffixes = (n: string) => n.toLowerCase().replace(/\b(gmbh|ag|kg|inc|corp|ltd|llc|se|sarl|ict|ohg|og|co)\b/gi, '').trim().replace(/\s+/g, ' ');
          const orgsSeen = new Map<string, typeof allOrgs[0]>(); // canonical stem → best entity

          for (const org of allOrgs) {
            const stem = stripSuffixes(org.name);
            if (stem.length < 3) continue;
            // Check if any existing stem is a prefix of this stem or vice versa
            let merged = false;
            for (const [existingStem, existing] of orgsSeen) {
              const shorter = stem.length < existingStem.length ? stem : existingStem;
              const longer = stem.length < existingStem.length ? existingStem : stem;
              if (longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === ' ')) {
                // Merge: migrate relations from the weaker to the stronger
                if (org.id !== existing.id) {
                  await this.kgRepo.migrateEntityRelations(userId, org.id, existing.id);
                  orgsMerged++;
                }
                merged = true;
                break;
              }
            }
            if (!merged) orgsSeen.set(stem, org);
          }
        } catch { /* non-critical */ }

        // Type conflict resolution: same normalized_name as both person and organization → delete the lower-confidence one
        let typeConflictsResolved = 0;
        try {
          const allEntities = await this.kgRepo.getAllEntities(userId);
          const byNorm = new Map<string, typeof allEntities>();
          for (const e of allEntities) {
            const key = e.normalizedName;
            const list = byNorm.get(key) || [];
            list.push(e);
            byNorm.set(key, list);
          }
          // Type conflict priority: CMDB types > organization > person > item
          const TYPE_PRIORITY: Record<string, number> = {
            server: 10, service: 10, container: 10, network_device: 10, certificate: 10,
            organization: 8, vehicle: 7, location: 6, person: 5, event: 4, metric: 3, item: 1,
          };
          for (const [, group] of byNorm) {
            if (group.length < 2) continue;
            // Sort by type priority descending — highest wins
            const sorted = group.sort((a, b) => (TYPE_PRIORITY[b.entityType] ?? 0) - (TYPE_PRIORITY[a.entityType] ?? 0));
            const winner = sorted[0];
            for (let i = 1; i < sorted.length; i++) {
              await this.kgRepo.migrateEntityRelations(userId, sorted[i].id, winner.id);
              typeConflictsResolved++;
            }
          }
        } catch { /* non-critical */ }

        // Cleanup invalid person entities (newlines in name, blacklisted words, >40 chars)
        let invalidPersonsCleaned = 0;
        try {
          const persons = await this.kgRepo.getEntitiesByType(userId, 'person' as any);
          for (const p of persons) {
            if (p.name === 'User') continue; // Never delete the User entity
            if (/[\n\r\t]/.test(p.name) || p.name.length > 40 || PERSON_BLACKLIST.has(p.name.toLowerCase())) {
              await this.kgRepo.deleteEntity(p.id);
              invalidPersonsCleaned++;
            }
          }
        } catch { /* non-critical */ }

        this.logger.info({ decayed, prunedEntities, prunedRelations, prunedEvents, mergedDupes, phantomsMerged, orgsMerged, typeConflictsResolved, invalidPersonsCleaned }, 'KG maintenance completed');
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
        const locName = location.trim();
        // Cross-check: don't create location if already known as organization, item, or service
        const existing = await this.kgRepo.getEntityByName?.(userId, locName.toLowerCase(), 'organization' as any)
          ?? await this.kgRepo.getEntityByName?.(userId, locName.toLowerCase(), 'item' as any);
        if (!existing) {
          // Skip generic non-location strings
          if (!/^(online|remote|zoom|teams|webex|virtual|tbd|n\/a|überweisung|führung)/i.test(locName)) {
            const loc = await this.kgRepo.upsertEntity(userId, locName, 'location', {}, 'calendar');
            await this.kgRepo.upsertRelation(userId, event.id, loc.id, 'located_at', `${time}`, 'calendar');
          }
        }
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

      // Extract entities from "für <Name>" or "mit <Name>" — route through classifyEntityName
      for (const pattern of PERSON_PATTERNS) {
        pattern.lastIndex = 0;
        const personMatch = pattern.exec(title);
        if (personMatch) {
          const rawName = personMatch[1].trim();
          const entityType = this.classifyEntityName(rawName);
          if (entityType) {
            const entity = await this.kgRepo.upsertEntity(userId, rawName, entityType as any, {}, 'todos');
            await this.kgRepo.upsertRelation(userId, event.id, entity.id, 'involves', title.trim(), 'todos');
          }
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
      for (const city of this.getKnownLocations()) {
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
      const user = await this.upsertUserEntity(userId);
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

      // Extract addresses as locations (dynamic list + PLZ pattern)
      if (keyLower.includes('adress') || keyLower.includes('address') || keyLower.includes('heim') || keyLower.includes('home')) {
        const isHome = keyLower.includes('heim') || keyLower.includes('home');
        // Known locations (dynamic)
        for (const city of this.getKnownLocations()) {
          if (value.includes(city)) {
            await this.kgRepo.upsertEntity(userId, city, 'location', { isHome }, 'memories');
          }
        }
        // PLZ pattern: "3033 Altlengbach", "80331 München"
        PLZ_CITY_REGEX.lastIndex = 0;
        let plzMatch;
        while ((plzMatch = PLZ_CITY_REGEX.exec(value)) !== null) {
          const city = plzMatch[2];
          if (!this.knownLocationsLower.has(city.toLowerCase())) {
            this.registerLocation(city);
            await this.kgRepo.upsertEntity(userId, city, 'location', { isHome, detectedBy: 'plz_pattern' }, 'memories');
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
      const user = await this.upsertUserEntity(userId);
      await this.kgRepo.upsertRelation(userId, user.id, strompreis.id, 'monitors', `${price}ct/kWh`, 'energy');
    }
  }

  private async extractFromSmartHome(userId: string, content: string): Promise<void> {
    // HA states come as pipe-delimited markdown table: | entity_id | state | friendly_name | unit |
    const tableRe = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;

    // Domains to skip (system entities, not real devices)
    const SKIP_DOMAINS = /^(sun\.|conversation\.|geo_location\.|weather\.|persistent_notification\.|zone\.)/;
    // Internal/technical entities to skip (Victron internals, Shelly hex IDs, system relays)
    const SKIP_INTERNALS = /^(vebus[\s_]|settings[\s_]ess|system[\s_]relay|shelly\w+[-_][0-9a-f]{6,})/i;
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
      // Skip internal/technical entities
      if (SKIP_INTERNALS.test(fn) || SKIP_INTERNALS.test(eid)) continue;
      const name = fn;

      const attrs: Record<string, unknown> = { entity_id: eid, state: st };
      if (unit.trim() !== '-' && unit.trim().length > 0) attrs.unit = unit.trim();

      // HA person.* entities are people, not items
      const entityType = eid.startsWith('person.') ? 'person' : 'item';
      await this.kgRepo.upsertEntity(userId, name, entityType as any, attrs, 'smarthome');
      count++;
    }
  }

  private async extractFromCrypto(userId: string, content: string): Promise<void> {
    const posRe = /\b(BTC|ETH|SOL|ADA|DOT|XRP|DOGE|LINK|AVAX|MATIC|Bitcoin|Ethereum)\b[*:\s]*([0-9.,]+)(?:\s*[×x€$]?\s*[€$]?\s*([0-9.,]+))?/gi;
    const user = await this.upsertUserEntity(userId);
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
      const user = await this.upsertUserEntity(userId);
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
        const smItems = items.filter(i => i.sources.includes('smarthome'));
        for (const item of smItems) {
          await this.kgRepo.upsertRelation(userId, item.id, homeLocation.id, 'located_at', undefined, 'cross');
        }
      }

      // Rule 6: Organizations → Work Location
      const workLocation = locations.find(l => l.attributes?.isWork === true && l.attributes?.isHome !== true);
      if (workLocation) {
        const orgs = entities.filter(e => e.entityType === 'organization');
        for (const org of orgs) {
          await this.kgRepo.upsertRelation(userId, org.id, workLocation.id, 'located_at', undefined, 'cross');
        }
      }
    } catch (err) {
      this.logger.info({ err }, 'KG: cross-extractor relations partially failed');
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
      // 1. Memory entities (persons, contacts) → KG person entities + User relations
      //    Canonical name resolution: same real person → same entity, context as attributes/relations
      const user = await this.upsertUserEntity(userId);
      const TITLE_WORDS = new Set(['sohn', 'tochter', 'frau', 'herr', 'schwester', 'bruder']);
      const canonicalPersons = new Map<string, string>(); // firstName → canonical "Title Firstname"

      // Load correction memories to override canonical names (e.g., "Noah heißt Habel, nicht Dohnal")
      const correctionMems = await this.memoryRepo.getByType(userId, 'correction', 20);
      const correctionTexts = correctionMems.map(m => m.value.toLowerCase());

      const entityMems = await this.memoryRepo.getByType(userId, 'entity', 30);
      for (const mem of entityMems) {
        // Strip punctuation, split on comma/parens/period, take first segment
        const raw = mem.value.split(/[,(.!?]/)[0].replace(/[:\d]/g, '').trim();
        const words = raw.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w));

        // Extract title + first actual name (max 2 words)
        // Stop at the firstName — don't append concept words like "Fußball"
        const nameWords: string[] = [];
        let firstName = '';
        for (const w of words) {
          const wClean = w.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
          if (!wClean || wClean.length < 2) continue;
          if (TITLE_WORDS.has(wClean.toLowerCase())) { nameWords.push(wClean); continue; }
          if (isInvalidPersonName(wClean, this.knownLocationsLower)) continue;
          // After firstName is found, only accept surname-like words (short, no compound noun)
          if (firstName) {
            // Second word must look like a surname: <8 chars, not a concept
            if (wClean.length > 7 || this.classifyEntityName(wClean) !== 'person') break;
          }
          firstName = wClean.toLowerCase();
          nameWords.push(wClean);
          if (nameWords.length >= 2) break;
        }
        if (!firstName || nameWords.length === 0) continue;
        const personName = nameWords.join(' ');
        if (personName.length < 2) continue;

        // Canonical resolution: if we already have this firstName, reuse the canonical name
        // This ensures "Sohn Linus" (from child_linus) and "Linus" (from linus_football_club)
        // map to the same entity
        const canonical = canonicalPersons.get(firstName);
        let effectiveName = canonical ?? personName;
        if (!canonical) canonicalPersons.set(firstName, personName);

        // Check if a correction memory overrides this person's name
        // e.g., "Noah heißt Habel" or "Noah und Lena heissen Habel"
        for (const ct of correctionTexts) {
          if (ct.includes(firstName)) {
            // Extract the corrected surname from patterns like "heisst/heißt/heissen X" or "Nachname X"
            const surnameMatch = ct.match(new RegExp(`${firstName}[^.]*?(?:hei[sß][st]e?n?|nachname[n]?)\\s+([A-ZÄÖÜ][a-zäöüß]+)`, 'i'));
            if (surnameMatch) {
              effectiveName = `${personName.split(' ').filter(w => !TITLE_WORDS.has(w.toLowerCase())).join(' ')} ${surnameMatch[1]}`.replace(/\s+/g, ' ').trim();
              // Also update the canonical map so subsequent entities use the corrected name
              canonicalPersons.set(firstName, effectiveName);
              break;
            }
          }
        }

        const person = await this.kgRepo.upsertEntity(userId, effectiveName, 'person',
          { memoryKey: mem.key, memoryConfidence: mem.confidence }, 'memories');

        // Extract context from value → attributes + relations (clubs, schools, etc.)
        const clubMatch = mem.value.match(/(?:beim?|im|at)\s+([A-ZÄÖÜ][\w\s]*(?:1980|Altlengbach|Kapfenberg|Wien|FC|SV|SK|SC|ASK|KSV|TSV|SVL)[^\s.,)]*)/i);
        if (clubMatch) {
          const clubName = clubMatch[1].trim();
          const club = await this.kgRepo.upsertEntity(userId, clubName, 'organization' as any, { sport: 'Fußball' }, 'memories');
          await this.kgRepo.upsertRelation(userId, person.id, club.id, 'plays_at', mem.value.slice(0, 80), 'memories');
        }

        // Derive relation type from memory key
        const k = mem.key.toLowerCase();
        const isFriend = k.includes('friend') || k.includes('freund');
        const relType = isFriend ? 'knows'
          : k.includes('child') || k.includes('sohn') || k.includes('tochter') || k.includes('kinder') ? 'parent_of'
          : k.includes('spouse') || k.includes('frau') || k.includes('mann') || k.includes('partner') ? 'spouse'
          : k.includes('mother') || k.includes('father') || k.includes('sister') || k.includes('brother') || k.includes('mutter') || k.includes('schwester') || k.includes('bruder') || k.includes('vater') ? 'family'
          : 'knows';
        await this.kgRepo.upsertRelation(userId, user.id, person.id, relType, mem.key, 'memories');
      }

      // 1b. Extract persons from ALL memory keys (any type) with person-name patterns
      //     "friend_bernhard_birthday" → Person "Bernhard" + User→knows→Bernhard
      //     "friend_bernhard_spouse_name" (value "Sabine") → Bernhard→spouse→Sabine
      const PERSON_KEY_PREFIXES = ['friend_', 'freund_', 'colleague_', 'kollege_', 'neighbor_', 'nachbar_', 'contact_', 'kontakt_'];
      const allMems = await this.memoryRepo.getRecentForPrompt(userId, 50);
      const keyPersons = new Map<string, { entity: KGEntity; prefix: string }>(); // "bernhard" → entity
      for (const mem of allMems) {
        const k = mem.key.toLowerCase();
        for (const prefix of PERSON_KEY_PREFIXES) {
          if (!k.startsWith(prefix)) continue;
          // Extract person name: between prefix and next underscore
          const rest = k.slice(prefix.length);
          const namePart = rest.split('_')[0];
          if (namePart.length < 3) continue;
          const personName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
          if (isInvalidPersonName(personName, this.knownLocationsLower)) continue;

          // Check canonical map — reuse existing entity if same firstName
          const canonical = canonicalPersons.get(namePart);
          const effectiveName = canonical ?? personName;
          if (!canonical) canonicalPersons.set(namePart, personName);

          if (!keyPersons.has(namePart)) {
            const person = await this.kgRepo.upsertEntity(userId, effectiveName, 'person', {}, 'memories');
            // Derive relation from prefix
            const relType = prefix.startsWith('friend') || prefix.startsWith('freund') ? 'knows'
              : prefix.startsWith('colleague') || prefix.startsWith('kollege') ? 'works_with'
              : prefix.startsWith('neighbor') || prefix.startsWith('nachbar') ? 'neighbor_of'
              : 'knows';
            await this.kgRepo.upsertRelation(userId, user.id, person.id, relType, mem.key, 'memories');
            keyPersons.set(namePart, { entity: person, prefix });
          }

          // Cross-reference: if this memory links the key-person to the value-person
          // e.g., "friend_bernhard_spouse_name" value "Sabine" → Bernhard→spouse→Sabine
          const keyPerson = keyPersons.get(namePart);
          if (keyPerson && k.includes('spouse') && mem.type === 'entity') {
            // The value is the spouse's name — find or create
            const spouseName = mem.value.split(',')[0].split('(')[0].replace(/[:\d]/g, '').trim();
            if (spouseName.length >= 2) {
              const spouse = await this.kgRepo.upsertEntity(userId, spouseName, 'person', { memoryKey: mem.key }, 'memories');
              await this.kgRepo.upsertRelation(userId, keyPerson.entity.id, spouse.id, 'spouse', mem.key, 'memories');
            }
          }
          // Birthday fact → add as attribute (check if it's the key-person's birthday or someone else's)
          if (keyPerson && k.includes('birthday') && mem.type === 'fact') {
            // "friend_bernhard_spouse_sabine_birthday" → Sabine's birthday, not Bernhard's
            // "friend_bernhard_birthday" → Bernhard's birthday
            const afterName = rest.slice(namePart.length + 1); // e.g., "spouse_sabine_birthday" or "birthday"
            if (afterName === 'birthday' || afterName === '') {
              // Direct birthday of the key-person
              await this.kgRepo.upsertEntity(userId, keyPerson.entity.name, 'person',
                { birthday: mem.value }, 'memories');
            } else if (afterName.includes('birthday')) {
              // Sub-person birthday: "spouse_sabine_birthday" → find "sabine" and set birthday
              const subParts = afterName.split('_').filter(p => p.length >= 3 && p !== 'birthday' && p !== 'spouse');
              for (const sub of subParts) {
                const subName = sub.charAt(0).toUpperCase() + sub.slice(1);
                const existing = await this.kgRepo.getEntityByName(userId, subName, 'person');
                if (existing) {
                  await this.kgRepo.upsertEntity(userId, subName, 'person', { birthday: mem.value }, 'memories');
                }
              }
            }
          }
          break; // only first matching prefix
        }
      }

      // 2. Memory relationships → KG person entities + relations
      const relMems = await this.memoryRepo.getByType(userId, 'relationship', 30);
      for (const mem of relMems) {
        for (const pattern of PERSON_PATTERNS) {
          pattern.lastIndex = 0;
          const m = pattern.exec(mem.value);
          if (m) {
            const name = m[1].trim();
            if (!isInvalidPersonName(name, this.knownLocationsLower)) {
              const person = await this.kgRepo.upsertEntity(userId, name, 'person',
                { relationship: mem.key }, 'memories');
              await this.kgRepo.upsertRelation(userId, user.id, person.id, 'knows', mem.key, 'memories');
            }
          }
        }
      }

      // 2b. Employment memories → KG organization entities + relations
      for (const query of ['employment', 'employer', 'arbeitgeber', 'firma', 'company', 'teamlead', 'position']) {
        const jobs = await this.memoryRepo.search(userId, query);
        for (const job of jobs.slice(0, 3)) {
          const orgMatch = job.value.match(/(?:bei|at)\s+([A-ZÄÖÜ][\w\s&.-]+?)(?:\s+(?:als|as|since|seit)|[.,]|$)/i)
            ?? job.value.match(/([A-ZÄÖÜ][\w\s&.-]*(?:GmbH|AG|ICT|Inc|Corp|Ltd|SE)[^\s.,]*)/i);
          if (orgMatch) {
            const orgName = orgMatch[1].trim();
            // Skip if it's "User" or an existing person entity
            if (orgName === 'User' || orgName.length < 3) continue;
            // Normalize: if full name (Axians ICT Austria GmbH) but short version exists, use short
            // Reject sentence-like org names (contain verbs, too long, start with lowercase preposition)
            if (orgName.length > 50) continue;
            if (/^(als|bei|user|er|sie|ich|wir|das|der|die)\s/i.test(orgName)) continue;
            if (/\b(arbeitet|ist|hat|wurde|wird|kann|soll|muss)\b/i.test(orgName)) continue;

            const shortName = orgName.split(/\s+/)[0]; // "Axians" from "Axians ICT Austria GmbH"
            const existingShort = await this.kgRepo.getEntityByName(userId, shortName, 'organization' as any);
            const effectiveOrgName = existingShort ? shortName : orgName;

            const roleMatch = job.value.match(/(?:als|as)\s+(.+?)(?:\s+(?:bei|at|seit|since|angestellt)|[.,]|$)/i);
            const attrs: Record<string, unknown> = {};
            if (roleMatch) attrs.role = roleMatch[1].trim();
            attrs.memoryKey = job.key;
            const org = await this.kgRepo.upsertEntity(userId, effectiveOrgName, 'organization' as any, attrs, 'memories');
            const user = await this.upsertUserEntity(userId);
            await this.kgRepo.upsertRelation(userId, user.id, org.id, 'works_at', roleMatch?.[1]?.slice(0, 80), 'memories');
          }
        }
      }

      // 3. Memory facts with addresses → KG location entities (dynamic + PLZ)
      for (const query of ['adress', 'address', 'heim', 'home', 'büro', 'office', 'wohn']) {
        const facts = await this.memoryRepo.search(userId, query);
        for (const fact of facts.slice(0, 5)) {
          // Collect cities: known locations + PLZ pattern matches
          const cities = new Set<string>();
          for (const city of this.getKnownLocations()) {
            if (fact.value.includes(city)) cities.add(city);
          }
          PLZ_CITY_REGEX.lastIndex = 0;
          let plzMatch;
          while ((plzMatch = PLZ_CITY_REGEX.exec(fact.value)) !== null) {
            const city = plzMatch[2];
            cities.add(city);
            this.registerLocation(city);
          }
          for (const city of cities) {
            // Find the sentence containing this city and check for home/work + negation
            const sentences = fact.value.split(/[.!]\s+/);
            const citySentence = sentences.find(s => s.includes(city)) ?? '';
            const lower = citySentence.toLowerCase();
            const hasHomeWord = /heim|home|wohn|zuhause|privat/i.test(lower);
            const hasWorkWord = /büro|office|arbeit|firma|work/i.test(lower);
            const hasNegation = /nicht|kein|never|no\s|!=|niemals/i.test(lower);
            const isHome = hasHomeWord && !hasNegation;
            const isWork = hasWorkWord && !hasNegation;
            await this.kgRepo.upsertEntity(userId, city, 'location',
              { isHome, isWork, address: fact.value }, 'memories');
          }
        }
      }
      // 4. Memory patterns → KG (behavioral patterns like "abends aktiv")
      const patternMems = await this.memoryRepo.getByType(userId, 'pattern', 10);
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
      this.logger.info({ err }, 'KG: memory sync partially failed');
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

  private async extractFromNotes(userId: string, content: string): Promise<void> {
    // Format: "- [2026-04-02] **Title**: preview..."
    const re = /^\s*-\s+\[\d{4}-\d{2}-\d{2}\]\s+\*\*(.+?)\*\*:\s*(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const title = match[1].trim();
      const preview = match[2].trim();
      if (title.length < 3) continue;
      await this.kgRepo.upsertEntity(userId, title, 'item',
        { type: 'note', preview: preview.slice(0, 100) }, 'notes');
    }
  }

  private async extractFromDocuments(userId: string, content: string): Promise<void> {
    // Format: "- filename.ext (123 KB, 5 Seiten, 2026-04-02)"
    const re = /^\s*-\s+(.+?)\s+\(\d+\s*KB,\s*(\d+)\s*Seiten/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const filename = match[1].trim();
      const pages = parseInt(match[2], 10);
      if (filename.length < 3) continue;
      await this.kgRepo.upsertEntity(userId, filename, 'item',
        { type: 'document', pages }, 'documents');
    }
  }

  private async extractFromReminders(userId: string, content: string): Promise<void> {
    // Format: "- DD.MM. HH:MM: message" or "- ⚠️ ÜBERFÄLLIG: message"
    const re = /^\s*-\s+(?:⚠️ ÜBERFÄLLIG|[\d.]+,?\s*[\d:]+):\s*(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const message = match[1].trim();
      if (message.length < 5) continue;
      await this.kgRepo.upsertEntity(userId, message.slice(0, 80), 'event',
        { type: 'reminder' }, 'reminders');
    }
  }

  private async extractLocations(userId: string, sectionKey: string, content: string): Promise<void> {
    // Only extract locations from user-relevant sections, not RSS feeds
    if (sectionKey === 'feeds' || sectionKey === 'infra' || sectionKey === 'activity' || sectionKey === 'skillHealth') return;

    // 1. Known locations — dynamic list (seed + learned from KG)
    for (const city of this.getKnownLocations()) {
      if (content.includes(city)) {
        await this.kgRepo.upsertEntity(userId, city, 'location', {}, sectionKey);
      }
    }

    // 2. Pattern-based: German geographic prepositions → location candidates
    // "nach Köln", "in London", "aus München", "über Zürich", "durch Berlin"
    const GEO_PATTERNS = [
      /\b(?:nach|in|aus|über|durch)\s+([A-ZÄÖÜ][a-zäöüß]{2,}(?:[\s-][A-ZÄÖÜ][a-zäöüß]+)?)\b/g,
      /\b(?:Messe|Flughafen|Bahnhof|Hotel|Flug|Reise)\s+(?:in\s+|nach\s+)?([A-ZÄÖÜ][a-zäöüß]{2,})\b/g,
    ];

    for (const pattern of GEO_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const candidate = match[1].trim();
        if (candidate.length < 3 || candidate.length > 30) continue;
        // Skip names with special characters (newlines, slashes from calendar entries etc.)
        if (/[\n\r\t/|]/.test(candidate)) continue;
        // Skip if already a known person, org, or in blacklists
        if (PERSON_BLACKLIST.has(candidate.toLowerCase())) continue;
        if (this.knownLocationsLower.has(candidate.toLowerCase())) {
          // Already handled above, but ensure it's created
          await this.kgRepo.upsertEntity(userId, candidate, 'location', {}, sectionKey);
          continue;
        }
        // Skip German common nouns (suffix check without length restriction — no city ends in these)
        if (!candidate.includes(' ') && /^[A-ZÄÖÜ][a-zäöüß]+$/.test(candidate)) {
          if (KnowledgeGraphService.NOUN_SUFFIXES.test(candidate)) continue;
        }
        // Skip known entity names that are not locations
        if (this.cmdbEntityNames.has(candidate.toLowerCase())) continue;
        // Quality gate: skip implausible location names
        if (!KnowledgeGraphService.isPlausibleLocation(candidate)) continue;
        // Create as location candidate and register for future recognition
        try {
          await this.kgRepo.upsertEntity(userId, candidate, 'location', { detectedBy: 'geo_pattern' }, sectionKey);
          this.registerLocation(candidate);
        } catch { /* constraint violation — skip */ }
      }
    }
  }

  /**
   * Extract entities from text using preposition patterns (bei/für/mit/von + Name).
   * Routes each extraction to the correct entity type instead of blindly creating persons.
   */
  private async extractEntitiesFromText(userId: string, sectionKey: string, content: string): Promise<void> {
    if (sectionKey === 'feeds' || sectionKey === 'infra' || sectionKey === 'activity' || sectionKey === 'skillHealth') return;

    for (const pattern of PERSON_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const rawName = match[1].trim();
        if (rawName.length < 3) continue;

        // Determine entity type by checking multiple signals
        const entityType = this.classifyEntityName(rawName);
        if (!entityType) continue; // filtered out (invalid name)

        await this.kgRepo.upsertEntity(userId, rawName, entityType as any, {}, sectionKey);
      }
    }
  }

  /** Classify an extracted name into the correct entity type. */
  private classifyEntityName(name: string): string | null {
    // Reject names with newlines, control chars, or that are clearly chat fragments
    if (/[\n\r\t]/.test(name)) return null;
    if (name.length < 2 || name.length > 40) return null;

    const lower = name.toLowerCase();

    // 0. CMDB-managed entity? Skip — CMDB is the source of truth for infra entities.
    if (this.cmdbEntityNames.has(lower)) return null;

    // 1. Known location?
    if (this.knownLocationsLower.has(lower)) return 'location';

    // 2. Organization? (AG, GmbH, ICT, Inc, etc.)
    if (isLikelyOrganization(name)) return 'organization';

    // 3. German compound noun = likely item/concept, not person
    //    "Hausbatterie", "Ladefenster", "Strompreis", "Wallbox", "Fußball"
    //    Single word, >7 chars, no space, starts uppercase = German compound
    // German compound nouns: single word, >9 chars (Hausbatterie=13, Strompreis=10, but Bernhard=8, Elisabeth=9 are names)
    if (!name.includes(' ') && name.length > 9 && /^[A-ZÄÖÜ][a-zäöüß]+$/.test(name)) return 'item';

    // 4. Ends with typical German noun suffixes → concept, not person
    if (/(?:ung|heit|keit|schaft|tion|tät|nis|ment|eur|gie|rie|mus|tik|thek|tur|trie)$/i.test(name)) return 'item';

    // 5. Known technical/device terms
    if (/^(?:Victron|Shelly|Sonos|Wallbox|Batterie|Akku|Inverter|Switch|Router|Gateway|Sensor|Zigbee)/i.test(name)) return 'item';

    // 6. Check person blacklist (generic words, brands)
    if (PERSON_BLACKLIST.has(lower)) return null;

    // 6b. 2-word names: check if second word is a common German noun (not a surname)
    //     "Noah Fußball" → second word "Fußball" is a noun → return null (not a person name)
    //     "Maria Dohnal" → second word "Dohnal" is NOT a noun → keep as person
    //     "Frau Alex" → second word "Alex" is NOT a noun → keep as person
    if (name.includes(' ')) {
      const words = name.split(/\s+/);
      if (words.length === 2) {
        const second = words[1];
        const secondLower = second.toLowerCase();
        // If second word is a single German compound noun (>6 chars, typical noun pattern)
        if (second.length > 6 && /^[A-ZÄÖÜ][a-zäöüß]+$/.test(second) && !this.knownLocationsLower.has(secondLower)) {
          // Check noun suffixes that indicate a common noun, not a surname
          if (/(?:ung|heit|keit|schaft|tion|tät|nis|ment|gie|rie|mus|tik|tur|ball|spiel|kurs|weise|platz|zeit|werk|haus|raum|bahn|berg)$/i.test(second)) {
            return null; // "Noah Fußball", "Linus Schwimmkurs" → not a person
          }
        }
        // If second word is in the person blacklist → not a person name
        if (PERSON_BLACKLIST.has(secondLower)) return null;
      }
    }

    // 7. Contains digits or underscores → not a person name
    if (/[0-9_]/.test(name)) return null;

    // 8. All lowercase → not a proper name
    if (name === lower) return null;

    // 9. Skip common German articles
    if (/^(Dem|Der|Das|Den|Die|Ein|Eine)$/i.test(name)) return null;

    // 10. Default: return null (unknown) instead of guessing 'person'.
    // Person entities should come from explicit sources: syncMemoryEntities (hardcoded),
    // extractFromEmail (sender names), LLM-Linker (context-based). The regex extractor
    // cannot reliably distinguish persons from German nouns (all capitalized).
    return null;
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
