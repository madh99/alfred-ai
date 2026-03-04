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
      if (retry.status === 204) return undefined;
      return retry.json();
    }

    if (!res.ok) throw new Error(`Graph API error: ${res.status}`);
    if (res.status === 204) return undefined;
    return res.json();
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
    const params = new URLSearchParams({
      $search: `"${query}"`,
      $top: String(Math.min(Math.max(1, count), 50)),
      $select: 'id,from,toRecipients,subject,receivedDateTime,isRead,bodyPreview,hasAttachments',
    });

    const data = await this.graphRequest(`/me/messages?${params}`);
    return (data.value ?? []).map((item: any) => this.mapMessage(item));
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
