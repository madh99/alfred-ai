import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { RunbookRepository, Runbook, RunbookStatus, RunbookSource } from '@alfred/storage';
import { effectiveUserId } from '../user-utils.js';

type RunbookAction =
  | 'list' | 'get' | 'create' | 'update' | 'delete'
  | 'mark_verified' | 'mark_deprecated' | 'find_matching';

/**
 * RunbookSkill — captured operational procedures (problem → cause → steps → verification).
 *
 * Runbooks are created automatically when:
 *   - An ITSM incident is closed with substantial root_cause + resolution
 *   - A Project-Agent session completes with ≥3 milestones
 *   - A chat-session reflects a problem-resolution pattern (daily LLM scan)
 *
 * They can also be created/edited manually via this skill. Once verified, runbooks
 * are surfaced in the reasoning prompt when matching symptoms appear in active incidents.
 */
export class RunbookSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'runbook',
    category: 'infrastructure',
    description:
      'Manage captured operational procedures (runbooks). Use "list" to browse, "get" by ID, ' +
      '"find_matching" to search by symptom text, "create" to define a new procedure manually, ' +
      '"update" to refine, "mark_verified" once tested, "mark_deprecated" when obsolete. ' +
      'Runbooks are also auto-created from successful incident resolutions and project sessions.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'mark_verified', 'mark_deprecated', 'find_matching'],
        },
        runbook_id: { type: 'string', description: 'Runbook ID (8-char prefix accepted)' },
        title: { type: 'string', description: 'Short descriptive title (for create/update)' },
        symptom: { type: 'string', description: 'When does this runbook apply (observable symptom)' },
        cause: { type: 'string', description: 'Root cause if known' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Numbered steps to resolve' },
        verification: { type: 'string', description: 'How to verify the fix worked' },
        rollback: { type: 'string', description: 'How to rollback if something goes wrong' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: 'Linked CMDB asset IDs' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['draft', 'verified', 'deprecated'] },
        source_type: { type: 'string', enum: ['itsm_incident', 'project_agent', 'chat_session', 'manual'] },
        source_id: { type: 'string', description: 'Reference to spawning event (incident-id, session-id, etc.)' },
        query: { type: 'string', description: 'Symptom keywords for find_matching' },
        limit: { type: 'number' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly repo: RunbookRepository) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const userId = effectiveUserId(context);
    if (!userId) return { success: false, error: 'No user context' };

    const action = input.action as RunbookAction;
    try {
      switch (action) {
        case 'list':         return this.list(userId, input);
        case 'get':          return this.get(userId, input);
        case 'create':       return this.create(userId, input);
        case 'update':       return this.update(userId, input);
        case 'delete':       return this.delete(userId, input);
        case 'mark_verified': return this.update(userId, { ...input, status: 'verified' });
        case 'mark_deprecated': return this.update(userId, { ...input, status: 'deprecated' });
        case 'find_matching': return this.findMatching(userId, input);
        default: return { success: false, error: `Unknown action: ${String(action)}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private renderRunbook(rb: Runbook): string {
    const lines = [
      `## ${rb.title}`,
      `*Status: ${rb.status} · Confidence: ${(rb.confidence * 100).toFixed(0)}% · Used: ${rb.usageCount}× · ID: ${rb.id.slice(0, 8)}*`,
      '',
    ];
    if (rb.symptom) lines.push(`**Symptom:** ${rb.symptom}`);
    if (rb.cause) lines.push(`**Ursache:** ${rb.cause}`);
    if (rb.steps.length > 0) {
      lines.push('', '**Schritte:**');
      rb.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    if (rb.verification) lines.push('', `**Verifikation:** ${rb.verification}`);
    if (rb.rollback) lines.push('', `**Rollback:** ${rb.rollback}`);
    if (rb.tags.length > 0) lines.push('', `*Tags: ${rb.tags.join(', ')}*`);
    if (rb.sourceType) lines.push(`*Quelle: ${rb.sourceType} (${rb.sourceId?.slice(0, 8) ?? '—'})*`);
    return lines.join('\n');
  }

  private async list(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const runbooks = await this.repo.list(userId, {
      status: input.status as RunbookStatus | undefined,
      sourceType: input.source_type as RunbookSource | undefined,
      limit: typeof input.limit === 'number' ? input.limit : 50,
    });
    if (runbooks.length === 0) return { success: true, data: [], display: 'Keine Runbooks gefunden.' };
    const rows = runbooks.map(rb =>
      `| ${rb.id.slice(0, 8)} | ${rb.status} | ${rb.title.slice(0, 60)} | ${rb.usageCount}× | ${rb.updatedAt.slice(0, 10)} |`,
    );
    return {
      success: true, data: runbooks,
      display: `## Runbooks (${runbooks.length})\n\n| ID | Status | Titel | Usage | Updated |\n|----|--------|-------|-------|---------|\n${rows.join('\n')}`,
    };
  }

  private async get(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.runbook_id as string;
    if (!id) return { success: false, error: 'runbook_id required' };
    const rb = await this.repo.getById(userId, id);
    if (!rb) return { success: false, error: `Runbook ${id} not found` };
    await this.repo.incrementUsage(rb.id);
    return { success: true, data: rb, display: this.renderRunbook(rb) };
  }

  private async create(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const title = input.title as string;
    const steps = Array.isArray(input.steps) ? input.steps as string[] : [];
    if (!title || steps.length === 0) {
      return { success: false, error: 'title and non-empty steps required for create' };
    }
    const rb = await this.repo.create(userId, {
      title,
      symptom: input.symptom as string | undefined,
      cause: input.cause as string | undefined,
      steps,
      verification: input.verification as string | undefined,
      rollback: input.rollback as string | undefined,
      sourceType: (input.source_type as RunbookSource | undefined) ?? 'manual',
      sourceId: input.source_id as string | undefined,
      assetIds: Array.isArray(input.asset_ids) ? input.asset_ids as string[] : [],
      tags: Array.isArray(input.tags) ? input.tags as string[] : [],
      status: (input.status as RunbookStatus | undefined) ?? 'draft',
    });
    return { success: true, data: rb, display: `📝 Runbook **${rb.title}** erstellt (ID: ${rb.id.slice(0, 8)})` };
  }

  private async update(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.runbook_id as string;
    if (!id) return { success: false, error: 'runbook_id required' };
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'symptom', 'cause', 'steps', 'verification', 'rollback', 'asset_ids', 'tags', 'status']) {
      if (input[k] !== undefined) {
        const camelKey = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        patch[camelKey] = input[k];
      }
    }
    const rb = await this.repo.update(userId, id, patch as any);
    if (!rb) return { success: false, error: `Runbook ${id} not found` };
    return { success: true, data: rb, display: `✅ Runbook **${rb.title}** aktualisiert (Status: ${rb.status})` };
  }

  private async delete(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const id = input.runbook_id as string;
    if (!id) return { success: false, error: 'runbook_id required' };
    const ok = await this.repo.delete(userId, id);
    return ok
      ? { success: true, display: `🗑️ Runbook ${id} gelöscht` }
      : { success: false, error: `Runbook ${id} not found` };
  }

  private async findMatching(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) return { success: false, error: 'query required for find_matching' };
    const limit = typeof input.limit === 'number' ? input.limit : 5;
    const matches = await this.repo.findMatching(userId, query, limit);
    if (matches.length === 0) return { success: true, data: [], display: `Keine passenden Runbooks für "${query}".` };
    return {
      success: true, data: matches,
      display: `## Passende Runbooks für "${query}" (${matches.length})\n\n` +
        matches.map(rb => `- **[${rb.id.slice(0, 8)}]** ${rb.title} (Status: ${rb.status}, ${rb.usageCount}× verwendet)`).join('\n'),
    };
  }
}
