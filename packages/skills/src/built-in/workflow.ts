import type { SkillMetadata, SkillContext, SkillResult, WorkflowStep } from '@alfred/types';
import { Skill } from '../skill.js';
import type { WorkflowRepository } from '@alfred/storage';
import { effectiveUserId, allUserIds } from '../user-utils.js';

type WorkflowAction = 'create' | 'list' | 'run' | 'delete' | 'history' | 'create_from_prompt' | 'activate' | 'dry_run';

/** Minimal interface to avoid circular dependency with @alfred/core */
interface WorkflowRunnerInterface {
  run(chain: import('@alfred/types').WorkflowChain, context: import('@alfred/types').SkillContext, initialData?: Record<string, unknown>): Promise<{
    executionId: string;
    status: 'completed' | 'failed' | 'partial';
    stepsCompleted: number;
    totalSteps: number;
    stepResults: Array<{ skillName: string; success: boolean; data?: unknown; error?: string }>;
    error?: string;
  }>;
}

/** Minimal interface for PromptParser to avoid circular dependency */
interface PromptParserInterface {
  parse(userPrompt: string): Promise<{
    name: string;
    description: string;
    triggerType: string;
    triggerConfig?: Record<string, unknown>;
    guards?: import('@alfred/types').WorkflowGuard[];
    steps: import('@alfred/types').WorkflowStep[];
  } | null>;
}

export class WorkflowSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'workflow',
    category: 'automation',
    description:
      'Create and manage multi-step workflows (skill chains). ' +
      'Use "create" to define a workflow with sequential steps. ' +
      'Each step runs a skill and can pass data to the next via {{prev.field}} or {{steps.0.field}} templates. ' +
      'Use "run" to execute a workflow, "list" to see all workflows, "delete" to remove, "history" to see recent executions.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 300_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'run', 'delete', 'history', 'create_from_prompt', 'activate', 'dry_run'],
          description: 'Workflow action',
        },
        name: {
          type: 'string',
          description: 'Workflow name (for create)',
        },
        steps: {
          type: 'array',
          description: 'Workflow steps (for create). Action step: { skillName, inputMapping: { paramName: "{{prev.field}}" }, onError: "stop"|"skip"|"retry", jumpTo?: stepIndex|"end" }. Condition step: { type: "condition", condition: { field: "prev.rain", operator: "eq", value: "true" }, then: stepIndex|"end"|null, else: stepIndex|"end"|null, label?: "Regen?" }. Jump targets are 0-based step indices, "end" finishes the workflow, null proceeds to next step.',
          items: {
            type: 'object',
          },
        },
        workflow_id: {
          type: 'string',
          description: 'Workflow ID (for run/delete/history)',
        },
        workflowId: {
          type: 'string',
          description: 'Alias for workflow_id (for activate/dry_run)',
        },
        prompt: {
          type: 'string',
          description: 'Natural language workflow description (for create_from_prompt)',
        },
        triggerData: {
          type: 'object',
          description: 'Optional trigger data (for dry_run)',
        },
      },
      required: ['action'],
    },
  };

  // WorkflowRunner is set after construction (to avoid circular deps)
  private runner?: WorkflowRunnerInterface;
  private promptParser?: PromptParserInterface;

  constructor(private readonly workflowRepo: WorkflowRepository) {
    super();
  }

  setRunner(runner: WorkflowRunnerInterface): void {
    this.runner = runner;
  }

  setPromptParser(parser: PromptParserInterface): void {
    this.promptParser = parser;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as WorkflowAction;
    switch (action) {
      case 'create': return this.createWorkflow(input, context);
      case 'list': return this.listWorkflows(context);
      case 'run': return this.runWorkflow(input, context);
      case 'delete': return this.deleteWorkflow(input, context);
      case 'history': return this.getHistory(input);
      case 'create_from_prompt': return this.createFromPrompt(input, context);
      case 'activate': return this.activateWorkflow(input);
      case 'dry_run': return this.dryRun(input, context);
      default:
        return { success: false, error: `Unknown action: "${String(action)}"` };
    }
  }

  private async createWorkflow(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const name = input.name as string | undefined;
    const steps = input.steps as WorkflowStep[] | undefined;
    if (!name) return { success: false, error: 'Missing required field "name"' };
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return { success: false, error: 'Missing or empty "steps" array' };
    }

    // Validate steps
    const validOperators = ['lt', 'gt', 'lte', 'gte', 'eq', 'neq', 'contains', 'not_contains', 'changed', 'increased', 'decreased'];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.type === 'condition') {
        // Condition step validation
        if (!s.condition || typeof s.condition !== 'object') {
          return { success: false, error: `Step ${i}: condition step missing "condition" object` };
        }
        if (!s.condition.field || typeof s.condition.field !== 'string') {
          return { success: false, error: `Step ${i}: condition.field must be a non-empty string` };
        }
        if (!validOperators.includes(s.condition.operator)) {
          return { success: false, error: `Step ${i}: condition.operator must be one of: ${validOperators.join(', ')}` };
        }
        for (const branch of ['then', 'else'] as const) {
          const target = s[branch];
          if (target !== null && target !== 'end' && (typeof target !== 'number' || target < 0 || target >= steps.length)) {
            return { success: false, error: `Step ${i}: "${branch}" must be null, "end", or a step index (0-${steps.length - 1})` };
          }
        }
      } else if (s.type === 'script') {
        // Script step validation
        if (!s.code || typeof s.code !== 'string') return { success: false, error: `Step ${i}: missing code` };
        if (!['python', 'node', 'bash'].includes(s.language)) return { success: false, error: `Step ${i}: language must be python|node|bash` };
        if (!['stop', 'skip', 'retry'].includes(s.onError)) return { success: false, error: `Step ${i}: onError must be stop|skip|retry` };
      } else if (s.type === 'db_query') {
        // DB query step validation
        if (!s.sql || typeof s.sql !== 'string') return { success: false, error: `Step ${i}: missing sql` };
        if (!['stop', 'skip', 'retry'].includes(s.onError)) return { success: false, error: `Step ${i}: onError must be stop|skip|retry` };
      } else {
        // Action step validation (default)
        const a = s as import('@alfred/types').WorkflowActionStep;
        if (!a.skillName) return { success: false, error: `Step ${i}: missing skillName` };
        if (!a.inputMapping || typeof a.inputMapping !== 'object') {
          return { success: false, error: `Step ${i}: missing inputMapping` };
        }
        if (!['stop', 'skip', 'retry'].includes(a.onError)) {
          return { success: false, error: `Step ${i}: onError must be stop|skip|retry` };
        }
        if (a.jumpTo !== undefined && a.jumpTo !== 'end' && (typeof a.jumpTo !== 'number' || a.jumpTo < 0 || a.jumpTo >= steps.length)) {
          return { success: false, error: `Step ${i}: jumpTo must be "end" or a step index (0-${steps.length - 1})` };
        }
      }
    }

    const chain = await this.workflowRepo.create({
      name,
      userId: effectiveUserId(context),
      chatId: context.chatId,
      platform: context.platform,
      steps,
      triggerType: 'manual',
      enabled: true,
    });

    return {
      success: true,
      data: { workflowId: chain.id, name, stepCount: steps.length },
      display: `Workflow "${name}" erstellt (${chain.id}) mit ${steps.length} Schritten.`,
    };
  }

  private async listWorkflows(context: SkillContext): Promise<SkillResult> {
    const workflows: import('@alfred/types').WorkflowChain[] = [];
    const seen = new Set<string>();
    for (const uid of allUserIds(context)) {
      for (const w of await this.workflowRepo.findByUser(uid)) {
        if (!seen.has(w.id)) { seen.add(w.id); workflows.push(w); }
      }
    }

    if (workflows.length === 0) {
      return { success: true, data: [], display: 'Keine Workflows vorhanden.' };
    }

    const lines = workflows.map(w =>
      `- ${w.enabled ? '\u2705' : '\u23F8\uFE0F'} ${w.name} (${w.id.slice(0, 8)}) \u2014 ${w.steps.length} Schritte, Trigger: ${w.triggerType}`,
    );

    return {
      success: true,
      data: workflows.map(w => ({ id: w.id, name: w.name, steps: w.steps.length, triggerType: w.triggerType, enabled: w.enabled })),
      display: `Workflows:\n${lines.join('\n')}`,
    };
  }

  private async runWorkflow(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.runner) {
      return { success: false, error: 'WorkflowRunner not available' };
    }

    const workflowId = input.workflow_id as string | undefined;
    if (!workflowId) return { success: false, error: 'Missing "workflow_id"' };

    const chain = await this.workflowRepo.getById(workflowId);
    if (!chain) return { success: false, error: `Workflow "${workflowId}" not found` };
    if (!chain.enabled) return { success: false, error: `Workflow "${chain.name}" is disabled` };

    const result = await this.runner.run(chain, context);

    const statusIcon = result.status === 'completed' ? '\u2705' : result.status === 'partial' ? '\u26A0\uFE0F' : '\u274C';
    const lines = [`${statusIcon} Workflow "${chain.name}": ${result.status}`];
    lines.push(`Schritte: ${result.stepsCompleted}/${result.totalSteps}`);
    if (result.error) lines.push(`Fehler: ${result.error}`);

    for (let i = 0; i < result.stepResults.length; i++) {
      const sr = result.stepResults[i];
      lines.push(`  ${i + 1}. ${sr.skillName}: ${sr.success ? '\u2705' : '\u274C ' + (sr.error ?? '')}`);
    }

    return {
      success: result.status === 'completed',
      data: result,
      display: lines.join('\n'),
    };
  }

  private async deleteWorkflow(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const workflowId = input.workflow_id as string | undefined;
    if (!workflowId) return { success: false, error: 'Missing "workflow_id"' };

    const chain = await this.workflowRepo.getById(workflowId);
    if (!chain) return { success: false, error: `Workflow "${workflowId}" not found` };

    // Verify ownership
    const userIds = allUserIds(context);
    if (!userIds.includes(chain.userId)) {
      return { success: false, error: 'Not authorized to delete this workflow' };
    }

    await this.workflowRepo.delete(workflowId);
    return { success: true, data: { workflowId }, display: `Workflow "${chain.name}" gel\u00F6scht.` };
  }

  private async getHistory(input: Record<string, unknown>): Promise<SkillResult> {
    const workflowId = input.workflow_id as string | undefined;
    if (!workflowId) return { success: false, error: 'Missing "workflow_id"' };

    const executions = await this.workflowRepo.getRecentExecutions(workflowId);
    if (executions.length === 0) {
      return { success: true, data: [], display: 'Keine Ausf\u00FChrungen vorhanden.' };
    }

    const lines = executions.map(e => {
      const icon = e.status === 'completed' ? '\u2705' : e.status === 'partial' ? '\u26A0\uFE0F' : '\u274C';
      return `- ${icon} ${e.startedAt} \u2014 ${e.stepsCompleted}/${e.totalSteps} Schritte (${e.status})`;
    });

    return {
      success: true,
      data: executions,
      display: `Letzte Ausf\u00FChrungen:\n${lines.join('\n')}`,
    };
  }

  private async createFromPrompt(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const prompt = input.prompt as string;
    if (!prompt) return { success: false, error: 'prompt is required' };
    if (!this.promptParser) return { success: false, error: 'Prompt parser not configured' };
    const parsed = await this.promptParser.parse(prompt);
    if (!parsed) return { success: false, error: 'Could not parse workflow from prompt. Try a more specific description.' };
    // Create workflow but don't activate trigger — needs user confirmation
    const workflow = await this.workflowRepo.create({
      name: parsed.name,
      userId: effectiveUserId(context),
      chatId: context.chatId,
      platform: context.platform,
      steps: parsed.steps,
      triggerType: (parsed.triggerType as any) ?? 'manual',
      triggerConfig: parsed.triggerConfig,
      guards: parsed.guards,
      enabled: false, // Needs "activate" confirmation
    });
    const stepList = parsed.steps.map((s: any, i: number) => `  ${i + 1}. ${s.type ?? 'action'}: ${s.skillName ?? s.language ?? 'condition'}`).join('\n');
    return {
      success: true,
      data: { workflowId: workflow.id, ...parsed },
      display: `Workflow "${parsed.name}" erstellt:\n${parsed.description}\n\nTrigger: ${parsed.triggerType ?? 'manual'}\nSteps:\n${stepList}\n\nNoch NICHT aktiviert. Bestaetige mit: workflow activate ${workflow.id}`,
    };
  }

  private async activateWorkflow(input: Record<string, unknown>): Promise<SkillResult> {
    const wfId = input.workflowId as string ?? input.workflow_id as string ?? input.id as string;
    if (!wfId) return { success: false, error: 'workflowId is required' };
    await this.workflowRepo.update(wfId, { enabled: true });
    return { success: true, data: { workflowId: wfId, activated: true }, display: `Workflow ${wfId} aktiviert — Trigger laeuft.` };
  }

  private async dryRun(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const wfId = input.workflowId as string ?? input.workflow_id as string ?? input.id as string;
    if (!wfId) return { success: false, error: 'workflowId is required' };
    if (!this.runner) return { success: false, error: 'WorkflowRunner not available' };
    const wf = await this.workflowRepo.getById(wfId);
    if (!wf) return { success: false, error: 'Workflow not found' };
    // Execute workflow (full run — dry_run label for clarity)
    const result = await this.runner.run(wf, context, input.triggerData as Record<string, unknown>);
    const stepDisplay = result.stepResults.map((s, i) => `  ${i + 1}. ${s.skillName}: ${s.success ? 'OK' : 'FAIL'}${s.error ? ' — ' + s.error : ''}`).join('\n');
    return {
      success: true,
      data: result,
      display: `Workflow "${wf.name}" ausgefuehrt:\nStatus: ${result.status}\nSteps:\n${stepDisplay}`,
    };
  }
}
