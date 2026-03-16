import { describe, it, expect, vi } from 'vitest';
import { buildSkillContext } from '../context-factory.js';

function createMockUsers(overrides?: Partial<Record<string, unknown>>) {
  const users: Record<string, unknown> = {
    findOrCreate: vi.fn((_platform: string, platformUserId: string, username?: string, displayName?: string) => ({
      id: 'internal-1',
      platform: 'telegram',
      platformUserId,
      username,
      displayName,
    })),
    findById: vi.fn((id: string) =>
      id === 'internal-1'
        ? { id: 'internal-1', platform: 'telegram', platformUserId: 'plat-1', username: 'alice' }
        : undefined,
    ),
    getMasterUserId: vi.fn(() => 'master-1'),
    getLinkedUsers: vi.fn(() => [
      { platformUserId: 'plat-1' },
      { platformUserId: 'plat-2' },
    ]),
    getProfile: vi.fn(() => ({ timezone: 'Europe/Berlin' })),
    ...overrides,
  };
  return users as any;
}

describe('buildSkillContext', () => {
  it('resolves via platformUserId path', async () => {
    const users = createMockUsers();
    const result = await buildSkillContext(users, {
      platformUserId: 'plat-1',
      platform: 'telegram',
      chatId: 'chat-1',
      chatType: 'dm',
      userName: 'alice',
      displayName: 'Alice',
    });

    expect(users.findOrCreate).toHaveBeenCalledWith('telegram', 'plat-1', 'alice', 'Alice');
    expect(result.context.userId).toBe('plat-1');
    expect(result.context.masterUserId).toBe('master-1');
    expect(result.context.linkedPlatformUserIds).toEqual(['plat-1', 'plat-2']);
    expect(result.context.timezone).toBe('Europe/Berlin');
    expect(result.context.chatId).toBe('chat-1');
    expect(result.context.platform).toBe('telegram');
    expect(result.masterUserId).toBe('master-1');
    expect(result.user.id).toBe('internal-1');
  });

  it('resolves via userId with findById hit', async () => {
    const users = createMockUsers();
    const result = await buildSkillContext(users, {
      userId: 'internal-1',
      platform: 'telegram',
      chatId: 'chat-1',
    });

    expect(users.findById).toHaveBeenCalledWith('internal-1');
    expect(users.findOrCreate).not.toHaveBeenCalled();
    expect(result.context.userId).toBe('plat-1');
    expect(result.masterUserId).toBe('master-1');
  });

  it('falls back to findOrCreate when findById misses', async () => {
    const users = createMockUsers({
      findById: vi.fn(() => undefined),
    });
    const result = await buildSkillContext(users, {
      userId: 'unknown-uuid',
      platform: 'telegram',
      chatId: 'chat-1',
    });

    expect(users.findById).toHaveBeenCalledWith('unknown-uuid');
    expect(users.findOrCreate).toHaveBeenCalledWith('telegram', 'unknown-uuid');
    expect(result.context.userId).toBe('unknown-uuid');
  });

  it('uses server timezone when profile has none', async () => {
    const users = createMockUsers({
      getProfile: vi.fn(() => undefined),
    });
    const result = await buildSkillContext(users, {
      platformUserId: 'plat-1',
      platform: 'telegram',
      chatId: 'chat-1',
    });

    // Should fall back to Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(result.context.timezone).toBeTruthy();
    expect(result.context.timezone).not.toBe('Europe/Berlin');
  });

  it('throws when neither platformUserId nor userId provided', async () => {
    const users = createMockUsers();
    await expect(
      buildSkillContext(users, {
        platform: 'telegram',
        chatId: 'chat-1',
      }),
    ).rejects.toThrow('ContextSource must provide either platformUserId or userId');
  });
});
