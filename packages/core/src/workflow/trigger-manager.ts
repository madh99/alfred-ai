import type { Logger } from 'pino';
import type { WorkflowRepository } from '@alfred/storage';
import type { WorkflowGuard } from '@alfred/types';
import type { GuardEvaluator } from './guard-evaluator.js';
import { matchesCron } from '@alfred/types';

type RunWorkflowFn = (workflowId: string, triggerData: Record<string, unknown>) => Promise<unknown>;

export class TriggerManager {
  private timer?: ReturnType<typeof setInterval>;
  private webhookMap = new Map<string, string>();

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly guardEvaluator: GuardEvaluator,
    private readonly runWorkflow: RunWorkflowFn,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err }, 'TriggerManager tick error'));
    }, 60_000);
    this.logger.info('Workflow TriggerManager started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    let workflows: Awaited<ReturnType<WorkflowRepository['listTriggered']>>;
    try {
      workflows = await this.workflowRepo.listTriggered();
    } catch {
      return;
    }

    const now = new Date();
    for (const wf of workflows) {
      try {
        const triggerType = wf.triggerType as string;
        const triggerConfig = wf.triggerConfig as Record<string, unknown> | undefined;
        if (triggerType === 'manual') continue;

        let shouldRun = false;

        if (triggerType === 'cron') {
          const cronExpr = (triggerConfig?.value as string) ?? (triggerConfig?.cron as string);
          if (cronExpr) {
            shouldRun = matchesCron(cronExpr, now);
            // Prevent double-fire within the same minute
            if (shouldRun && wf.lastTriggeredAt) {
              if (now.getTime() - new Date(wf.lastTriggeredAt).getTime() < 60_000) {
                shouldRun = false;
              }
            }
          }
        } else if (triggerType === 'interval') {
          const intervalMin = parseInt(String(triggerConfig?.value ?? triggerConfig?.minutes ?? '30'), 10);
          const intervalMs = intervalMin * 60_000;
          const lastRun = wf.lastTriggeredAt ? new Date(wf.lastTriggeredAt).getTime() : 0;
          shouldRun = (now.getTime() - lastRun) >= intervalMs;
        }
        // webhook, watch, mqtt are push-based, not polled here

        if (!shouldRun) continue;

        // Evaluate guards
        const guards = (wf.guards ?? []) as WorkflowGuard[];
        if (guards.length > 0) {
          const pass = await this.guardEvaluator.evaluateAll(guards);
          if (!pass) {
            this.logger.debug({ workflowId: wf.id, name: wf.name }, 'Trigger skipped (guard failed)');
            continue;
          }
        }

        this.logger.info({ workflowId: wf.id, name: wf.name, trigger: triggerType }, 'Workflow triggered');
        await this.workflowRepo.updateTriggerState(wf.id, now.toISOString());
        this.runWorkflow(wf.id, { triggerType, triggeredAt: now.toISOString() }).catch(err =>
          this.logger.warn({ err, workflowId: wf.id }, 'Triggered workflow execution failed'),
        );
      } catch (err) {
        this.logger.warn({ err, workflowId: wf.id }, 'Trigger evaluation failed');
      }
    }
  }

  async onWebhook(name: string, payload: Record<string, unknown>): Promise<void> {
    const workflowId = this.webhookMap.get(name);
    if (!workflowId) return;
    this.logger.info({ webhookName: name, workflowId }, 'Webhook-triggered workflow');
    await this.runWorkflow(workflowId, { triggerType: 'webhook', webhookName: name, body: payload });
  }

  async onWatchTriggered(watchId: string, value: unknown): Promise<void> {
    try {
      const workflows = await this.workflowRepo.listTriggered();
      for (const wf of workflows) {
        const config = wf.triggerConfig as Record<string, unknown> | undefined;
        if (wf.triggerType === 'watch' && (config?.value === watchId || config?.watchId === watchId)) {
          this.logger.info({ workflowId: wf.id, watchId }, 'Watch-triggered workflow');
          await this.workflowRepo.updateTriggerState(wf.id, new Date().toISOString());
          this.runWorkflow(wf.id, { triggerType: 'watch', watchId, watchValue: value }).catch(err =>
            this.logger.warn({ err, workflowId: wf.id }, 'Watch-triggered workflow failed'),
          );
        }
      }
    } catch (err) {
      this.logger.warn({ err, watchId }, 'Watch-triggered workflow lookup failed');
    }
  }

  registerWebhook(name: string, workflowId: string): void {
    this.webhookMap.set(name, workflowId);
  }

  deregisterWebhook(name: string): void {
    this.webhookMap.delete(name);
  }
}
