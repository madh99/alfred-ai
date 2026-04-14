/**
 * PlanningAgent — Autonomous multi-step plan creation and execution.
 *
 * Sits between ReasoningEngine and SkillSandbox. When reasoning detects a
 * multi-step scenario, it proposes a Plan instead of individual actions.
 * The PlanExecutor runs steps sequentially with LLM re-evaluation after each step.
 */
import type { Logger } from 'pino';
import type { Plan, PlanStep, PlanStatus } from '@alfred/types';
import type { PlanRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

interface SkillExecutor {
  execute(skillName: string, params: Record<string, unknown>, userId: string): Promise<{ success: boolean; data?: unknown; display?: string; error?: string }>;
}

interface MessageSender {
  send(userId: string, platform: string, chatId: string, text: string): Promise<void>;
}

const MAX_STEPS = 10;
const MAX_REPLANS = 3;
const CHECKPOINT_TIMEOUT_MS = 4 * 60 * 60_000; // 4h
const PLAN_TIMEOUT_MS = 24 * 60 * 60_000; // 24h

export class PlanningAgent {
  private readonly planRepo: PlanRepository;
  private readonly llm: LLMProvider;
  private readonly skillExecutor: SkillExecutor;
  private readonly logger: Logger;
  private messageSender?: MessageSender;

  constructor(planRepo: PlanRepository, llm: LLMProvider, skillExecutor: SkillExecutor, logger: Logger) {
    this.planRepo = planRepo;
    this.llm = llm;
    this.skillExecutor = skillExecutor;
    this.logger = logger;
  }

  setMessageSender(sender: MessageSender): void { this.messageSender = sender; }

  /**
   * Create a plan from a reasoning proposal.
   * Validates steps, persists, and returns the plan for user approval.
   */
  async createPlan(
    userId: string,
    goal: string,
    steps: PlanStep[],
    triggerSource: Plan['triggerSource'] = 'reasoning',
  ): Promise<Plan> {
    // Validate
    if (steps.length === 0) throw new Error('Plan has no steps');
    if (steps.length > MAX_STEPS) steps = steps.slice(0, MAX_STEPS);

    // Ensure at least 1 checkpoint
    const hasCheckpoint = steps.some(s => s.riskLevel === 'checkpoint');
    if (!hasCheckpoint) {
      // Find the first non-auto step and make it a checkpoint
      const firstNonAuto = steps.find(s => s.riskLevel !== 'auto');
      if (firstNonAuto) firstNonAuto.riskLevel = 'checkpoint';
      else steps[steps.length - 1].riskLevel = 'checkpoint'; // last step as checkpoint
    }

    // Normalize step indices
    steps.forEach((s, i) => { s.index = i; s.status = 'pending'; });

    const plan = await this.planRepo.create({
      userId,
      goal,
      status: 'pending_approval',
      steps,
      currentStepIndex: 0,
      context: {},
      triggerSource,
    });

    this.logger.info({ planId: plan.id, goal, steps: steps.length }, 'Plan created');
    return plan;
  }

  /**
   * Execute a plan step by step.
   * AUTO steps run immediately, CHECKPOINTs pause for user input.
   */
  async executePlan(plan: Plan): Promise<Plan> {
    plan.status = 'running';
    await this.planRepo.update(plan);
    let replans = 0;

    while (plan.currentStepIndex < plan.steps.length) {
      const step = plan.steps[plan.currentStepIndex];

      // Condition check
      if (step.condition) {
        try {
          const met = this.evaluateCondition(step.condition, plan.context);
          if (!met) {
            step.status = 'skipped';
            this.logger.info({ planId: plan.id, step: step.index, condition: step.condition }, 'Step skipped (condition not met)');
            plan.currentStepIndex++;
            await this.planRepo.update(plan);
            continue;
          }
        } catch { /* condition eval failed — execute step anyway */ }
      }

      // Checkpoint → pause
      if (step.riskLevel === 'checkpoint') {
        step.status = 'waiting_approval';
        plan.status = 'paused_at_checkpoint';
        await this.planRepo.update(plan);
        this.logger.info({ planId: plan.id, step: step.index, description: step.description }, 'Plan paused at checkpoint');
        return plan;
      }

      // Execute step
      step.status = 'running';
      await this.planRepo.update(plan);

      try {
        const params = this.resolveTemplates(step.skillParams, plan.context);
        const result = await this.skillExecutor.execute(step.skillName, params, plan.userId);

        if (result.success) {
          step.result = (result.data as Record<string, unknown>) ?? {};
          step.status = 'completed';
          plan.context[`step_${step.index}`] = { ...step.result, display: result.display };
          this.logger.info({ planId: plan.id, step: step.index, skill: step.skillName }, 'Step completed');
        } else {
          throw new Error(result.error ?? 'Skill execution failed');
        }
      } catch (err) {
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        this.logger.warn({ planId: plan.id, step: step.index, error: step.error }, 'Step failed');

        if (step.onFailure === 'stop') {
          plan.status = 'failed';
          await this.planRepo.update(plan);
          return plan;
        }
        if (step.onFailure === 'replan' && replans < MAX_REPLANS) {
          replans++;
          await this.adaptPlan(plan);
        }
        // skip or retry-then-skip
      }

      // Notify on proactive steps
      if (step.riskLevel === 'proactive' && step.status === 'completed') {
        // Notification handled by caller
      }

      plan.currentStepIndex++;
      await this.planRepo.update(plan);

      // LLM re-evaluation (every 3 steps, not on every step to save tokens)
      if (plan.currentStepIndex < plan.steps.length && plan.currentStepIndex % 3 === 0 && replans < MAX_REPLANS) {
        const adapted = await this.shouldAdapt(plan);
        if (adapted) {
          replans++;
          await this.adaptPlan(plan);
        }
      }
    }

    plan.status = 'completed';
    plan.completedAt = new Date().toISOString();
    await this.planRepo.update(plan);
    this.logger.info({ planId: plan.id, goal: plan.goal }, 'Plan completed');
    return plan;
  }

  /**
   * Resume a plan after checkpoint approval.
   */
  async resumeFromCheckpoint(plan: Plan): Promise<Plan> {
    if (plan.status !== 'paused_at_checkpoint') return plan;

    const step = plan.steps[plan.currentStepIndex];
    if (step.status === 'waiting_approval') {
      // Execute the checkpoint step now (user approved)
      step.riskLevel = 'proactive'; // downgrade so it executes
      step.status = 'pending';
    }

    return this.executePlan(plan);
  }

  /**
   * Skip a checkpoint step and continue.
   */
  async skipCheckpoint(plan: Plan): Promise<Plan> {
    if (plan.status !== 'paused_at_checkpoint') return plan;
    const step = plan.steps[plan.currentStepIndex];
    step.status = 'skipped';
    plan.currentStepIndex++;
    plan.status = 'running';
    return this.executePlan(plan);
  }

  /**
   * Cancel a plan.
   */
  async cancelPlan(plan: Plan): Promise<Plan> {
    plan.status = 'cancelled';
    plan.completedAt = new Date().toISOString();
    await this.planRepo.update(plan);
    return plan;
  }

  /**
   * Build a display string for the plan.
   */
  formatPlan(plan: Plan): string {
    const statusIcon = (s: PlanStep): string => {
      switch (s.status) {
        case 'completed': return '✅';
        case 'failed': return '❌';
        case 'skipped': return '⏭️';
        case 'running': return '🔄';
        case 'waiting_approval': return '⏸️';
        default: return s.riskLevel === 'checkpoint' ? '⚠️' : s.riskLevel === 'proactive' ? '🔔' : '⬜';
      }
    };

    const lines = [`📋 **Plan: ${plan.goal}**`, `Status: ${plan.status}`, ''];
    for (const step of plan.steps) {
      lines.push(`${statusIcon(step)} ${step.index + 1}. ${step.description}`);
      if (step.error) lines.push(`   ❌ ${step.error}`);
      if (step.result?.display) lines.push(`   → ${String(step.result.display).slice(0, 100)}`);
    }
    return lines.join('\n');
  }

  /**
   * Get active plans summary for reasoning context.
   */
  async getContextSummary(userId: string): Promise<string> {
    const active = await this.planRepo.getActiveByUser(userId);
    if (active.length === 0) return '';
    return active.map(p => {
      const completed = p.steps.filter(s => s.status === 'completed').length;
      const statusDetail = p.status === 'paused_at_checkpoint'
        ? `pausiert: Checkpoint "${p.steps[p.currentStepIndex]?.description}"`
        : `Schritt ${p.currentStepIndex + 1}/${p.steps.length}`;
      return `- "${p.goal}" (${p.status}, ${completed}/${p.steps.length} erledigt, ${statusDetail})`;
    }).join('\n');
  }

  // ── Private helpers ──────────────────────────────────────

  private resolveTemplates(params: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        resolved[key] = value.replace(/\{\{(.*?)\}\}/g, (_match, path) => {
          const parts = path.trim().split('.');
          let current: unknown = context;
          for (const part of parts) {
            const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (bracketMatch) {
              current = (current as Record<string, unknown>)?.[bracketMatch[1]];
              current = (current as unknown[])?.[parseInt(bracketMatch[2])];
            } else {
              current = (current as Record<string, unknown>)?.[part];
            }
          }
          return current !== undefined ? String(current) : `{{${path}}}`;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  private evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
    // Simple condition evaluation: "step_0.result.soc < 70"
    try {
      const resolved = condition.replace(/step_(\d+)\.(\w+(?:\.\w+)*)/g, (_m, idx, path) => {
        let val: unknown = context[`step_${idx}`];
        for (const p of path.split('.')) val = (val as Record<string, unknown>)?.[p];
        return JSON.stringify(val);
      });
      // eslint-disable-next-line no-eval
      return Boolean(new Function('return ' + resolved)());
    } catch {
      return true; // on error, execute the step
    }
  }

  private async shouldAdapt(plan: Plan): Promise<boolean> {
    try {
      const completedSteps = plan.steps
        .filter(s => s.status === 'completed')
        .map(s => `Schritt ${s.index + 1} (${s.description}): ${JSON.stringify(s.result).slice(0, 150)}`)
        .join('\n');
      const remainingSteps = plan.steps
        .filter(s => s.status === 'pending')
        .map(s => `Schritt ${s.index + 1}: ${s.description}`)
        .join('\n');

      const prompt = `Plan "${plan.goal}" — soll angepasst werden?

Erledigte Schritte:
${completedSteps}

Verbleibende Schritte:
${remainingSteps}

Sind die verbleibenden Schritte noch sinnvoll? Antworte NUR als JSON: {"adapt": false} oder {"adapt": true, "reason": "..."}`;

      const res = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], tier: 'fast', maxTokens: 100 });
      const json = JSON.parse(res.content.match(/\{.*\}/s)?.[0] ?? '{"adapt":false}');
      return json.adapt === true;
    } catch {
      return false;
    }
  }

  private async adaptPlan(plan: Plan): Promise<void> {
    this.logger.info({ planId: plan.id }, 'Adapting plan based on intermediate results');
    // For now, just log — full re-planning would require another LLM call
    // to regenerate remaining steps. This is a future enhancement.
  }
}
