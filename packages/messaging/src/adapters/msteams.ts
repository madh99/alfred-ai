/**
 * Microsoft Teams Messaging Adapter — Bot Framework Webhook.
 *
 * Architecture: Teams → Bot Service → HTTPS POST /api/messages → this adapter.
 * Uses the `botbuilder` SDK for Activity parsing, token validation, and reply routing.
 * Externalized dependency: `botbuilder` is lazy-loaded (not a build-time dependency).
 */
import { randomUUID } from 'node:crypto';
import type { NormalizedMessage, SendMessageOptions, MSTeamsConfig } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

// Minimal inline types for botbuilder (lazy-loaded at runtime, no compile-time dependency)
interface BotBuilderModule {
  CloudAdapter: new (auth: unknown) => CloudAdapterInstance;
  ConfigurationBotFrameworkAuthentication: new (config: Record<string, string>) => unknown;
  ActivityTypes: { Message: string; Typing: string };
  TurnContext: { getConversationReference(activity: unknown): Record<string, unknown> };
}

interface CloudAdapterInstance {
  onTurnError: (context: unknown, error: Error) => Promise<void>;
  process(req: unknown, res: unknown, logic: (ctx: unknown) => Promise<void>): Promise<void>;
  continueConversationAsync(appId: string, ref: Record<string, unknown>, logic: (ctx: unknown) => Promise<void>): Promise<void>;
}

export class MSTeamsAdapter extends MessagingAdapter {
  readonly platform = 'msteams' as const;
  private adapter?: CloudAdapterInstance;
  private server?: import('http').Server;
  private botbuilder?: BotBuilderModule;

  /** Stored conversation references for proactive messaging (chatId → ref). */
  private conversationRefs = new Map<string, Record<string, unknown>>();

  constructor(private readonly config: MSTeamsConfig) {
    super();
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    // Lazy-load botbuilder (externalized dependency like mqtt/sonos/ccxt)
    this.botbuilder = await (Function('return import("botbuilder")')() as Promise<BotBuilderModule>);
    const bb = this.botbuilder;

    // Bot Framework Authentication (single-tenant)
    const auth = new bb.ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.config.appId,
      MicrosoftAppPassword: this.config.appPassword,
      MicrosoftAppTenantId: this.config.tenantId,
      MicrosoftAppType: 'SingleTenant',
    });

    // Cloud Adapter handles token validation, activity parsing, response routing
    this.adapter = new bb.CloudAdapter(auth);

    // Global error handler
    this.adapter.onTurnError = async (_context: unknown, error: Error) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    };

    // HTTP server for incoming Bot Framework webhooks
    const http = await import('node:http');
    const port = this.config.webhookPort ?? 3978;
    const path = this.config.webhookPath ?? '/api/messages';

    this.server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === path) {
        try {
          await this.adapter!.process(req, res, (context: unknown) => this.handleTurn(context));
        } catch (err: unknown) {
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
          if (!res.writableEnded) { res.writeHead(500); res.end(); }
        }
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', adapter: 'msteams' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => resolve());
      this.server!.on('error', reject);
    });

    this.status = 'connected';
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    this.adapter = undefined;
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  // ── Incoming Messages ──────────────────────────────────────

  private async handleTurn(context: unknown): Promise<void> {
    const ctx = context as Record<string, unknown>;
    const activity = ctx.activity as Record<string, unknown>;
    const bb = this.botbuilder!;

    // Only handle message activities
    if (activity.type !== bb.ActivityTypes.Message) return;

    // Strip bot @mention from text (Teams prefixes "@BotName" in channels)
    let text = (activity.text as string) ?? '';
    const entities = activity.entities as Array<Record<string, unknown>> | undefined;
    if (entities) {
      for (const entity of entities) {
        if (entity.type === 'mention') {
          const mentioned = entity.mentioned as Record<string, unknown> | undefined;
          if (mentioned?.id === this.config.appId) {
            text = text.replace((entity.text as string) ?? '', '').trim();
          }
        }
      }
    }

    if (!text && !(activity.attachments as unknown[]|undefined)?.length) return;

    // Policy check: DM allowlist
    const from = activity.from as Record<string, unknown> | undefined;
    const senderId = from?.aadObjectId as string | undefined;
    const conversation = activity.conversation as Record<string, unknown>;
    const conversationType = conversation?.conversationType as string | undefined;

    if (this.config.dmPolicy === 'disabled' && conversationType === 'personal') return;
    if (this.config.dmPolicy === 'allowlist' && senderId) {
      if (!this.config.allowedUsers?.includes(senderId)) return;
    }

    // Channel: require @mention if configured (default true)
    if (conversationType === 'channel') {
      const requireMention = this.config.requireMention !== false;
      if (requireMention) {
        const wasMentioned = entities?.some(
          (e) => e.type === 'mention' && (e.mentioned as Record<string, unknown>)?.id === this.config.appId,
        );
        if (!wasMentioned) return;
      }
    }

    // Store ConversationReference for proactive messaging
    const ref = bb.TurnContext.getConversationReference(activity);
    this.conversationRefs.set(conversation.id as string, ref);

    // Determine chat type
    const chatType = conversationType === 'personal' ? 'dm' as const : 'group' as const;

    // Map attachments
    const attachments: NormalizedMessage['attachments'] = [];
    const rawAttachments = activity.attachments as Array<Record<string, unknown>> | undefined;
    if (rawAttachments) {
      for (const att of rawAttachments) {
        if (att.contentUrl) {
          const contentType = att.contentType as string | undefined;
          attachments.push({
            type: contentType?.startsWith('image/') ? 'image' : 'document',
            url: att.contentUrl as string,
            mimeType: contentType ?? undefined,
            fileName: (att.name as string) ?? undefined,
          });
        }
      }
    }

    // Build NormalizedMessage
    const msg: NormalizedMessage = {
      id: (activity.id as string) ?? randomUUID(),
      platform: 'msteams',
      chatId: conversation.id as string,
      chatType,
      userId: senderId ?? (from?.id as string) ?? 'unknown',
      userName: (from?.name as string) ?? 'unknown',
      text,
      timestamp: new Date((activity.timestamp as string) ?? Date.now()),
      replyToMessageId: (activity.replyToId as string) ?? undefined,
      threadId: conversation.id as string,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: activity,
    };

    // Send typing indicator immediately (Teams shows "Alfred is typing...")
    try {
      const sendActivity = (ctx as Record<string, (...args: unknown[]) => Promise<unknown>>).sendActivity;
      if (typeof sendActivity === 'function') {
        await sendActivity.call(ctx, { type: bb.ActivityTypes.Typing });
      }
    } catch { /* best effort */ }

    // Emit to Alfred's message pipeline
    this.emit('message', msg);
  }

  // ── Outgoing Messages ──────────────────────────────────────

  async sendMessage(
    chatId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<string> {
    if (!this.adapter) throw new Error('MS Teams adapter not connected');

    const ref = this.conversationRefs.get(chatId);
    if (!ref) {
      throw new Error(`No conversation reference for chatId "${chatId}". User must message Alfred first.`);
    }

    let sentId = '';
    await this.adapter.continueConversationAsync(
      this.config.appId,
      ref,
      async (context: unknown) => {
        const ctx = context as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
        const response = await ctx.sendActivity(text);
        sentId = (response?.id as string) ?? randomUUID();
      },
    );

    return sentId;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.adapter) return;
    const ref = this.conversationRefs.get(chatId);
    if (!ref) return;

    await this.adapter.continueConversationAsync(
      this.config.appId,
      ref,
      async (context: unknown) => {
        const ctx = context as Record<string, (...args: unknown[]) => Promise<void>>;
        await ctx.updateActivity({ type: 'message', id: messageId, text } as unknown);
      },
    );
  }

  async deleteMessage(
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (!this.adapter) return;
    const ref = this.conversationRefs.get(chatId);
    if (!ref) return;

    await this.adapter.continueConversationAsync(
      this.config.appId,
      ref,
      async (context: unknown) => {
        const ctx = context as Record<string, (...args: unknown[]) => Promise<void>>;
        await ctx.deleteActivity(messageId);
      },
    );
  }

  // ── Utilities ──────────────────────────────────────────────

  /** Get stored conversation references (for persistence on shutdown). */
  getConversationRefs(): Map<string, Record<string, unknown>> {
    return this.conversationRefs;
  }

  /** Restore conversation references (from DB on startup). */
  restoreConversationRefs(refs: Map<string, Record<string, unknown>>): void {
    for (const [k, v] of refs) {
      this.conversationRefs.set(k, v);
    }
  }
}
