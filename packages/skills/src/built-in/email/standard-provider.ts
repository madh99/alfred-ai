import type { EmailAccountConfig } from '@alfred/types';
import { EmailProvider } from './email-provider.js';
import type { EmailMessage, EmailDetail, SendEmailInput } from './email-provider.js';

export class StandardEmailProvider extends EmailProvider {
  constructor(private readonly config: EmailAccountConfig) {
    super();
  }

  async initialize(): Promise<void> {
    // No-op for IMAP/SMTP — connections are created per-request
  }

  private createImapClient(): any {
    // Lazy import to avoid loading imapflow when not needed
    return import('imapflow').then(({ ImapFlow }) => new ImapFlow({
      host: this.config.imap!.host,
      port: this.config.imap!.port,
      secure: this.config.imap!.secure,
      auth: this.config.auth!,
      logger: false,
    }));
  }

  private formatAddress(addr: any): string {
    if (!addr) return 'unknown';
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address ?? 'unknown';
  }

  async fetchInbox(count: number): Promise<EmailMessage[]> {
    return this.fetchFolder('INBOX', count);
  }

  async readMessage(id: string): Promise<EmailDetail> {
    const seq = parseInt(id, 10);
    if (isNaN(seq) || seq < 1) {
      throw new Error('messageId must be a positive number (sequence number).');
    }

    const client = await this.createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const msg = await client.fetchOne(String(seq), {
          envelope: true,
          source: true,
          bodyStructure: true,
        });

        if (!msg) {
          throw new Error(`Message #${seq} not found.`);
        }

        const from = this.formatAddress(msg.envelope?.from?.[0]);
        const to = msg.envelope?.to?.map(
          (t: any) => t.name ? `${t.name} <${t.address}>` : t.address ?? '',
        ) ?? [];
        const cc = msg.envelope?.cc?.map(
          (c: any) => c.name ? `${c.name} <${c.address}>` : c.address ?? '',
        );

        const rawSource = msg.source?.toString() ?? '';
        const body = this.extractTextBody(rawSource);

        const attachments = this.extractAttachmentInfo(msg.bodyStructure);

        return {
          id: String(seq),
          from,
          to,
          subject: msg.envelope?.subject ?? '(no subject)',
          date: msg.envelope?.date ?? new Date(),
          read: msg.flags?.has('\\Seen') ?? false,
          body,
          cc,
          attachments,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async searchMessages(query: string, count: number): Promise<EmailMessage[]> {
    const limit = Math.min(Math.max(1, count), 50);
    const client = await this.createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const rawResult = await client.search({
          or: [
            { subject: query },
            { from: query },
            { body: query },
          ],
        });

        const searchResult = Array.isArray(rawResult) ? rawResult : [];
        if (searchResult.length === 0) return [];

        const seqNums = searchResult.slice(-limit) as number[];
        const messages: EmailMessage[] = [];

        for await (const msg of client.fetch(seqNums, { envelope: true, flags: true })) {
          messages.push({
            id: String(msg.seq),
            from: this.formatAddress(msg.envelope?.from?.[0]),
            to: msg.envelope?.to?.map(
              (t: any) => t.name ? `${t.name} <${t.address}>` : t.address ?? '',
            ) ?? [],
            subject: msg.envelope?.subject ?? '(no subject)',
            date: msg.envelope?.date ?? new Date(),
            read: msg.flags?.has('\\Seen') ?? false,
          });
        }

        messages.reverse();
        return messages;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async sendMessage(input: SendEmailInput): Promise<{ messageId: string }> {
    const nodemailer = await import('nodemailer');

    const transport = nodemailer.createTransport({
      host: this.config.smtp!.host,
      port: this.config.smtp!.port,
      secure: this.config.smtp!.secure,
      auth: this.config.auth!,
    });

    const mailOpts: Record<string, unknown> = {
      from: this.config.auth!.user,
      to: input.to,
      subject: input.subject,
    };

    if (input.cc) mailOpts.cc = input.cc;
    if (input.isHtml) {
      mailOpts.html = input.body;
    } else {
      mailOpts.text = input.body;
    }

    if (input.replyTo) {
      mailOpts.inReplyTo = input.replyTo;
      mailOpts.references = input.replyTo;
    }

    const info = await transport.sendMail(mailOpts);
    return { messageId: info.messageId };
  }

  async listFolders(): Promise<string[]> {
    const client = await this.createImapClient();

    try {
      await client.connect();
      const mailboxes = await client.list();
      const folders: string[] = [];
      for (const mb of mailboxes) {
        folders.push(mb.path);
      }
      return folders;
    } finally {
      await client.logout();
    }
  }

  async fetchFolder(folder: string, count: number): Promise<EmailMessage[]> {
    const limit = Math.min(Math.max(1, count), 50);
    const client = await this.createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        const messages: EmailMessage[] = [];
        const mb = client.mailbox;
        const totalMessages = mb && typeof mb === 'object' ? (mb.exists ?? 0) : 0;
        if (totalMessages === 0) return [];

        const startSeq = Math.max(1, totalMessages - limit + 1);
        const range = `${startSeq}:*`;

        for await (const msg of client.fetch(range, {
          envelope: true,
          flags: true,
        })) {
          const from = this.formatAddress(msg.envelope?.from?.[0]);

          messages.push({
            id: String(msg.seq),
            from,
            to: msg.envelope?.to?.map(
              (t: any) => t.name ? `${t.name} <${t.address}>` : t.address ?? '',
            ) ?? [],
            subject: msg.envelope?.subject ?? '(no subject)',
            date: msg.envelope?.date ?? new Date(),
            read: msg.flags?.has('\\Seen') ?? false,
          });
        }

        messages.reverse();
        return messages;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const seq = parseInt(messageId, 10);
    if (isNaN(seq) || seq < 1) {
      throw new Error('messageId must be a positive number.');
    }

    const client = await this.createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const msg = await client.fetchOne(String(seq), {
          bodyParts: [attachmentId],
        });

        const part = msg?.bodyParts?.get(attachmentId);
        if (!part) {
          throw new Error(`Attachment "${attachmentId}" not found in message #${seq}.`);
        }

        return Buffer.from(part);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private extractAttachmentInfo(bodyStructure: any): Array<{ id: string; name: string; contentType: string; size: number }> {
    const attachments: Array<{ id: string; name: string; contentType: string; size: number }> = [];
    if (!bodyStructure) return attachments;

    const walk = (node: any, partId: string): void => {
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          walk(node.childNodes[i], partId ? `${partId}.${i + 1}` : String(i + 1));
        }
        return;
      }

      const disposition = node.disposition?.toLowerCase();
      if (disposition === 'attachment' || (node.type && !node.type.startsWith('text/') && disposition !== 'inline')) {
        const name = node.dispositionParameters?.filename ?? node.parameters?.name ?? `part-${partId}`;
        attachments.push({
          id: node.part ?? partId,
          name,
          contentType: node.type ?? 'application/octet-stream',
          size: node.size ?? 0,
        });
      }
    };

    walk(bodyStructure, '');
    return attachments;
  }

  private extractTextBody(rawSource: string): string {
    const parts = rawSource.split(/\r?\n\r?\n/);
    if (parts.length < 2) return rawSource;

    const headers = parts[0].toLowerCase();
    if (!headers.includes('multipart')) {
      return this.decodeBody(parts.slice(1).join('\n\n'));
    }

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

    return this.decodeBody(parts.slice(1).join('\n\n').slice(0, 5000));
  }

  private decodeBody(body: string): string {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .trim();
  }
}
