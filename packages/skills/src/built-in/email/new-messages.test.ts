import { describe, it, expect } from 'vitest';
import { EmailSkill } from './index.js';
import { EmailProvider } from './email-provider.js';
import type { EmailMessage, EmailDetail, SendEmailInput } from './email-provider.js';

// v1211 — deterministische Aktion `new_messages` für die Mail-Ereignisquelle:
// Posteingang holen, nach Absender/Betreff/Zeit filtern, keine Gmail-Operatoren, kein Modell.
class FakeProvider extends EmailProvider {
  readonly providerType = 'microsoft' as const;
  constructor(private readonly mails: EmailMessage[]) { super(); }
  async initialize(): Promise<void> { /* noop */ }
  async fetchInbox(): Promise<EmailMessage[]> { return this.mails; }
  async readMessage(id: string): Promise<EmailDetail> { return { id, from: '', to: [], subject: '', date: new Date(), read: true, body: '' }; }
  async searchMessages(): Promise<EmailMessage[]> { return []; }
  async sendMessage(_i: SendEmailInput): Promise<{ messageId: string }> { return { messageId: 'x' }; }
  async listFolders(): Promise<string[]> { return []; }
  async fetchFolder(): Promise<EmailMessage[]> { return []; }
  async downloadAttachment(): Promise<Buffer> { return Buffer.from('x'); }
}

const OUTLOOK: EmailMessage[] = [
  { id: 'm3', from: 'aWATTar Service <service@awattar.com>', to: [], subject: 'aWATTar - Rechnung Strom 06/2026 - 3', date: new Date('2026-07-10T09:50:00Z'), read: false, hasAttachments: true },
  { id: 'm2', from: 'news@awattar.com', to: [], subject: 'Neuigkeiten', date: new Date('2026-07-09T09:50:00Z'), read: true },
  { id: 'm1', from: 'aWATTar Service <service@awattar.com>', to: [], subject: 'aWATTar - Rechnung Strom 05/2026 - 2', date: new Date('2026-06-10T09:50:00Z'), read: true, hasAttachments: true },
];

function skill(): EmailSkill {
  // Zwei Konten wie auf .92 (Gmail zuerst = impliziter Default) → zusammengesetzte IDs mit Kontopräfix
  return new EmailSkill(new Map<string, EmailProvider>([['GmailX', new FakeProvider([])], ['outlook', new FakeProvider(OUTLOOK)]]));
}
const ctx = { userId: 'u', chatId: 'c', platform: 'test', conversationId: 'x' } as never;

describe('email new_messages (v1211)', () => {
  it('filtert nach Absender und Betreff, liefert zusammengesetzte IDs mit Kontopräfix, neueste zuerst', async () => {
    const r = await skill().execute({ action: 'new_messages', account: 'outlook', from: 'service@awattar.com', subject: 'Rechnung' }, ctx);
    expect(r.success).toBe(true);
    const d = r.data as { count: number; messages: Array<{ id: string; subject: string; date: string }> };
    expect(d.count).toBe(2);
    expect(d.messages.map(m => m.id)).toEqual(['outlook::m3', 'outlook::m1']);
    expect(d.messages[0].date).toBe('2026-07-10T09:50:00.000Z');
  });
  it('since schneidet ältere Nachrichten ab; ohne Filter kommt alles', async () => {
    const r = await skill().execute({ action: 'new_messages', account: 'outlook', since: '2026-07-01T00:00:00Z' }, ctx);
    const d = r.data as { count: number; messages: Array<{ id: string }> };
    expect(d.messages.map(m => m.id)).toEqual(['outlook::m3', 'outlook::m2']);
  });
  it('Standardkonto ohne Treffer → count 0, success true', async () => {
    const r = await skill().execute({ action: 'new_messages', from: 'awattar' }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { count: number }).count).toBe(0);
  });
});
