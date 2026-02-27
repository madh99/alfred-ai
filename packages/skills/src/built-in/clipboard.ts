import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { execSync } from 'node:child_process';
import { Skill } from '../skill.js';

export class ClipboardSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'clipboard',
    description:
      'Read or write the system clipboard. Use when the user asks to copy something, ' +
      'paste from clipboard, or check what is in their clipboard.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: '"read" to get clipboard contents, "write" to set clipboard contents',
        },
        text: {
          type: 'string',
          description: 'Text to copy to clipboard (required for write)',
        },
      },
      required: ['action'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'read': return this.readClipboard();
      case 'write': return this.writeClipboard(input.text as string | undefined);
      default:
        return { success: false, error: `Unknown action "${action}". Valid: read, write` };
    }
  }

  private readClipboard(): SkillResult {
    try {
      let content: string;

      switch (process.platform) {
        case 'darwin':
          content = execSync('pbpaste', { encoding: 'utf-8', timeout: 5000 });
          break;
        case 'win32':
          content = execSync('powershell -NoProfile -Command Get-Clipboard', {
            encoding: 'utf-8',
            timeout: 5000,
          }).replace(/\r\n$/, '');
          break;
        default: // linux
          content = execSync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output', {
            encoding: 'utf-8',
            timeout: 5000,
          });
          break;
      }

      if (!content || content.trim().length === 0) {
        return { success: true, data: { content: '' }, display: 'Clipboard is empty.' };
      }

      return {
        success: true,
        data: { content },
        display: content.length > 2000 ? content.slice(0, 2000) + '\n\n[... truncated]' : content,
      };
    } catch (err) {
      return { success: false, error: `Failed to read clipboard: ${(err as Error).message}` };
    }
  }

  private writeClipboard(text: string | undefined): SkillResult {
    if (!text || typeof text !== 'string') {
      return { success: false, error: 'Missing "text" for write action' };
    }

    try {
      switch (process.platform) {
        case 'darwin':
          execSync('pbcopy', { input: text, timeout: 5000 });
          break;
        case 'win32':
          // Use stdin pipe to avoid escaping issues
          execSync('powershell -NoProfile -Command "$input | Set-Clipboard"', {
            input: text,
            timeout: 5000,
          });
          break;
        default: // linux
          execSync('xclip -selection clipboard 2>/dev/null || xsel --clipboard --input', {
            input: text,
            timeout: 5000,
          });
          break;
      }

      return {
        success: true,
        data: { copiedLength: text.length },
        display: `Copied ${text.length} characters to clipboard.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to write clipboard: ${(err as Error).message}` };
    }
  }
}
