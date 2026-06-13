import type { Logger } from 'pino';
import type { ConfirmationRepository, ConversationRepository, ProjectRepository, MemoryRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, SkillContext, PendingConfirmation, ConfirmationExtraAction } from '@alfred/types';
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
/**
 * v884 — Klassifiziert eine Freitext-Antwort als Bestätigung/Ablehnung.
 *
 * Strenge Wortliste (exakte Tokens) gilt IMMER. Breitere Phrasen
 * ("ok mach es so", "ja passt") NUR bei eindeutigem Reply-Bezug (`hasReplyContext`):
 * ohne Reply würde freies Geplauder sonst blind die neueste Confirmation auslösen
 * (gefährlich). Mit Reply hat der User explizit auf genau diese Frage geantwortet.
 * Gemischte Signale (ja+nein) → 'none' (kein Raten).
 */
export function classifyConfirmationReply(normalized: string, hasReplyContext: boolean): 'yes' | 'no' | 'none' {
  const STRICT_YES = ['ja', 'ok', 'yes', 'bestätigen', 'j'];
  const STRICT_NO = ['nein', 'no', 'abbrechen', 'n', 'nö'];
  if (STRICT_YES.includes(normalized)) return 'yes';
  if (STRICT_NO.includes(normalized)) return 'no';
  if (!hasReplyContext) return 'none';
  // Eine Rückfrage ist keine Bestätigung (z.B. "was genau?", "ist das ok?").
  if (normalized.includes('?')) return 'none';
  // Bewusst KONSERVATIV: nur eindeutig affirmative Kommando-/Zustimmungswörter.
  // Mehrdeutige Wörter (genau/richtig) sind raus — sie kommen oft in Rückfragen vor.
  const LOOSE_YES_RE = /\b(ok|okay|ja|jo|jup|jep|passt|mach|machs|los|approve|freigabe|freigeben)\b/;
  const LOOSE_NO_RE = /\b(nein|nicht|stop|stopp|abbrechen|lass|verwerfen|niemals)\b/;
  const yes = LOOSE_YES_RE.test(normalized);
  const no = LOOSE_NO_RE.test(normalized);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'none';
}

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

  // v657 — optionale Repos für die extra-Action-Handler (cancel-item / defer)
  private projectRepo?: ProjectRepository;
  private memoryRepo?: MemoryRepository;
  setProjectRepo(repo: ProjectRepository): void { this.projectRepo = repo; }
  setMemoryRepo(repo: MemoryRepository): void { this.memoryRepo = repo; }

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
    /** v657 \u2014 zus\u00E4tzliche Buttons neben approve/reject (z.B. Open-Item-Eskalation: Ablehnen/Zur\u00FCckstellen) */
    extraActions?: ConfirmationExtraAction[];
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
      extraActions: opts.extraActions,
      expiresAt,
    });

    const adapter = this.adapters.get(opts.platform as Platform);
    if (adapter) {
      const confirmId = confirmation.id;
      const msg = `\u2753 Best\u00E4tigung erforderlich:\n${opts.description}\n\nAntworte "ja" oder "nein".`;
      try {
        // Use inline buttons for Telegram
        if (opts.platform === 'telegram' && confirmId) {
          // v657 \u2014 Standard-Buttons + extra Actions (max 3 pro Zeile)
          const standardRow = [
            { text: '\u2705 Ja', callbackData: `confirm:${confirmId}:approve` },
            { text: '\u274C Nein', callbackData: `confirm:${confirmId}:reject` },
          ];
          const inlineKeyboard: Array<Array<{ text: string; callbackData: string }>> = [standardRow];
          if (opts.extraActions && opts.extraActions.length > 0) {
            // extra actions in eigener Row (oder mehrere wenn viele)
            let currentRow: Array<{ text: string; callbackData: string }> = [];
            for (const ea of opts.extraActions) {
              currentRow.push({ text: ea.label, callbackData: `confirm:${confirmId}:${ea.key}` });
              if (currentRow.length === 3) { inlineKeyboard.push(currentRow); currentRow = []; }
            }
            if (currentRow.length > 0) inlineKeyboard.push(currentRow);
          }
          const sentId = await adapter.sendMessage(opts.chatId, msg, {
            replyMarkup: { inlineKeyboard },
          });
          // v884 — message_id persistieren: ein Reply darauf löst GENAU diese
          // Confirmation auf (statt blind "neueste pending").
          if (sentId) { try { await this.confirmRepo.setSentMessageId(confirmId, sentId); } catch { /* best-effort */ } }
        } else {
          const sentId = await adapter.sendMessage(opts.chatId, msg);
          if (sentId && confirmId) { try { await this.confirmRepo.setSentMessageId(confirmId, sentId); } catch { /* best-effort */ } }
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
  async checkForConfirmation(chatId: string, platform: string, text: string, context: SkillContext, replyToMessageId?: string): Promise<boolean> {
    const normalized = text.trim().toLowerCase();

    // Handle inline keyboard callback data: confirm:<id>:<key>
    // <key> kann 'approve' / 'reject' / oder ein custom extraAction-key sein
    const callbackMatch = /^confirm:([^:]+):([a-z0-9_-]+)$/i.exec(text.trim());
    const callbackKey = callbackMatch?.[2]?.toLowerCase();

    // v884 \u2014 Reply-Bezug: hat der User per Reply auf eine BESTIMMTE
    // Best\u00E4tigungs-Nachricht geantwortet? Dann ist eindeutig, welche Confirmation
    // gemeint ist \u2014 unabh\u00E4ngig davon, welche die neueste ist.
    let replyPending: PendingConfirmation | undefined;
    if (!callbackMatch && replyToMessageId) {
      replyPending = await this.confirmRepo.findPendingBySentMessageId(chatId, platform, replyToMessageId);
    }

    // v884 \u2014 Affirmativ-Klassifikation in pure Funktion ausgelagert (deterministisch,
    // getestet). Bei Reply-Bezug greifen breitere Phrasen ("ok mach es so").
    const verdict = classifyConfirmationReply(normalized, !!replyPending);
    const isYes = callbackKey === 'approve' || (!callbackMatch && verdict === 'yes');
    const isNo = callbackKey === 'reject' || (!callbackMatch && verdict === 'no');
    const isExtraAction = callbackMatch && !!callbackKey && callbackKey !== 'approve' && callbackKey !== 'reject';

    if (!isYes && !isNo && !isExtraAction) return false;

    // Priorit\u00E4t: Callback-ID > Reply-referenzierte Confirmation > neueste pending
    const pending = callbackMatch
      ? await this.confirmRepo.getById(callbackMatch[1])
      : (replyPending ?? await this.confirmRepo.findPending(chatId, platform));

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

    // v657 — Extra-Action: nicht approve/reject, sondern eine custom-action aus extraActions
    if (isExtraAction && callbackKey) {
      const ea = pending.extraActions?.find(a => a.key === callbackKey);
      if (!ea) {
        if (adapter) await adapter.sendMessage(chatId, `⚠️ Aktion "${callbackKey}" ist nicht mehr verfügbar.`);
        return true;
      }
      try {
        switch (ea.kind) {
          case 'skill': {
            // führe die spezifizierte Skill-Aktion aus, markiere als 'approved'
            await this.confirmRepo.resolve(pending.id, 'approved');
            if (ea.skillName) {
              const skill = this.skillRegistry.get(ea.skillName);
              if (skill) {
                const result = await this.skillSandbox.execute(skill, ea.skillParams ?? {}, context);
                if (adapter) {
                  const display = result?.display ?? (result?.data ? JSON.stringify(result.data) : '');
                  const msg = result?.success
                    ? (display ? `✅ **${ea.label}**\n\n${display}` : `✅ ${ea.label}`)
                    : `❌ ${ea.label} fehlgeschlagen: ${result?.error ?? 'unknown'}`;
                  await adapter.sendMessage(chatId, msg);
                }
              } else if (adapter) {
                await adapter.sendMessage(chatId, `❌ Skill "${ea.skillName}" nicht registriert.`);
              }
            }
            break;
          }
          case 'dismiss': {
            await this.confirmRepo.resolve(pending.id, 'rejected');
            if (adapter) await adapter.sendMessage(chatId, `🙅 ${ea.label}: Aktion verworfen — keine weitere Eskalation.`);
            break;
          }
          case 'cancel-item': {
            await this.confirmRepo.resolve(pending.id, 'rejected');
            if (this.projectRepo && ea.openItemId) {
              try {
                await this.projectRepo.updateOpenItemStatus(ea.openItemId, 'cancelled');
                if (adapter) await adapter.sendMessage(chatId, `🗑 Open-Item geschlossen (cancelled).`);
              } catch (err) {
                if (adapter) await adapter.sendMessage(chatId, `⚠️ Konnte Item nicht schließen: ${(err as Error).message}`);
              }
            } else if (adapter) {
              await adapter.sendMessage(chatId, `⚠️ ${ea.label}: kein Projekt-Repo verkabelt.`);
            }
            break;
          }
          case 'defer': {
            // löscht den Eskalations-Marker → Item wird nach Wartezeit erneut eskaliert
            await this.confirmRepo.resolve(pending.id, 'expired');
            const deferHours = ea.deferHours ?? 24;
            if (this.memoryRepo && ea.openItemId) {
              try {
                // Marker-Key Pattern: open_item_escalated:<itemId> (siehe open-items-reflector)
                // Wir schreiben einen "snooze"-Marker der erst nach deferHours abläuft.
                // Implementation: existing Marker auf "snoozed_until" mit Zeitstempel updaten.
                const snoozeUntil = new Date(Date.now() + deferHours * 3600_000).toISOString();
                await this.memoryRepo.saveWithMetadata(
                  context.masterUserId || context.userId,
                  `open_item_snoozed:${ea.openItemId}`,
                  `Snoozed bis ${snoozeUntil}`,
                  'general', 'feedback', 1.0, 'auto',
                );
                if (adapter) await adapter.sendMessage(chatId, `⏰ Zurückgestellt — Erinnerung in ${deferHours}h.`);
              } catch (err) {
                if (adapter) await adapter.sendMessage(chatId, `⚠️ Defer fehlgeschlagen: ${(err as Error).message}`);
              }
            } else if (adapter) {
              await adapter.sendMessage(chatId, `⏰ Zurückgestellt.`);
            }
            break;
          }
        }
        this.activityLogger?.logConfirmation({
          confirmationId: pending.id, skillName: pending.skillName, description: pending.description,
          source: pending.source, sourceId: pending.sourceId, outcome: 'approved',
          userId: context.userId, platform, chatId,
        });
      } catch (err) {
        this.logger.error({ err, confirmationId: pending.id, key: callbackKey }, 'Extra-Action fehlgeschlagen');
        if (adapter) await adapter.sendMessage(chatId, `❌ ${ea.label} fehlgeschlagen: ${(err as Error).message}`);
      }
      return true;
    }

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
    /** v657 — kann auch ein custom extra-action key sein (z.B. 'cancel_item', 'snooze_24h') */
    decision: 'approve' | 'reject' | string;
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

  async listPendingForUser(userId: string | string[], limit = 50): Promise<PendingConfirmation[]> {
    if (typeof (this.confirmRepo as unknown as { findAllPendingForUser?: unknown }).findAllPendingForUser !== 'function') {
      return [];
    }
    return (this.confirmRepo as unknown as { findAllPendingForUser: (u: string | string[], l: number) => Promise<PendingConfirmation[]> }).findAllPendingForUser(userId, limit);
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
