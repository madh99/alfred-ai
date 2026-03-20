export { EmailProvider } from './email-provider.js';
export type { EmailMessage, EmailDetail, EmailAttachment, SendEmailInput, SendEmailAttachment } from './email-provider.js';
export { createEmailProvider } from './factory.js';
export { StandardEmailProvider } from './standard-provider.js';
export { MicrosoftGraphEmailProvider } from './microsoft-provider.js';

import type { SkillMetadata, SkillContext, SkillResult, LLMRequest, LLMResponse } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { EmailProvider, SendEmailAttachment } from './email-provider.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Minimal LLM interface to avoid hard dependency on @alfred/llm. */
interface EmailLLM {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export class EmailSkill extends Skill {
  readonly metadata: SkillMetadata;

  private readonly providers: Map<string, EmailProvider>;
  private readonly accountNames: string[];
  private readonly defaultAccount: string;
  private readonly multiAccount: boolean;
  private llm?: EmailLLM;

  /** Per-request override for user-specific providers (set in execute, cleared in finally). */
  private activeProviders?: Map<string, EmailProvider>;

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

    const accountProp = {
      account: {
        type: 'string' as const,
        description: 'Email account name. Use list_accounts to see available accounts.',
      },
    };

    const description = 'Access your email: check inbox, read, search, send, draft, reply, forward, attachment. Use "list_accounts" to see available email accounts. Use "draft" instead of "send" when the user asks to prepare/draft an email without sending it.';

    this.metadata = {
      name: 'email',
      category: 'productivity',
      description,
      riskLevel: 'write',
      version: '3.1.0',
      timeoutMs: 300_000, // 5 min — extract action may read hundreds of emails
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['inbox', 'read', 'search', 'send', 'draft', 'folders', 'folder', 'reply', 'forward', 'attachment', 'extract', 'summarize_inbox', 'categorize', 'list_accounts'],
            description: 'The email action to perform. Use "extract" for bulk invoice/receipt extraction. Use "summarize_inbox" for an AI-generated summary of recent unread emails. Use "categorize" to classify unread emails by priority.',
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
            description: 'Attachment ID or filename (for attachment action)',
          },
          save: {
            type: 'string',
            description: 'Directory path to save the attachment to disk instead of reading its content (for attachment action)',
          },
          isHtml: {
            type: 'boolean',
            description: 'Whether the body is HTML (for send action)',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results for extract action (default: 200, max: 1000)',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fields to extract (for extract action). Available: "from", "subject", "date", "amount". Include "amount" to read email bodies and extract monetary amounts.',
          },
          dateFrom: {
            type: 'string',
            description: 'Start date filter for extract action (YYYY-MM-DD format, e.g. "2026-01-01")',
          },
          dateTo: {
            type: 'string',
            description: 'End date filter for extract action (YYYY-MM-DD format, e.g. "2026-12-31")',
          },
          attachmentKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to attach to the email (for send/draft/reply actions). Array of FileStore keys (e.g. "userId/timestamp_file.pdf") or local file paths.',
          },
        },
        required: ['action'],
      },
    };
  }

  setLLM(llm: EmailLLM): void {
    this.llm = llm;
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    // Resolve per-user email providers if available
    const userProviders = await this.resolveUserProviders(_context);
    this.activeProviders = userProviders ?? undefined;

    try {
      // Multi-user: non-admin users must have their own email config, no fallback to global
      let providers: Map<string, EmailProvider>;
      if (this.activeProviders) {
        if (_context.userRole === 'admin' || !_context.alfredUserId) {
          // Admin: merge global + per-user (per-user overrides global with same name)
          providers = new Map([...this.providers, ...this.activeProviders]);
        } else {
          providers = this.activeProviders;
        }
      } else {
        providers = (_context.userRole === 'admin' || !_context.alfredUserId) ? this.providers : new Map();
      }
      if (providers.size === 0) {
        return {
          success: false,
          error: 'Email is not configured. Run `alfred setup` to configure email access.',
        };
      }

      const action = input.action as string;

      switch (action) {
        case 'inbox':
          return await this.handleInbox(input);
        case 'read':
          return await this.handleRead(input);
        case 'search':
          return await this.handleSearch(input);
        case 'send':
          return await this.handleSend(input, _context);
        case 'draft':
          return await this.handleDraft(input, _context);
        case 'folders':
          return await this.handleFolders(input);
        case 'folder':
          return await this.handleFolder(input);
        case 'reply':
          return await this.handleReply(input, _context);
        case 'forward':
          return await this.handleForward(input);
        case 'attachment':
          return await this.handleAttachment(input);
        case 'extract':
          return await this.handleExtract(input);
        case 'summarize_inbox':
          return await this.handleSummarizeInbox(input);
        case 'categorize':
          return await this.handleCategorize(input);
        case 'list_accounts':
          return this.handleListAccounts(providers);
        default:
          return { success: false, error: `Unknown action: ${action}. Use: inbox, read, search, send, draft, folders, folder, reply, forward, attachment, extract, summarize_inbox, categorize, list_accounts` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Email error: ${msg}` };
    } finally {
      this.activeProviders = undefined;
    }
  }

  /**
   * Resolve per-user email providers from UserServiceResolver.
   * Returns null if no per-user config is available (fall back to global).
   */
  private async resolveUserProviders(context: SkillContext): Promise<Map<string, EmailProvider> | null> {
    if (!context.userServiceResolver || !context.alfredUserId) return null;
    const services = await context.userServiceResolver.getUserServices(context.alfredUserId, 'email');
    if (services.length === 0) return null;

    const providers = new Map<string, EmailProvider>();
    for (const svc of services) {
      try {
        const { createEmailProvider } = await import('./factory.js');
        const provider = await createEmailProvider(svc.config as unknown as import('@alfred/types').EmailAccountConfig);
        providers.set(svc.serviceName, provider);
      } catch { /* skip broken per-user configs */ }
    }
    return providers.size > 0 ? providers : null;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private resolveProvider(input: Record<string, unknown>): { provider: EmailProvider; account: string } | SkillResult {
    const providers = this.activeProviders ?? this.providers;
    const accountNames = [...providers.keys()];
    const defaultAccount = accountNames[0] ?? 'default';
    const account = (input.account as string) ?? defaultAccount;
    const provider = providers.get(account);
    if (!provider) {
      return {
        success: false,
        error: `Unknown email account "${account}". Available: ${accountNames.join(', ')}`,
      };
    }
    return { provider, account };
  }

  private encodeId(account: string, rawId: string): string {
    return this.multiAccount ? `${account}::${rawId}` : rawId;
  }

  private decodeId(compositeId: string): { account: string; rawId: string } {
    const providers = this.activeProviders ?? this.providers;
    const isMulti = providers.size > 1;
    if (isMulti) {
      const idx = compositeId.indexOf('::');
      if (idx >= 0) {
        return { account: compositeId.slice(0, idx), rawId: compositeId.slice(idx + 2) };
      }
    }
    const defaultAccount = [...providers.keys()][0] ?? this.defaultAccount;
    return { account: defaultAccount, rawId: compositeId };
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
    const provider = (this.activeProviders ?? this.providers).get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const detail = await provider.readMessage(rawId);

    const attLine = detail.attachments?.length
      ? `\nAttachments:\n${detail.attachments.map(a => `  - [attachmentId: ${a.id}] ${a.name} (${a.contentType}, ${this.formatSize(a.size)})`).join('\n')}`
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

  private async handleSend(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;

    if (!to) return { success: false, error: '"to" (recipient email) is required.' };
    if (!subject) return { success: false, error: '"subject" is required.' };
    if (!body) return { success: false, error: '"body" is required.' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const attachments = await this.loadAttachments(input.attachmentKeys as string[] | undefined, context);

    const result = await provider.sendMessage({
      to,
      subject,
      body,
      cc: input.cc as string | undefined,
      isHtml: input.isHtml as boolean | undefined,
      attachments,
    });

    const attInfo = attachments && attachments.length > 0
      ? `\nAttachments: ${attachments.map(a => a.fileName).join(', ')}`
      : '';

    return {
      success: true,
      data: { messageId: result.messageId, to, subject, attachmentCount: attachments?.length ?? 0 },
      display: this.accountLabel(account, `Email sent to ${to}\nSubject: ${subject}${attInfo}\nMessage ID: ${result.messageId}`),
    };
  }

  private async handleDraft(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const body = input.body as string;

    // Reply draft: only messageId + body required
    if (messageId) {
      if (!body) return { success: false, error: '"body" is required for reply draft.' };

      const { account, rawId } = this.decodeId(messageId);
      const provider = (this.activeProviders ?? this.providers).get(account);
      if (!provider) {
        return { success: false, error: `Unknown email account "${account}".` };
      }

      const attachments = await this.loadAttachments(input.attachmentKeys as string[] | undefined, context);
      const result = await provider.createDraft({
        to: '',
        subject: '',
        body,
        replyTo: rawId,
        attachments,
      });

      return {
        success: true,
        data: { messageId: result.messageId },
        display: this.accountLabel(account, `Reply draft created for message ${rawId}.\nMessage ID: ${result.messageId}\n\nThe reply is saved as a draft and has NOT been sent.`),
      };
    }

    // New draft: to, subject, body required
    const to = input.to as string;
    const subject = input.subject as string;

    if (!to) return { success: false, error: '"to" (recipient email) is required.' };
    if (!subject) return { success: false, error: '"subject" is required.' };
    if (!body) return { success: false, error: '"body" is required.' };

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const attachments = await this.loadAttachments(input.attachmentKeys as string[] | undefined, context);
    const result = await provider.createDraft({
      to,
      subject,
      body,
      cc: input.cc as string | undefined,
      isHtml: input.isHtml as boolean | undefined,
      attachments,
    });

    return {
      success: true,
      data: { messageId: result.messageId, to, subject },
      display: this.accountLabel(account, `Draft created for ${to}\nSubject: ${subject}\nMessage ID: ${result.messageId}\n\nThe email is saved as a draft and has NOT been sent.`),
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

  private async handleReply(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const body = input.body as string;
    if (!messageId) return { success: false, error: '"messageId" is required for reply.' };
    if (!body) return { success: false, error: '"body" is required for reply.' };

    const { account, rawId } = this.decodeId(messageId);
    const provider = (this.activeProviders ?? this.providers).get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const attachments = await this.loadAttachments(input.attachmentKeys as string[] | undefined, context);
    const result = await provider.sendMessage({
      to: '',
      subject: '',
      body,
      replyTo: rawId,
      attachments,
    });

    return {
      success: true,
      data: { messageId: result.messageId },
      display: this.accountLabel(account, `Reply sent to message ${rawId}.`),
    };
  }

  private async handleForward(input: Record<string, unknown>): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const to = input.to as string;
    if (!messageId) return { success: false, error: '"messageId" is required for forward.' };
    if (!to) return { success: false, error: '"to" (recipient email) is required for forward.' };

    const { account, rawId } = this.decodeId(messageId);
    const provider = (this.activeProviders ?? this.providers).get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    const comment = (input.body as string) ?? undefined;
    const result = await provider.forwardMessage(rawId, to, comment);

    return {
      success: true,
      data: { messageId: result.messageId, to },
      display: this.accountLabel(account, `Email forwarded to ${to}.`),
    };
  }

  private async handleAttachment(input: Record<string, unknown>): Promise<SkillResult> {
    const messageId = input.messageId as string;
    const attachmentId = input.attachmentId as string;
    const savePath = input.save as string | undefined;
    if (!messageId) return { success: false, error: '"messageId" is required.' };
    if (!attachmentId) return { success: false, error: '"attachmentId" is required.' };

    const { account, rawId } = this.decodeId(messageId);
    const provider = (this.activeProviders ?? this.providers).get(account);
    if (!provider) {
      return { success: false, error: `Unknown email account "${account}".` };
    }

    // Resolve attachment: try by ID first, then fall back to filename match
    const detail = await provider.readMessage(rawId);
    let attMeta = detail.attachments?.find(a => a.id === attachmentId);
    if (!attMeta) {
      attMeta = detail.attachments?.find(a => a.name.toLowerCase() === attachmentId.toLowerCase());
    }
    if (!attMeta) {
      const available = detail.attachments?.map(a => `[${a.id}] ${a.name}`).join(', ') ?? 'none';
      return { success: false, error: `Attachment "${attachmentId}" not found. Available: ${available}` };
    }

    const data = await provider.downloadAttachment(rawId, attMeta.id);
    const fileName = attMeta.name;
    const mimeType = attMeta.contentType;

    // Save mode: write to disk, no text extraction
    if (savePath) {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.resolve(savePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const safeFileName = path.basename(fileName);
      const filePath = path.join(dir, safeFileName);
      fs.writeFileSync(filePath, data);
      return {
        success: true,
        data: { messageId, attachmentId: attMeta.id, fileName, size: data.length, savedTo: filePath },
        display: this.accountLabel(account, `Saved attachment: ${fileName} (${this.formatSize(data.length)}) → ${filePath}`),
      };
    }

    // Read mode: extract text content for readable file types
    const textContent = await this.extractText(data, mimeType, fileName);
    if (textContent !== null) {
      const truncated = textContent.length > 6000
        ? textContent.slice(0, 6000) + '\n\n... (truncated)'
        : textContent;
      return {
        success: true,
        data: { messageId, attachmentId: attMeta.id, fileName, size: data.length, hasContent: true },
        display: this.accountLabel(account, `Attachment: ${fileName} (${this.formatSize(data.length)})\n\nContent:\n${truncated}`),
        attachments: [{ fileName, data, mimeType }],
      };
    }

    // Binary file: just pass through to user
    return {
      success: true,
      data: { messageId, attachmentId: attMeta.id, fileName, size: data.length },
      display: this.accountLabel(account, `Downloaded attachment: ${fileName} (${this.formatSize(data.length)})`),
      attachments: [{ fileName, data, mimeType }],
    };
  }

  private async handleExtract(input: Record<string, unknown>): Promise<SkillResult> {
    const query = input.query as string;
    if (!query) {
      return { success: false, error: 'query is required for extract. Example: "rechnung OR invoice OR receipt 2026"' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const maxResults = Math.min(Math.max(1, (input.maxResults as number | undefined) ?? 200), 1000);
    const fields = (input.fields as string[] | undefined) ?? ['from', 'subject', 'date', 'amount'];
    const dateFrom = input.dateFrom as string | undefined;
    const dateTo = input.dateTo as string | undefined;

    try {
      const results = await provider.extractFromSearch(query, maxResults, fields, dateFrom, dateTo);

      if (results.length === 0) {
        return { success: true, data: { results: [] }, display: this.accountLabel(account, `No emails found for "${query}".`) };
      }

      // Build compact display
      const lines = results.map((r, i) => {
        const amount = r.amount ? ` | ${r.amount} ${r.currency ?? ''}` : '';
        return `${i + 1}. ${r.date} | ${r.from} | ${r.subject}${amount}`;
      });

      const withAmount = results.filter(r => r.amount);
      const summary = `Found ${results.length} emails (${withAmount.length} with detected amounts)`;

      return {
        success: true,
        data: { results, totalFound: results.length, withAmounts: withAmount.length },
        display: this.accountLabel(account, `${summary}:\n\n${lines.join('\n')}`),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Extract is not supported')) {
        return { success: false, error: 'The extract action is only supported with Microsoft Graph email. Use search + read for other providers.' };
      }
      throw err;
    }
  }

  private async handleSummarizeInbox(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.llm) {
      return { success: false, error: 'LLM not configured. Email intelligence requires an LLM provider.' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const limit = Math.min(Math.max(1, (input.count as number | undefined) ?? 20), 50);
    const messages = await provider.fetchInbox(limit);
    const unread = messages.filter(m => !m.read);

    if (unread.length === 0) {
      return { success: true, data: { summary: 'No unread emails.' }, display: this.accountLabel(account, 'No unread emails to summarize.') };
    }

    const emailList = unread.map((m, i) =>
      `${i + 1}. From: ${m.from} | Subject: ${m.subject} | Date: ${m.date.toISOString()}${m.hasAttachments ? ' [has attachments]' : ''}`
    ).join('\n');

    const response = await this.llm.complete({
      messages: [{
        role: 'user',
        content: `Summarize these ${unread.length} unread emails concisely. Highlight anything urgent or requiring action.\n\n${emailList}`,
      }],
      system: 'You are an email assistant. Provide a brief, actionable summary in the user\'s language. Group by priority if applicable.',
      tier: 'fast',
    });

    const summary = response.content;
    return {
      success: true,
      data: { summary, unreadCount: unread.length },
      display: this.accountLabel(account, `Inbox Summary (${unread.length} unread):\n\n${summary}`),
    };
  }

  private async handleCategorize(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.llm) {
      return { success: false, error: 'LLM not configured. Email intelligence requires an LLM provider.' };
    }

    const resolved = this.resolveProvider(input);
    if ('success' in resolved) return resolved;
    const { provider, account } = resolved;

    const limit = Math.min(Math.max(1, (input.count as number | undefined) ?? 20), 50);
    const messages = await provider.fetchInbox(limit);
    const unread = messages.filter(m => !m.read);

    if (unread.length === 0) {
      return { success: true, data: { categories: {} }, display: this.accountLabel(account, 'No unread emails to categorize.') };
    }

    const emailList = unread.map((m, i) =>
      `${i + 1}. From: ${m.from} | Subject: ${m.subject} | Date: ${m.date.toISOString()}`
    ).join('\n');

    const response = await this.llm.complete({
      messages: [{
        role: 'user',
        content: `Categorize each email into one of: urgent, action_required, fyi, newsletter. Return ONLY valid JSON like: {"1":"urgent","2":"fyi",...}\n\n${emailList}`,
      }],
      system: 'You are an email classifier. Return only a JSON object mapping email number to category. No other text.',
      tier: 'fast',
    });

    // Parse LLM response
    let categories: Record<string, string> = {};
    try {
      const jsonMatch = response.content.match(/\{[^}]+\}/);
      if (jsonMatch) categories = JSON.parse(jsonMatch[0]);
    } catch { /* fallback to empty */ }

    const grouped: Record<string, Array<{ from: string; subject: string }>> = {
      urgent: [], action_required: [], fyi: [], newsletter: [],
    };

    for (const [idx, cat] of Object.entries(categories)) {
      const i = parseInt(idx, 10) - 1;
      if (i >= 0 && i < unread.length && grouped[cat]) {
        grouped[cat].push({ from: unread[i].from, subject: unread[i].subject });
      }
    }

    const lines: string[] = [];
    for (const [cat, items] of Object.entries(grouped)) {
      if (items.length > 0) {
        const emoji = cat === 'urgent' ? '🔴' : cat === 'action_required' ? '🟡' : cat === 'fyi' ? '🔵' : '📰';
        lines.push(`${emoji} ${cat.toUpperCase()} (${items.length}):`);
        for (const item of items) {
          lines.push(`  • ${item.from}: ${item.subject}`);
        }
      }
    }

    return {
      success: true,
      data: { categories: grouped, totalCategorized: Object.keys(categories).length },
      display: this.accountLabel(account, lines.length > 0 ? lines.join('\n') : 'Could not categorize emails.'),
    };
  }

  private async extractText(data: Buffer, mimeType: string, fileName: string): Promise<string | null> {
    try {
      if (mimeType === 'application/pdf') {
        // pdf-parse is an optional runtime dependency (installed on deployment)
        const pdfParse = (await import(/* webpackIgnore: true */ 'pdf-parse' as string)).default as (buf: Buffer) => Promise<{ text: string }>;
        const result = await pdfParse(data);
        return result.text?.trim() || null;
      }
      if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword'
      ) {
        // mammoth is an optional runtime dependency
        const mammoth = await import(/* webpackIgnore: true */ 'mammoth' as string) as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
        const result = await mammoth.extractRawText({ buffer: data });
        return result.value?.trim() || null;
      }
      if (mimeType.startsWith('text/') || fileName.endsWith('.csv') || fileName.endsWith('.json') || fileName.endsWith('.md')) {
        return data.toString('utf-8');
      }
    } catch {
      // Extraction failed — fall through to binary mode
    }
    return null;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private handleListAccounts(providers: Map<string, EmailProvider>): SkillResult {
    const names = [...providers.keys()];
    if (names.length === 0) {
      return { success: true, data: { accounts: [] }, display: 'Keine Email-Accounts konfiguriert.\nNutze "setup_service" um ein Email-Konto einzurichten (z.B. GMX, Gmail, Outlook).' };
    }
    return {
      success: true,
      data: { accounts: names, default: names[0] },
      display: `Verfügbare Email-Accounts:\n${names.map((n, i) => `${i === 0 ? '• ' + n + ' (Standard)' : '• ' + n}`).join('\n')}`,
    };
  }

  /** Load attachments from FileStore keys or local file paths. */
  private async loadAttachments(
    keys: string[] | undefined,
    context: SkillContext,
  ): Promise<SendEmailAttachment[] | undefined> {
    if (!keys || keys.length === 0) return undefined;

    const MIME_MAP: Record<string, string> = {
      '.pdf': 'application/pdf', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.zip': 'application/zip', '.html': 'text/html',
    };

    const results: SendEmailAttachment[] = [];
    for (const key of keys) {
      const isStoreKey = !path.isAbsolute(key) && !key.startsWith('~') && key.includes('/') && context.fileStore;

      let data: Buffer;
      let fileName: string;

      if (isStoreKey && context.fileStore) {
        data = await context.fileStore.read(key, context.userId);
        const rawName = key.split('/').pop() ?? key;
        fileName = rawName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, '');
      } else {
        const resolved = path.resolve(key.startsWith('~') ? key.replace('~', process.env['HOME'] || '') : key);
        if (!fs.existsSync(resolved)) throw new Error(`Attachment not found: ${key}`);
        data = fs.readFileSync(resolved);
        fileName = path.basename(resolved);
      }

      const ext = path.extname(fileName).toLowerCase();
      results.push({ fileName, data, contentType: MIME_MAP[ext] || 'application/octet-stream' });
    }
    return results.length > 0 ? results : undefined;
  }
}
