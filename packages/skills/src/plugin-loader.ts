import fs from 'node:fs';
import path from 'node:path';
import { Skill } from './skill.js';

export class PluginLoader {
  /**
   * Load all plugin skills from .js files in the given directory.
   * Each file must default-export a class that extends Skill.
   * Files that fail to load are skipped with a warning logged to console.
   */
  async loadFromDirectory(dirPath: string): Promise<Skill[]> {
    const resolvedDir = path.resolve(dirPath);

    let entries: string[];

    try {
      entries = await fs.promises.readdir(resolvedDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`PluginLoader: failed to read directory "${resolvedDir}": ${message}`);
      return [];
    }

    const jsFiles = entries.filter((entry) => entry.endsWith('.js'));
    const skills: Skill[] = [];

    for (const file of jsFiles) {
      const filePath = path.join(resolvedDir, file);

      try {
        const skill = await this.loadFromFile(filePath);
        skills.push(skill);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`PluginLoader: skipping "${filePath}": ${message}`);
      }
    }

    return skills;
  }

  /**
   * Load a single plugin skill from a .js file.
   * The module must default-export a class that extends Skill.
   */
  async loadFromFile(filePath: string): Promise<Skill> {
    const resolvedPath = path.resolve(filePath);

    // Convert to a file:// URL for dynamic import compatibility on all platforms
    const fileUrl = `file:///${resolvedPath.replace(/\\/g, '/')}`;

    const mod: Record<string, unknown> = await import(fileUrl);
    const ExportedClass = mod.default as new () => Skill;

    if (typeof ExportedClass !== 'function') {
      throw new Error(`Module "${resolvedPath}" does not have a default export that is a class`);
    }

    const instance = new ExportedClass();

    if (!(instance instanceof Skill)) {
      throw new Error(
        `Default export of "${resolvedPath}" does not extend Skill`,
      );
    }

    this.validateMetadata(instance, resolvedPath);

    return instance;
  }

  private validateMetadata(skill: Skill, filePath: string): void {
    const { metadata } = skill;

    if (!metadata) {
      throw new Error(`Plugin "${filePath}" is missing metadata`);
    }

    if (!metadata.name || typeof metadata.name !== 'string') {
      throw new Error(`Plugin "${filePath}" has invalid or missing metadata.name`);
    }

    if (!metadata.description || typeof metadata.description !== 'string') {
      throw new Error(`Plugin "${filePath}" has invalid or missing metadata.description`);
    }

    const validRiskLevels = ['read', 'write', 'destructive', 'admin'];

    if (!validRiskLevels.includes(metadata.riskLevel)) {
      throw new Error(
        `Plugin "${filePath}" has invalid metadata.riskLevel: "${String(metadata.riskLevel)}"`,
      );
    }

    if (!metadata.version || typeof metadata.version !== 'string') {
      throw new Error(`Plugin "${filePath}" has invalid or missing metadata.version`);
    }
  }
}
