import type { Logger } from 'pino';
import type { WorkflowRepository, ActivityRepository } from '@alfred/storage';
import type { ReflectionResult } from './types.js';

type WorkflowConfig = {
  staleAfterDays: number;
  failedStepsBeforeSuggest: number;
};

export class WorkflowReflector {
  constructor(
    private readonly workflowRepo: WorkflowRepository | undefined,
    private readonly activityRepo: ActivityRepository,
    private readonly logger: Logger,
    private readonly config: WorkflowConfig,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult[]> {
    if (!this.workflowRepo) return [];

    const results: ReflectionResult[] = [];
    const workflows = await this.workflowRepo.findByUser(userId);
    const now = Date.now();

    for (const wf of workflows) {
      const ageDays = (now - new Date(wf.createdAt).getTime()) / 86400_000;

      // Check recent executions
      let executions;
      try {
        executions = await this.workflowRepo.getRecentExecutions(wf.id, 10);
      } catch {
        this.logger.debug({ workflowId: wf.id }, 'Could not query workflow executions');
        continue;
      }

      // 1. Workflow never run + age > staleAfterDays → suggest cleanup/review
      if (executions.length === 0 && ageDays > this.config.staleAfterDays) {
        results.push({
          target: { type: 'workflow', id: wf.id, name: wf.name },
          finding: `Workflow "${wf.name}" wurde seit ${Math.round(ageDays)} Tagen nie ausgefuehrt`,
          action: 'suggest',
          risk: 'confirm',
          reasoning: `Workflow existiert seit ${Math.round(ageDays)} Tagen ohne eine einzige Ausfuehrung (Schwellwert: ${this.config.staleAfterDays}). Ueberpruefen ob noch relevant.`,
        });
        continue;
      }

      // 2. Repeated failures in recent executions
      const failures = executions.filter((e) => e.status === 'failed');
      if (failures.length >= this.config.failedStepsBeforeSuggest) {
        results.push({
          target: { type: 'workflow', id: wf.id, name: wf.name },
          finding: `Workflow "${wf.name}" ist ${failures.length}x fehlgeschlagen (letzte 10 Ausfuehrungen)`,
          action: 'suggest',
          risk: 'confirm',
          reasoning: `${failures.length} fehlgeschlagene Ausfuehrungen in den letzten 10 Runs (Schwellwert: ${this.config.failedStepsBeforeSuggest}). Workflow sollte ueberarbeitet werden.`,
        });
      }
    }

    return results;
  }
}
