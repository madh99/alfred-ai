import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type { MemoryRepository, MemoryEntry } from '@alfred/storage';

const MERGE_PROMPT = `You are a memory consolidation system. Merge these similar memories into one concise entry.

Memories to merge:
{MEMORIES}

Return a single JSON object with: {"key": "merged_key", "value": "merged concise value", "category": "best_category"}
Return ONLY valid JSON, no explanation.`;

export class MemoryConsolidator {
  constructor(
    private readonly llm: LLMProvider,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Run consolidation for a user:
   * 1. Delete stale low-confidence memories (older than staleDays)
   * 2. Find and merge similar memories via LLM
   */
  async consolidate(
    userId: string,
    staleDays = 60,
    staleMaxConfidence = 0.5,
  ): Promise<{ deleted: number; merged: number }> {
    let deleted = 0;
    let merged = 0;

    // 1. Delete stale memories
    try {
      const stale = await this.memoryRepo.findStale(userId, staleDays, staleMaxConfidence);
      if (stale.length > 0) {
        deleted = await this.memoryRepo.deleteByIds(stale.map(m => m.id));
        this.logger.info({ userId, deleted }, 'Deleted stale memories');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to delete stale memories');
    }

    // 1b. Delete low-confidence rule memories older than 30 days
    try {
      const ruleCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rules = await this.memoryRepo.getByType(userId, 'rule', 100);
      const expiredRules = rules.filter(
        r => r.confidence < 0.3 && r.updatedAt < ruleCutoff,
      );
      if (expiredRules.length > 0) {
        const ruleDeleted = await this.memoryRepo.deleteByIds(expiredRules.map(r => r.id));
        deleted += ruleDeleted;
        this.logger.info(
          { userId, ruleDeleted, keys: expiredRules.map(r => r.key) },
          'Deleted expired low-confidence rules',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to delete expired rules');
    }

    // 2. Find and merge similar memories
    try {
      const allMemories = await this.memoryRepo.listAll(userId);
      const groups = this.findSimilarGroups(allMemories);

      for (const group of groups) {
        try {
          const mergeResult = await this.mergeGroup(group);
          if (mergeResult) {
            // Save merged entry FIRST (keep highest confidence from the group)
            const maxConfidence = Math.max(...group.map(m => m.confidence));
            await this.memoryRepo.saveWithMetadata(
              userId,
              mergeResult.key,
              mergeResult.value,
              mergeResult.category,
              group[0].type,
              maxConfidence,
              'auto',
            );
            // Then delete old entries
            await this.memoryRepo.deleteByIds(group.map(m => m.id));
            merged++;
            this.logger.info(
              { mergedKeys: group.map(m => m.key), newKey: mergeResult.key },
              'Merged similar memories',
            );
          }
        } catch (err) {
          this.logger.warn({ err, keys: group.map(m => m.key) }, 'Failed to merge memory group');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to find similar memories for merging');
    }

    return { deleted, merged };
  }

  /**
   * Find groups of similar memories using Jaccard similarity on key tokens.
   */
  private findSimilarGroups(memories: MemoryEntry[]): MemoryEntry[][] {
    // Filter out protected memories: entity/fact/rule types and manually created memories
    const candidates = memories.filter(
      m => !(m.type === 'entity' || m.type === 'fact' || m.type === 'rule' || m.source === 'manual'),
    );

    const groups: MemoryEntry[][] = [];
    const used = new Set<string>();

    for (let i = 0; i < candidates.length; i++) {
      if (used.has(candidates[i].id)) continue;

      const group = [candidates[i]];
      const tokensA = this.tokenize(candidates[i].key);

      for (let j = i + 1; j < candidates.length; j++) {
        if (used.has(candidates[j].id)) continue;

        const tokensB = this.tokenize(candidates[j].key);
        const similarity = this.jaccardSimilarity(tokensA, tokensB);

        if (similarity >= 0.5) {
          group.push(candidates[j]);
        }
      }

      if (group.length >= 2) {
        for (const m of group) used.add(m.id);
        groups.push(group);
      }
    }

    return groups;
  }

  private tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/[\s_\-]+/).filter(t => t.length >= 2));
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private async mergeGroup(
    group: MemoryEntry[],
  ): Promise<{ key: string; value: string; category: string } | null> {
    const memoriesText = group
      .map(m => `- ${m.key}: ${m.value} [${m.category}]`)
      .join('\n');

    const prompt = MERGE_PROMPT.replace('{MEMORIES}', memoriesText);

    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        tier: 'fast',
        maxTokens: 256,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if (!parsed.key || !parsed.value) return null;

      return {
        key: String(parsed.key),
        value: String(parsed.value),
        category: String(parsed.category || group[0].category),
      };
    } catch (err) {
      this.logger.debug({ err }, 'LLM merge failed');
      return null;
    }
  }
}
