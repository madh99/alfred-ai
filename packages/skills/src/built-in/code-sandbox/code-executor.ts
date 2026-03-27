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
  private resolveNodePath(): string {
    const dirs = new Set<string>();

    // 1. Try require.resolve (works in dev, fails in bundle)
    for (const pkg of ['pdf-parse', 'exceljs', 'pdfkit', 'docx']) {
      try {
        const resolved = require.resolve(`${pkg}/package.json`);
        dirs.add(path.dirname(path.dirname(resolved)));
      } catch { /* not available */ }
    }

    // 2. Fallback: node_modules next to the running script (resolve symlinks)
    try {
      const realScript = fs.realpathSync(process.argv[1] ?? '');
      const scriptDir = path.dirname(realScript);
      // Check node_modules next to bundle (e.g. /tmp/node_modules)
      const candidate = path.join(scriptDir, 'node_modules');
      if (fs.existsSync(candidate)) dirs.add(candidate);
      // Check parent node_modules (global npm install: .../bundle/../node_modules)
      const parentCandidate = path.join(scriptDir, '..', 'node_modules');
      if (fs.existsSync(parentCandidate)) dirs.add(fs.realpathSync(parentCandidate));
    } catch { /* argv[1] not resolvable */ }

    // 3. Fallback: node_modules in cwd
    const cwdCandidate = path.join(process.cwd(), 'node_modules');
    if (fs.existsSync(cwdCandidate)) dirs.add(cwdCandidate);

    // 4. Preserve existing NODE_PATH entries (split by delimiter)
    if (process.env.NODE_PATH) {
      for (const p of process.env.NODE_PATH.split(path.delimiter)) {
        if (p) dirs.add(p);
      }
    }

    return [...dirs].join(path.delimiter);
  }

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

      // Build a safe env that excludes secrets and API keys
      const safeEnv: Record<string, string> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (val === undefined) continue;
        // Exclude Alfred secrets and common sensitive env vars
        if (/^ALFRED_/i.test(key)) continue;
        if (/^(ANTHROPIC|OPENAI|GOOGLE|AWS|AZURE|GITHUB|GITLAB|SLACK)_/i.test(key)) continue;
        if (/token|secret|password|api.?key|credentials/i.test(key)) continue;
        safeEnv[key] = val;
      }

      return await new Promise<ExecutionResult>((resolve) => {
        const proc = spawn(cmd, args, {
          cwd: tmpDir,
          timeout,
          env: {
            ...safeEnv,
            NODE_ENV: 'sandbox',
            PYTHONDONTWRITEBYTECODE: '1',
            ...options?.env,
            TMPDIR: tmpDir,
            TEMP: tmpDir,
            TMP: tmpDir,
            NODE_PATH: this.resolveNodePath(),
          },
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
                  : f.endsWith('.html') || f.endsWith('.htm') ? 'text/html'
                  : f.endsWith('.txt') ? 'text/plain'
                  : f.endsWith('.md') ? 'text/markdown'
                  : f.endsWith('.xml') ? 'application/xml'
                  : f.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  : f.endsWith('.xls') ? 'application/vnd.ms-excel'
                  : f.endsWith('.pdf') ? 'application/pdf'
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
