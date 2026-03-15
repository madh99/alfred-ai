import type { Logger } from 'pino';
import type { WorkflowRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { WorkflowChain, WorkflowActionStep, WorkflowConditionStep, SkillContext } from '@alfred/types';
import { resolveTemplatesInObject } from './template-resolver.js';
import { evaluateWorkflowCondition } from './workflow-condition-evaluator.js';
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
    let currentIndex = 0;
    let visitedCount = 0;
    const visitCount = new Map<number, number>();
    const maxVisits = chain.steps.length + 2; // cycle guard

    while (currentIndex < chain.steps.length) {
      // Cycle guard
      const visits = (visitCount.get(currentIndex) ?? 0) + 1;
      visitCount.set(currentIndex, visits);
      if (visits > maxVisits) {
        const errMsg = `Workflow cycle detected at step ${currentIndex} (visited ${visits} times)`;
        this.finishExecution(execution.id, 'failed', visitedCount, stepResults, errMsg);
        this.logWorkflow(chain, execution.id, 'failed', visitedCount, errMsg);
        return { executionId: execution.id, status: 'failed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: errMsg };
      }

      const step = chain.steps[currentIndex];
      visitedCount++;

      // ── Condition step ──────────────────────────────────────────
      if (step.type === 'condition') {
        const condStep = step as WorkflowConditionStep;
        const templateCtx: Record<string, unknown> = {
          prev: lastStepData,
          steps: stepResults.map(r => r.data),
        };
        if (initialData) templateCtx.trigger = initialData;

        const conditionMet = evaluateWorkflowCondition(condStep.condition, templateCtx);
        const branch = conditionMet ? 'then' : 'else';
        const target = conditionMet ? condStep.then : condStep.else;

        stepResults.push({
          skillName: condStep.label ?? '__condition__',
          success: true,
          data: { branch, field: condStep.condition.field, conditionMet, target },
        });

        this.logger.debug({
          workflowId: chain.id, step: currentIndex, branch, target,
          field: condStep.condition.field, conditionMet,
        }, 'Workflow condition evaluated');

        if (target === 'end') {
          this.finishExecution(execution.id, 'completed', visitedCount, stepResults);
          this.logWorkflow(chain, execution.id, 'completed', visitedCount);
          return { executionId: execution.id, status: 'completed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults };
        } else if (typeof target === 'number') {
          if (target < 0 || target >= chain.steps.length) {
            const errMsg = `Condition step ${currentIndex}: jump target ${target} is out of range (0-${chain.steps.length - 1})`;
            this.finishExecution(execution.id, 'failed', visitedCount, stepResults, errMsg);
            return { executionId: execution.id, status: 'failed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: errMsg };
          }
          currentIndex = target;
        } else {
          // null → next step
          currentIndex++;
        }

        // Update progress
        this.workflowRepo.updateExecution(execution.id, {
          stepsCompleted: visitedCount,
          stepResults: JSON.stringify(stepResults),
        });
        continue;
      }

      // ── Action step ─────────────────────────────────────────────
      const actionStep = step as WorkflowActionStep;

      // Check skill health
      if (this.healthTracker?.isDisabled(actionStep.skillName)) {
        const errMsg = `Skill "${actionStep.skillName}" is temporarily disabled`;
        if (actionStep.onError === 'skip') {
          stepResults.push({ skillName: actionStep.skillName, success: false, error: errMsg });
          currentIndex++;
          continue;
        }
        const status = visitedCount > 1 ? 'partial' : 'failed';
        this.finishExecution(execution.id, status, visitedCount, stepResults, errMsg);
        return { executionId: execution.id, status, stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: errMsg };
      }

      const skill = this.skillRegistry.get(actionStep.skillName);
      if (!skill) {
        const errMsg = `Skill "${actionStep.skillName}" not found`;
        if (actionStep.onError === 'skip') {
          stepResults.push({ skillName: actionStep.skillName, success: false, error: errMsg });
          currentIndex++;
          continue;
        }
        const status = visitedCount > 1 ? 'partial' : 'failed';
        this.finishExecution(execution.id, status, visitedCount, stepResults, errMsg);
        return { executionId: execution.id, status, stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: errMsg };
      }

      // Resolve input mapping
      const templateCtx: Record<string, unknown> = {
        prev: lastStepData,
        steps: stepResults.map(r => r.data),
      };
      if (initialData) templateCtx.trigger = initialData;

      const resolvedInput = resolveTemplatesInObject(actionStep.inputMapping, templateCtx);

      // Execute with retries
      const maxAttempts = actionStep.onError === 'retry' ? (actionStep.maxRetries ?? 1) + 1 : 1;
      let lastError: string | undefined;
      let stepSucceeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await this.skillSandbox.execute(skill, resolvedInput, context);
          if (result.success) {
            lastStepData = result.data;
            stepResults.push({ skillName: actionStep.skillName, success: true, data: result.data });
            this.healthTracker?.recordSuccess(actionStep.skillName);
            stepSucceeded = true;
            break;
          } else {
            lastError = result.error ?? 'Unknown error';
            this.healthTracker?.recordFailure(actionStep.skillName, lastError);
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.healthTracker?.recordFailure(actionStep.skillName, lastError);
        }
      }

      if (!stepSucceeded) {
        stepResults.push({ skillName: actionStep.skillName, success: false, error: lastError });
        if (actionStep.onError === 'skip') {
          currentIndex++;
          continue;
        }
        // stop (or retry exhausted)
        const status = visitedCount > 1 ? 'partial' : 'failed';
        this.finishExecution(execution.id, status, visitedCount, stepResults, lastError);
        this.logWorkflow(chain, execution.id, status, visitedCount, lastError);
        return { executionId: execution.id, status, stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: lastError };
      }

      // Update progress
      this.workflowRepo.updateExecution(execution.id, {
        stepsCompleted: visitedCount,
        stepResults: JSON.stringify(stepResults),
      });

      // Handle jumpTo on action step
      if (actionStep.jumpTo === 'end') {
        this.finishExecution(execution.id, 'completed', visitedCount, stepResults);
        this.logWorkflow(chain, execution.id, 'completed', visitedCount);
        return { executionId: execution.id, status: 'completed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults };
      } else if (typeof actionStep.jumpTo === 'number') {
        if (actionStep.jumpTo < 0 || actionStep.jumpTo >= chain.steps.length) {
          const errMsg = `Action step ${currentIndex}: jumpTo ${actionStep.jumpTo} is out of range`;
          this.finishExecution(execution.id, 'failed', visitedCount, stepResults, errMsg);
          return { executionId: execution.id, status: 'failed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults, error: errMsg };
        }
        currentIndex = actionStep.jumpTo;
      } else {
        currentIndex++;
      }
    }

    this.finishExecution(execution.id, 'completed', visitedCount, stepResults);
    this.logWorkflow(chain, execution.id, 'completed', visitedCount);
    return { executionId: execution.id, status: 'completed', stepsCompleted: visitedCount, totalSteps: chain.steps.length, stepResults };
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
