import type { Logger } from 'pino';
import type { WatchRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, Watch } from '@alfred/types';
import type { UserRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import { extractField, evaluateCondition, evaluateCompositeCondition } from './condition-evaluator.js';
import { resolveTemplates, resolveTemplatesInObject } from './template-resolver.js';
import { buildSkillContext } from './context-factory.js';
import type { ConfirmationQueue } from './confirmation-queue.js';
import type { ActivityLogger } from './activity-logger.js';
import type { SkillHealthTracker } from './skill-health-tracker.js';

const MAX_CHAIN_DEPTH = 5;

const OPERATOR_LABELS: Record<string, string> = {
  lt: '<', gt: '>', lte: '<=', gte: '>=',
  eq: '=', neq: '!=',
  contains: 'contains', not_contains: 'not contains',
  changed: 'changed', increased: 'increased', decreased: 'decreased',
};

export class WatchEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly watchRepo: WatchRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly confirmationQueue?: ConfirmationQueue,
    private readonly activityLogger?: ActivityLogger,
    private readonly skillHealthTracker?: SkillHealthTracker,
    private readonly llmProvider?: LLMProvider,
    private readonly nodeId: string = 'single',
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info('Watch engine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Watch engine stopped');
  }

  /** Trigger a specific watch immediately (used by inbound webhooks). */
  async triggerWatch(watchId: string): Promise<void> {
    const watch = await this.watchRepo.getById(watchId);
    if (!watch) throw new Error(`Watch ${watchId} not found`);
    if (!watch.enabled) throw new Error(`Watch ${watchId} is disabled`);
    const claimed = await this.watchRepo.claimSingle(watchId, this.nodeId);
    if (!claimed) {
      this.logger.debug({ watchId }, 'Watch claim held by another node, skipping webhook trigger');
      return;
    }
    this.logger.info({ watchId, name: watch.name }, 'Watch triggered via webhook');
    await this.checkWatch(watch);
  }

  private async tick(): Promise<void> {
    try {
      const dueWatches = await this.watchRepo.claimDue(this.nodeId);

      for (const watch of dueWatches) {
        try {
          await this.checkWatch(watch);
        } catch (err) {
          this.logger.error({ err, watchId: watch.id }, 'Failed to check watch');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error during watch engine tick');
    }
  }

  private async checkWatch(watch: Watch, chainDepth = 0): Promise<void> {
    const now = new Date().toISOString();
    this.logger.debug({ watchId: watch.id, name: watch.name, skill: watch.skillName }, 'Checking watch');

    // Execute the skill
    const skill = this.skillRegistry.get(watch.skillName);
    if (!skill) {
      this.logger.warn({ watchId: watch.id, skillName: watch.skillName }, 'Unknown skill for watch');
      await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: watch.lastValue });
      return;
    }

    // Skip if poll skill is auto-disabled
    if (this.skillHealthTracker?.isDisabled(watch.skillName)) {
      this.logger.debug({ watchId: watch.id, skillName: watch.skillName }, 'Watch poll skill is auto-disabled, skipping');
      await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: watch.lastValue });
      return;
    }

    // Resolve the user who owns this watch.
    // In DMs, chatId == userId. In groups, chatId is the group ID.
    // Use chatId as platformUserId for DMs (most common case).
    const { context } = await buildSkillContext(this.users, {
      platformUserId: watch.chatId,
      platform: watch.platform as Platform,
      chatId: watch.chatId,
    });

    this.logger.info({ watchId: watch.id, skillName: watch.skillName, skillParams: watch.skillParams, userId: context.userId, masterUserId: context.masterUserId }, '[DEBUG] Watch executing skill');
    const result = await this.skillSandbox.execute(skill, watch.skillParams, context);
    this.logger.info({ watchId: watch.id, success: result.success, error: result.error, hasData: result.data != null, dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data as Record<string,unknown>) : undefined }, '[DEBUG] Watch skill result');

    if (!result.success) {
      this.logger.warn({ watchId: watch.id, error: result.error }, 'Watch skill execution failed');
      this.skillHealthTracker?.recordFailure(watch.skillName, result.error ?? 'Watch poll failed');
      await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: watch.lastValue });
      return;
    }

    this.skillHealthTracker?.recordSuccess(watch.skillName);

    // Evaluate condition(s)
    let triggered: boolean;
    let displayValue: string;
    let newLastValue: string;

    if (watch.compositeCondition) {
      // Composite condition: AND/OR over multiple fields
      let lastValues: Record<string, unknown> | null = null;
      if (watch.lastValue !== null) {
        try {
          const parsed = JSON.parse(watch.lastValue);
          lastValues = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null; // non-object lastValue (e.g. leftover from single-condition) → treat as baseline
        } catch { /* malformed JSON → treat as baseline */ }
      }

      const composite = evaluateCompositeCondition(
        result.data,
        watch.compositeCondition,
        lastValues,
      );

      triggered = composite.triggered;
      newLastValue = JSON.stringify(composite.newLastValues);
      displayValue = Object.entries(composite.displayValues)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    } else {
      // Single condition
      const currentValue = extractField(result.data, watch.condition.field);
      let lastValue: unknown = null;
      if (watch.lastValue !== null) {
        try { lastValue = JSON.parse(watch.lastValue); } catch { /* treat as baseline */ }
      }

      const evalResult = evaluateCondition(
        currentValue,
        watch.condition.operator,
        watch.condition.value,
        lastValue,
      );

      triggered = evalResult.triggered;
      displayValue = evalResult.displayValue;
      newLastValue = JSON.stringify(currentValue);
    }

    if (triggered && this.isCooldownExpired(watch)) {
      const actionMode = watch.actionOnTrigger ?? 'alert';

      // Build template context for {{...}} resolution
      const templateContext: Record<string, unknown> = {
        result: result.data,
        currentValue: displayValue,
        watchName: watch.name,
      };

      // Resolve template variables in action params and message template
      const resolvedParams = watch.actionSkillParams
        ? resolveTemplatesInObject(watch.actionSkillParams as Record<string, unknown>, templateContext)
        : {};
      const resolvedTemplate = watch.messageTemplate
        ? resolveTemplates(watch.messageTemplate, templateContext)
        : undefined;

      // Confirmation gate: enqueue action instead of executing directly
      if (watch.requiresConfirmation && this.confirmationQueue
          && (actionMode === 'action_only' || actionMode === 'alert_and_action') && watch.actionSkillName) {
        await this.confirmationQueue.enqueue({
          chatId: watch.chatId,
          platform: watch.platform,
          source: 'watch',
          sourceId: watch.id,
          description: `Watch "${watch.name}": ${watch.actionSkillName} ausf\u00FChren`,
          skillName: watch.actionSkillName,
          skillParams: resolvedParams,
        });

        // Still send alert if mode includes it
        if (actionMode === 'alert_and_action') {
          let alertText = await this.buildAlertText(watch, displayValue, result.data, resolvedTemplate);

          alertText += '\n\n(Aktion wartet auf Best\u00E4tigung)';

          const adapter = this.adapters.get(watch.platform as Platform);
          if (adapter) {
            try { await adapter.sendMessage(watch.chatId, alertText); } catch (err) {
              this.logger.error({ err, watchId: watch.id, chatId: watch.chatId }, 'Failed to send watch alert message');
            }
          }
        }

        await this.watchRepo.updateAfterCheck(watch.id, {
          lastCheckedAt: now,
          lastValue: newLastValue,
          lastTriggeredAt: now,
        });
        return; // Don't execute action directly
      }

      // Trigger chained watch
      if (actionMode === 'trigger_watch' && watch.triggerWatchId) {
        if (chainDepth >= MAX_CHAIN_DEPTH) {
          this.logger.warn(
            { watchId: watch.id, targetId: watch.triggerWatchId, chainDepth },
            'Watch chain depth limit reached, aborting chain',
          );
          this.activityLogger?.logWatchChain({
            watchId: watch.id, watchName: watch.name,
            targetWatchId: watch.triggerWatchId,
            platform: watch.platform, chatId: watch.chatId,
            outcome: 'depth_limit', chainDepth,
          });
          await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: newLastValue, lastTriggeredAt: now });
          return;
        }

        const target = await this.watchRepo.getById(watch.triggerWatchId);
        if (!target) {
          this.logger.warn({ watchId: watch.id, targetId: watch.triggerWatchId }, 'Chained watch not found');
          await this.watchRepo.updateActionError(watch.id, `Chained watch "${watch.triggerWatchId}" not found`);
          await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: newLastValue, lastTriggeredAt: now });
          return;
        }

        if (!target.enabled) {
          this.logger.warn({ watchId: watch.id, targetId: target.id }, 'Chained watch is disabled, skipping');
          await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: newLastValue, lastTriggeredAt: now });
          return;
        }

        this.activityLogger?.logWatchChain({
          watchId: watch.id, watchName: watch.name,
          targetWatchId: target.id, targetWatchName: target.name,
          platform: watch.platform, chatId: watch.chatId,
          outcome: 'success', chainDepth,
        });

        this.logger.info(
          { watchId: watch.id, targetId: target.id, targetName: target.name, chainDepth: chainDepth + 1 },
          'Watch chain: triggering downstream watch',
        );

        try {
          await this.checkWatch(target, chainDepth + 1);
          await this.watchRepo.updateActionError(watch.id, null);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.watchRepo.updateActionError(watch.id, errMsg);
          this.logger.warn({ watchId: watch.id, targetId: target.id, err }, 'Watch chain execution failed');
        }

        await this.watchRepo.updateAfterCheck(watch.id, { lastCheckedAt: now, lastValue: newLastValue, lastTriggeredAt: now });
        return;
      }

      // Execute action skill if configured
      let actionError: string | null = null;
      if ((actionMode === 'action_only' || actionMode === 'alert_and_action') && watch.actionSkillName) {
        // Skip if action skill is auto-disabled
        if (this.skillHealthTracker?.isDisabled(watch.actionSkillName)) {
          actionError = `Action skill "${watch.actionSkillName}" is temporarily disabled due to repeated failures`;
          await this.watchRepo.updateActionError(watch.id, actionError);
          this.logger.warn({ watchId: watch.id, skillName: watch.actionSkillName }, 'Watch action skill is auto-disabled');
        } else {
          const actionSkill = this.skillRegistry.get(watch.actionSkillName);
          if (actionSkill) {
            try {
              await this.skillSandbox.execute(actionSkill, resolvedParams, context);
              await this.watchRepo.updateActionError(watch.id, null);
              this.skillHealthTracker?.recordSuccess(watch.actionSkillName!);
              this.activityLogger?.logWatchAction({
                watchId: watch.id, watchName: watch.name, skillName: watch.actionSkillName!,
                platform: watch.platform, chatId: watch.chatId, outcome: 'success',
              });
            } catch (err) {
              actionError = err instanceof Error ? err.message : String(err);
              await this.watchRepo.updateActionError(watch.id, actionError);
              this.skillHealthTracker?.recordFailure(watch.actionSkillName!, actionError);
              this.logger.warn({ watchId: watch.id, err }, 'Watch action failed');
              this.activityLogger?.logWatchAction({
                watchId: watch.id, watchName: watch.name, skillName: watch.actionSkillName!,
                platform: watch.platform, chatId: watch.chatId, outcome: 'error', error: actionError,
              });
            }
          } else {
            actionError = `Action skill "${watch.actionSkillName}" not found`;
            await this.watchRepo.updateActionError(watch.id, actionError);
            this.logger.warn({ watchId: watch.id, skillName: watch.actionSkillName }, 'Unknown action skill for watch');
          }
        }
      }

      // Send alert if mode includes alerting
      if (actionMode === 'alert' || actionMode === 'alert_and_action') {
        let alertText = await this.buildAlertText(watch, displayValue, result.data, resolvedTemplate);

        if (actionError) {
          alertText += '\n\n\u26A0\uFE0F Aktion fehlgeschlagen: ' + actionError;
        }

        const adapter = this.adapters.get(watch.platform as Platform);
        if (adapter) {
          try {
            await adapter.sendMessage(watch.chatId, alertText);
            this.logger.info({ watchId: watch.id, name: watch.name, value: displayValue }, 'Watch alert sent');
            this.activityLogger?.logWatchTrigger({
              watchId: watch.id, watchName: watch.name, value: displayValue,
              platform: watch.platform, chatId: watch.chatId, outcome: 'success',
            });
          } catch (err) {
            this.logger.error({ err, watchId: watch.id }, 'Failed to send watch alert');
            this.activityLogger?.logWatchTrigger({
              watchId: watch.id, watchName: watch.name, value: displayValue,
              platform: watch.platform, chatId: watch.chatId, outcome: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          this.logger.warn({ watchId: watch.id, platform: watch.platform }, 'Watch alert skipped — no adapter for platform');
        }
      }

      await this.watchRepo.updateAfterCheck(watch.id, {
        lastCheckedAt: now,
        lastValue: newLastValue,
        lastTriggeredAt: now,
      });
    } else {
      await this.watchRepo.updateAfterCheck(watch.id, {
        lastCheckedAt: now,
        lastValue: newLastValue,
      });
    }
  }

  private isCooldownExpired(watch: Watch): boolean {
    if (!watch.lastTriggeredAt) return true;
    const cooldownMs = watch.cooldownMinutes * 60_000;
    const elapsed = Date.now() - new Date(watch.lastTriggeredAt).getTime();
    return elapsed >= cooldownMs;
  }

  private formatAlert(watch: Watch, displayValue: string, resultData?: unknown): string {
    const op = OPERATOR_LABELS[watch.condition.operator] ?? watch.condition.operator;
    const thresholdStr = watch.condition.value != null ? ` ${op} ${watch.condition.value}` : ` ${op}`;
    const lines = [
      `\u26A1 Watch Alert: ${watch.name}`,
      `Bedingung erf\u00FCllt: ${watch.condition.field}${thresholdStr}`,
      `Aktueller Wert: ${displayValue}`,
    ];

    // Enrich alert with context from result data
    if (resultData && typeof resultData === 'object') {
      const data = resultData as Record<string, unknown>;
      const detail = this.formatResultContext(data, watch.condition.field);
      if (detail) lines.push('', detail);
    }

    return lines.join('\n');
  }

  /**
   * Use LLM to intelligently format watch alert based on messageTemplate + result data.
   * The messageTemplate acts as instruction (e.g. "zeige die 5 günstigsten RTX 5090 Angebote"),
   * and the LLM filters/formats the raw data accordingly.
   */
  private async formatAlertWithLLM(
    messageTemplate: string,
    resultData: unknown,
    watchName: string,
  ): Promise<string | null> {
    if (!this.llmProvider) return null;

    try {
      // Pre-filter marketplace listings to avoid LLM sorting/selection errors
      let dataForLLM = resultData;
      if (resultData && typeof resultData === 'object' && !Array.isArray(resultData)) {
        const rd = resultData as Record<string, unknown>;
        if (Array.isArray(rd.listings) && rd.listings.length > 0) {
          // Extract requested count from template (e.g. "5 günstigsten" → 5), default 10, minimum 10
          const countMatch = messageTemplate.match(/(\d+)\s*(günstigst|teuerst|billigst|Angebot|Listing|Ergebnis)/i);
          const requested = countMatch ? Math.max(parseInt(countMatch[1], 10), 10) : 10;
          const limit = Math.max(requested, 10); // at least 10 to give LLM enough context
          if (rd.listings.length > limit) {
            dataForLLM = { ...rd, listings: (rd.listings as unknown[]).slice(0, limit) };
          }
        }
      }
      const dataStr = JSON.stringify(dataForLLM, null, 2);
      // Truncate if too large to avoid excessive token usage
      const truncated = dataStr.length > 8000 ? dataStr.slice(0, 8000) + '\n... (truncated)' : dataStr;

      const response = await this.llmProvider.complete({
        messages: [{
          role: 'user',
          content: `Du bist ein Watch-Alert-Formatter. Formatiere die folgenden Daten als kurze, übersichtliche Benachrichtigung für den User.

Anweisung des Users: "${messageTemplate}"

Watch: "${watchName}"

Rohdaten:
${truncated}

Regeln:
- Folge der Anweisung des Users (z.B. Anzahl, Filter, Sortierung)
- Filtere irrelevante Ergebnisse heraus (z.B. Zubehör wenn nach einem Produkt gesucht wird)
- Kompaktes Format: Titel, Preis, Standort, Link pro Eintrag
- Antworte NUR mit der formatierten Nachricht, keine Erklärungen
- Sprache: Deutsch`,
        }],
        tier: 'fast',
        maxTokens: 1024,
        temperature: 0.1,
      });

      return response.content?.trim() || null;
    } catch (err) {
      this.logger.warn({ err, watchName }, 'LLM alert formatting failed, falling back to static formatter');
      return null;
    }
  }

  /**
   * Build alert text: uses LLM formatting when messageTemplate is set and LLM is available,
   * otherwise falls back to static formatResultContext.
   */
  private async buildAlertText(
    watch: Watch,
    displayValue: string,
    resultData: unknown,
    resolvedTemplate: string | undefined,
  ): Promise<string> {
    // When messageTemplate exists and LLM is available, use intelligent formatting
    if (resolvedTemplate && resultData && this.llmProvider) {
      const llmFormatted = await this.formatAlertWithLLM(
        watch.messageTemplate!,
        resultData,
        watch.name,
      );
      if (llmFormatted) return llmFormatted;
    }

    // Fallback: static formatting
    let alertText = resolvedTemplate ?? this.formatAlert(watch, displayValue, resultData);

    if (resolvedTemplate && resultData && typeof resultData === 'object') {
      const resultContext = this.formatResultContext(resultData as Record<string, unknown>, watch.condition.field);
      if (resultContext) alertText += '\n\n' + resultContext;
    }

    return alertText;
  }

  /**
   * Build human-readable context from structured result data.
   * Recognizes common patterns (marketplace listings, arrays with items, etc.)
   */
  private formatResultContext(data: Record<string, unknown>, conditionField: string): string | null {
    // Marketplace-style: has listings array
    if (Array.isArray(data.listings) && data.listings.length > 0) {
      const listings = data.listings as Array<Record<string, unknown>>;
      // Sort by price ascending, show all returned listings (skill controls the count)
      const withPrice = listings
        .filter(l => typeof l.price === 'number')
        .sort((a, b) => (a.price as number) - (b.price as number));
      if (withPrice.length === 0) return null;

      const lines = [`G\u00FCnstigste ${withPrice.length}:`];
      for (const l of withPrice) {
        const title = String(l.title ?? '').slice(0, 60);
        const price = typeof l.price === 'number' ? `${l.price}\u00A0\u20AC` : 'k.A.';
        const loc = l.location ? ` \u2014 ${l.location}` : '';
        const url = l.url ? `\n  ${l.url}` : '';
        lines.push(`\u2022 ${title} \u2014 ${price}${loc}${url}`);
      }
      if (typeof data.count === 'number' && data.count > withPrice.length) {
        lines.push(`\nInsgesamt: ${data.count} Inserate`);
      }
      return lines.join('\n');
    }

    // Marketplace compare-style: has cheapest array
    if (Array.isArray(data.cheapest) && data.cheapest.length > 0) {
      const cheapest = data.cheapest as Array<Record<string, unknown>>;
      const lines = [`G\u00FCnstigste ${cheapest.length}:`];
      for (const l of cheapest) {
        const title = String(l.title ?? '').slice(0, 60);
        const price = typeof l.price === 'number' ? `${l.price}\u00A0\u20AC` : 'k.A.';
        const url = l.url ? `\n  ${l.url}` : '';
        lines.push(`\u2022 ${title} \u2014 ${price}${url}`);
      }
      return lines.join('\n');
    }

    return null;
  }
}
