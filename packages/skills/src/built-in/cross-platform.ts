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
}

export class CrossPlatformSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'cross_platform',
    description:
      'Manage cross-platform identity linking and messaging. ' +
      'Actions: link_start (generate a linking code on current platform), ' +
      'link_confirm (enter a code from another platform to link accounts), ' +
      'send_message (send a message to a linked platform), ' +
      'list_identities (show all linked platforms), ' +
      'unlink (remove a platform link).',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['link_start', 'link_confirm', 'send_message', 'list_identities', 'unlink'],
          description: 'The action to perform',
        },
        code: {
          type: 'string',
          description: 'The 6-digit linking code (for link_confirm)',
        },
        platform: {
          type: 'string',
          description: 'Target platform (for send_message or unlink)',
        },
        chat_id: {
          type: 'string',
          description: 'Target chat ID (for send_message)',
        },
        message: {
          type: 'string',
          description: 'Message text to send (for send_message)',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly users: UserRepository,
    private readonly linkTokens: LinkTokenRepository,
    private readonly adapters: Map<Platform, CrossPlatformAdapter>,
  ) {
    super();
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
        return this.sendMessage(input);
      case 'list_identities':
        return this.listIdentities(context);
      case 'unlink':
        return this.unlink(input, context);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  private async linkStart(context: SkillContext): Promise<SkillResult> {
    // Clean up expired tokens first
    this.linkTokens.cleanup();

    const token = this.linkTokens.create(context.userId, context.platform);

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

    const token = this.linkTokens.findByCode(code.trim());
    if (!token) {
      return {
        success: false,
        error: 'Invalid or expired linking code. Please generate a new one.',
      };
    }

    // Don't allow linking to yourself on the same platform
    if (token.userId === context.userId) {
      return {
        success: false,
        error: 'Cannot link an account to itself. Use the code on a different platform.',
      };
    }

    // Determine master user: use existing master if either user already has one
    const existingMaster1 = this.users.getMasterUserId(token.userId);
    const existingMaster2 = this.users.getMasterUserId(context.userId);

    let masterUserId: string;
    if (existingMaster1 !== token.userId) {
      // Token user already has a master — use it
      masterUserId = existingMaster1;
    } else if (existingMaster2 !== context.userId) {
      // Current user already has a master — use it
      masterUserId = existingMaster2;
    } else {
      // Neither has a master — use the token user as master
      masterUserId = token.userId;
    }

    // Link both users to the master
    if (token.userId !== masterUserId) {
      this.users.setMasterUser(token.userId, masterUserId);
    }
    if (context.userId !== masterUserId) {
      this.users.setMasterUser(context.userId, masterUserId);
    }

    // Consume the token
    this.linkTokens.consume(token.id);

    const tokenUser = this.users.findById(token.userId);
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
  ): Promise<SkillResult> {
    const platform = input.platform as string | undefined;
    const chatId = input.chat_id as string | undefined;
    const message = input.message as string | undefined;

    if (!platform) {
      return { success: false, error: 'Missing required field "platform"' };
    }
    if (!chatId) {
      return { success: false, error: 'Missing required field "chat_id"' };
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

    try {
      const messageId = await adapter.sendMessage(chatId, message);
      return {
        success: true,
        data: { messageId, platform, chatId },
        display: `Message sent to ${platform} (chat ${chatId}).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to send message: ${msg}` };
    }
  }

  private async listIdentities(context: SkillContext): Promise<SkillResult> {
    const masterUserId = this.users.getMasterUserId(context.userId);
    const linkedUsers = this.users.getLinkedUsers(masterUserId);

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
      const isCurrent = u.id === context.userId ? ' (current)' : '';
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

    const masterUserId = this.users.getMasterUserId(context.userId);
    const linkedUsers = this.users.getLinkedUsers(masterUserId);

    const targetUser = linkedUsers.find(u => u.platform === platform && u.id !== context.userId);
    if (!targetUser) {
      return {
        success: false,
        error: `No linked account found on platform "${platform}".`,
      };
    }

    // Remove the link by clearing master_user_id
    this.users.setMasterUser(targetUser.id, targetUser.id);

    return {
      success: true,
      data: { unlinkedPlatform: platform, unlinkedUserId: targetUser.id },
      display: `Unlinked ${platform} account (${targetUser.displayName ?? targetUser.username ?? targetUser.platformUserId}).`,
    };
  }
}
