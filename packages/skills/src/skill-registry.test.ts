import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from './skill-registry.js';
import { Skill } from './skill.js';
import type { SkillMetadata, SkillResult } from '@alfred/types';

class TestSkill extends Skill {
  readonly metadata: SkillMetadata;

  constructor(name = 'test_skill', description = 'A test skill') {
    super();
    this.metadata = {
      name,
      description,
      riskLevel: 'read' as const,
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {} },
    };
  }

  async execute(): Promise<SkillResult> {
    return { success: true, data: 'ok' };
  }
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('should register a skill', () => {
    const skill = new TestSkill();
    registry.register(skill);
    expect(registry.has('test_skill')).toBe(true);
  });

  it('should retrieve a skill by name', () => {
    const skill = new TestSkill();
    registry.register(skill);
    const retrieved = registry.get('test_skill');
    expect(retrieved).toBe(skill);
  });

  it('should throw on duplicate registration', () => {
    const skill1 = new TestSkill();
    const skill2 = new TestSkill();
    registry.register(skill1);
    expect(() => registry.register(skill2)).toThrow('already registered');
  });

  it('should list all skills', () => {
    const skill1 = new TestSkill('skill_a', 'Skill A');
    const skill2 = new TestSkill('skill_b', 'Skill B');
    registry.register(skill1);
    registry.register(skill2);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });

  it('should convert to tool definitions', () => {
    const skill = new TestSkill();
    registry.register(skill);
    const tools = registry.toToolDefinitions();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'test_skill',
      description: 'A test skill',
      inputSchema: { type: 'object', properties: {} },
    });
  });
});
