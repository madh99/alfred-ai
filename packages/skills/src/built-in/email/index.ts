export { EmailProvider } from './email-provider.js';
export type { EmailMessage, EmailDetail, EmailAttachment, SendEmailInput } from './email-provider.js';
export { createEmailProvider } from './factory.js';
export { StandardEmailProvider } from './standard-provider.js';
export { MicrosoftGraphEmailProvider } from './microsoft-provider.js';

import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { EmailProvider } from './email-provider.js';

export class EmailSkill extends Skill {
  readonly metadata: SkillMetadata;

  private readonly providers: Map<string, EmailProvider>;
  private readonly accountNames: string[];
  private readonly defaultAccount: string;
  private readonly multiAccount: boolean;

  constructor(providers?: Map<string, EmailProvider> | EmailProvider) {
    super();

    if (providers instanceof Map) {
      this.providers = providers;
    } else if (providers) {
      this.providers = new Map([['default', providers]]);
    } else {
      this.providers = new Map();
    }

    this.accountNames = [...this.providers.keys()];
    this.defaultAccount = this.accountNames[0] ?? 'default';
    this.multiAccount = this.providers.size > 1;

    const accountProp = this.multiAccount
      ? {
          account: {
            type: 'string' as const,
            enum: this.accountNames,
            description: `Email account to use (available: ${this.accountNames.join(', ')})`,
          },
        }
      : {};

    const description = this.multiAccount
      ? `Access the user's email accounts (${this.accountNames.join(', ')}): check inbox, read messages, search emails, send new emails, list folders, read from specific folders, reply to messages, or download attachments.`
      : 'Access the user\'s email: check inbox, read messages, search emails, send new emails, list folders, read from specific folders, reply to messages, or download attachments. Use when the user asks about their emails or wants to send one.';

    this.metadata = {
      name: 'email',
      description,
      riskLevel: 'write',
      version: '3.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['inbox', 'read', 'search', 'send', 'folders', 'folder', 'reply', 'attachment'],
            description: 'The email action to perform',
          },
          ...accountProp,
          count: {
            type: 'number',
            description: 'Number of emails to fetch (for inbox/search/folder, default: 10)',
          },
          messageId: {
            type: 'string',
            description: 'Message ID to read or reply to',
          },
          query: {
            type: 'string',
            description: 'Search query (for search action)',
          },
          to: {
            type: 'string',
            description: 'Recipient email address (for send action)',
          },
          subject: {
            type: 'string',
            description: 'Email subject (for send action)',
          },
          body: {
            type: 'string',
            description: 'Email body text (for send/reply action)',
          },
          cc: {
            type: 'string',
            description: 'CC recipients, comma-separated (for send action)',
          },
          folder: {
            type: 'string',
            description: 'Folder name (for folder action)',
          },
          attachmentId: {
            type: 'string',
            description: 'Attachment ID (for attachment action)',
          },
          isHtml: {
            type: 'boolean',
            description: 'Whether the body is HTML (for send action)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    if (this.providers.size === 0) {
      return {
        success: false,
        error: 'Email is not configured. Run `alfred setup` to configure email access.',
      };
    }

    const action = input.action as string;

    try {
      switch (action) {
        case 'inbox':
          return await this.handleInbox(input);
        case 'read':
          return await this.handleRead(input);
        case 'search':
          return await this.handleSearch(input);
        case 'send':
          return await this.handleSend(input);
        case 'folders':
          return await this.handleFolders(input);
        case 'folder':
          return await this.handleFolder(input);
        case 'reply':
          return await this.handleReply(input);
        case 'attachment':
          return await this.handleAttachment(input);
        default:
          return { success: false, error: `Unknown action: ${action}. Use: inbox, read, search, send, folders, folder, reply, attachment` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Email error: ${msg}` };
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private resolveProvider(input: Record<string, unknown>): { provider: EmailProvider; account: string } | SkillResult {
    const account = (input.account as string) ?? this.defaultAccount;
    const provider = this.providers.get(account);
    if (!provider) {
      return {
        success: false,
        error: `Unknown email account "${account}". Available: ${this.accountNames.join(', ')}`,
      };
    }
    return { provider, account };
  }

  private encodeId(account: string, rawId: string): string {
    return this.multiAccount ? `${account}::${rawId}` : rawId;
  }

  private decodeId(compositeId: string): { account: string; rawId: string } {
    if (this.multiAccount) {
      const idx = compositeId.indexOf('::');
      if (idx >= 0) {
        return { account: compositeId.slice(0, idx), rawId: compositeId.slice(idx + 2) };
      }
    }
    return { account: this.defaultAccount, rawId: compositeId };
  }

  private accountLabel(account: string, text: string): string {
    return this.multiAccount ? `[${account}] ${text}` : text;
  }

  // ── Handlers ─────────────────────────────────────────────────────

  private async handleInbox(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const limit = Math.min(Math.max(1, (input.count as number | undefined) ?? 10), 50);
    const messages = await provider.fetchInbox(limit);

    if (messages.length === 0) {
      return { success: true, data: { messages: [] }, display: this.accountLabel(account, 'Inbox is empty.') };
    }

    const unreadCount = messages.filter(m => !m.read).length;

    const display = messages.map((m, i) => {
      const unread = m.read ? '' : ' [UNREAD]';
      const att = m.hasAttachments ? ' [ATT]' : '';
      return `${i + 1}. [${this.encodeId(account, m.id)}]${unread}${att} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`;
    }).join('\n\n');

    return {
      success: true,
      data: { messages: messages.map(m => ({ ...m, id: this.encodeId(account, m.id) })), unreadCount },
      display: this.accountLabel(account, `Inbox (${unreadCount} unread):\n\n${display}`),
    };
  }

  private async handleRead(input: Record<string, unknown>): Promise<SkillResult> {
    const messageId = input.messageId as string;
    if (!messageId) {
      return { success: false, error: 'messageId is required.' };
    }

    const { account, rawId } = this.decodeId(messageId);
    const provider = this.providers.get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const detail = await provider.readMessage(rawId);

    const attLine = detail.attachments?.length
      ? `\nAttachments: ${detail.attachments.map(a => `${a.name} (${a.contentType}, ${this.formatSize(a.size)})`).join(', ')}`
      : '';

    return {
      success: true,
      data: { ...detail, id: this.encodeId(account, detail.id) },
      display: this.accountLabel(account, [
        `From: ${detail.from}`,
        `To: ${detail.to.join(', ')}`,
        ...(detail.cc?.length ? [`CC: ${detail.cc.join(', ')}`] : []),
        `Subject: ${detail.subject}`,
        `Date: ${detail.date.toISOString()}`,
        attLine,
        '',
        detail.body.slice(0, 3000) + (detail.body.length > 3000 ? '\n\n... (truncated)' : ''),
      ].join('\n')),
    };
  }

  private async handleSearch(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) {
      return { success: false, error: 'query is required for search.' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const limit = Math.min(Math.max(1, (input.count as number | undefined) ?? 10), 50);
    const results = await provider.searchMessages(query, limit);

    if (results.length === 0) {
      return { success: true, data: { results: [] }, display: this.accountLabel(account, `No emails found for "${query}".`) };
    }

    const display = results.map((m, i) =>
      `${i + 1}. [${this.encodeId(account, m.id)}] ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`
    ).join('\n\n');

    return {
      success: true,
      data: { query, results: results.map(m => ({ ...m, id: this.encodeId(account, m.id) })), totalMatches: results.length },
      display: this.accountLabel(account, `Search results for "${query}" (${results.length} matches):\n\n${display}`),
    };
  }

  private async handleSend(input: Record<string, unknown>): Promise<SkillResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;

    if (!to) return { success: false, error: '"to" (recipient email) is required.' };
    if (!subject) return { success: false, error: '"subject" is required.' };
    if (!body) return { success: false, error: '"body" is required.' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const result = await provider.sendMessage({
      to,
      subject,
      body,
      cc: input.cc as string | undefined,
      isHtml: input.isHtml as boolean | undefined,
    });

    return {
      success: true,
      data: { messageId: result.messageId, to, subject },
      display: this.accountLabel(account, `Email sent to ${to}\nSubject: ${subject}\nMessage ID: ${result.messageId}`),
    };
  }

  private async handleFolders(input: Record<string, unknown>): Promise<SkillResult> {
    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const folders = await provider.listFolders();

    return {
      success: true,
      data: { folders },
      display: folders.length === 0
        ? this.accountLabel(account, 'No folders found.')
        : this.accountLabel(account, `Email folders:\n${folders.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`),
    };
  }

  private async handleFolder(input: Record<string, unknown>): Promise<SkillResult> {
    const folder = input.folder as string;
    if (!folder) {
      return { success: false, error: '"folder" name is required. Use the "folders" action to list available folders.' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const limit = Math.min(Math.max(1, (input.count as number | undefined) ?? 10), 50);
    const messages = await provider.fetchFolder(folder, limit);

    if (messages.length === 0) {
      return { success: true, data: { messages: [] }, display: this.accountLabel(account, `Folder "${folder}" is empty.`) };
    }

    const display = messages.map((m, i) => {
      const unread = m.read ? '' : ' [UNREAD]';
      return `${i + 1}. [${this.encodeId(account, m.id)}]${unread} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`;
    }).join('\n\n');

    return {
      success: true,
      data: { folder, messages: messages.map(m => ({ ...m, id: this.encodeId(account, m.id) })) },
      display: this.accountLabel(account, `Folder "${folder}" (${messages.length} messages):\n\n${display}`),
    };
  }

  private async handleReply(input: Record<string, unknown>): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const body = input.body as string;
    if (!messageId) return { success: false, error: '"messageId" is required for reply.' };
    if (!body) return { success: false, error: '"body" is required for reply.' };

    const { account, rawId } = this.decodeId(messageId);
    const provider = this.providers.get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const result = await provider.sendMessage({
      to: '',
      subject: '',
      body,
      replyTo: rawId,
    });

    return {
      success: true,
      data: { messageId: result.messageId },
      display: this.accountLabel(account, `Reply sent to message ${rawId}.`),
    };
  }

  private async handleAttachment(input: Record<string, unknown>): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const attachmentId = input.attachmentId as string;
    if (!messageId) return { success: false, error: '"messageId" is required.' };
    if (!attachmentId) return { success: false, error: '"attachmentId" is required.' };

    const { account, rawId } = this.decodeId(messageId);
    const provider = this.providers.get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const detail = await provider.readMessage(rawId);
    const attMeta = detail.attachments?.find(a => a.id === attachmentId);

    const data = await provider.downloadAttachment(rawId, attachmentId);

    const fileName = attMeta?.name ?? `attachment-${attachmentId}`;
    const mimeType = attMeta?.contentType ?? 'application/octet-stream';

    return {
      success: true,
      data: { messageId, attachmentId, fileName, size: data.length },
      display: this.accountLabel(account, `Downloaded attachment: ${fileName} (${this.formatSize(data.length)})`),
      attachments: [{
        fileName,
        data,
        mimeType,
      }],
    };
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
