import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository, MemoryType, MemorySource } from '@alfred/storage';
import type { EmbeddingService } from '../embedding-service.js';

const VALID_TYPES: MemoryType[] = [
  'fact', 'preference', 'correction', 'entity', 'decision',
  'relationship', 'principle', 'commitment', 'moment', 'skill',
  'connection',
];

interface ExtractedMemory {
  key: string;
  value: string;
  type: MemoryType;
  confidence: number;
  category: string;
}

const EXTRACTION_PROMPT = `You are a memory extraction and cross-context reasoning system. Analyze the conversation AND existing memories to:
1. Extract NEW personal facts about the user
2. Detect CONNECTIONS between what the user says and what you already know

Rules for extraction:
- Only extract information the user STATES or IMPLIES about themselves
- Do NOT extract questions, requests, or commands
- Each memory needs: key (snake_case identifier), value (concise fact), type, confidence, category

Rules for connections (IMPORTANT — this is what makes you proactive):
- Compare the new conversation against EXISTING MEMORIES below
- If you spot a useful connection, create a memory with type "connection"
- Connections should be ACTIONABLE — something the user would benefit from knowing
- Examples: scheduling conflicts, opportunities (nearby shop for watched product), time-sensitive advice
- Only create connections with confidence >= 0.6 (real, non-obvious insights)

Types: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill, connection
- "connection" = cross-context insight linking new information to existing memories

Confidence: 0.9+ for explicitly stated, 0.6-0.8 for implied/connected, 0.4-0.6 for inferred
Category: personal, work, preferences, relationships, health, hobbies, education, location, shopping, travel, schedule, other

If nothing worth extracting or connecting, return []

{EXISTING_MEMORIES}

Conversation:
User: {USER_MESSAGE}
Assistant: {ASSISTANT_RESPONSE}

Return ONLY a valid JSON array, no explanation:`;

export class MemoryExtractor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
    private readonly embeddingService?: EmbeddingService,
    private readonly minConfidence = 0.4,
  ) {}

  async extract(
    userId: string,
    userMessage: string,
    assistantResponse: string,
  ): Promise<number> {
    try {
      // Load existing memories for cross-context reasoning
      let existingMemoriesBlock = '';
      try {
        const recent = await this.memoryRepo.getRecentForPrompt(userId, 20);
        if (recent.length > 0) {
          const lines = recent.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
          existingMemoriesBlock = `Existing memories about this user:\n${lines}\n\nLook for CONNECTIONS between these and the new conversation.\n`;
        }
      } catch (err) { this.logger.warn({ err }, 'Failed to load existing memories for extraction'); }

      const prompt = EXTRACTION_PROMPT
        .replace('{EXISTING_MEMORIES}', existingMemoriesBlock)
        .replace('{USER_MESSAGE}', userMessage)
        .replace('{ASSISTANT_RESPONSE}', assistantResponse);

      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        tier: 'fast',
        maxTokens: 1024,
      });

      const memories = this.parseResponse(response.content);
      if (memories.length === 0) return 0;

      let savedCount = 0;
      for (const mem of memories) {
        if (mem.confidence < this.minConfidence) continue;

        try {
          const entry = await this.memoryRepo.saveWithMetadata(
            userId,
            mem.key,
            mem.value,
            mem.category,
            mem.type,
            mem.confidence,
            'auto' as MemorySource,
          );

          // Fire-and-forget embedding
          if (this.embeddingService) {
            this.embeddingService
              .embedAndStore(userId, `${mem.key}: ${mem.value}`, 'memory', entry.id)
              .catch(err => this.logger.debug({ err }, 'Auto-embed failed'));
          }

          // If the memory describes a TIME-BOUND EVENT with a future date, set expiresAt
          const eventDate = this.extractFutureEventDate(mem);
          if (eventDate) {
            const expiresAt = new Date(eventDate.getTime() + 24 * 60 * 60_000).toISOString();
            try {
              await this.memoryRepo.setExpiry(userId, mem.key, expiresAt);
            } catch { /* non-critical */ }
          }

          // Resolve contradictions: if this memory explicitly negates something, delete contradicted memories
          await this.resolveContradictions(userId, mem);

          savedCount++;
          this.logger.info(
            { key: mem.key, type: mem.type, confidence: mem.confidence, expiresAt: eventDate ? 'set' : 'none' },
            'Auto-extracted memory saved',
          );
        } catch (err) {
          this.logger.warn({ err, key: mem.key }, 'Failed to save extracted memory');
        }
      }

      return savedCount;
    } catch (err) {
      this.logger.error({ err }, 'Memory extraction failed');
      return 0;
    }
  }

  /**
   * Connection-only extraction: runs only when user has ≥5 memories.
   * Used for low-signal messages that still might trigger cross-context insights.
   */
  async extractConnectionsOnly(
    userId: string,
    userMessage: string,
    assistantResponse: string,
  ): Promise<number> {
    // Only run if user has enough memories to connect against
    const existing = await this.memoryRepo.getRecentForPrompt(userId, 20);
    if (existing.length < 5) return 0;

    const lines = existing.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
    const existingMemoriesBlock = `Existing memories about this user:\n${lines}\n\nLook for CONNECTIONS between these and the new conversation.\n`;

    const prompt = EXTRACTION_PROMPT
      .replace('{EXISTING_MEMORIES}', existingMemoriesBlock)
      .replace('{USER_MESSAGE}', userMessage)
      .replace('{ASSISTANT_RESPONSE}', assistantResponse);

    const response = await this.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      tier: 'fast',
      maxTokens: 512,
    });

    const memories = this.parseResponse(response.content)
      .filter(m => m.type === 'connection');

    if (memories.length === 0) return 0;

    let savedCount = 0;
    for (const mem of memories) {
      if (mem.confidence < 0.6) continue;
      try {
        const entry = await this.memoryRepo.saveWithMetadata(
          userId, mem.key, mem.value, mem.category,
          mem.type, mem.confidence, 'auto' as MemorySource,
        );
        if (this.embeddingService) {
          this.embeddingService
            .embedAndStore(userId, `${mem.key}: ${mem.value}`, 'memory', entry.id)
            .catch(err => this.logger.debug({ err }, 'Auto-embed failed'));
        }
        // Set expiresAt for time-bound connections
        const eventDate = this.extractFutureEventDate(mem);
        if (eventDate) {
          const expiresAt = new Date(eventDate.getTime() + 24 * 60 * 60_000).toISOString();
          try { await this.memoryRepo.setExpiry(userId, mem.key, expiresAt); } catch { /* non-critical */ }
        }

        // Resolve contradictions in connection path too
        await this.resolveContradictions(userId, mem);

        savedCount++;
        this.logger.info(
          { key: mem.key, type: 'connection', confidence: mem.confidence, expires: eventDate ? 'set' : 'none' },
          'Cross-context connection extracted',
        );
      } catch (err) {
        this.logger.warn({ err, key: mem.key }, 'Failed to save connection memory');
      }
    }
    return savedCount;
  }

  /**
   * When a high-confidence memory explicitly negates something ("Linus spielt NICHT beim KSV"),
   * find and delete older memories that contain the contradicted statement.
   * This prevents stale wrong information from persisting alongside corrections.
   */
  private async resolveContradictions(userId: string, mem: ExtractedMemory): Promise<void> {
    try {
      // Only for high-confidence memories with explicit negation
      if (mem.confidence < 0.9) return;
      const NEGATION_RE = /\b(nicht|not|kein|keine|keinem|keiner|falsch|wrong|korrektur|correction|stimmt nicht|war falsch)\b/i;
      if (!NEGATION_RE.test(mem.value)) return;

      // Extract entity name from key (e.g., "linus" from "linus_football_club")
      const keyParts = mem.key.toLowerCase().split('_');
      const entityName = keyParts.find(p => p.length >= 3 && !/^(connection|fact|pref|pattern|rule|feedback|general|correction)$/.test(p));
      if (!entityName) return;

      // Extract what is being negated (text after "nicht/not/kein")
      const negMatch = mem.value.match(/(?:nicht|not|kein|keine)\s+(?:beim?|bei|im|in|am|vom?|zum?)?\s*(.{3,40}?)(?:[.,;!)\]]|\s+[-–]|\s+und\b|\s+oder\b|$)/i);
      if (!negMatch) return;
      const negatedTerm = negMatch[1].trim();
      if (negatedTerm.length < 3) return;

      // Search for memories about the same entity that contain the negated term
      const candidates = await this.memoryRepo.search(userId, entityName);
      for (const candidate of candidates) {
        if (candidate.key === mem.key) continue;
        if (candidate.confidence >= mem.confidence) continue;
        // Check if the candidate's value contains the negated term
        const termToSearch = negatedTerm.toLowerCase().slice(0, 20);
        if (!candidate.value.toLowerCase().includes(termToSearch)) continue;

        await this.memoryRepo.delete(userId, candidate.key);
        this.logger.info(
          { deletedKey: candidate.key, reason: `contradicted by ${mem.key}`, negatedTerm },
          'Contradictory memory deleted',
        );
      }
    } catch (err) {
      this.logger.debug({ err }, 'resolveContradictions failed (non-critical)');
    }
  }

  /**
   * Detect if a memory describes a TIME-BOUND EVENT with a FUTURE date.
   * Returns the event date only if ALL conditions are met:
   * 1. Memory type is 'connection', 'moment', or 'general' (NOT fact, entity, preference, relationship)
   * 2. Key or value contains event-like words (match, training, termin, meeting, conflict, etc.)
   * 3. The date is in the future (or max 7 days in the past — recently expired events)
   *
   * NEVER sets expiresAt on: birthdays, employment dates, historical facts, addresses.
   */
  private extractFutureEventDate(mem: ExtractedMemory): Date | null {
    // Only time-bound types — NEVER expire facts, entities, preferences, relationships
    const EXPIRABLE_TYPES: string[] = ['connection', 'moment', 'general'];
    if (!EXPIRABLE_TYPES.includes(mem.type)) return null;

    // Key or value must contain event-like words
    const combined = `${mem.key} ${mem.value}`.toLowerCase();
    const EVENT_WORDS = /match|training|termin|meeting|event|conflict|spiel|turnier|fahrt|reise|abfahrt|ankunft|fällig|deadline|appointment|kickoff|session/;
    if (!EVENT_WORDS.test(combined)) return null;

    // Must NOT contain birthday/permanent-fact words
    const PERMANENT_WORDS = /geboren|birthday|geburtstag|geb\.|seit|employment|hired|angestellt|adresse|address|wohnt|lebt/;
    if (PERMANENT_WORDS.test(combined)) return null;

    // Extract date
    let date: Date | null = null;

    // DD.MM.YYYY
    const deMatch = mem.value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (deMatch) {
      const d = new Date(parseInt(deMatch[3]), parseInt(deMatch[2]) - 1, parseInt(deMatch[1]));
      if (!isNaN(d.getTime())) date = d;
    }

    // YYYY-MM-DD
    if (!date) {
      const isoMatch = mem.value.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        const d = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
        if (!isNaN(d.getTime())) date = d;
      }
    }

    if (!date) return null;

    // Date must be in the future or max 7 days in the past
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    if (date < sevenDaysAgo) return null; // Too old — probably a permanent fact

    return date;
  }

  private parseResponse(content: string): ExtractedMemory[] {
    try {
      // Try to extract JSON array from the response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null)
        .map(item => ({
          key: String(item.key || ''),
          value: String(item.value || ''),
          type: this.validateType(String(item.type || 'fact')),
          confidence: this.clampConfidence(Number(item.confidence) || 0.5),
          category: String(item.category || 'general'),
        }))
        .filter(item => item.key && item.value);
    } catch {
      this.logger.debug({ content: content.slice(0, 200) }, 'Failed to parse extraction response');
      return [];
    }
  }

  private validateType(type: string): MemoryType {
    return VALID_TYPES.includes(type as MemoryType) ? (type as MemoryType) : 'fact';
  }

  private clampConfidence(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}
