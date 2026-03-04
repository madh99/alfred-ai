import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { ScheduledActionRepository, UserRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, ScheduledAction, NormalizedMessage } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import type { MessagePipeline } from './message-pipeline.js';
import type { ResponseFormatter } from './response-formatter.js';

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
      const dueActions = this.actionRepo.getDue();

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
    this.logger.info({ actionId: action.id, name: action.name }, 'Executing scheduled action');

    let resultText: string;

    if (action.promptTemplate && this.pipeline) {
      // Route through the full message pipeline so the LLM can use all tools
      try {
        const syntheticMessage: NormalizedMessage = {
          id: `scheduled-${crypto.randomUUID()}`,
          platform: action.platform as Platform,
          chatId: action.chatId,
          chatType: 'dm',
          userId: action.userId,
          userName: action.userId,
          text: action.promptTemplate,
          timestamp: new Date(),
        };

        const result = await this.pipeline.process(syntheticMessage);
        const formatted = this.formatter
          ? this.formatter.format(result.text, action.platform as Platform)
          : { text: result.text, parseMode: 'text' as const };

        resultText = formatted.text;

        // Send file attachments if any
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
      // Execute skill directly
      const skill = this.skillRegistry.get(action.skillName);
      if (!skill) {
        this.logger.warn({ actionId: action.id, skillName: action.skillName }, 'Unknown skill for scheduled action');
        resultText = `Scheduled action "${action.name}" failed: unknown skill "${action.skillName}"`;
      } else {
        try {
          let input: Record<string, unknown>;
          try { input = JSON.parse(action.skillInput); }
          catch { input = {}; this.logger.warn({ actionId: action.id }, 'Invalid skillInput JSON, using empty input'); }
          const user = this.users.findOrCreate(action.platform as Platform, action.userId);
          const masterUserId = this.users.getMasterUserId(user.id);
          const linked = this.users.getLinkedUsers(masterUserId);
          const context = {
            userId: action.userId,
            masterUserId,
            linkedPlatformUserIds: linked.map(u => u.platformUserId),
            chatId: action.chatId,
            platform: action.platform,
            conversationId: '',
            chatType: 'dm' as const,
          };

          const result = await this.skillSandbox.execute(skill, input, context);
          resultText = result.success
            ? `\uD83D\uDD14 Scheduled: ${action.name}\n\n${result.display ?? JSON.stringify(result.data)}`
            : `\u274C Scheduled action "${action.name}" failed: ${result.error}`;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          resultText = `\u274C Scheduled action "${action.name}" failed: ${errorMsg}`;
        }
      }
    }

    // Send result to user
    const adapter = this.adapters.get(action.platform as Platform);
    if (adapter) {
      try {
        await adapter.sendMessage(action.chatId, resultText);
      } catch (err) {
        this.logger.error({ err, actionId: action.id }, 'Failed to send scheduled action result');
      }
    }

    // Calculate next run
    const nextRunAt = this.calculateNextRun(action);

    if (nextRunAt) {
      this.actionRepo.updateLastRun(action.id, now, nextRunAt);
    } else {
      // No next run (e.g. 'once' type) — disable the action
      this.actionRepo.updateLastRun(action.id, now, null);
      this.actionRepo.setEnabled(action.id, false);
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
        return this.getNextCronDate(action.scheduleValue, now)?.toISOString() ?? null;
      }
      default:
        return null;
    }
  }

  private getNextCronDate(cronExpr: string, after: Date): Date | null {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    // Start 1 minute ahead and scan up to 24 hours forward
    const candidate = new Date(after.getTime() + 60_000);
    candidate.setSeconds(0, 0);

    for (let i = 0; i < 1440; i++) {
      if (this.matchesCron(parts, candidate)) {
        return candidate;
      }
      candidate.setTime(candidate.getTime() + 60_000);
    }

    return null;
  }

  private matchesCron(parts: string[], date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    return (
      this.matchCronField(parts[0], minute) &&
      this.matchCronField(parts[1], hour) &&
      this.matchCronField(parts[2], dayOfMonth) &&
      this.matchCronField(parts[3], month) &&
      this.matchCronField(parts[4], dayOfWeek)
    );
  }

  private matchCronField(field: string, value: number): boolean {
    if (field === '*') return true;

    // */N — every N
    const stepMatch = /^\*\/(\d+)$/.exec(field);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      return value % step === 0;
    }

    // Specific number
    const num = parseInt(field, 10);
    if (!isNaN(num)) return value === num;

    return false;
  }
}
