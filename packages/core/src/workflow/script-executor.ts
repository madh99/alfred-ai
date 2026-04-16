import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

interface ScriptStep {
  language: 'python' | 'node' | 'bash';
  code: string;
  timeout?: number;        // ms, default 30000
  outputFormat?: 'json' | 'text';
}

interface ScriptResult {
  success: boolean;
  data: Record<string, unknown>;
  output?: string;
  error?: string;
}

const INTERPRETERS: Record<string, string> = { python: 'python3', node: 'node', bash: 'bash' };
const EXTENSIONS: Record<string, string> = { python: '.py', node: '.mjs', bash: '.sh' };

export class ScriptExecutor {
  constructor(private readonly scriptsDir: string, private readonly logger: Logger) {
    try { mkdirSync(scriptsDir, { recursive: true }); } catch { /* exists */ }
  }

  async execute(step: ScriptStep, workflowId: string, stepIndex: number): Promise<ScriptResult> {
    const ext = EXTENSIONS[step.language] ?? '.sh';
    const filename = `${workflowId}_step${stepIndex}${ext}`;
    const filepath = join(this.scriptsDir, filename);
    writeFileSync(filepath, step.code, 'utf-8');

    const interpreter = INTERPRETERS[step.language] ?? 'bash';
    const timeout = step.timeout || 30_000;

    return new Promise<ScriptResult>((resolve) => {
      const proc = execFile(interpreter, [filepath], { timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const isTimeout = (err as NodeJS.ErrnoException & { killed?: boolean }).killed || err.message.includes('TIMEOUT');
          resolve({ success: false, data: {}, error: isTimeout ? `Script timeout after ${timeout}ms` : `${err.message}${stderr ? '\n' + stderr : ''}` });
          return;
        }
        const output = stdout.trim();
        if (step.outputFormat === 'json' || !step.outputFormat) {
          try {
            const parsed = JSON.parse(output);
            resolve({ success: true, data: typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed }, output });
          } catch {
            resolve({ success: true, data: { raw: output }, output });
          }
        } else {
          resolve({ success: true, data: { raw: output }, output });
        }
      });
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* dead */ } }, timeout + 1000);
    });
  }

  cleanup(workflowId: string): void {
    try {
      const files = readdirSync(this.scriptsDir);
      for (const f of files) {
        if (f.startsWith(`${workflowId}_`)) unlinkSync(join(this.scriptsDir, f));
      }
    } catch { /* best effort */ }
  }
}
