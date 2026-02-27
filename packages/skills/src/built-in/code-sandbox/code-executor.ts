import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: { name: string; data: Buffer; mimeType: string }[];
  durationMs: number;
}

export class CodeExecutor {
  async execute(
    code: string,
    language: 'javascript' | 'python',
    options?: { timeout?: number; env?: Record<string, string> },
  ): Promise<ExecutionResult> {
    const timeout = Math.min(options?.timeout ?? 30_000, 120_000);
    const tmpDir = path.join(os.tmpdir(), `alfred-sandbox-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const ext = language === 'javascript' ? 'js' : 'py';
      const scriptPath = path.join(tmpDir, `script.${ext}`);
      fs.writeFileSync(scriptPath, code);

      const cmd = language === 'javascript' ? 'node' : (process.platform === 'win32' ? 'python' : 'python3');
      const args = [scriptPath];

      const startTime = Date.now();

      return await new Promise<ExecutionResult>((resolve) => {
        const proc = spawn(cmd, args, {
          cwd: tmpDir,
          timeout,
          env: { ...process.env, ...options?.env, TMPDIR: tmpDir, TEMP: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (exitCode) => {
          const durationMs = Date.now() - startTime;

          // Check for output files (images, etc.)
          const files: ExecutionResult['files'] = [];
          try {
            const outputFiles = fs.readdirSync(tmpDir).filter(f => !f.startsWith('script.'));
            for (const f of outputFiles) {
              const filePath = path.join(tmpDir, f);
              const stat = fs.statSync(filePath);
              if (stat.isFile() && stat.size < 10_000_000) { // Max 10MB
                const data = fs.readFileSync(filePath);
                const mimeType = f.endsWith('.png') ? 'image/png'
                  : f.endsWith('.jpg') || f.endsWith('.jpeg') ? 'image/jpeg'
                  : f.endsWith('.svg') ? 'image/svg+xml'
                  : f.endsWith('.csv') ? 'text/csv'
                  : f.endsWith('.json') ? 'application/json'
                  : 'application/octet-stream';
                files.push({ name: f, data, mimeType });
              }
            }
          } catch { /* ignore */ }

          resolve({
            stdout: stdout.slice(0, 50_000), // Cap output
            stderr: stderr.slice(0, 10_000),
            exitCode: exitCode ?? 1,
            files: files.length > 0 ? files : undefined,
            durationMs,
          });
        });

        proc.on('error', (err) => {
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 1,
            durationMs: Date.now() - startTime,
          });
        });

        // Close stdin
        proc.stdin.end();
      });
    } finally {
      // Cleanup temp dir
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}
