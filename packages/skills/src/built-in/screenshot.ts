import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Skill } from '../skill.js';

export class ScreenshotSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'screenshot',
    category: 'media',
    description:
      'Take a screenshot of the current screen and save it to a file. ' +
      'Use when the user asks to capture their screen or take a screenshot.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Output file path (optional, defaults to ~/Desktop/screenshot-<timestamp>.png)',
        },
      },
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultDir = path.join(os.homedir(), 'Desktop');
    const outputPath = (input.path as string) || path.join(defaultDir, `screenshot-${timestamp}.png`);

    try {
      switch (process.platform) {
        case 'darwin':
          execSync(`screencapture -x "${outputPath}"`, { timeout: 10_000 });
          break;

        case 'win32':
          // PowerShell screenshot using .NET
          execSync(
            `powershell -NoProfile -Command "` +
            `Add-Type -AssemblyName System.Windows.Forms; ` +
            `$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
            `$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height); ` +
            `$graphics = [System.Drawing.Graphics]::FromImage($bitmap); ` +
            `$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); ` +
            `$bitmap.Save('${outputPath.replace(/'/g, "''")}'); ` +
            `$graphics.Dispose(); $bitmap.Dispose()"`,
            { timeout: 10_000 },
          );
          break;

        default: // linux
          // Try multiple tools
          try {
            execSync(`scrot "${outputPath}"`, { timeout: 10_000 });
          } catch {
            try {
              execSync(`import -window root "${outputPath}"`, { timeout: 10_000 });
            } catch {
              execSync(`gnome-screenshot -f "${outputPath}"`, { timeout: 10_000 });
            }
          }
          break;
      }

      return {
        success: true,
        data: { path: outputPath },
        display: `Screenshot saved to ${outputPath}`,
      };
    } catch (err) {
      return { success: false, error: `Screenshot failed: ${(err as Error).message}` };
    }
  }
}
