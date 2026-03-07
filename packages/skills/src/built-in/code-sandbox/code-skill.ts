import type { SkillMetadata, SkillContext, SkillResult, SkillResultAttachment } from '@alfred/types';
import { Skill } from '../../skill.js';
import { CodeExecutor } from './code-executor.js';

export class CodeExecutionSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'code_sandbox',
    category: 'automation',
    description: 'Execute code in a sandboxed environment. Supports JavaScript (Node.js) and Python. Use for calculations, data processing, generating files (PDF, HTML, CSV, images, etc.), or testing code snippets. Code runs in an isolated temp directory with a timeout. Any files written to the working directory are automatically collected and sent to the user as attachments — do NOT use the file skill to send them afterwards. For PDF generation use pdfkit (Node.js) or reportlab/fpdf (Python). IMPORTANT: When generating large files, write compact data-driven code — define data as arrays/objects, then build the output programmatically. Never embed large HTML/text as string literals.',
    riskLevel: 'write',
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

    if (!code) return { success: false, error: 'Missing required field "code". IMPORTANT: Do NOT embed large HTML/text as string literals — write compact code that builds content programmatically from data arrays/objects, e.g. rows.map(r => `<tr><td>${r.time}</td><td>${r.price}</td></tr>`).join(""). Keep the code short and data-driven.' };
    if (!language) return { success: false, error: 'Missing required field "language"' };
    if (!this.allowedLanguages.has(language)) {
      return { success: false, error: `Language "${language}" is not allowed. Allowed: ${[...this.allowedLanguages].join(', ')}` };
    }

    if (action === 'run' && code.length > 4000) {
      return {
        success: false,
        error:
          `Code too large (${code.length} chars, limit 4000 for action "run"). ` +
          'This usually means data is hardcoded in the code. ' +
          'Use action "run_with_data" with the data parameter instead. ' +
          'The data will be available as INPUT_DATA (already parsed). ' +
          'If you received a data reference like "result_1", pass it as the data parameter.',
      };
    }

    let finalCode = code;
    if (action === 'run_with_data' && data) {
      let isJson = false;
      try { JSON.parse(data); isJson = true; } catch { /* not JSON */ }

      if (language === 'javascript') {
        finalCode = isJson
          ? `const INPUT_DATA = ${data};\n${code}`
          : `const INPUT_DATA = ${JSON.stringify(data)};\n${code}`;
      } else {
        finalCode = isJson
          ? `import json as _json\nINPUT_DATA = _json.loads(${JSON.stringify(data)})\n${code}`
          : `INPUT_DATA = ${JSON.stringify(data)}\n${code}`;
      }
    }

    const result = await this.executor.execute(finalCode, language, { timeout });

    // Map output files to attachments so the pipeline can send them to the user
    const attachments: SkillResultAttachment[] | undefined = result.files?.map(f => ({
      fileName: f.name,
      data: f.data,
      mimeType: f.mimeType,
    }));

    const output = [
      result.stdout ? `Output:\n${result.stdout}` : '',
      result.stderr ? `Errors:\n${result.stderr}` : '',
      `Exit code: ${result.exitCode}`,
      `Duration: ${result.durationMs}ms`,
      attachments && attachments.length > 0
        ? `Files generated: ${attachments.map(a => a.fileName).join(', ')}`
        : '',
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
      attachments,
    };
  }
}
