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
    category: 'automation',
    description:
      'Execute shell commands on the host system. Use this for ANY task involving files, folders, ' +
      'system operations, or running programs: ls, cat, find, file, du, mkdir, cp, mv, grep, etc. ' +
      'When the user asks about their documents, files, or anything on disk — use this tool.',
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

    // Block obviously dangerous shell patterns
    const dangerous = [
      /\brm\s+-rf\s+\/(?:\s|$)/,        // rm -rf /
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r)[a-zA-Z]*\s+\/(?:\s|$)/, // rm -r -f /
      /\brm\s+-rf\s+\/\*/,              // rm -rf /*
      /:(){ :|:& };:/,                  // fork bomb
      /:\(\)\s*\{.*\|.*&\s*\}\s*;/,     // fork bomb variant
      />\s*\/dev\/sd[a-z]/,              // write to raw disk
      /\bmkfs\b/,                        // format filesystem
      /\bdd\s+.*\bif=/,                  // dd if=
      /\bchmod\s+777\b/,                 // chmod 777
      /\bcurl\b.*\|\s*\bbash\b/,         // curl|bash
      /\bwget\b.*\|\s*\bsh\b/,           // wget|sh
      /\bpython[23]?\s+-c\b/,            // python -c
      /\bnode\s+-e\b/,                    // node -e
      /\b(bash|sh)\s+-i\b.*\/dev\/tcp/,  // reverse shell via /dev/tcp
      /\bnc\s+.*-e\b/,                   // netcat reverse shell
      /\b(bash|sh)\s+-c\b/,              // arbitrary command execution via bash -c / sh -c
      /\bdd\b.*\bof=\/dev\//,            // dd to block devices
      /\bchmod\s+777\s+\//,              // chmod 777 on root
      /\bchown\s+.*\s+\/(?:\s|$)/,       // chown on root
      /\bbase64\b.*\|\s*\b(bash|sh)\b/,  // base64 decode to shell
      /\bperl\s+-e\b/,                    // perl one-liner
      /\bruby\s+-e\b/,                    // ruby one-liner
      /\bphp\s+-r\b/,                     // php one-liner
      /\btee\s+\/(etc|root|boot|sys|proc)\//, // tee to sensitive paths
      /\bcrontab\b/,                      // crontab manipulation
      /\bmount\b/,                        // mount operations
      /\bstrace\b/,                       // process tracing
      /\bgdb\b/,                          // debugger
      /\bsudo\b/,                         // privilege escalation
      /\bchroot\b/,                       // chroot
      /\beval\s/,                         // eval execution
    ];
    for (const pattern of dangerous) {
      if (pattern.test(command)) {
        return {
          success: false,
          error: 'Command blocked: potentially destructive system operation',
        };
      }
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
