import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { SkillContext } from '@alfred/types';
import type { Platform } from '@alfred/types';
import { CrossPlatformSkill } from './cross-platform.js';
import type { CrossPlatformAdapter } from './cross-platform.js';

let hasBetterSqlite3 = true;
try {
  const { Database } = await import('@alfred/storage');
  const testDb = new Database(path.join(os.tmpdir(), `alfred-probe-${Date.now()}.db`));
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('CrossPlatformSkill', () => {
  let dbPath: string;
  let db: import('@alfred/storage').Database;

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('@alfred/storage');
    const { UserRepository } = await import('@alfred/storage');
    const { LinkTokenRepository } = await import('@alfred/storage');

    dbPath = path.join(os.tmpdir(), `alfred-test-crossplatform-${Date.now()}.db`);
    db = new Database(dbPath);
    const rawDb = db.getDb();
    const users = new UserRepository(rawDb);
    const linkTokens = new LinkTokenRepository(rawDb);

    const adapters = new Map<Platform, CrossPlatformAdapter>();
    const mockAdapter: CrossPlatformAdapter = {
      sendMessage: async (chatId: string, text: string) => `msg-${Date.now()}`,
    };
    adapters.set('discord', mockAdapter);

    const skill = new CrossPlatformSkill(users, linkTokens, adapters);

    return { skill, users, linkTokens, adapters, mockAdapter };
  }

  const ctxTelegram: SkillContext = {
    userId: '',
    chatId: 'tg-chat-1',
    platform: 'telegram',
    conversationId: 'conv-tg',
  };

  const ctxDiscord: SkillContext = {
    userId: '',
    chatId: 'dc-chat-1',
    platform: 'discord',
    conversationId: 'conv-dc',
  };

  it('link_start generates a 6-digit code', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const ctx = { ...ctxTelegram, userId: tgUser.id };

    const result = await skill.execute({ action: 'link_start' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const data = result.data as { code: string; expiresAt: string };
    expect(data.code).toBeDefined();
    expect(data.code).toMatch(/^\d{6}$/);
    expect(data.expiresAt).toBeDefined();
  });

  it('link_confirm with valid code links accounts', async () => {
    const { skill, users } = await setup();

    // Create two users on different platforms
    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const dcUser = users.findOrCreate('discord', 'dc-user-1', 'alice_dc');

    const tgCtx = { ...ctxTelegram, userId: tgUser.id };
    const dcCtx = { ...ctxDiscord, userId: dcUser.id };

    // Generate code on telegram
    const startResult = await skill.execute({ action: 'link_start' }, tgCtx);
    expect(startResult.success).toBe(true);
    const code = (startResult.data as { code: string }).code;

    // Confirm on discord
    const confirmResult = await skill.execute({ action: 'link_confirm', code }, dcCtx);
    expect(confirmResult.success).toBe(true);

    const confirmData = confirmResult.data as { masterUserId: string; linkedPlatform: string };
    expect(confirmData.masterUserId).toBeDefined();
    expect(confirmData.linkedPlatform).toBe('telegram');
  });

  it('link_confirm with invalid code fails', async () => {
    const { skill, users } = await setup();

    const dcUser = users.findOrCreate('discord', 'dc-user-1', 'bob');
    const dcCtx = { ...ctxDiscord, userId: dcUser.id };

    const result = await skill.execute({ action: 'link_confirm', code: '000000' }, dcCtx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid or expired');
  });

  it('link_confirm with missing code fails', async () => {
    const { skill, users } = await setup();

    const dcUser = users.findOrCreate('discord', 'dc-user-1', 'bob');
    const dcCtx = { ...ctxDiscord, userId: dcUser.id };

    const result = await skill.execute({ action: 'link_confirm' }, dcCtx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('code');
  });

  it('link_confirm with own code (self-link) fails', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    // Generate and confirm with same user
    const startResult = await skill.execute({ action: 'link_start' }, tgCtx);
    const code = (startResult.data as { code: string }).code;

    const confirmResult = await skill.execute({ action: 'link_confirm', code }, tgCtx);

    expect(confirmResult.success).toBe(false);
    expect(confirmResult.error).toContain('Cannot link an account to itself');
  });

  it('list_identities shows linked accounts', async () => {
    const { skill, users } = await setup();

    // Create and link two users
    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice', 'Alice');
    const dcUser = users.findOrCreate('discord', 'dc-user-1', 'alice_dc', 'Alice DC');

    const tgCtx = { ...ctxTelegram, userId: tgUser.id };
    const dcCtx = { ...ctxDiscord, userId: dcUser.id };

    // Link them
    const startResult = await skill.execute({ action: 'link_start' }, tgCtx);
    const code = (startResult.data as { code: string }).code;
    await skill.execute({ action: 'link_confirm', code }, dcCtx);

    // List identities from telegram side
    const listResult = await skill.execute({ action: 'list_identities' }, tgCtx);

    expect(listResult.success).toBe(true);
    const data = listResult.data as { identities: Array<{ platform: string }> };
    expect(data.identities.length).toBe(2);

    const platforms = data.identities.map(i => i.platform);
    expect(platforms).toContain('telegram');
    expect(platforms).toContain('discord');
  });

  it('list_identities with no links returns single identity', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const listResult = await skill.execute({ action: 'list_identities' }, tgCtx);

    expect(listResult.success).toBe(true);
    expect(listResult.display).toContain('No linked accounts');
  });

  it('unlink removes a link', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice', 'Alice');
    const dcUser = users.findOrCreate('discord', 'dc-user-1', 'alice_dc', 'Alice DC');

    const tgCtx = { ...ctxTelegram, userId: tgUser.id };
    const dcCtx = { ...ctxDiscord, userId: dcUser.id };

    // Link
    const startResult = await skill.execute({ action: 'link_start' }, tgCtx);
    const code = (startResult.data as { code: string }).code;
    await skill.execute({ action: 'link_confirm', code }, dcCtx);

    // Unlink from telegram side
    const unlinkResult = await skill.execute(
      { action: 'unlink', platform: 'discord' },
      tgCtx,
    );

    expect(unlinkResult.success).toBe(true);
    const unlinkData = unlinkResult.data as { unlinkedPlatform: string };
    expect(unlinkData.unlinkedPlatform).toBe('discord');

    // Verify list now shows only one
    const listResult = await skill.execute({ action: 'list_identities' }, tgCtx);
    expect(listResult.success).toBe(true);
    // After unlinking, only 1 identity remains (or "No linked accounts" message)
    expect(listResult.display).toContain('No linked accounts');
  });

  it('unlink with missing platform fails', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const result = await skill.execute({ action: 'unlink' }, tgCtx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('platform');
  });

  it('send_message sends via adapter', async () => {
    const { skill, users, mockAdapter } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const result = await skill.execute(
      {
        action: 'send_message',
        platform: 'discord',
        chat_id: 'dc-chat-42',
        message: 'Hello from telegram!',
      },
      tgCtx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { messageId: string; platform: string; chatId: string };
    expect(data.platform).toBe('discord');
    expect(data.chatId).toBe('dc-chat-42');
    expect(data.messageId).toBeDefined();
  });

  it('send_message with unavailable platform fails', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const result = await skill.execute(
      {
        action: 'send_message',
        platform: 'whatsapp',
        chat_id: 'wa-chat-1',
        message: 'Hello',
      },
      tgCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('send_message with missing fields fails', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const r1 = await skill.execute({ action: 'send_message' }, tgCtx);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('platform');

    const r2 = await skill.execute({ action: 'send_message', platform: 'discord' }, tgCtx);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('chat_id');

    const r3 = await skill.execute(
      { action: 'send_message', platform: 'discord', chat_id: 'c1' },
      tgCtx,
    );
    expect(r3.success).toBe(false);
    expect(r3.error).toContain('message');
  });

  it('unknown action returns error', async () => {
    const { skill, users } = await setup();

    const tgUser = users.findOrCreate('telegram', 'tg-user-1', 'alice');
    const tgCtx = { ...ctxTelegram, userId: tgUser.id };

    const result = await skill.execute({ action: 'invalid_action' }, tgCtx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});
