import type { MicrosoftEmailConfig } from '@alfred/types';
import { EmailProvider } from './email-provider.js';
import type { EmailMessage, EmailDetail, EmailAttachment, SendEmailInput } from './email-provider.js';

export class MicrosoftGraphEmailProvider extends EmailProvider {
  private accessToken = '';

  constructor(private readonly config: MicrosoftEmailConfig) {
    super();
  }

  async initialize(): Promise<void> {
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.config.refreshToken) {
      throw new Error('Microsoft email: refreshToken is missing from config');
    }
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`Microsoft token refresh failed: ${res.status} — ${errorBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    this.accessToken = data.access_token;
    // Note: Microsoft may rotate refresh tokens but we don't persist them here
  }

  private async graphRequest(path: string, options: RequestInit = {}): Promise<any> {
    const doFetch = (token: string) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

    const res = await doFetch(this.accessToken);

    if (res.status === 401) {
      await this.refreshAccessToken();
      const retry = await doFetch(this.accessToken);
      if (!retry.ok) throw new Error(`Graph API error: ${retry.status}`);
      return this.parseJsonOrUndefined(retry);
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    return this.parseJsonOrUndefined(res);
  }

  /** Parse JSON response body, returning undefined for empty bodies (202, 204, etc.). */
  private async parseJsonOrUndefined(res: Response): Promise<any> {
    if (res.status === 204 || res.status === 202) return undefined;
    const text = await res.text();
    if (!text || text.length === 0) return undefined;
    return JSON.parse(text);
  }

  private async graphRequestRaw(path: string): Promise<Buffer> {
    const doFetch = (token: string) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    let res = await doFetch(this.accessToken);

    if (res.status === 401) {
      await this.refreshAccessToken();
      res = await doFetch(this.accessToken);
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async fetchInbox(count: number): Promise<EmailMessage[]> {
    const params = new URLSearchParams({
      $top: String(Math.min(Math.max(1, count), 50)),
      $orderby: 'receivedDateTime desc',
      $select: 'id,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview,hasAttachments',
    });

    const data = await this.graphRequest(`/me/mailFolders/inbox/messages?${params}`);
    return (data.value ?? []).map((item: any) => this.mapMessage(item));
  }

  async readMessage(id: string): Promise<EmailDetail> {
    const params = new URLSearchParams({
      $select: 'id,from,toRecipients,ccRecipients,bccRecipients,subject,body,receivedDateTime,isRead,hasAttachments',
    });

    const data = await this.graphRequest(`/me/messages/${id}?${params}`);

    let attachments: EmailAttachment[] = [];
    if (data.hasAttachments) {
      const attData = await this.graphRequest(`/me/messages/${id}/attachments?$select=id,name,contentType,size`);
      attachments = (attData.value ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size ?? 0,
      }));
    }

    return {
      id: data.id,
      from: this.formatGraphAddress(data.from),
      to: (data.toRecipients ?? []).map((r: any) => this.formatGraphAddress(r)),
      subject: data.subject ?? '(no subject)',
      date: new Date(data.receivedDateTime),
      read: data.isRead ?? false,
      body: data.body?.contentType === 'html'
        ? this.stripHtml(data.body.content ?? '')
        : (data.body?.content ?? ''),
      bodyHtml: data.body?.contentType === 'html' ? data.body.content : undefined,
      cc: data.ccRecipients?.map((r: any) => this.formatGraphAddress(r)),
      bcc: data.bccRecipients?.map((r: any) => this.formatGraphAddress(r)),
      hasAttachments: data.hasAttachments,
      attachments,
    };
  }

  async searchMessages(query: string, count: number): Promise<EmailMessage[]> {
    const pageSize = Math.min(Math.max(1, count), 50);
    const params = new URLSearchParams({
      $search: `"${query}"`,
      $top: String(pageSize),
      $select: 'id,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview,hasAttachments',
    });

    const data = await this.graphRequest(`/me/messages?${params}`);
    const results: EmailMessage[] = (data.value ?? []).map((item: any) => this.mapMessage(item));

    // Follow pagination if more results requested
    if (count > 50) {
      let nextLink = data['@odata.nextLink'] as string | undefined;
      while (nextLink && results.length < count) {
        const nextData = await this.graphRequest(nextLink.replace('https://graph.microsoft.com/v1.0', ''));
        const page = (nextData.value ?? []).map((item: any) => this.mapMessage(item));
        results.push(...page);
        nextLink = nextData['@odata.nextLink'] as string | undefined;
      }
    }

    return results.slice(0, count);
  }

  /**
   * Search emails and extract structured data server-side.
   * Reads each email body internally (not in LLM context) and extracts amounts via regex.
   * Returns a compact list suitable for large-scale processing (100s-1000s of emails).
   */
  async extractFromSearch(
    query: string,
    maxResults: number,
    fields: string[],
  ): Promise<Array<{ id: string; from: string; subject: string; date: string; preview: string; amount?: string; currency?: string }>> {
    // Step 1: Paginated search to get ALL matching emails
    const allMessages = await this.searchMessages(query, maxResults);

    // Step 2: If amount extraction requested, read bodies and extract
    const needAmount = fields.includes('amount');
    const results: Array<{ id: string; from: string; subject: string; date: string; preview: string; amount?: string; currency?: string }> = [];

    for (const msg of allMessages) {
      const entry: typeof results[0] = {
        id: msg.id,
        from: msg.from,
        subject: msg.subject,
        date: msg.date.toISOString().split('T')[0],
        preview: (msg.preview ?? '').slice(0, 200),
      };

      if (needAmount) {
        try {
          const detail = await this.readMessage(msg.id);
          const extracted = this.extractAmount(detail.body);
          if (extracted) {
            entry.amount = extracted.amount;
            entry.currency = extracted.currency;
          }
        } catch {
          // Skip unreadable emails (404, etc.)
        }
      }

      results.push(entry);
    }

    return results;
  }

  /**
   * Extract monetary amount from email body text using common patterns.
   */
  private extractAmount(body: string): { amount: string; currency: string } | null {
    // Patterns ordered by specificity
    const patterns: Array<{ regex: RegExp; currency: string }> = [
      // EUR patterns: €12.34, €1.234,56, EUR 12,34, 12,34 EUR, 12.34 €
      { regex: /(?:gesamt|total|summe|betrag|amount|charged|bezahlt|preis|price)[:\s]*€\s*([\d.,]+)/i, currency: 'EUR' },
      { regex: /(?:gesamt|total|summe|betrag|amount|charged|bezahlt|preis|price)[:\s]*([\d.,]+)\s*€/i, currency: 'EUR' },
      { regex: /(?:gesamt|total|summe|betrag|amount|charged|bezahlt|preis|price)[:\s]*EUR\s*([\d.,]+)/i, currency: 'EUR' },
      { regex: /(?:gesamt|total|summe|betrag|amount|charged|bezahlt|preis|price)[:\s]*([\d.,]+)\s*EUR/i, currency: 'EUR' },
      // USD patterns
      { regex: /(?:total|amount|charged|price|subtotal)[:\s]*\$\s*([\d.,]+)/i, currency: 'USD' },
      { regex: /(?:total|amount|charged|price|subtotal)[:\s]*USD\s*([\d.,]+)/i, currency: 'USD' },
      { regex: /(?:total|amount|charged|price|subtotal)[:\s]*([\d.,]+)\s*USD/i, currency: 'USD' },
      // Fallback: any € or $ amount
      { regex: /€\s*([\d]+[.,]\d{2})\b/, currency: 'EUR' },
      { regex: /\b([\d]+[.,]\d{2})\s*€/, currency: 'EUR' },
      { regex: /EUR\s*([\d]+[.,]\d{2})\b/, currency: 'EUR' },
      { regex: /\$([\d]+[.,]\d{2})\b/, currency: 'USD' },
      { regex: /USD\s*([\d]+[.,]\d{2})\b/, currency: 'USD' },
    ];

    for (const { regex, currency } of patterns) {
      const match = body.match(regex);
      if (match?.[1]) {
        return { amount: match[1].trim(), currency };
      }
    }
    return null;
  }

  async sendMessage(input: SendEmailInput): Promise<{ messageId: string }> {
    if (input.replyTo) {
      // Reply to an existing message
      await this.graphRequest(`/me/messages/${input.replyTo}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          comment: input.body,
        }),
      });
      return { messageId: input.replyTo };
    }

    const message: Record<string, unknown> = {
      subject: input.subject,
      body: {
        contentType: input.isHtml ? 'html' : 'text',
        content: input.body,
      },
      toRecipients: input.to.split(',').map(addr => ({
        emailAddress: { address: addr.trim() },
      })),
    };

    if (input.cc) {
      message.ccRecipients = input.cc.split(',').map(addr => ({
        emailAddress: { address: addr.trim() },
      }));
    }

    await this.graphRequest('/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });

    return { messageId: `sent-${Date.now()}` };
  }

  async createDraft(input: SendEmailInput): Promise<{ messageId: string }> {
    if (input.replyTo) {
      // Create a reply draft (not sent)
      const data = await this.graphRequest(`/me/messages/${input.replyTo}/createReply`, {
        method: 'POST',
        body: JSON.stringify({
          comment: input.body,
        }),
      });
      return { messageId: data?.id ?? input.replyTo };
    }

    const message: Record<string, unknown> = {
      subject: input.subject,
      body: {
        contentType: input.isHtml ? 'html' : 'text',
        content: input.body,
      },
      toRecipients: input.to.split(',').map(addr => ({
        emailAddress: { address: addr.trim() },
      })),
    };

    if (input.cc) {
      message.ccRecipients = input.cc.split(',').map(addr => ({
        emailAddress: { address: addr.trim() },
      }));
    }

    const data = await this.graphRequest('/me/messages', {
      method: 'POST',
      body: JSON.stringify(message),
    });

    return { messageId: data?.id ?? `draft-${Date.now()}` };
  }

  async listFolders(): Promise<string[]> {
    const data = await this.graphRequest('/me/mailFolders?$select=displayName&$top=100');
    return (data.value ?? []).map((f: any) => f.displayName);
  }

  async fetchFolder(folder: string, count: number): Promise<EmailMessage[]> {
    // First resolve folder name to ID
    const foldersData = await this.graphRequest('/me/mailFolders?$select=id,displayName&$top=100');
    const match = (foldersData.value ?? []).find(
      (f: any) => f.displayName.toLowerCase() === folder.toLowerCase(),
    );

    if (!match) {
      throw new Error(`Folder "${folder}" not found. Use the 'folders' action to list available folders.`);
    }

    const params = new URLSearchParams({
      $top: String(Math.min(Math.max(1, count), 50)),
      $orderby: 'receivedDateTime desc',
      $select: 'id,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview,hasAttachments',
    });

    const data = await this.graphRequest(`/me/mailFolders/${match.id}/messages?${params}`);
    return (data.value ?? []).map((item: any) => this.mapMessage(item));
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    return this.graphRequestRaw(`/me/messages/${messageId}/attachments/${attachmentId}/$value`);
  }

  async forwardMessage(messageId: string, to: string, comment?: string): Promise<{ messageId: string }> {
    await this.graphRequest(`/me/messages/${messageId}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        comment: comment ?? '',
        toRecipients: to.split(',').map(addr => ({
          emailAddress: { address: addr.trim() },
        })),
      }),
    });

    return { messageId: `fwd-${Date.now()}` };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private mapMessage(item: any): EmailMessage {
    return {
      id: item.id,
      from: this.formatGraphAddress(item.from),
      to: (item.toRecipients ?? []).map((r: any) => this.formatGraphAddress(r)),
      subject: item.subject ?? '(no subject)',
      date: new Date(item.receivedDateTime),
      read: item.isRead ?? false,
      preview: item.bodyPreview ?? undefined,
      hasAttachments: item.hasAttachments ?? false,
    };
  }

  private formatGraphAddress(recipient: any): string {
    if (!recipient) return 'unknown';
    const email = recipient.emailAddress ?? recipient;
    if (!email?.address) return 'unknown';
    return email.name ? `${email.name} <${email.address}>` : email.address;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
