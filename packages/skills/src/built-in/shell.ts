import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import { exec } from 'node:child_process';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_SIZE = 10_000;

function truncate(text: string): string {
  if (text.length > MAX_OUTPUT_SIZE) {
    return text.slice(0, MAX_OUTPUT_SIZE) + '\n[output truncated]';
  }
  return text;
}

export class ShellSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'shell',
    description:
      'Execute shell commands on the host system and return stdout/stderr output. ' +
      'Use this tool to run CLI commands, scripts, or system utilities. ' +
      'Commands run in a child process with a configurable timeout and working directory.',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
      },
      required: ['command'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const command = input.command as string | undefined;

    if (!command || typeof command !== 'string') {
      return {
        success: false,
        error: 'Missing required field "command"',
      };
    }

    const timeout =
      typeof input.timeout === 'number' && input.timeout > 0
        ? input.timeout
        : DEFAULT_TIMEOUT;

    const cwd =
      typeof input.cwd === 'string' && input.cwd.length > 0
        ? input.cwd
        : undefined;

    try {
      const { stdout, stderr, exitCode } = await this.run(command, timeout, cwd);

      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${truncate(stdout)}`);
      if (stderr) parts.push(`stderr:\n${truncate(stderr)}`);
      if (parts.length === 0) parts.push('(no output)');
      parts.push(`exit code: ${exitCode}`);

      return {
        success: exitCode === 0,
        data: { stdout, stderr, exitCode },
        display: parts.join('\n\n'),
        ...(exitCode !== 0 && { error: `Command exited with code ${exitCode}` }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Shell execution failed: ${message}`,
      };
    }
  }

  private run(
    command: string,
    timeout: number,
    cwd: string | undefined,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(command, { timeout, cwd }, (error, stdout, stderr) => {
        const exitCode =
          error && 'code' in error && typeof error.code === 'number'
            ? error.code
            : error
              ? 1
              : 0;

        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
        });
      });
    });
  }
}
