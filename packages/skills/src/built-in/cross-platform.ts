import type {
  SkillMetadata,
  SkillContext,
  SkillResult,
} from '@alfred/types';
import { Skill } from '../skill.js';
import type { UserRepository } from '@alfred/storage';
import type { LinkTokenRepository } from '@alfred/storage';
import type { Platform } from '@alfred/types';

/** Minimal adapter interface to avoid depending on @alfred/messaging. */
export interface CrossPlatformAdapter {
  sendMessage(chatId: string, text: string): Promise<string>;
  sendFile?(chatId: string, file: Buffer, fileName: string, caption?: string): Promise<string | undefined>;
  sendDirectMessage?(userId: string, text: string): Promise<string | undefined>;
}

/** Minimal Alfred user repo interface for username → platform lookup. */
export interface AlfredUserLookup {
  getByUsername(username: string): Promise<{ id: string; username: string } | undefined>;
  getPlatformLinks(userId: string): Promise<Array<{ platform: string; platformUserId: string }>>;
}

/** Resolve chat_id for a linked user on another platform. */
export type FindConversationFn = (platform: string, userId: string) => Promise<{ chatId: string } | undefined> | { chatId: string } | undefined;

/**
 * CrossPlatformSkill intentionally does NOT use the shared effectiveUserId/allUserIds
 * utilities from user-utils.ts because it is the skill that *mutates* the user-linking
 * graph (setMasterUser, link/unlink). It needs direct UserRepository access for
 * findOrCreate, getMasterUserId, setMasterUser, and getLinkedUsers.
 */
export class CrossPlatformSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'cross_platform',
    category: 'identity',
    description:
      'Manage cross-platform identity linking and messaging. ' +
      'Actions: link_start (generate a linking code on current platform), ' +
      'link_confirm (enter a code from another platform to link accounts), ' +
      'send_message (send a message to your own linked platform), ' +
      'send_to_user (send a message/file to another person), ' +
      'send_to_self (send a message/file to YOURSELF on another platform — only needs platform, no username), ' +
      'list_identities (show all linked platforms), ' +
      'unlink (remove a platform link).',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['link_start', 'link_confirm', 'send_message', 'send_to_user', 'send_to_self', 'list_identities', 'unlink'],
          description: 'The action to perform',
        },
        code: {
          type: 'string',
          description: 'The 6-digit linking code (for link_confirm)',
        },
        platform: {
          type: 'string',
          description: 'Target platform: telegram, matrix, discord, whatsapp, signal (for send_message, send_to_user, or unlink)',
        },
        chat_id: {
          type: 'string',
          description: 'Target chat ID (for send_message)',
        },
        message: {
          type: 'string',
          description: 'Message text to send (for send_message/send_to_user)',
        },
        username: {
          type: 'string',
          description: 'Alfred username or platform user ID of recipient (for send_to_user). OPTIONAL — if omitted, sends to yourself on the target platform.',
        },
        attachment_key: {
          type: 'string',
          description: 'FileStore key to send as file attachment (for send_to_user, optional). Get from file list_store or code_sandbox response.',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly users: UserRepository,
    private readonly linkTokens: LinkTokenRepository,
    private readonly adapters: Map<Platform, CrossPlatformAdapter>,
    private readonly findConversation?: FindConversationFn,
    private alfredUsers?: AlfredUserLookup,
  ) {
    super();
  }

  /** Set Alfred user lookup (called after multi-user init). */
  setAlfredUserLookup(lookup: AlfredUserLookup): void {
    this.alfredUsers = lookup;
  }

  /** Resolve platform user ID to internal DB UUID via findOrCreate. */
  private async resolveInternalId(context: SkillContext): Promise<string> {
    return (await this.users.findOrCreate(context.platform as Platform, context.userId)).id;
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'link_start':
        return this.linkStart(context);
      case 'link_confirm':
        return this.linkConfirm(input, context);
      case 'send_message':
        return this.sendMessage(input, context);
      case 'send_to_user':
        return this.sendToUser(input, context);
      case 'send_to_self':
        return this.sendToUser({ ...input, username: undefined }, context);
      case 'list_identities':
        return this.listIdentities(context);
      case 'unlink':
        return this.unlink(input, context);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  private failedConfirmAttempts = new Map<string, { count: number; resetAt: number }>();

  private checkConfirmRateLimit(userId: string): string | null {
    const now = Date.now();
    const entry = this.failedConfirmAttempts.get(userId);
    if (entry && now < entry.resetAt && entry.count >= 5) {
      const waitSec = Math.ceil((entry.resetAt - now) / 1000);
      return `Too many failed attempts. Please wait ${waitSec}s before trying again.`;
    }
    return null;
  }

  private recordFailedConfirm(userId: string): void {
    const now = Date.now();
    const entry = this.failedConfirmAttempts.get(userId);
    if (entry && now < entry.resetAt) {
      entry.count++;
    } else {
      this.failedConfirmAttempts.set(userId, { count: 1, resetAt: now + 5 * 60_000 });
    }
  }

  private async linkStart(context: SkillContext): Promise<SkillResult> {
    // Clean up expired tokens first
    await this.linkTokens.cleanup();

    const internalId = await this.resolveInternalId(context);

    // Rate limit: max 5 active codes per user per 10 minutes
    const recentCount = await this.linkTokens.countRecentByUser(internalId, 10);
    if (recentCount >= 5) {
      return { success: false, error: 'Too many linking codes generated recently. Please wait a few minutes.' };
    }

    const token = await this.linkTokens.create(internalId, context.platform);

    return {
      success: true,
      data: { code: token.code, expiresAt: token.expiresAt },
      display:
        `Your linking code is: **${token.code}**\n\n` +
        `Enter this code on your other platform within 10 minutes using:\n` +
        `"Link my account with code ${token.code}"`,
    };
  }

  private async linkConfirm(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const code = input.code as string | undefined;
    if (!code) {
      return { success: false, error: 'Missing required field "code"' };
    }

    const currentInternalId = await this.resolveInternalId(context);

    // Rate limit failed confirmation attempts (max 5 per 5 minutes)
    const rateLimitError = this.checkConfirmRateLimit(currentInternalId);
    if (rateLimitError) {
      return { success: false, error: rateLimitError };
    }

    const token = await this.linkTokens.findByCode(code.trim());
    if (!token) {
      this.recordFailedConfirm(currentInternalId);
      return {
        success: false,
        error: 'Invalid or expired linking code. Please generate a new one.',
      };
    }

    // token.userId is already an internal UUID (stored by linkStart)
    const tokenInternalId = token.userId;

    // Don't allow linking to yourself on the same platform
    if (tokenInternalId === currentInternalId) {
      return {
        success: false,
        error: 'Cannot link an account to itself. Use the code on a different platform.',
      };
    }

    // Determine master user: use existing master if either user already has one
    const existingMaster1 = await this.users.getMasterUserId(tokenInternalId);
    const existingMaster2 = await this.users.getMasterUserId(currentInternalId);

    let masterUserId: string;
    if (existingMaster1 !== tokenInternalId) {
      masterUserId = existingMaster1;
    } else if (existingMaster2 !== currentInternalId) {
      masterUserId = existingMaster2;
    } else {
      masterUserId = tokenInternalId;
    }

    // If BOTH users have different existing master groups, merge them
    if (
      existingMaster1 !== tokenInternalId &&
      existingMaster2 !== currentInternalId &&
      existingMaster1 !== existingMaster2
    ) {
      const groupToMerge = await this.users.getLinkedUsers(existingMaster2);
      for (const u of groupToMerge) {
        await this.users.setMasterUser(u.id, masterUserId);
      }
    }

    // Link both users to the master
    if (tokenInternalId !== masterUserId) {
      await this.users.setMasterUser(tokenInternalId, masterUserId);
    }
    if (currentInternalId !== masterUserId) {
      await this.users.setMasterUser(currentInternalId, masterUserId);
    }

    // Consume the token
    await this.linkTokens.consume(token.id);

    const tokenUser = await this.users.findById(tokenInternalId);
    const platformName = token.platform;

    return {
      success: true,
      data: { masterUserId, linkedPlatform: platformName },
      display:
        `Account linked successfully! Your ${platformName} account ` +
        `(${tokenUser?.displayName ?? tokenUser?.username ?? 'unknown'}) ` +
        `is now linked to this ${context.platform} account.\n\n` +
        `Your memories, preferences, and context are now shared across platforms.`,
    };
  }

  private async sendMessage(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const platform = input.platform as string | undefined;
    let chatId = input.chat_id as string | undefined;
    const message = input.message as string | undefined;

    if (!platform) {
      return { success: false, error: 'Missing required field "platform"' };
    }
    if (!message) {
      return { success: false, error: 'Missing required field "message"' };
    }

    const adapter = this.adapters.get(platform as Platform);
    if (!adapter) {
      return {
        success: false,
        error: `Platform "${platform}" is not connected. Available: ${[...this.adapters.keys()].join(', ')}`,
      };
    }

    // Resolve chat_id: try DB conversation lookup for linked user on target platform
    if (!chatId || !/^[!0-9]/.test(chatId)) {
      const currentInternalId = await this.resolveInternalId(context);
      const masterUserId = await this.users.getMasterUserId(currentInternalId);
      const linked = await this.users.getLinkedUsers(masterUserId);
      const targetUser = linked.find(u => u.platform === platform);
      if (targetUser && this.findConversation) {
        const conv = await this.findConversation(platform, targetUser.id);
        if (conv) {
          // Matrix chatId format: "!roomId:server:@user:server" — extract room ID
          chatId = conv.chatId.startsWith('!') ? conv.chatId.split(':').slice(0, 2).join(':') : conv.chatId;
        }
      }
      // Fallback to platformUserId for Telegram DMs
      if (!chatId && targetUser) {
        chatId = targetUser.platformUserId;
      }
    }

    if (!chatId) {
      return { success: false, error: 'Could not resolve chat_id for target platform. No linked account or conversation found.' };
    }

    try {
      const messageId = await adapter.sendMessage(chatId, message);
      return {
        success: true,
        data: { messageId, platform, chatId },
        display: `Message sent to ${platform}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to send message: ${msg}` };
    }
  }

  // Rate limiting for send_to_user
  private sendRateLimits = new Map<string, { count: number; resetAt: number }>();

  private async sendToUser(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const targetUsername = input.username as string | undefined;
    const message = input.message as string | undefined;
    const platform = input.platform as string | undefined;
    const attachmentKey = input.attachment_key as string | undefined;

    // If no username provided, assume self-send (user wants to send to themselves on another platform)
    const isSelfSendImplicit = !targetUsername || ['mir', 'mich', 'me', 'myself', 'ich', 'self'].includes((targetUsername ?? '').toLowerCase());
    const resolvedUsername = isSelfSendImplicit ? undefined : targetUsername;
    if (!message && !attachmentKey) return { success: false, error: 'Missing "message" or "attachment_key" — at least one is required.' };

    // Rate limit: max 10 sends per minute per sender
    const senderId = context.userId;
    const now = Date.now();
    const limit = this.sendRateLimits.get(senderId);
    if (limit && now < limit.resetAt && limit.count >= 10) {
      return { success: false, error: 'Zu viele Nachrichten. Bitte warte eine Minute.' };
    }
    if (!limit || now >= (limit?.resetAt ?? 0)) {
      this.sendRateLimits.set(senderId, { count: 1, resetAt: now + 60_000 });
    } else {
      limit.count++;
    }

    // Resolve recipient: try Alfred username first, then platform user ID
    let targetPlatform = platform;
    let targetChatId: string | undefined;

    // 1. Check if sending to self (use cross-platform linked identities)
    const currentInternalId = await this.resolveInternalId(context);
    const masterUserId = await this.users.getMasterUserId(currentInternalId);
    const linkedUsers = await this.users.getLinkedUsers(masterUserId);

    // If no username or self-keywords → self-send
    let isSelf = isSelfSendImplicit;

    // If username provided, check if it matches own identity
    if (!isSelf && resolvedUsername) {
      isSelf = linkedUsers.some(u =>
        u.username?.toLowerCase() === resolvedUsername.toLowerCase()
        || u.displayName?.toLowerCase() === resolvedUsername.toLowerCase()
        || u.platformUserId === resolvedUsername
      );

      // Also check Alfred username (e.g. "admin" is the Alfred username but not in users table)
      if (!isSelf && this.alfredUsers) {
        const callerAlfred = await this.alfredUsers.getByUsername(resolvedUsername);
        if (callerAlfred) {
          const callerLinks = await this.alfredUsers.getPlatformLinks(callerAlfred.id);
          const callerPlatformLink = callerLinks.find(l => l.platform === context.platform && l.platformUserId === context.userId);
          if (callerPlatformLink) isSelf = true;
        }
      }
    }

    if (isSelf) {
      // Send to own linked platform — prefer Alfred user platform links (more complete)
      if (this.alfredUsers) {
        let alfredUser = resolvedUsername ? await this.alfredUsers.getByUsername(resolvedUsername) : undefined;
        if (!alfredUser) {
          for (const u of linkedUsers) {
            if (u.username) {
              alfredUser = await this.alfredUsers.getByUsername(u.username);
              if (alfredUser) break;
            }
          }
        }
        if (alfredUser) {
          const links = await this.alfredUsers.getPlatformLinks(alfredUser.id);
          const link = targetPlatform
            ? links.find(l => l.platform === targetPlatform)
            : links.find(l => l.platform !== context.platform && this.adapters.has(l.platform as Platform));
          if (link) {
            targetPlatform = link.platform;
            targetChatId = link.platformUserId;
          }
        }
      }
      // Fallback to users table linked identities
      if (!targetChatId) {
        const targetLinked = targetPlatform
          ? linkedUsers.find(u => u.platform === targetPlatform)
          : linkedUsers.find(u => u.platform !== context.platform && this.adapters.has(u.platform as Platform));
        if (targetLinked) {
          targetPlatform = targetLinked.platform;
          targetChatId = targetLinked.platformUserId;
        }
      }
    }

    // 2. Try Alfred user lookup (other users)
    if (!targetChatId && resolvedUsername && this.alfredUsers) {
      const alfredUser = await this.alfredUsers.getByUsername(resolvedUsername);
      if (alfredUser) {
        const links = await this.alfredUsers.getPlatformLinks(alfredUser.id);
        if (targetPlatform) {
          const link = links.find(l => l.platform === targetPlatform);
          targetChatId = link?.platformUserId;
        } else {
          for (const link of links) {
            if (this.adapters.has(link.platform as Platform)) {
              targetPlatform = link.platform;
              targetChatId = link.platformUserId;
              break;
            }
          }
        }
      }
    }

    // 2. Try conversation DB lookup (resolves Matrix user ID → room ID)
    if (targetChatId && targetPlatform && this.findConversation) {
      try {
        const internalUser = await this.users.findOrCreate(targetPlatform as Platform, targetChatId);
        const conv = await this.findConversation(targetPlatform, internalUser.id);
        if (conv) {
          // Matrix chatId format: "!roomId:server:@user:server" — extract room ID
          const resolved = conv.chatId.startsWith('!') ? conv.chatId.split(':').slice(0, 2).join(':') : conv.chatId;
          if (resolved) targetChatId = resolved;
        }
      } catch (convErr) {
        // Log but continue with platformUserId
        console.error('[cross_platform] Conversation lookup failed:', (convErr as Error).message);
      }
    }

    // 3. Last resort: treat username as chatId directly (e.g. Telegram numeric ID)
    if (!targetChatId && resolvedUsername) {
      targetChatId = resolvedUsername;
      if (!targetPlatform) targetPlatform = [...this.adapters.keys()][0];
    }

    if (!targetPlatform || !targetChatId) {
      return { success: false, error: `Empfänger "${targetUsername}" nicht gefunden. Kein Alfred-User und kein bekannter Kontakt.` };
    }

    const adapter = this.adapters.get(targetPlatform as Platform);
    if (!adapter) {
      return { success: false, error: `Plattform "${targetPlatform}" ist nicht verbunden. Verfügbar: ${[...this.adapters.keys()].join(', ')}` };
    }

    try {
      // For platforms that use user IDs instead of chat IDs (Matrix: @user:server, Discord: username),
      // use sendDirectMessage which creates/finds a DM room/channel automatically.
      const isUserId = targetChatId.startsWith('@') || (targetPlatform === 'discord' && !/^\d+$/.test(targetChatId));

      if (isUserId && adapter.sendDirectMessage) {
        // DM path: sendDirectMessage handles room/channel creation
        if (message) {
          await adapter.sendDirectMessage(targetChatId, message);
        }
        if (attachmentKey && context.fileStore && adapter.sendFile) {
          // For Matrix/Discord DMs: sendDirectMessage ensures room exists,
          // then we need the room ID for sendFile. Use sendDirectMessage with file info as text fallback.
          const data = await context.fileStore.read(attachmentKey, context.userId);
          const rawName = attachmentKey.split('/').pop() ?? attachmentKey;
          const fileName = rawName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, '');
          // Try sendFile with user ID — Telegram/WhatsApp handle this fine,
          // Matrix will fail but we already sent the text message above
          try {
            await adapter.sendFile(targetChatId, data, fileName);
          } catch {
            // Matrix sendFile needs room ID, not user ID — send as DM text with filename
            if (message) {
              // Text already sent, inform about file limitation
              await adapter.sendDirectMessage!(targetChatId, `📎 Datei: ${fileName} (Datei-Versand über DM wird noch nicht unterstützt auf ${targetPlatform})`);
            }
          }
        }
      } else {
        // Direct chat ID path (Telegram numeric ID, Matrix room ID, etc.)
        if (message) {
          await adapter.sendMessage(targetChatId, message);
        }
        if (attachmentKey && context.fileStore) {
          const data = await context.fileStore.read(attachmentKey, context.userId);
          const rawName = attachmentKey.split('/').pop() ?? attachmentKey;
          const fileName = rawName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, '');
          if (adapter.sendFile) {
            await adapter.sendFile(targetChatId, data, fileName);
          } else {
            return { success: false, error: `Plattform "${targetPlatform}" unterstützt keinen Dateiversand.` };
          }
        }
      }

      const parts = [];
      if (message) parts.push(`Nachricht an ${targetUsername} (${targetPlatform}) gesendet`);
      if (attachmentKey) parts.push(`Datei gesendet`);

      return {
        success: true,
        data: { platform: targetPlatform, chatId: targetChatId, hasAttachment: !!attachmentKey },
        display: `✅ ${parts.join(' + ')}.`,
      };
    } catch (err) {
      return { success: false, error: `Senden fehlgeschlagen: ${(err as Error).message} [targetChatId=${targetChatId}, platform=${targetPlatform}, isUserId=${targetChatId?.startsWith('@')}]` };
    }
  }

  private async listIdentities(context: SkillContext): Promise<SkillResult> {
    const currentInternalId = await this.resolveInternalId(context);
    const masterUserId = await this.users.getMasterUserId(currentInternalId);
    const linkedUsers = await this.users.getLinkedUsers(masterUserId);

    if (linkedUsers.length <= 1) {
      return {
        success: true,
        data: { identities: linkedUsers },
        display:
          'No linked accounts found. To link another platform, use:\n' +
          '"Start linking my account" on the platform you want to link from, ' +
          'then enter the code on the other platform.',
      };
    }

    const lines = linkedUsers.map(u => {
      const isCurrent = u.id === currentInternalId ? ' (current)' : '';
      const name = u.displayName ?? u.username ?? u.platformUserId;
      return `- **${u.platform}**: ${name}${isCurrent}`;
    });

    return {
      success: true,
      data: { identities: linkedUsers.map(u => ({ platform: u.platform, username: u.username, displayName: u.displayName })) },
      display: `Linked accounts:\n${lines.join('\n')}`,
    };
  }

  private async unlink(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const platform = input.platform as string | undefined;
    if (!platform) {
      return { success: false, error: 'Missing required field "platform"' };
    }

    const currentInternalId = await this.resolveInternalId(context);
    const masterUserId = await this.users.getMasterUserId(currentInternalId);
    const linkedUsers = await this.users.getLinkedUsers(masterUserId);

    const targetUser = linkedUsers.find(u => u.platform === platform && u.id !== currentInternalId);
    if (!targetUser) {
      return {
        success: false,
        error: `No linked account found on platform "${platform}".`,
      };
    }

    // Remove the link by clearing master_user_id
    await this.users.setMasterUser(targetUser.id, targetUser.id);

    return {
      success: true,
      data: { unlinkedPlatform: platform, unlinkedUserId: targetUser.id },
      display: `Unlinked ${platform} account (${targetUser.displayName ?? targetUser.username ?? targetUser.platformUserId}).`,
    };
  }
}
