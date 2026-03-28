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

          savedCount++;
          this.logger.info(
            { key: mem.key, type: mem.type, confidence: mem.confidence },
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
        savedCount++;
        this.logger.info(
          { key: mem.key, type: 'connection', confidence: mem.confidence },
          'Cross-context connection extracted',
        );
      } catch (err) {
        this.logger.warn({ err, key: mem.key }, 'Failed to save connection memory');
      }
    }
    return savedCount;
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
