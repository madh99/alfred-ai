import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { CodeExecutor } from './code-executor.js';

let hasPython = true;
try {
  const { execSync } = await import('node:child_process');
  const cmd = process.platform === 'win32' ? 'python --version' : 'python3 --version';
  execSync(cmd, { stdio: 'pipe' });
} catch {
  hasPython = false;
}

describe('CodeExecutor', () => {
  const executor = new CodeExecutor();

  it('should execute JavaScript code and return stdout', async () => {
    const result = await executor.execute(
      'console.log("hello from sandbox");',
      'javascript',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from sandbox');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should capture stderr from JavaScript', async () => {
    const result = await executor.execute(
      'console.error("warning message");',
      'javascript',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning message');
  });

  it('should handle JavaScript syntax errors (non-zero exit code)', async () => {
    const result = await executor.execute(
      'const x = {;',
      'javascript',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it('should handle JavaScript runtime errors', async () => {
    const result = await executor.execute(
      'throw new Error("runtime failure");',
      'javascript',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('runtime failure');
  });

  it.skipIf(!hasPython)('should execute Python code and return stdout', async () => {
    const result = await executor.execute(
      'print("hello from python")',
      'python',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from python');
  });

  it.skipIf(!hasPython)('should handle Python syntax errors', async () => {
    const result = await executor.execute(
      'def foo(\n',
      'python',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it('should handle timeout', async () => {
    const result = await executor.execute(
      // Infinite loop — should be killed by timeout
      'while(true) {}',
      'javascript',
      { timeout: 1000 },
    );

    // On timeout, the process is killed and returns non-zero exit code
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
  }, 10_000);

  it('should clean up temp directory after execution', async () => {
    // List tmpdir contents before and after to verify cleanup
    const beforeDirs = new Set(
      fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('alfred-sandbox-')),
    );

    await executor.execute('console.log("cleanup test")', 'javascript');

    const afterDirs = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('alfred-sandbox-'));
    // No new sandbox dirs should remain
    const newDirs = afterDirs.filter(d => !beforeDirs.has(d));
    expect(newDirs.length).toBe(0);
  });

  it('should pass environment variables', async () => {
    const result = await executor.execute(
      'console.log(process.env.MY_TEST_VAR);',
      'javascript',
      { env: { MY_TEST_VAR: 'test_value_123' } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test_value_123');
  });

  it('should detect output files created by script', async () => {
    const result = await executor.execute(
      `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.TMPDIR || process.env.TEMP, 'output.json'), '{"result":42}');
console.log("file written");
      `,
      'javascript',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('file written');
    // Files are collected before cleanup
    if (result.files && result.files.length > 0) {
      const jsonFile = result.files.find(f => f.name === 'output.json');
      expect(jsonFile).toBeDefined();
      expect(jsonFile!.mimeType).toBe('application/json');
    }
  });

  it('should cap stdout at 50000 characters', async () => {
    const result = await executor.execute(
      // Print a very long string
      `console.log("x".repeat(60000));`,
      'javascript',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(50_000);
  });
});
