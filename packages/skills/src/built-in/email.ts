import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
  auth: {
    user: string;
    pass: string;
  };
}

export class EmailSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'email',
    description: 'Access the user\'s email: check inbox, read messages, search emails, or send new emails. Use when the user asks about their emails or wants to send one.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inbox', 'read', 'search', 'send'],
          description: 'The email action to perform',
        },
        count: {
          type: 'number',
          description: 'Number of emails to fetch (for inbox, default: 10)',
        },
        messageId: {
          type: 'string',
          description: 'Message sequence number to read (for read action)',
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
          description: 'Email body text (for send action)',
        },
      },
      required: ['action'],
    },
  };

  constructor(private readonly config?: EmailConfig) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    if (!this.config) {
      return {
        success: false,
        error: 'Email is not configured. Run `alfred setup` to configure email access.',
      };
    }

    const action = input.action as string;

    try {
      switch (action) {
        case 'inbox':
          return await this.fetchInbox(input.count as number | undefined);
        case 'read':
          return await this.readMessage(input.messageId as string);
        case 'search':
          return await this.searchMessages(input.query as string, input.count as number | undefined);
        case 'send':
          return await this.sendMessage(
            input.to as string,
            input.subject as string,
            input.body as string,
          );
        default:
          return { success: false, error: `Unknown action: ${action}. Use: inbox, read, search, send` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Email error: ${msg}` };
    }
  }

  // ── IMAP: Fetch inbox ──────────────────────────────────────────

  private async fetchInbox(count?: number): Promise<SkillResult> {
    const limit = Math.min(Math.max(1, count ?? 10), 50);
    const { ImapFlow } = await import('imapflow');

    const client = new ImapFlow({
      host: this.config!.imap.host,
      port: this.config!.imap.port,
      secure: this.config!.imap.secure,
      auth: this.config!.auth,
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const messages: Array<{ seq: number; from: string; subject: string; date: string; seen: boolean }> = [];

        // Fetch latest messages
        const mb = client.mailbox;
        const totalMessages = mb && typeof mb === 'object' ? (mb.exists ?? 0) : 0;
        if (totalMessages === 0) {
          return { success: true, data: { messages: [] }, display: 'Inbox is empty.' };
        }

        const startSeq = Math.max(1, totalMessages - limit + 1);
        const range = `${startSeq}:*`;

        for await (const msg of client.fetch(range, {
          envelope: true,
          flags: true,
        })) {
          const from = msg.envelope?.from?.[0];
          const fromStr = from
            ? (from.name ? `${from.name} <${from.address}>` : from.address ?? 'unknown')
            : 'unknown';

          messages.push({
            seq: msg.seq,
            from: fromStr,
            subject: msg.envelope?.subject ?? '(no subject)',
            date: msg.envelope?.date?.toISOString() ?? '',
            seen: msg.flags?.has('\\Seen') ?? false,
          });
        }

        // Newest first
        messages.reverse();

        const display = messages.length === 0
          ? 'No messages found.'
          : messages.map((m, i) => {
              const unread = m.seen ? '' : ' [UNREAD]';
              return `${i + 1}. [#${m.seq}]${unread} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date}`;
            }).join('\n\n');

        const unreadCount = messages.filter(m => !m.seen).length;

        return {
          success: true,
          data: { messages, totalMessages, unreadCount },
          display: `Inbox (${totalMessages} total, ${unreadCount} unread):\n\n${display}`,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  // ── IMAP: Read single message ──────────────────────────────────

  private async readMessage(messageId: string): Promise<SkillResult> {
    if (!messageId) {
      return { success: false, error: 'messageId is required. Use the sequence number from inbox.' };
    }

    const seq = parseInt(messageId, 10);
    if (isNaN(seq) || seq < 1) {
      return { success: false, error: 'messageId must be a positive number (sequence number).' };
    }

    const { ImapFlow } = await import('imapflow');

    const client = new ImapFlow({
      host: this.config!.imap.host,
      port: this.config!.imap.port,
      secure: this.config!.imap.secure,
      auth: this.config!.auth,
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const msg = await client.fetchOne(String(seq), {
          envelope: true,
          source: true,
        });

        if (!msg) {
          return { success: false, error: `Message #${seq} not found.` };
        }

        const from = msg.envelope?.from?.[0];
        const fromStr = from
          ? (from.name ? `${from.name} <${from.address}>` : from.address ?? 'unknown')
          : 'unknown';
        const to = msg.envelope?.to?.map(
          (t: any) => t.name ? `${t.name} <${t.address}>` : t.address ?? '',
        ).join(', ') ?? '';

        // Extract text body from source
        const rawSource = msg.source?.toString() ?? '';
        const body = this.extractTextBody(rawSource);

        return {
          success: true,
          data: {
            seq,
            from: fromStr,
            to,
            subject: msg.envelope?.subject ?? '(no subject)',
            date: msg.envelope?.date?.toISOString() ?? '',
            body,
          },
          display: [
            `From: ${fromStr}`,
            `To: ${to}`,
            `Subject: ${msg.envelope?.subject ?? '(no subject)'}`,
            `Date: ${msg.envelope?.date?.toISOString() ?? ''}`,
            '',
            body.slice(0, 3000) + (body.length > 3000 ? '\n\n... (truncated)' : ''),
          ].join('\n'),
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  // ── IMAP: Search messages ──────────────────────────────────────

  private async searchMessages(query: string, count?: number): Promise<SkillResult> {
    if (!query) {
      return { success: false, error: 'query is required for search.' };
    }

    const limit = Math.min(Math.max(1, count ?? 10), 50);
    const { ImapFlow } = await import('imapflow');

    const client = new ImapFlow({
      host: this.config!.imap.host,
      port: this.config!.imap.port,
      secure: this.config!.imap.secure,
      auth: this.config!.auth,
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search by subject or from containing the query
        const rawResult = await client.search({
          or: [
            { subject: query },
            { from: query },
            { body: query },
          ],
        });

        const searchResult = Array.isArray(rawResult) ? rawResult : [];

        if (searchResult.length === 0) {
          return { success: true, data: { results: [] }, display: `No emails found for "${query}".` };
        }

        // Take the latest N results
        const seqNums = searchResult.slice(-limit) as number[];
        const messages: Array<{ seq: number; from: string; subject: string; date: string }> = [];

        for await (const msg of client.fetch(seqNums, { envelope: true })) {
          const from = msg.envelope?.from?.[0];
          const fromStr = from
            ? (from.name ? `${from.name} <${from.address}>` : from.address ?? 'unknown')
            : 'unknown';

          messages.push({
            seq: msg.seq,
            from: fromStr,
            subject: msg.envelope?.subject ?? '(no subject)',
            date: msg.envelope?.date?.toISOString() ?? '',
          });
        }

        messages.reverse();

        const display = messages.map((m, i) =>
          `${i + 1}. [#${m.seq}] ${m.subject}\n   From: ${m.from}\n   Date: ${m.date}`
        ).join('\n\n');

        return {
          success: true,
          data: { query, results: messages, totalMatches: seqNums.length },
          display: `Search results for "${query}" (${seqNums.length} matches):\n\n${display}`,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  // ── SMTP: Send message ─────────────────────────────────────────

  private async sendMessage(to: string, subject: string, body: string): Promise<SkillResult> {
    if (!to) return { success: false, error: '"to" (recipient email) is required.' };
    if (!subject) return { success: false, error: '"subject" is required.' };
    if (!body) return { success: false, error: '"body" is required.' };

    const nodemailer = await import('nodemailer');

    const transport = nodemailer.createTransport({
      host: this.config!.smtp.host,
      port: this.config!.smtp.port,
      secure: this.config!.smtp.secure,
      auth: this.config!.auth,
    });

    const info = await transport.sendMail({
      from: this.config!.auth.user,
      to,
      subject,
      text: body,
    });

    return {
      success: true,
      data: { messageId: info.messageId, to, subject },
      display: `Email sent to ${to}\nSubject: ${subject}\nMessage ID: ${info.messageId}`,
    };
  }

  // ── Helper: extract text body from raw email source ────────────

  private extractTextBody(rawSource: string): string {
    // Try to find plain text part
    // Simple approach: look for Content-Type: text/plain section
    const parts = rawSource.split(/\r?\n\r?\n/);
    if (parts.length < 2) return rawSource;

    // For simple emails (no multipart), body is after first blank line
    const headers = parts[0].toLowerCase();
    if (!headers.includes('multipart')) {
      // Single part email — body is everything after headers
      return this.decodeBody(parts.slice(1).join('\n\n'));
    }

    // Multipart: find the text/plain boundary
    const boundaryMatch = headers.match(/boundary="?([^"\s;]+)"?/i) ??
      rawSource.match(/boundary="?([^"\s;]+)"?/i);
    if (!boundaryMatch) {
      return parts.slice(1).join('\n\n').slice(0, 5000);
    }

    const boundary = boundaryMatch[1];
    const sections = rawSource.split(`--${boundary}`);

    for (const section of sections) {
      const sectionLower = section.toLowerCase();
      if (sectionLower.includes('content-type: text/plain') || sectionLower.includes('content-type:text/plain')) {
        const bodyStart = section.indexOf('\n\n');
        if (bodyStart >= 0) {
          return this.decodeBody(section.slice(bodyStart + 2));
        }
        const bodyStartCr = section.indexOf('\r\n\r\n');
        if (bodyStartCr >= 0) {
          return this.decodeBody(section.slice(bodyStartCr + 4));
        }
      }
    }

    // Fallback: return first section body
    return this.decodeBody(parts.slice(1).join('\n\n').slice(0, 5000));
  }

  private decodeBody(body: string): string {
    // Handle quoted-printable encoding
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .trim();
  }
}
