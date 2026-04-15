import type { Logger } from 'pino';
import type { WatchRepository, ActivityRepository } from '@alfred/storage';
import type { ReflectionResult, ReflectionConfig } from './types.js';

type WatchConfig = {
  staleAfterDays: number;
  deleteAfterDays: number;
  maxTriggersPerDay: number;
  ignoredAlertsBeforePause: number;
  failedActionsBeforeDisable: number;
};

export class WatchReflector {
  constructor(
    private readonly watchRepo: WatchRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly logger: Logger,
    private readonly config: WatchConfig,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult[]> {
    const results: ReflectionResult[] = [];
    // Use getEnabled() since there's no user-scoped listAll
    const watches = await this.watchRepo.getEnabled();
    const now = Date.now();

    for (const watch of watches) {
      const ageDays = (now - new Date(watch.createdAt).getTime()) / 86400_000;
      const lastTriggerDays = watch.lastTriggeredAt
        ? (now - new Date(watch.lastTriggeredAt).getTime()) / 86400_000
        : ageDays;

      // 1. Never triggered or stale for too long → delete
      if (lastTriggerDays >= this.config.deleteAfterDays) {
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" hat seit ${Math.round(lastTriggerDays)} Tagen nicht getriggert`,
          action: 'delete',
          risk: 'proactive',
          reasoning: `Kein Trigger seit ${Math.round(lastTriggerDays)} Tagen (Schwellwert: ${this.config.deleteAfterDays}). Watch wird geloescht.`,
        });
        continue;
      }

      // 2. Stale → adjust (double interval, max 24h)
      if (lastTriggerDays >= this.config.staleAfterDays) {
        const newInterval = Math.min((watch.intervalMinutes ?? 30) * 2, 1440);
        results.push({
          target: { type: 'watch', id: watch.id, name: watch.name },
          finding: `Watch "${watch.name}" hat seit ${Math.round(lastTriggerDays)} Tagen nicht getriggert`,
          action: 'adjust',
          params: { intervalMinutes: newInterval },
          risk: 'auto',
          reasoning: `Kein Trigger seit ${Math.round(lastTriggerDays)} Tagen. Intervall von ${watch.intervalMinutes ?? 30}min auf ${newInterval}min erhoeht.`,
        });
        continue;
      }

      // 3. Triggering too often (last 24h)
      try {
        const since = new Date(now - 86400_000).toISOString();
        const triggers = await this.activityRepo.query({
          eventType: 'watch_trigger',
          since,
          limit: 200,
        });
        const watchTriggers = triggers.filter(
          (t) => t.action === watch.id || t.action === watch.name,
        );
        if (watchTriggers.length > this.config.maxTriggersPerDay) {
          const newCooldown = Math.max(
            (watch as any).cooldownMinutes ?? 0,
            60,
          );
          results.push({
            target: { type: 'watch', id: watch.id, name: watch.name },
            finding: `Watch "${watch.name}" triggert zu oft (${watchTriggers.length}x in 24h)`,
            action: 'adjust',
            params: { cooldownMinutes: newCooldown },
            risk: 'auto',
            reasoning: `${watchTriggers.length} Trigger in 24h (Schwellwert: ${this.config.maxTriggersPerDay}). Cooldown auf ${newCooldown}min gesetzt.`,
          });
        }
      } catch {
        this.logger.debug(
          { watchId: watch.id },
          'Could not query watch triggers',
        );
      }

      // 4. Failed actions (last 7 days)
      try {
        const since = new Date(now - 7 * 86400_000).toISOString();
        const actions = await this.activityRepo.query({
          eventType: 'watch_action',
          since,
          limit: 50,
        });
        const watchActions = actions.filter(
          (t) => t.action === watch.id || t.action === watch.name,
        );
        const failures = watchActions.filter((a) => a.outcome === 'error');
        if (failures.length >= this.config.failedActionsBeforeDisable) {
          results.push({
            target: { type: 'watch', id: watch.id, name: watch.name },
            finding: `Watch "${watch.name}" Action fehlgeschlagen ${failures.length}x in 7 Tagen`,
            action: 'deactivate',
            risk: 'proactive',
            reasoning: `${failures.length} fehlgeschlagene Actions (Schwellwert: ${this.config.failedActionsBeforeDisable}). Watch deaktiviert.`,
          });
        }
      } catch {
        this.logger.debug(
          { watchId: watch.id },
          'Could not query watch actions',
        );
      }
    }

    return results;
  }
}
