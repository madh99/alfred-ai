import type { ToolDefinition } from '@alfred/types';
import { Skill } from './skill.js';

export class SkillRegistry {
  private readonly skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    const { name } = skill.metadata;

    if (this.skills.has(name)) {
      throw new Error(`Skill "${name}" is already registered`);
    }

    this.skills.set(name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return [...this.skills.values()];
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  toToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      inputSchema: skill.metadata.inputSchema,
    }));
  }
}
