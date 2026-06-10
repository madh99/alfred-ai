import { describe, it, expect, vi } from 'vitest';
import { EmailSkill } from './index.js';
import { EmailProvider } from './email-provider.js';
import type { EmailMessage, EmailDetail, SendEmailInput } from './email-provider.js';

/**
 * v861 — Email-ID-Routing: der aWATTar-Vorfall vom 10.06.2026.
 *
 * Bug-Kette (vor v861):
 *  1. search (account:"outlook") liefert composite-ID `outlook::AAMkADFj…`
 *  2. LLM übergibt beim read die NACKTE Graph-ID (Prefix verloren)
 *  3. decodeId findet kein `::` → Fallback providers[0] = Gmail/IMAP
 *  4. parseInt("AAMk…") → "messageId must be a positive number"
 *  5. LLM probiert numerische ID → IMAP-Sequenznummer → liest die
 *     älteste Gmail-Mail von 2017
 *
 * v861-Fixes: account-Param wird respektiert, Graph-IDs werden zum
 * (einzigen) Microsoft-Provider selbst-geheilt, IMAP-Fehlertext erklärt
 * Graph-IDs.
 */

const GRAPH_ID = 'AAMkADFjMzlmNzZkLTk4YTAtNGU1ZC1hM2I2LWRmNTBjMjA1YmY2YwBGAAAAAAB';

class FakeMicrosoftProvider extends EmailProvider {
  readonly providerType = 'microsoft' as const;
  readMessageCalls: string[] = [];
  async initialize(): Promise<void> { /* noop */ }
  async fetchInbox(): Promise<EmailMessage[]> { return []; }
  async readMessage(id: string): Promise<EmailDetail> {
    this.readMessageCalls.push(id);
    return {
      id, from: 'service@awattar.com', to: ['user@example.com'],
      subject: 'aWATTar - Rechnung Strom 05/2026', date: new Date(), read: true,
      body: 'Rechnung', attachments: [{ id: 'att1', name: 'rechnung.pdf', contentType: 'application/pdf', size: 1234 }],
    };
  }
  async searchMessages(): Promise<EmailMessage[]> { return []; }
  async sendMessage(_i: SendEmailInput): Promise<{ messageId: string }> { return { messageId: 'x' }; }
  async listFolders(): Promise<string[]> { return []; }
  async fetchFolder(): Promise<EmailMessage[]> { return []; }
  async downloadAttachment(): Promise<Buffer> { return Buffer.from('%PDF-fake'); }
}

class FakeImapProvider extends EmailProvider {
  readonly providerType = 'imap' as const;
  readMessageCalls: string[] = [];
  async initialize(): Promise<void> { /* noop */ }
  async fetchInbox(): Promise<EmailMessage[]> { return []; }
  async readMessage(id: string): Promise<EmailDetail> {
    this.readMessageCalls.push(id);
    const seq = parseInt(id, 10);
    if (isNaN(seq) || seq < 1) {
      if (/^A[AQ]Mk/.test(id)) {
        throw new Error(`"${id.slice(0, 20)}…" ist eine Microsoft-Graph-Message-ID — dieser Account ist aber ein IMAP-Postfach.`);
      }
      throw new Error('messageId must be a positive number (sequence number).');
    }
    return {
      id, from: 'old@gmail.com', to: [], subject: `Old mail seq ${seq}`,
      date: new Date('2017-01-01'), read: true, body: 'old',
    };
  }
  async searchMessages(): Promise<EmailMessage[]> { return []; }
  async sendMessage(_i: SendEmailInput): Promise<{ messageId: string }> { return { messageId: 'x' }; }
  async listFolders(): Promise<string[]> { return []; }
  async fetchFolder(): Promise<EmailMessage[]> { return []; }
  async downloadAttachment(): Promise<Buffer> { return Buffer.from('x'); }
}

function makeSkill() {
  const gmail = new FakeImapProvider();
  const outlook = new FakeMicrosoftProvider();
  // Insertion-Order absichtlich wie auf .92: Gmail ZUERST (= impliziter Default)
  const skill = new EmailSkill(new Map<string, EmailProvider>([
    ['GmailMarkus', gmail],
    ['outlook', outlook],
  ]));
  return { skill, gmail, outlook };
}

const ctx = { userId: 'u1', chatId: 'c1', platform: 'api', conversationId: 'cv1' } as any;

describe('v861 Email-ID-Routing', () => {
  it('composite-ID outlook::GraphID routet zu Microsoft (bisheriges Verhalten)', async () => {
    const { skill, outlook } = makeSkill();
    const r = await skill.execute({ action: 'read', messageId: `outlook::${GRAPH_ID}` }, ctx);
    expect(r.success).toBe(true);
    expect(outlook.readMessageCalls).toEqual([GRAPH_ID]);
  });

  it('nackte Graph-ID + account:"outlook" routet zu Microsoft (Kern-Fix)', async () => {
    const { skill, outlook, gmail } = makeSkill();
    const r = await skill.execute({ action: 'read', messageId: GRAPH_ID, account: 'outlook' }, ctx);
    expect(r.success).toBe(true);
    expect(outlook.readMessageCalls).toEqual([GRAPH_ID]);
    expect(gmail.readMessageCalls).toEqual([]);
  });

  it('nackte Graph-ID OHNE account-Param: Selfheal zum einzigen Microsoft-Provider', async () => {
    const { skill, outlook, gmail } = makeSkill();
    const r = await skill.execute({ action: 'read', messageId: GRAPH_ID }, ctx);
    expect(r.success).toBe(true);
    expect(outlook.readMessageCalls).toEqual([GRAPH_ID]);
    expect(gmail.readMessageCalls).toEqual([]);
  });

  it('numerische ID ohne account bleibt beim Default (IMAP legacy-kompatibel)', async () => {
    const { skill, gmail } = makeSkill();
    const r = await skill.execute({ action: 'read', messageId: '42' }, ctx);
    expect(r.success).toBe(true);
    expect(gmail.readMessageCalls).toEqual(['42']);
  });

  it('attachment mit Graph-ID + account routet zu Microsoft und lädt PDF', async () => {
    const { skill, outlook } = makeSkill();
    const r = await skill.execute({ action: 'attachment', messageId: GRAPH_ID, attachmentId: 'rechnung.pdf', account: 'outlook' }, ctx);
    expect(r.success).toBe(true);
    expect(outlook.readMessageCalls).toContain(GRAPH_ID);
  });

  it('IMAP-Provider erklärt Graph-IDs statt kryptischem parseInt-Fehler', async () => {
    const { skill } = makeSkill();
    // Erzwinge IMAP-Routing trotz Graph-ID (expliziter falscher Account)
    const r = await skill.execute({ action: 'read', messageId: GRAPH_ID, account: 'GmailMarkus' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Microsoft-Graph-Message-ID/);
  });

  it('setDefaultAccount ändert den Fallback für nicht-Graph-IDs', async () => {
    const { skill, outlook } = makeSkill();
    skill.setDefaultAccount('outlook');
    // numerische ID → kein Graph-Selfheal, kein account-Param → configuredDefault
    await skill.execute({ action: 'read', messageId: '7' }, ctx).catch(() => {});
    expect(outlook.readMessageCalls).toEqual(['7']);
  });

  it('setDefaultAccount ignoriert unbekannte Accounts', async () => {
    const { skill, gmail } = makeSkill();
    skill.setDefaultAccount('nonexistent');
    await skill.execute({ action: 'read', messageId: '7' }, ctx);
    expect(gmail.readMessageCalls).toEqual(['7']); // Insertion-Order-Fallback bleibt
  });
});
