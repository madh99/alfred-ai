import { describe, it, expect, beforeEach } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { SummarizeSkill } from './summarize.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

describe('SummarizeSkill', () => {
  let skill: SummarizeSkill;

  beforeEach(() => {
    skill = new SummarizeSkill();
  });

  it('should return short text unchanged', async () => {
    const shortText = 'This is a short piece of text.';
    const result = await skill.execute({ text: shortText }, ctx);

    expect(result.success).toBe(true);
    expect(result.display).toBe(shortText);
  });

  it('should summarize long text', async () => {
    const longText =
      'Artificial intelligence has transformed many industries in recent decades. ' +
      'Machine learning algorithms can now identify patterns in massive datasets. ' +
      'Natural language processing enables computers to understand human speech. ' +
      'Computer vision systems can recognize objects and faces with remarkable accuracy. ' +
      'Robotics has advanced to the point where machines can perform complex physical tasks. ' +
      'Deep learning neural networks have achieved superhuman performance on many benchmarks. ' +
      'The ethical implications of AI development are widely debated among researchers. ' +
      'Governments around the world are establishing regulations for AI systems. ' +
      'The economic impact of automation continues to reshape labor markets globally. ' +
      'Future developments in AI promise even more dramatic changes to society and technology.';

    expect(longText.length).toBeGreaterThan(280);

    const result = await skill.execute({ text: longText }, ctx);

    expect(result.success).toBe(true);
    expect(result.display).toBeDefined();
    expect(result.display!.length).toBeLessThanOrEqual(280);
  });

  it('should handle empty text', async () => {
    const result = await skill.execute({ text: '' }, ctx);
    expect(result.success).toBe(false);
  });

  it('should respect custom maxLength', async () => {
    const longText =
      'Artificial intelligence has transformed many industries in recent decades. ' +
      'Machine learning algorithms can now identify patterns in massive datasets. ' +
      'Natural language processing enables computers to understand human speech. ' +
      'Computer vision systems can recognize objects and faces with remarkable accuracy. ' +
      'Robotics has advanced to the point where machines can perform complex physical tasks.';

    const result = await skill.execute({ text: longText, maxLength: 100 }, ctx);

    expect(result.success).toBe(true);
    expect(result.display).toBeDefined();
    expect(result.display!.length).toBeLessThanOrEqual(100);
  });
});
