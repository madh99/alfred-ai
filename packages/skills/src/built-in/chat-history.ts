import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { ConversationRepository } from '@alfred/storage';
import { effectiveUserId } from '../user-utils.js';

/**
 * ChatHistorySkill — full-text search over the user's past conversations.
 *
 * Backed by FTS5 on SQLite or tsvector on Postgres (migration v59/v62). The LLM
 * uses this to recall what was discussed days/weeks/months ago — beyond the
 * conversation summarizer's compressed window.
 *
 * Roles searched by default: user, assistant, tool (so skill display outputs like
 * "BMW SoC: 45%" are searchable too). System messages are excluded as they are
 * mostly internal noise.
 */
export class ChatHistorySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'chat_history',
    category: 'core',
    description:
      'Search past conversations by keyword. Use when the user asks "when did we last talk about X", ' +
      '"what did I say about Y", "show me past discussion of Z", or when reasoning needs historical ' +
      'context beyond the current conversation. Searches user messages, assistant replies, and tool ' +
      'outputs across ALL the user\'s conversations (Telegram, Discord, etc.), ranked by relevance ' +
      'with newer messages weighted higher.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search'], description: 'Action to perform' },
        query: {
          type: 'string',
          description: 'Full-text search query. Plain words work best — the engine tokenizes ' +
            'with diacritics stripped (so "Müller" matches "Muller"). Avoid quotation marks unless ' +
            'searching for a literal phrase.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 50)',
        },
        since_days: {
          type: 'number',
          description: 'Only search messages from the last N days (default: all history)',
        },
        roles: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
          description: 'Which message roles to search. Default: ["user","assistant","tool"]. ' +
            'Use ["user"] alone to find what the user said.',
        },
      },
      required: ['action', 'query'],
    },
  };

  constructor(private readonly conversationRepo: ConversationRepository) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (input.action !== 'search') {
      return { success: false, error: `Unknown action "${String(input.action)}". Valid: search` };
    }
    const query = (input.query as string | undefined)?.trim();
    if (!query || query.length < 2) {
      return { success: false, error: 'query must be at least 2 characters' };
    }

    const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);
    const sinceDays = typeof input.since_days === 'number' && input.since_days > 0
      ? Number(input.since_days)
      : undefined;
    const rolesRaw = Array.isArray(input.roles) ? input.roles as string[] : ['user', 'assistant', 'tool'];
    const validRoles = ['user', 'assistant', 'tool', 'system'] as const;
    const roles = rolesRaw.filter((r): r is typeof validRoles[number] => (validRoles as readonly string[]).includes(r));

    const userId = effectiveUserId(context);
    if (!userId) return { success: false, error: 'No user context — cannot search history' };

    try {
      const results = await this.conversationRepo.searchMessages(userId, query, {
        limit, sinceDays, roles, timeDecay: true,
      });

      if (results.length === 0) {
        return { success: true, data: [], display: `Keine Treffer für "${query}".` };
      }

      const lines = results.map(r => {
        const when = r.createdAt?.slice(0, 16).replace('T', ' ') ?? '';
        const platform = r.platform ?? '';
        const snippet = r.content.length > 200 ? `${r.content.slice(0, 200)}…` : r.content;
        return `**${when}** [${platform}/${r.role}] (score ${r.score.toFixed(2)})\n${snippet}`;
      });

      return {
        success: true,
        data: results,
        display: `Gefunden ${results.length} Treffer für "${query}":\n\n${lines.join('\n\n---\n\n')}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Chat-search failed: ${msg}` };
    }
  }
}
