import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { ScheduledActionRepository, UserRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, ScheduledAction, NormalizedMessage } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import type { MessagePipeline } from './message-pipeline.js';
import type { ResponseFormatter } from './response-formatter.js';
import type { ConversationManager } from './conversation-manager.js';
import { matchesCron, getNextCronDate } from '@alfred/types';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';

export class ProactiveScheduler {
  private tickTimer?: ReturnType<typeof setInterval>;
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly actionRepo: ScheduledActionRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly llm: LLMProvider,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly pipeline?: MessagePipeline,
    private readonly formatter?: ResponseFormatter,
    private readonly conversationManager?: ConversationManager,
    private readonly activityLogger?: ActivityLogger,
    private readonly nodeId: string = 'single',
  ) {}

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info('Proactive scheduler started');
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.logger.info('Proactive scheduler stopped');
  }

  private async tick(): Promise<void> {
    try {
      const dueActions = await this.actionRepo.claimDue(this.nodeId);

      for (const action of dueActions) {
        try {
          await this.executeAction(action);
        } catch (err) {
          this.logger.error({ err, actionId: action.id }, 'Failed to execute scheduled action');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error during proactive scheduler tick');
    }
  }

  private async executeAction(action: ScheduledAction): Promise<void> {
    const now = new Date().toISOString();
    const startMs = Date.now();
    this.logger.info({ actionId: action.id, name: action.name }, 'Executing scheduled action');

    let resultText: string;
    let resultParseMode: 'text' | 'markdown' | 'html' = 'text';

    if (action.skillName && this.skillRegistry.has(action.skillName)) {
      // Execute skill directly — preferred path (no LLM overhead).
      // Checked BEFORE promptTemplate so tasks with both fields use the
      // cheaper direct path (e.g. old briefing tasks with legacy prompt_template).
      const skill = this.skillRegistry.get(action.skillName)!;
      try {
        let input: Record<string, unknown>;
        try { input = JSON.parse(action.skillInput); }
        catch { input = {}; this.logger.warn({ actionId: action.id }, 'Invalid skillInput JSON, using empty input'); }
        const { context } = await buildSkillContext(this.users, {
          userId: action.userId,
          platform: action.platform as Platform,
          chatId: action.chatId,
          chatType: 'dm',
        });

        const result = await this.skillSandbox.execute(skill, input, context);
        if (result.success) {
          const rawText = result.display ?? JSON.stringify(result.data);
          if (this.formatter) {
            const formatted = this.formatter.format(rawText, action.platform as Platform);
            resultText = formatted.text;
            resultParseMode = formatted.parseMode;
          } else {
            resultText = rawText;
          }
        } else {
          resultText = `\u274C Scheduled action "${action.name}" failed: ${result.error}`;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        resultText = `\u274C Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else if (action.promptTemplate && this.pipeline) {
      // Route through the full message pipeline so the LLM can use all tools.
      try {
        const isolatedChatId = `scheduled-${action.id}`;
        const resolvedUser = await this.users.findById(action.userId);
        const platformUserId = resolvedUser?.platformUserId ?? action.userId;
        const syntheticMessage: NormalizedMessage = {
          id: `scheduled-${crypto.randomUUID()}`,
          platform: action.platform as Platform,
          chatId: isolatedChatId,
          chatType: 'dm',
          userId: platformUserId,
          userName: resolvedUser?.username ?? platformUserId,
          text: action.promptTemplate + '\n\n[Format: Use only Markdown (**, *, ~~, `, ```). Do NOT use HTML tags like <b>, <i>, <code>. The system converts Markdown to platform-specific formatting automatically.]',
          timestamp: new Date(),
          metadata: { scheduled: true, skipHistory: true, tier: 'fast', originalChatId: action.chatId },
        };

        const result = await this.pipeline.process(syntheticMessage);
        const formatted = this.formatter
          ? this.formatter.format(result.text, action.platform as Platform)
          : { text: result.text, parseMode: 'text' as const };

        resultText = formatted.text;
        resultParseMode = formatted.parseMode;

        // Send file attachments if any — to the USER's original chatId
        const adapter = this.adapters.get(action.platform as Platform);
        if (adapter && result.attachments) {
          for (const att of result.attachments) {
            try {
              const isImage = att.mimeType.startsWith('image/');
              const isVoice = att.mimeType === 'audio/ogg' || att.mimeType === 'audio/opus';
              if (isImage) {
                await adapter.sendPhoto(action.chatId, att.data, att.fileName);
              } else if (isVoice) {
                await adapter.sendVoice(action.chatId, att.data);
              } else {
                await adapter.sendFile(action.chatId, att.data, att.fileName);
              }
            } catch (err) {
              this.logger.warn({ err, fileName: att.fileName, actionId: action.id }, 'Failed to send scheduled action attachment');
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({ actionId: action.id, err }, 'Pipeline execution failed for scheduled action');
        resultText = `Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else if (action.promptTemplate) {
      // Fallback: LLM-only (no pipeline available)
      try {
        const response = await this.llm.complete({
          messages: [{ role: 'user', content: action.promptTemplate }],
          maxTokens: 1024,
          tier: 'fast',
        });
        resultText = response.content;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({ actionId: action.id, err }, 'LLM call failed for scheduled action');
        resultText = `Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else {
      this.logger.warn({ actionId: action.id, skillName: action.skillName }, 'Unknown skill for scheduled action');
      resultText = `Scheduled action "${action.name}" failed: unknown skill "${action.skillName}"`;
    }

    // Log activity
    const isError = resultText.startsWith('\u274C');
    this.activityLogger?.logScheduledExec({
      actionId: action.id, actionName: action.name,
      skillName: action.skillName ?? undefined,
      platform: action.platform, chatId: action.chatId, userId: action.userId,
      outcome: isError ? 'error' : 'success',
      durationMs: Date.now() - startMs,
      error: isError ? resultText : undefined,
    });

    // Send result to user — for prompt_template tasks whose prompt contains
    // "antworte NICHTS" or similar, use whitelist logic: only send if the
    // response contains actual problem indicators.  This avoids chasing every
    // creative LLM variation of "all clear" (e.g. "silenzio.", "(no response)").
    const trimmed = resultText.trim();
    const promptLower = (action.promptTemplate ?? '').toLowerCase();
    const isSilentPrompt = /nichts|silent|no\s*output|don't\s*respond|do\s*not\s*respond/i.test(promptLower);
    const hasAlertIndicators = /offline|down|fehler|error|warn|critical|alert|fail|nicht\s+(erreichbar|verf[uü]gbar|gefunden|online)|ausgefallen|stopped|unreachable|unavailable|⚠|❌|🚨|🔴/i.test(trimmed)
      && !/keine\s+(probleme|fehler|auff[aä]lligkeiten)/i.test(trimmed);
    const isSilent = !trimmed
      || trimmed.length < 3
      || (isSilentPrompt && !hasAlertIndicators);
    if (isSilent) {
      this.logger.info({ actionId: action.id, name: action.name }, 'Scheduled action produced no actionable output — skipping notification');
    } else {
      const adapter = this.adapters.get(action.platform as Platform);
      if (adapter) {
        try {
          await adapter.sendMessage(action.chatId, resultText, {
            parseMode: resultParseMode !== 'text' ? resultParseMode : undefined,
          });

          // For prompt_template tasks running in an isolated conversation:
          // inject the alert into the USER's conversation so they can reply
          // with context (e.g. "restart the VM").  Skill-based tasks already
          // run without conversation context, so injecting their output would
          // just bloat the user's history.
          if (action.promptTemplate && this.conversationManager) {
            const userConv = await this.conversationManager.getOrCreateConversation(
              action.platform as Platform,
              action.chatId,
              action.userId,
            );
            const alertMsg = `[Automated Scheduled Alert: ${action.name}]\n${resultText}`;
            await this.conversationManager.addMessage(userConv.id, 'assistant', alertMsg);
          }
        } catch (err) {
          this.logger.error({ err, actionId: action.id }, 'Failed to send scheduled action result');
        }
      }
    }

    // Prune isolated scheduled-task conversations to prevent unbounded growth.
    // Keep only the last 20 messages (≈10 prompt/response pairs).
    if (action.promptTemplate && this.conversationManager) {
      try {
        const isolatedChatId = `scheduled-${action.id}`;
        const conv = await this.conversationManager.getOrCreateConversation(
          action.platform as Platform,
          isolatedChatId,
          action.userId,
        );
        await this.conversationManager.pruneMessages(conv.id, 20);
      } catch {
        // Non-critical — ignore pruning errors
      }
    }

    // Calculate next run
    const nextRunAt = this.calculateNextRun(action);

    if (nextRunAt) {
      await this.actionRepo.updateLastRun(action.id, now, nextRunAt);
    } else {
      // No next run (e.g. 'once' type) — disable the action
      await this.actionRepo.updateLastRun(action.id, now, null);
      await this.actionRepo.setEnabled(action.id, false);
    }
  }

  private calculateNextRun(action: ScheduledAction): string | null {
    const now = new Date();

    switch (action.scheduleType) {
      case 'interval': {
        const minutes = parseInt(action.scheduleValue, 10);
        if (isNaN(minutes) || minutes <= 0) return null;
        return new Date(now.getTime() + minutes * 60_000).toISOString();
      }
      case 'once': {
        // One-time actions don't repeat
        return null;
      }
      case 'cron': {
        return getNextCronDate(action.scheduleValue, now)?.toISOString() ?? null;
      }
      default:
        return null;
    }
  }

  // Cron matching delegated to shared cron-utils
}
