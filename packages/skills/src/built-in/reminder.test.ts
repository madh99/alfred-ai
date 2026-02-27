import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import type { ReminderRepository, ReminderEntry } from '@alfred/storage';
import { ReminderSkill } from './reminder.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

function createMockRepo(): ReminderRepository {
  const entries: ReminderEntry[] = [];

  return {
    create: vi.fn((userId: string, platform: string, chatId: string, message: string, triggerAt: Date): ReminderEntry => {
      const entry: ReminderEntry = {
        id: `reminder-${entries.length + 1}`,
        userId,
        platform,
        chatId,
        message,
        triggerAt: triggerAt.toISOString(),
        createdAt: new Date().toISOString(),
        fired: false,
      };
      entries.push(entry);
      return entry;
    }),
    getDue: vi.fn(() => entries.filter((e) => !e.fired)),
    getByUser: vi.fn((userId: string) => entries.filter((e) => e.userId === userId && !e.fired)),
    markFired: vi.fn((id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (entry) entry.fired = true;
    }),
    cancel: vi.fn((id: string) => {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      entries.splice(idx, 1);
      return true;
    }),
  } as unknown as ReminderRepository;
}

describe('ReminderSkill', () => {
  let skill: ReminderSkill;
  let repo: ReminderRepository;

  beforeEach(() => {
    repo = createMockRepo();
    skill = new ReminderSkill(repo);
  });

  it('should set a reminder and return id', async () => {
    const result = await skill.execute(
      { action: 'set', message: 'test reminder', delayMinutes: 5 },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>).reminderId).toBeDefined();
    expect(typeof (result.data as Record<string, unknown>).reminderId).toBe('string');
  });

  it('should list reminders for user', async () => {
    await skill.execute({ action: 'set', message: 'reminder 1', delayMinutes: 5 }, ctx);
    await skill.execute({ action: 'set', message: 'reminder 2', delayMinutes: 10 }, ctx);

    const listResult = await skill.execute({ action: 'list' }, ctx);

    expect(listResult.success).toBe(true);
    expect(Array.isArray(listResult.data)).toBe(true);
    expect((listResult.data as unknown[]).length).toBe(2);
  });

  it('should cancel a reminder', async () => {
    const setResult = await skill.execute(
      { action: 'set', message: 'to cancel', delayMinutes: 5 },
      ctx,
    );

    const reminderId = (setResult.data as Record<string, unknown>).reminderId as string;

    const cancelResult = await skill.execute(
      { action: 'cancel', reminderId },
      ctx,
    );

    expect(cancelResult.success).toBe(true);

    // Verify it no longer shows up in the list
    const listResult = await skill.execute({ action: 'list' }, ctx);
    expect((listResult.data as unknown[]).length).toBe(0);
  });

  it('should require message for set', async () => {
    const result = await skill.execute(
      { action: 'set', delayMinutes: 5 },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('message');
  });
});
