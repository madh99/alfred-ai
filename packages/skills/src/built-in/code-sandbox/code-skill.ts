import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../../skill.js';
import { CodeExecutor } from './code-executor.js';

export class CodeExecutionSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'code_sandbox',
    description: 'Execute code in a sandboxed environment. Supports JavaScript (Node.js) and Python. Use for calculations, data processing, generating charts, or testing code snippets. Code runs in an isolated temp directory with a timeout.',
    riskLevel: 'destructive',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'run_with_data'], description: 'Action to perform' },
        code: { type: 'string', description: 'Code to execute' },
        language: { type: 'string', enum: ['javascript', 'python'], description: 'Programming language' },
        data: { type: 'string', description: 'Input data to pass (available as DATA env var or stdin)' },
        timeout: { type: 'number', description: 'Timeout in ms (max 120000)' },
      },
      required: ['action', 'code', 'language'],
    },
  };

  private readonly executor = new CodeExecutor();
  private readonly allowedLanguages: Set<string>;
  private readonly maxTimeout: number;

  constructor(config?: { allowedLanguages?: string[]; maxTimeoutMs?: number }) {
    super();
    this.allowedLanguages = new Set(config?.allowedLanguages ?? ['javascript', 'python']);
    this.maxTimeout = config?.maxTimeoutMs ?? 120_000;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;
    const code = input.code as string;
    const language = input.language as 'javascript' | 'python';
    const data = input.data as string | undefined;
    const timeout = Math.min((input.timeout as number) ?? 30_000, this.maxTimeout);

    if (!code) return { success: false, error: 'Missing required field "code"' };
    if (!language) return { success: false, error: 'Missing required field "language"' };
    if (!this.allowedLanguages.has(language)) {
      return { success: false, error: `Language "${language}" is not allowed. Allowed: ${[...this.allowedLanguages].join(', ')}` };
    }

    let finalCode = code;
    if (action === 'run_with_data' && data) {
      // Inject data as environment variable
      if (language === 'javascript') {
        finalCode = `const INPUT_DATA = ${JSON.stringify(data)};\n${code}`;
      } else {
        finalCode = `INPUT_DATA = ${JSON.stringify(data)}\n${code}`;
      }
    }

    const result = await this.executor.execute(finalCode, language, { timeout });

    const output = [
      result.stdout ? `Output:\n${result.stdout}` : '',
      result.stderr ? `Errors:\n${result.stderr}` : '',
      `Exit code: ${result.exitCode}`,
      `Duration: ${result.durationMs}ms`,
    ].filter(Boolean).join('\n\n');

    return {
      success: result.exitCode === 0,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        fileCount: result.files?.length ?? 0,
      },
      display: output,
      error: result.exitCode !== 0 ? `Code execution failed with exit code ${result.exitCode}` : undefined,
    };
  }
}
