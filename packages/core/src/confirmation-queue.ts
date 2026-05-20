import type { Logger } from 'pino';
import type { ConfirmationRepository, ConversationRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, SkillContext, PendingConfirmation } from '@alfred/types';
import type { ActivityLogger } from './activity-logger.js';
import type { FeedbackService } from './feedback/feedback-service.js';

/**
 * Compute a canonical "topic key" for a pending confirmation.
 * Two confirmations are considered the SAME TOPIC iff their topic keys match.
 *
 * Per-skill rules use skill_params (the most reliable signal):
 * - itsm.create_incident / create_problem → params.title
 * - itsm.create_change_request → params.title
 * - workflow.create / watch.create → params.name
 * - reminder.set → first 8 words of params.message
 * - Generic fallback → first 8 lowercase words ≥4 chars from description
 *
 * Returns null when no usable signal is available (caller should NOT auto-dedup).
 */
export function computeTopicKey(c: PendingConfirmation): string | null {
  const skill = c.skillName;
  const action = (c.skillParams?.action as string | undefined) ?? '';
  const params = c.skillParams ?? {};

  // Skill-specific reliable signals
  if (skill === 'itsm' && (action === 'create_incident' || action === 'create_problem' || action === 'create_change_request')) {
    const title = (params.title as string | undefined)?.trim().toLowerCase();
    if (title) return `${skill}:${action}:${title}`;
  }
  if ((skill === 'workflow' || skill === 'watch') && action === 'create') {
    const name = (params.name as string | undefined)?.trim().toLowerCase();
    if (name) return `${skill}:${action}:${name}`;
  }
  if (skill === 'reminder' && action === 'set') {
    const msg = (params.message as string | undefined)?.trim().toLowerCase() ?? '';
    const sig = msg.split(/\s+/).slice(0, 8).join(' ');
    if (sig.length >= 5) return `${skill}:${action}:${sig}`;
  }

  // Generic fallback: description signature
  const descSig = c.description.toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 8).sort().join(' ');
  if (descSig.length >= 5) return `${skill}:${action}:desc:${descSig}`;
  return null;
}

export class ConfirmationQueue {
  private expireTimer: ReturnType<typeof setInterval> | null = null;
  private feedbackService?: FeedbackService;

  constructor(
    private readonly confirmRepo: ConfirmationRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly activityLogger?: ActivityLogger,
  ) {}

  setFeedbackService(service: FeedbackService): void {
    this.feedbackService = service;
  }

  start(): void {
    // Check for expired confirmations every 60s
    this.expireTimer = setInterval(() => this.expireTick(), 60_000);
  }

  stop(): void {
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
  }

  async enqueue(opts: {
    chatId: string;
    platform: string;
    source: 'watch' | 'scheduled' | 'reasoning';
    sourceId: string;
    description: string;
    skillName: string;
    skillParams: Record<string, unknown>;
    timeoutMinutes?: number;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + (opts.timeoutMinutes ?? 30) * 60_000).toISOString();

    const confirmation = await this.confirmRepo.create({
      chatId: opts.chatId,
      platform: opts.platform,
      source: opts.source,
      sourceId: opts.sourceId,
      description: opts.description,
      skillName: opts.skillName,
      skillParams: opts.skillParams,
      expiresAt,
    });

    const adapter = this.adapters.get(opts.platform as Platform);
    if (adapter) {
      const confirmId = confirmation.id;
      const msg = `\u2753 Best\u00E4tigung erforderlich:\n${opts.description}\n\nAntworte "ja" oder "nein".`;
      try {
        // Use inline buttons for Telegram
        if (opts.platform === 'telegram' && confirmId) {
          await adapter.sendMessage(opts.chatId, msg, {
            replyMarkup: {
              inlineKeyboard: [[
                { text: '\u2705 Approve', callbackData: `confirm:${confirmId}:approve` },
                { text: '\u274C Reject', callbackData: `confirm:${confirmId}:reject` },
              ]],
            },
          });
        } else {
          await adapter.sendMessage(opts.chatId, msg);
        }
      } catch (err) {
        this.logger.error({ err }, 'Failed to send confirmation request');
      }
    }
  }

  /**
   * Enqueue a plan for user approval. On approval, the plan executor starts.
   */
  private defaultChatId?: string;
  private defaultPlatform?: string;

  /** Set default chat/platform for plan notifications (called from ReasoningEngine). */
  setDefaultTarget(chatId: string, platform: string): void {
    this.defaultChatId = chatId;
    this.defaultPlatform = platform;
  }

  async enqueuePlan(plan: import('@alfred/types').Plan, display: string): Promise<void> {
    if (!this.defaultChatId || !this.defaultPlatform) return;
    await this.enqueue({
      chatId: this.defaultChatId,
      platform: this.defaultPlatform,
      source: 'reasoning',
      sourceId: `plan:${plan.id}`,
      description: display,
      skillName: '__plan__',
      skillParams: { planId: plan.id },
      timeoutMinutes: 240,
    });
  }

  /**
   * Check if an incoming message is a confirmation response.
   * Returns true if the message was handled (consumed), false if it should proceed normally.
   */
  async checkForConfirmation(chatId: string, platform: string, text: string, context: SkillContext): Promise<boolean> {
    const normalized = text.trim().toLowerCase();

    // Handle inline keyboard callback data: confirm:<id>:approve / confirm:<id>:reject
    const callbackMatch = /^confirm:([^:]+):(approve|reject)$/.exec(normalized);
    const isYes = callbackMatch ? callbackMatch[2] === 'approve' : ['ja', 'ok', 'yes', 'best\u00E4tigen', 'j'].includes(normalized);
    const isNo = callbackMatch ? callbackMatch[2] === 'reject' : ['nein', 'no', 'abbrechen', 'n', 'n\u00F6'].includes(normalized);

    if (!isYes && !isNo) return false;

    // Use specific confirmation ID from callback button, or fall back to most recent pending
    const pending = callbackMatch
      ? await this.confirmRepo.getById(callbackMatch[1])
      : await this.confirmRepo.findPending(chatId, platform);

    const adapter = this.adapters.get(platform as Platform);

    // Fix B — Better fallback when callback ID exists but isn't pending anymore.
    // Look up the confirmation regardless of status and tell the user explicitly what
    // happened, instead of falling through to the LLM with a confusing "no matching action".
    if (!pending && callbackMatch) {
      const stale = await this.confirmRepo.getByIdAnyStatus(callbackMatch[1]);
      if (stale && adapter) {
        const statusLabel: Record<string, string> = {
          approved: 'bereits freigegeben',
          rejected: 'bereits abgelehnt',
          expired: 'inzwischen abgelaufen oder durch eine andere Bestätigung erledigt',
        };
        const label = statusLabel[stale.status] ?? `bereits abgeschlossen (${stale.status})`;
        const when = stale.resolvedAt ? ` (${stale.resolvedAt.slice(0, 16).replace('T', ' ')})` : '';
        await adapter.sendMessage(chatId, `ℹ️ Diese Aktion wurde ${label}${when}: ${stale.description}`);
        return true; // consumed — don't fall through to LLM
      }
      return false;
    }
    if (!pending) return false;

    if (isYes) {
      await this.confirmRepo.resolve(pending.id, 'approved');

      // Fix A + C — Auto-resolve other pending confirmations only when the TOPIC KEY matches
      // exactly. The topic key is computed from skill_params (title/name/message) where
      // available, with a strict description-signature fallback. This prevents
      // "ITSM Incident A" and "ITSM Incident B" (different incidents) from collapsing
      // into one just because their descriptions share generic words like "ITSM" and
      // "dokumentieren".
      try {
        const approvedTopic = computeTopicKey(pending);
        if (approvedTopic) {
          const allPending = await this.confirmRepo.findAllPending(chatId, platform);
          for (const other of allPending) {
            if (other.id === pending.id) continue;
            const otherTopic = computeTopicKey(other);
            if (otherTopic && otherTopic === approvedTopic) {
              await this.confirmRepo.resolve(other.id, 'expired');
              this.logger.info({ resolved: other.id, by: pending.id, topic: approvedTopic },
                'Auto-resolved sibling confirmation (same topic key)');
            }
          }
        }
      } catch { /* best effort */ }

      // Execute the action
      const skill = this.skillRegistry.get(pending.skillName);
      if (skill) {
        try {
          const result = await this.skillSandbox.execute(skill, pending.skillParams, context);
          if (result && !result.success) {
            throw new Error(result.error ?? 'Skill returned success=false');
          }
          if (adapter) {
            // Show full skill result (like a normal chat interaction), not just "Ausgeführt"
            const display = result?.display ?? result?.data ? String(result.display ?? JSON.stringify(result.data)) : '';
            const msg = display
              ? `\u2705 **${pending.description}**\n\n${display}`
              : `\u2705 Aktion ausgef\u00FChrt: ${pending.description}`;
            await adapter.sendMessage(chatId, msg);
          }
          this.activityLogger?.logConfirmation({
            confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
            source: pending.source, sourceId: pending.sourceId, outcome: 'approved',
            userId: context.userId, platform, chatId,
          });
        } catch (err) {
          this.logger.error({ err, confirmationId: pending.id }, 'Confirmed action failed');
          if (adapter) {
            await adapter.sendMessage(chatId, `\u274C Aktion fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.activityLogger?.logConfirmation({
            confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
            source: pending.source, sourceId: pending.sourceId, outcome: 'error',
            userId: context.userId, platform, chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        if (adapter) {
          await adapter.sendMessage(chatId, `\u274C Skill "${pending.skillName}" nicht gefunden.`);
        }
      }
    } else {
      await this.confirmRepo.resolve(pending.id, 'rejected');
      if (adapter) {
        await adapter.sendMessage(chatId, `\u274C Aktion abgelehnt: ${pending.description}`);
      }
      this.activityLogger?.logConfirmation({
        confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
        source: pending.source, sourceId: pending.sourceId, outcome: 'rejected',
        userId: context.userId, platform, chatId,
      });
      // Fire-and-forget feedback capture
      this.feedbackService?.onWatchRejected({
        userId: context.userId,
        watchId: pending.sourceId,
        watchName: pending.description,
        skillName: pending.skillName,
        skillParams: (pending as unknown as Record<string, unknown>).skillParams as Record<string, unknown> ?? {},
        description: pending.description,
      });
    }

    return true;
  }

  private convRepo?: ConversationRepository;
  setConversationRepository(repo: ConversationRepository): void {
    this.convRepo = repo;
  }

  /**
   * v629 — Web-UI helper: approve or reject by confirmation-ID without going through
   * the chat-message-pipeline. Returns `{ok:false, reason}` if the confirmation is
   * no longer pending so the HTTP layer can return 409/404.
   */
  async handleWebDecision(opts: {
    id: string;
    decision: 'approve' | 'reject';
    userId: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const pending = await this.confirmRepo.getById(opts.id);
    if (!pending) {
      const stale = await this.confirmRepo.getByIdAnyStatus(opts.id);
      if (stale) return { ok: false, reason: `already-${stale.status}` };
      return { ok: false, reason: 'not-found' };
    }

    let conversationId = '';
    if (this.convRepo) {
      try {
        const conv = await this.convRepo.findByPlatformChat(pending.platform as Platform, pending.chatId);
        if (conv) conversationId = conv.id;
      } catch { /* best effort */ }
    }

    const context: SkillContext = {
      userId: opts.userId,
      chatId: pending.chatId,
      platform: pending.platform,
      conversationId,
      masterUserId: opts.userId,
    };

    // Re-use the chat-flow handler — pass synthetic callback so auto-sibling-cleanup,
    // adapter notifications, and feedback hooks run exactly like a Telegram button press.
    const handled = await this.checkForConfirmation(
      pending.chatId,
      pending.platform,
      `confirm:${pending.id}:${opts.decision}`,
      context,
    );
    return handled ? { ok: true } : { ok: false, reason: 'not-handled' };
  }

  async listPendingForUser(userId: string, limit = 50): Promise<PendingConfirmation[]> {
    if (typeof (this.confirmRepo as unknown as { findAllPendingForUser?: unknown }).findAllPendingForUser !== 'function') {
      return [];
    }
    return (this.confirmRepo as unknown as { findAllPendingForUser: (u: string, l: number) => Promise<PendingConfirmation[]> }).findAllPendingForUser(userId, limit);
  }

  private async expireTick(): Promise<void> {
    try {
      const expired = await this.confirmRepo.expireOld();
      for (const conf of expired) {
        this.activityLogger?.logConfirmation({
          confirmationId: conf.id, skillName: conf.skillName, description: conf.description,
          source: conf.source, sourceId: conf.sourceId, outcome: 'expired',
          platform: conf.platform, chatId: conf.chatId,
        });
        const adapter = this.adapters.get(conf.platform as Platform);
        if (adapter) {
          try {
            await adapter.sendMessage(conf.chatId, `\u23F0 Best\u00E4tigung abgelaufen: ${conf.description}`);
          } catch { /* best effort */ }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Confirmation expire tick failed');
    }
  }
}
