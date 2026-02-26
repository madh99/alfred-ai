import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Database } from '../database.js';

let hasBetterSqlite3 = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const testDb = new BetterSqlite3(':memory:');
  testDb.close();
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('ConversationRepository', () => {
  let dbPath: string;
  let db: Database;

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const { Database } = await import('../database.js');
    const { ConversationRepository } = await import('./conversation-repository.js');
    dbPath = path.join(os.tmpdir(), `alfred-test-conv-${Date.now()}.db`);
    db = new Database(dbPath);
    const repo = new ConversationRepository(db.getDb());
    return repo;
  }

  it('should create a conversation', async () => {
    const repo = await setup();

    const conversation = repo.create('telegram', 'chat-123', 'user-456');

    expect(conversation).toBeDefined();
    expect(conversation.id).toBeDefined();
    expect(typeof conversation.id).toBe('string');
    expect(conversation.platform).toBe('telegram');
    expect(conversation.chatId).toBe('chat-123');
    expect(conversation.userId).toBe('user-456');
    expect(conversation.createdAt).toBeDefined();
    expect(conversation.updatedAt).toBeDefined();
  });

  it('should find conversation by platform and chatId', async () => {
    const repo = await setup();

    const created = repo.create('discord', 'chat-abc', 'user-789');
    const found = repo.findByPlatformChat('discord', 'chat-abc');

    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.platform).toBe('discord');
    expect(found!.chatId).toBe('chat-abc');
  });

  it('should add and get messages', async () => {
    const repo = await setup();

    const conversation = repo.create('telegram', 'chat-msg', 'user-1');
    const message = repo.addMessage(conversation.id, 'user', 'Hello, Alfred!');

    expect(message).toBeDefined();
    expect(message.id).toBeDefined();
    expect(message.conversationId).toBe(conversation.id);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello, Alfred!');

    const messages = repo.getMessages(conversation.id);

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(message.id);
    expect(messages[0].content).toBe('Hello, Alfred!');
    expect(messages[0].role).toBe('user');
  });

  it('should return undefined for nonexistent conversation', async () => {
    const repo = await setup();

    const found = repo.findByPlatformChat('signal', 'nonexistent-chat');

    expect(found).toBeUndefined();
  });
});
