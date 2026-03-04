import { describe, it, expect } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { effectiveUserId, allUserIds } from './user-utils.js';

function makeContext(overrides?: Partial<SkillContext>): SkillContext {
  return {
    userId: 'plat-1',
    chatId: 'c1',
    platform: 'telegram',
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('effectiveUserId', () => {
  it('returns masterUserId when set', () => {
    expect(effectiveUserId(makeContext({ masterUserId: 'master-1' }))).toBe('master-1');
  });

  it('falls back to userId when masterUserId is undefined', () => {
    expect(effectiveUserId(makeContext())).toBe('plat-1');
  });
});

describe('allUserIds', () => {
  it('returns only userId when no linked data', () => {
    expect(allUserIds(makeContext())).toEqual(['plat-1']);
  });

  it('includes masterUserId, userId, and linked IDs', () => {
    const ids = allUserIds(makeContext({
      masterUserId: 'master-1',
      linkedPlatformUserIds: ['plat-1', 'plat-2', 'plat-3'],
    }));
    expect(ids).toContain('master-1');
    expect(ids).toContain('plat-1');
    expect(ids).toContain('plat-2');
    expect(ids).toContain('plat-3');
  });

  it('deduplicates IDs', () => {
    const ids = allUserIds(makeContext({
      userId: 'plat-1',
      masterUserId: 'plat-1',
      linkedPlatformUserIds: ['plat-1'],
    }));
    expect(ids).toEqual(['plat-1']);
  });
});
