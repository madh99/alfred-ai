import type { Logger } from 'pino';
import type { WatchRepository, WorkflowRepository, AsyncDbAdapter } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform } from '@alfred/types';
import type { ReflectionResult } from './types.js';

export class ActionExecutor {
  constructor(
    private readonly watchRepo: WatchRepository,
    private readonly workflowRepo: WorkflowRepository | undefined,
    private readonly adapter: AsyncDbAdapter | undefined,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    private readonly logger: Logger,
  ) {}

  async execute(results: ReflectionResult[]): Promise<void> {
    const auto = results.filter(r => r.risk === 'auto');
    const proactive = results.filter(r => r.risk === 'proactive');
    const confirm = results.filter(r => r.risk === 'confirm');

    // 1. Auto: execute silently
    for (const result of auto) {
      try {
        await this.executeAction(result);
        this.logger.info({ target: result.target, action: result.action }, 'Reflection: auto action executed');
      } catch (err) {
        this.logger.warn({ err, target: result.target }, 'Reflection: auto action failed');
      }
    }

    // 2. Proactive: execute + notify user
    for (const result of proactive) {
      try {
        await this.executeAction(result);
        await this.notifyUser(`🔄 **Selbst-Optimierung:** ${result.reasoning}`);
        this.logger.info({ target: result.target, action: result.action }, 'Reflection: proactive action executed');
      } catch (err) {
        this.logger.warn({ err, target: result.target }, 'Reflection: proactive action failed');
      }
    }

    // 3. Confirm: send as suggestions only
    if (confirm.length > 0) {
      const lines = confirm.map(r =>
        `- **${r.target.name ?? r.target.type}:** ${r.finding}\n  _${r.reasoning}_`,
      );
      await this.notifyUser(
        `💡 **Alfreds Vorschlag** (Selbstreflexion)\n\n${lines.join('\n\n')}\n\nAntworte wenn du einen Vorschlag umsetzen moechtest.`,
      );
    }

    if (results.length > 0) {
      this.logger.info({ auto: auto.length, proactive: proactive.length, confirm: confirm.length }, 'Reflection: execution complete');
    }
  }

  private async executeAction(result: ReflectionResult): Promise<void> {
    switch (result.target.type) {
      case 'watch':
        if (!result.target.id) return;
        switch (result.action) {
          case 'adjust':
            if (result.params) {
              await this.watchRepo.updateSettings(result.target.id, result.params as any);
            }
            break;
          case 'delete':
            await this.watchRepo.delete(result.target.id);
            break;
          case 'deactivate':
          case 'pause':
            await this.watchRepo.toggle(result.target.id, false);
            break;
        }
        break;
      case 'workflow':
        if (!result.target.id || !this.workflowRepo) return;
        switch (result.action) {
          case 'deactivate':
            await this.workflowRepo.toggle(result.target.id, false);
            break;
          case 'delete':
            await this.workflowRepo.delete(result.target.id);
            break;
        }
        break;
      case 'reminder':
        if (!result.target.id || !this.adapter) return;
        if (result.action === 'delete') {
          await this.adapter.execute('DELETE FROM reminders WHERE id = ?', [result.target.id]);
        }
        break;
    }
  }

  private async notifyUser(message: string): Promise<void> {
    const adapter = this.adapters.get(this.defaultPlatform);
    if (adapter) {
      try { await adapter.sendMessage(this.defaultChatId, message); }
      catch (err) { this.logger.warn({ err }, 'Reflection: failed to notify user'); }
    }
  }
}
