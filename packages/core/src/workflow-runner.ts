import type { Logger } from 'pino';
import type { WorkflowRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { WorkflowChain, SkillContext } from '@alfred/types';
import { resolveTemplatesInObject } from './template-resolver.js';
import type { ActivityLogger } from './activity-logger.js';
import type { SkillHealthTracker } from './skill-health-tracker.js';

export interface WorkflowRunResult {
  executionId: string;
  status: 'completed' | 'failed' | 'partial';
  stepsCompleted: number;
  totalSteps: number;
  stepResults: Array<{ skillName: string; success: boolean; data?: unknown; error?: string }>;
  error?: string;
}

export class WorkflowRunner {
  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
    private readonly healthTracker?: SkillHealthTracker,
  ) {}

  async run(
    chain: WorkflowChain,
    context: SkillContext,
    initialData?: Record<string, unknown>,
  ): Promise<WorkflowRunResult> {
    const execution = this.workflowRepo.createExecution(chain.id, chain.steps.length);
    const stepResults: Array<{ skillName: string; success: boolean; data?: unknown; error?: string }> = [];
    let lastStepData: unknown = initialData ?? {};

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];

      // Check skill health
      if (this.healthTracker?.isDisabled(step.skillName)) {
        const errMsg = `Skill "${step.skillName}" is temporarily disabled`;
        if (step.onError === 'skip') {
          stepResults.push({ skillName: step.skillName, success: false, error: errMsg });
          continue;
        }
        // stop or retry → fail
        this.finishExecution(execution.id, 'failed', i, stepResults, errMsg);
        return { executionId: execution.id, status: 'failed', stepsCompleted: i, totalSteps: chain.steps.length, stepResults, error: errMsg };
      }

      const skill = this.skillRegistry.get(step.skillName);
      if (!skill) {
        const errMsg = `Skill "${step.skillName}" not found`;
        if (step.onError === 'skip') {
          stepResults.push({ skillName: step.skillName, success: false, error: errMsg });
          continue;
        }
        this.finishExecution(execution.id, 'failed', i, stepResults, errMsg);
        return { executionId: execution.id, status: 'failed', stepsCompleted: i, totalSteps: chain.steps.length, stepResults, error: errMsg };
      }

      // Resolve input mapping
      const templateCtx: Record<string, unknown> = {
        prev: lastStepData,
        steps: stepResults.map(r => r.data),
      };
      if (initialData) templateCtx.trigger = initialData;

      const resolvedInput = resolveTemplatesInObject(step.inputMapping, templateCtx);

      // Execute with retries
      const maxAttempts = step.onError === 'retry' ? (step.maxRetries ?? 1) + 1 : 1;
      let lastError: string | undefined;
      let stepSucceeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await this.skillSandbox.execute(skill, resolvedInput, context);
          if (result.success) {
            lastStepData = result.data;
            stepResults.push({ skillName: step.skillName, success: true, data: result.data });
            this.healthTracker?.recordSuccess(step.skillName);
            stepSucceeded = true;
            break;
          } else {
            lastError = result.error ?? 'Unknown error';
            this.healthTracker?.recordFailure(step.skillName, lastError);
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.healthTracker?.recordFailure(step.skillName, lastError);
        }
      }

      if (!stepSucceeded) {
        stepResults.push({ skillName: step.skillName, success: false, error: lastError });
        // On skip: don't update lastStepData — next step sees previous successful step's data
        if (step.onError === 'skip') {
          continue;
        }

        // stop (or retry exhausted)
        const status = i > 0 ? 'partial' : 'failed';
        this.finishExecution(execution.id, status, i, stepResults, lastError);
        this.logWorkflow(chain, execution.id, status, i, lastError);
        return { executionId: execution.id, status, stepsCompleted: i, totalSteps: chain.steps.length, stepResults, error: lastError };
      }

      // Update progress
      this.workflowRepo.updateExecution(execution.id, {
        stepsCompleted: i + 1,
        stepResults: JSON.stringify(stepResults),
      });
    }

    this.finishExecution(execution.id, 'completed', chain.steps.length, stepResults);
    this.logWorkflow(chain, execution.id, 'completed', chain.steps.length);
    return { executionId: execution.id, status: 'completed', stepsCompleted: chain.steps.length, totalSteps: chain.steps.length, stepResults };
  }

  private finishExecution(
    id: string,
    status: 'completed' | 'failed' | 'partial',
    stepsCompleted: number,
    stepResults: unknown[],
    error?: string,
  ): void {
    this.workflowRepo.updateExecution(id, {
      status,
      stepsCompleted,
      stepResults: JSON.stringify(stepResults),
      error,
      completedAt: new Date().toISOString(),
    });
  }

  private logWorkflow(
    chain: WorkflowChain,
    executionId: string,
    status: string,
    stepsCompleted: number,
    error?: string,
  ): void {
    this.activityLogger?.logWorkflowExec({
      chainId: chain.id,
      chainName: chain.name,
      executionId,
      platform: chain.platform,
      chatId: chain.chatId,
      userId: chain.userId,
      outcome: status === 'completed' ? 'success' : 'error',
      error,
      details: { stepsCompleted, totalSteps: chain.steps.length },
    });
  }
}
