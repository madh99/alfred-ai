import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { MemoryRepository } from '@alfred/storage';

interface EmbeddingServiceLike {
  embedAndStore(userId: string, content: string, sourceType: string, sourceId: string): Promise<void>;
  semanticSearch(userId: string, query: string, limit?: number): Promise<{ key: string; value: string; category: string; score: number }[]>;
}

type MemoryAction = 'save' | 'recall' | 'search' | 'list' | 'delete' | 'semantic_search';

export class MemorySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'memory',
    description:
      'Store and retrieve persistent memories. Use this to remember user preferences, facts, ' +
      'and important information across conversations.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'recall', 'search', 'list', 'delete', 'semantic_search'],
          description: 'The memory action to perform',
        },
        key: {
          type: 'string',
          description: 'The memory key/label',
        },
        value: {
          type: 'string',
          description: 'The value to remember (for save)',
        },
        category: {
          type: 'string',
          description: 'Optional category (for save/list)',
        },
        query: {
          type: 'string',
          description: 'Search query (for search)',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly embeddingService?: EmbeddingServiceLike,
  ) {
    super();
  }

  /** Resolve effective user ID: cross-platform master if linked, else current user. */
  private effectiveUserId(context: SkillContext): string {
    return context.masterUserId ?? context.userId;
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as MemoryAction;

    switch (action) {
      case 'save':
        return this.saveMemory(input, context);
      case 'recall':
        return this.recallMemory(input, context);
      case 'search':
        return this.searchMemories(input, context);
      case 'list':
        return this.listMemories(input, context);
      case 'delete':
        return this.deleteMemory(input, context);
      case 'semantic_search':
        return this.semanticSearchMemories(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: save, recall, search, list, delete, semantic_search`,
        };
    }
  }

  private saveMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const key = input.key as string | undefined;
    const value = input.value as string | undefined;
    const category = input.category as string | undefined;

    if (!key || typeof key !== 'string') {
      return {
        success: false,
        error: 'Missing required field "key" for save action',
      };
    }

    if (!value || typeof value !== 'string') {
      return {
        success: false,
        error: 'Missing required field "value" for save action',
      };
    }

    const entry = this.memoryRepo.save(
      this.effectiveUserId(context),
      key,
      value,
      category ?? 'general',
    );

    // Auto-embed for semantic search
    if (this.embeddingService) {
      this.embeddingService.embedAndStore(
        this.effectiveUserId(context),
        `${key}: ${value}`,
        'memory',
        key,
      ).catch(() => { /* non-critical */ });
    }

    return {
      success: true,
      data: entry,
      display: `Remembered "${key}" = "${value}" (category: ${entry.category})`,
    };
  }

  private recallMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const key = input.key as string | undefined;

    if (!key || typeof key !== 'string') {
      return {
        success: false,
        error: 'Missing required field "key" for recall action',
      };
    }

    const entry = this.memoryRepo.recall(this.effectiveUserId(context), key);

    if (!entry) {
      return {
        success: true,
        data: null,
        display: `No memory found for key "${key}".`,
      };
    }

    return {
      success: true,
      data: entry,
      display: `${key} = "${entry.value}" (category: ${entry.category}, updated: ${entry.updatedAt})`,
    };
  }

  private searchMemories(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const query = input.query as string | undefined;

    if (!query || typeof query !== 'string') {
      return {
        success: false,
        error: 'Missing required field "query" for search action',
      };
    }

    const entries = this.memoryRepo.search(this.effectiveUserId(context), query);

    return {
      success: true,
      data: entries,
      display:
        entries.length === 0
          ? `No memories matching "${query}".`
          : `Found ${entries.length} memory(ies):\n${entries.map((e) => `- ${e.key}: "${e.value}"`).join('\n')}`,
    };
  }

  private listMemories(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const category = input.category as string | undefined;

    const entries =
      category && typeof category === 'string'
        ? this.memoryRepo.listByCategory(this.effectiveUserId(context), category)
        : this.memoryRepo.listAll(this.effectiveUserId(context));

    const label = category ? `in category "${category}"` : 'total';

    return {
      success: true,
      data: entries,
      display:
        entries.length === 0
          ? `No memories found${category ? ` in category "${category}"` : ''}.`
          : `${entries.length} memory(ies) ${label}:\n${entries.map((e) => `- [${e.category}] ${e.key}: "${e.value}"`).join('\n')}`,
    };
  }

  private deleteMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const key = input.key as string | undefined;

    if (!key || typeof key !== 'string') {
      return {
        success: false,
        error: 'Missing required field "key" for delete action',
      };
    }

    const deleted = this.memoryRepo.delete(this.effectiveUserId(context), key);

    return {
      success: true,
      data: { key, deleted },
      display: deleted
        ? `Memory "${key}" deleted.`
        : `No memory found for key "${key}".`,
    };
  }

  private async semanticSearchMemories(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const query = input.query as string | undefined;
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required field "query" for semantic_search action' };
    }

    if (!this.embeddingService) {
      // Fallback to keyword search
      return this.searchMemories(input, context);
    }

    const results = await this.embeddingService.semanticSearch(this.effectiveUserId(context), query, 10);
    if (results.length === 0) {
      // Fallback to keyword search
      return this.searchMemories(input, context);
    }

    return {
      success: true,
      data: results,
      display: `Found ${results.length} semantically related memory(ies):\n${results.map(r => `- ${r.key}: "${r.value}" (score: ${r.score.toFixed(2)})`).join('\n')}`,
    };
  }
}
