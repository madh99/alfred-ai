import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { MemoryRepository } from '@alfred/storage';
import { effectiveUserId, allUserIds } from '../user-utils.js';

interface EmbeddingServiceLike {
  embedAndStore(userId: string, content: string, sourceType: string, sourceId: string): Promise<string | undefined>;
  semanticSearch(userId: string, query: string, limit?: number): Promise<{ key: string; value: string; category: string; score: number }[]>;
}

type MemoryAction = 'save' | 'recall' | 'search' | 'list' | 'delete' | 'semantic_search';

export class MemorySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'memory',
    category: 'core',
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

  private async saveMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
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

    const entry = await this.memoryRepo.save(
      effectiveUserId(context),
      key,
      value,
      category ?? 'general',
    );

    // Auto-embed for semantic search
    if (this.embeddingService) {
      this.embeddingService.embedAndStore(
        effectiveUserId(context),
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

  private async recallMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const key = input.key as string | undefined;

    if (!key || typeof key !== 'string') {
      return {
        success: false,
        error: 'Missing required field "key" for recall action',
      };
    }

    // Search across all linked user IDs for cross-platform access
    let entry: Awaited<ReturnType<typeof this.memoryRepo.recall>>;
    for (const uid of allUserIds(context)) {
      entry = await this.memoryRepo.recall(uid, key);
      if (entry) break;
    }

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

  private async searchMemories(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const query = input.query as string | undefined;

    if (!query || typeof query !== 'string') {
      return {
        success: false,
        error: 'Missing required field "query" for search action',
      };
    }

    // Search across all linked user IDs for cross-platform access
    const seen = new Set<string>();
    const entries: Awaited<ReturnType<typeof this.memoryRepo.search>> = [];
    for (const uid of allUserIds(context)) {
      for (const e of await this.memoryRepo.search(uid, query)) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          entries.push(e);
        }
      }
    }

    return {
      success: true,
      data: entries,
      display:
        entries.length === 0
          ? `No memories matching "${query}".`
          : `Found ${entries.length} memory(ies):\n${entries.map((e) => `- ${e.key}: "${e.value}"`).join('\n')}`,
    };
  }

  private async listMemories(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const category = input.category as string | undefined;

    // List across all linked user IDs for cross-platform access
    const seen = new Set<string>();
    const entries: Awaited<ReturnType<typeof this.memoryRepo.listAll>> = [];
    for (const uid of allUserIds(context)) {
      const items = category && typeof category === 'string'
        ? await this.memoryRepo.listByCategory(uid, category)
        : await this.memoryRepo.listAll(uid);
      for (const e of items) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          entries.push(e);
        }
      }
    }

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

  private async deleteMemory(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const key = input.key as string | undefined;

    if (!key || typeof key !== 'string') {
      return {
        success: false,
        error: 'Missing required field "key" for delete action',
      };
    }

    // Try deleting across all linked user IDs (old data may be under platform ID)
    let deleted = false;
    for (const uid of allUserIds(context)) {
      if (await this.memoryRepo.delete(uid, key)) {
        deleted = true;
        break;
      }
    }

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

    // Search across all linked user IDs for cross-platform access
    const seen = new Set<string>();
    const results: { key: string; value: string; category: string; score: number }[] = [];
    for (const uid of allUserIds(context)) {
      for (const r of await this.embeddingService.semanticSearch(uid, query, 10)) {
        if (!seen.has(r.key)) {
          seen.add(r.key);
          results.push(r);
        }
      }
    }

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
