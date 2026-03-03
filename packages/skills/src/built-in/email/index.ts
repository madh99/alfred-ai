export { EmailProvider } from './email-provider.js';
export type { EmailMessage, EmailDetail, EmailAttachment, SendEmailInput } from './email-provider.js';
export { createEmailProvider } from './factory.js';
export { StandardEmailProvider } from './standard-provider.js';
export { MicrosoftGraphEmailProvider } from './microsoft-provider.js';

import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { EmailProvider } from './email-provider.js';

export class EmailSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'email',
    description: 'Access the user\'s email: check inbox, read messages, search emails, send new emails, list folders, read from specific folders, reply to messages, or download attachments. Use when the user asks about their emails or wants to send one.',
    riskLevel: 'write',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inbox', 'read', 'search', 'send', 'folders', 'folder', 'reply', 'attachment'],
          description: 'The email action to perform',
        },
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

  constructor(private readonly provider?: EmailProvider) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    if (!this.provider) {
      return {
        success: false,
        error: 'Email is not configured. Run `alfred setup` to configure email access.',
      };
    }

    const action = input.action as string;

    try {
      switch (action) {
        case 'inbox':
          return await this.handleInbox(input.count as number | undefined);
        case 'read':
          return await this.handleRead(input.messageId as string);
        case 'search':
          return await this.handleSearch(input.query as string, input.count as number | undefined);
        case 'send':
          return await this.handleSend(input);
        case 'folders':
          return await this.handleFolders();
        case 'folder':
          return await this.handleFolder(input.folder as string, input.count as number | undefined);
        case 'reply':
          return await this.handleReply(input.messageId as string, input.body as string);
        case 'attachment':
          return await this.handleAttachment(input.messageId as string, input.attachmentId as string);
        default:
          return { success: false, error: `Unknown action: ${action}. Use: inbox, read, search, send, folders, folder, reply, attachment` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Email error: ${msg}` };
    }
  }

  private async handleInbox(count?: number): Promise<SkillResult> {
    const limit = Math.min(Math.max(1, count ?? 10), 50);
    const messages = await this.provider!.fetchInbox(limit);

    if (messages.length === 0) {
      return { success: true, data: { messages: [] }, display: 'Inbox is empty.' };
    }

    const unreadCount = messages.filter(m => !m.read).length;

    const display = messages.map((m, i) => {
      const unread = m.read ? '' : ' [UNREAD]';
      const att = m.hasAttachments ? ' [ATT]' : '';
      return `${i + 1}. [${m.id}]${unread}${att} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`;
    }).join('\n\n');

    return {
      success: true,
      data: { messages, unreadCount },
      display: `Inbox (${unreadCount} unread):\n\n${display}`,
    };
  }

  private async handleRead(messageId: string): Promise<SkillResult> {
    if (!messageId) {
      return { success: false, error: 'messageId is required.' };
    }

    const detail = await this.provider!.readMessage(messageId);

    const attLine = detail.attachments?.length
      ? `\nAttachments: ${detail.attachments.map(a => `${a.name} (${a.contentType}, ${this.formatSize(a.size)})`).join(', ')}`
      : '';

    return {
      success: true,
      data: detail,
      display: [
        `From: ${detail.from}`,
        `To: ${detail.to.join(', ')}`,
        ...(detail.cc?.length ? [`CC: ${detail.cc.join(', ')}`] : []),
        `Subject: ${detail.subject}`,
        `Date: ${detail.date.toISOString()}`,
        attLine,
        '',
        detail.body.slice(0, 3000) + (detail.body.length > 3000 ? '\n\n... (truncated)' : ''),
      ].join('\n'),
    };
  }

  private async handleSearch(query: string, count?: number): Promise<SkillResult> {
    if (!query) {
      return { success: false, error: 'query is required for search.' };
    }

    const limit = Math.min(Math.max(1, count ?? 10), 50);
    const results = await this.provider!.searchMessages(query, limit);

    if (results.length === 0) {
      return { success: true, data: { results: [] }, display: `No emails found for "${query}".` };
    }

    const display = results.map((m, i) =>
      `${i + 1}. [${m.id}] ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`
    ).join('\n\n');

    return {
      success: true,
      data: { query, results, totalMatches: results.length },
      display: `Search results for "${query}" (${results.length} matches):\n\n${display}`,
    };
  }

  private async handleSend(input: Record<string, unknown>): Promise<SkillResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;

    if (!to) return { success: false, error: '"to" (recipient email) is required.' };
    if (!subject) return { success: false, error: '"subject" is required.' };
    if (!body) return { success: false, error: '"body" is required.' };

    const result = await this.provider!.sendMessage({
      to,
      subject,
      body,
      cc: input.cc as string | undefined,
      isHtml: input.isHtml as boolean | undefined,
    });

    return {
      success: true,
      data: { messageId: result.messageId, to, subject },
      display: `Email sent to ${to}\nSubject: ${subject}\nMessage ID: ${result.messageId}`,
    };
  }

  private async handleFolders(): Promise<SkillResult> {
    const folders = await this.provider!.listFolders();

    return {
      success: true,
      data: { folders },
      display: folders.length === 0
        ? 'No folders found.'
        : `Email folders:\n${folders.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`,
    };
  }

  private async handleFolder(folder: string, count?: number): Promise<SkillResult> {
    if (!folder) {
      return { success: false, error: '"folder" name is required. Use the "folders" action to list available folders.' };
    }

    const limit = Math.min(Math.max(1, count ?? 10), 50);
    const messages = await this.provider!.fetchFolder(folder, limit);

    if (messages.length === 0) {
      return { success: true, data: { messages: [] }, display: `Folder "${folder}" is empty.` };
    }

    const display = messages.map((m, i) => {
      const unread = m.read ? '' : ' [UNREAD]';
      return `${i + 1}. [${m.id}]${unread} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date.toISOString()}`;
    }).join('\n\n');

    return {
      success: true,
      data: { folder, messages },
      display: `Folder "${folder}" (${messages.length} messages):\n\n${display}`,
    };
  }

  private async handleReply(messageId: string, body: string): Promise<SkillResult> {
    if (!messageId) return { success: false, error: '"messageId" is required for reply.' };
    if (!body) return { success: false, error: '"body" is required for reply.' };

    const result = await this.provider!.sendMessage({
      to: '',
      subject: '',
      body,
      replyTo: messageId,
    });

    return {
      success: true,
      data: { messageId: result.messageId },
      display: `Reply sent to message ${messageId}.`,
    };
  }

  private async handleAttachment(messageId: string, attachmentId: string): Promise<SkillResult> {
    if (!messageId) return { success: false, error: '"messageId" is required.' };
    if (!attachmentId) return { success: false, error: '"attachmentId" is required.' };

    // First read the message to get attachment metadata
    const detail = await this.provider!.readMessage(messageId);
    const attMeta = detail.attachments?.find(a => a.id === attachmentId);

    const data = await this.provider!.downloadAttachment(messageId, attachmentId);

    const fileName = attMeta?.name ?? `attachment-${attachmentId}`;
    const mimeType = attMeta?.contentType ?? 'application/octet-stream';

    return {
      success: true,
      data: { messageId, attachmentId, fileName, size: data.length },
      display: `Downloaded attachment: ${fileName} (${this.formatSize(data.length)})`,
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
