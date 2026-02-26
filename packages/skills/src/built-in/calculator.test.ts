import { describe, it, expect, beforeEach } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { CalculatorSkill } from './calculator.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

describe('CalculatorSkill', () => {
  let skill: CalculatorSkill;

  beforeEach(() => {
    skill = new CalculatorSkill();
  });

  it('should evaluate simple addition', async () => {
    const result = await skill.execute({ expression: '2 + 3' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toBe(5);
  });

  it('should evaluate multiplication', async () => {
    const result = await skill.execute({ expression: '6 * 7' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toBe(42);
  });

  it('should support Math functions', async () => {
    const result = await skill.execute({ expression: 'Math.sqrt(16)' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toBe(4);
  });

  it('should reject invalid expressions', async () => {
    const result = await skill.execute({ expression: 'process.exit()' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('disallowed');
  });

  it('should reject empty input', async () => {
    const result = await skill.execute({ expression: '' }, ctx);
    expect(result.success).toBe(false);
  });

  it('should handle division by zero', async () => {
    const result = await skill.execute({ expression: '1/0' }, ctx);
    expect(result.success).toBe(false);
  });
});
