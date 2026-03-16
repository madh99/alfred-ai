import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository, MemoryType, MemorySource } from '@alfred/storage';
import type { EmbeddingService } from '../embedding-service.js';

const VALID_TYPES: MemoryType[] = [
  'fact', 'preference', 'correction', 'entity', 'decision',
  'relationship', 'principle', 'commitment', 'moment', 'skill',
];

interface ExtractedMemory {
  key: string;
  value: string;
  type: MemoryType;
  confidence: number;
  category: string;
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the user message and extract personal facts about the USER (not about what they're asking).

Rules:
- Only extract information the user STATES about themselves
- Do NOT extract questions, requests, or commands
- Do NOT extract information about topics they're asking about
- Each memory needs: key (snake_case identifier), value (concise fact), type, confidence, category
- Types: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- Confidence: 0.9+ for explicitly stated facts, 0.6-0.8 for implied, 0.4-0.6 for inferred
- Category: personal, work, preferences, relationships, health, hobbies, education, location, other
- Return a JSON array. If nothing worth extracting, return []

Example input: "Ich lebe in Altlengbach und arbeite als Softwareentwickler"
Example output: [{"key":"location","value":"Lebt in Altlengbach","type":"fact","confidence":0.95,"category":"location"},{"key":"occupation","value":"Softwareentwickler","type":"fact","confidence":0.95,"category":"work"}]

Extract memories from this conversation:

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
      const prompt = EXTRACTION_PROMPT
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
