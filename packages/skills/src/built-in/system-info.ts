import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

type SystemInfoCategory = 'general' | 'memory' | 'uptime';

export class SystemInfoSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'system_info',
    description: 'Get system information about the Alfred bot',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['general', 'memory', 'uptime'],
          description: 'Category of system info',
        },
      },
      required: ['category'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const category = input.category as SystemInfoCategory;

    switch (category) {
      case 'general':
        return this.getGeneralInfo();
      case 'memory':
        return this.getMemoryInfo();
      case 'uptime':
        return this.getUptimeInfo();
      default:
        return {
          success: false,
          error: `Unknown category: "${String(category)}". Valid categories: general, memory, uptime`,
        };
    }
  }

  private getGeneralInfo(): SkillResult {
    const info = {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };

    return {
      success: true,
      data: info,
      display: `Node.js ${info.nodeVersion} on ${info.platform} (${info.arch})`,
    };
  }

  private getMemoryInfo(): SkillResult {
    const mem = process.memoryUsage();
    const toMB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);

    const info = {
      rss: `${toMB(mem.rss)} MB`,
      heapTotal: `${toMB(mem.heapTotal)} MB`,
      heapUsed: `${toMB(mem.heapUsed)} MB`,
      external: `${toMB(mem.external)} MB`,
    };

    return {
      success: true,
      data: info,
      display: `Memory — RSS: ${info.rss}, Heap: ${info.heapUsed} / ${info.heapTotal}, External: ${info.external}`,
    };
  }

  private getUptimeInfo(): SkillResult {
    const totalSeconds = process.uptime();
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const info = {
      uptimeSeconds: totalSeconds,
      formatted: `${hours}h ${minutes}m ${seconds}s`,
    };

    return {
      success: true,
      data: info,
      display: `Uptime: ${info.formatted}`,
    };
  }
}
