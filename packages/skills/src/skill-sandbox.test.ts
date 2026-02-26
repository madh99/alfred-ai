import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillSandbox } from './skill-sandbox.js';
import { Skill } from './skill.js';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as any;

const dummyContext: SkillContext = {
  userId: 'user-1',
  chatId: 'chat-1',
  platform: 'telegram',
  conversationId: 'conv-1',
};

class SuccessSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'success_skill',
    description: 'A skill that succeeds',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: {} },
  };

  async execute(): Promise<SkillResult> {
    return { success: true, data: 'ok' };
  }
}

class ErrorSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'error_skill',
    description: 'A skill that throws',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: {} },
  };

  async execute(): Promise<SkillResult> {
    throw new Error('Skill exploded');
  }
}

class SlowSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'slow_skill',
    description: 'A skill that takes too long',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: {} },
  };

  async execute(): Promise<SkillResult> {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ success: true, data: 'done' }), 60_000);
    });
  }
}

describe('SkillSandbox', () => {
  let sandbox: SkillSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    sandbox = new SkillSandbox(mockLogger);
  });

  it('should execute skill and return result', async () => {
    const skill = new SuccessSkill();
    const result = await sandbox.execute(skill, {}, dummyContext);

    expect(result).toEqual({ success: true, data: 'ok' });
  });

  it('should handle skill errors', async () => {
    const skill = new ErrorSkill();
    const result = await sandbox.execute(skill, {}, dummyContext);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill exploded');
  });

  it('should timeout slow skills', async () => {
    vi.useFakeTimers();

    const skill = new SlowSkill();
    const resultPromise = sandbox.execute(skill, {}, dummyContext, 100);

    // Advance timers past the timeout
    vi.advanceTimersByTime(200);

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');

    vi.useRealTimers();
  });
});
