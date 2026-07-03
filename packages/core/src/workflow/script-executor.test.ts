import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ScriptExecutor } from './script-executor.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.test-scripts');
const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

// Auf Windows-Dev-Maschinen löst `bash` zu WSLs bash.exe auf, das je nach
// Distro-Zustand fehlschlägt — bash-Erfolgspfade dort skippen (Muster wie die
// Storage-SQLite-Tests); die Parsing-Logik deckt der node-Interpreter überall ab.
const isWindows = process.platform === 'win32';

describe('ScriptExecutor', () => {
  beforeAll(() => { try { mkdirSync(TEST_DIR, { recursive: true }); } catch {} });
  afterAll(() => { try { rmSync(TEST_DIR, { recursive: true }); } catch {} });

  it.skipIf(isWindows)('executes bash and returns JSON output', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    const result = await executor.execute(
      { language: 'bash', code: 'echo \'{"value": 42}\'', timeout: 5000, outputFormat: 'json' },
      'test-wf', 0,
    );
    expect(result.success).toBe(true);
    expect(result.data.value).toBe(42);
  });

  it.skipIf(isWindows)('executes bash and returns text output', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    const result = await executor.execute(
      { language: 'bash', code: 'echo "hello world"', timeout: 5000, outputFormat: 'text' },
      'test-wf', 1,
    );
    expect(result.success).toBe(true);
    expect(result.data.raw).toBe('hello world');
  });

  it('executes node and returns JSON output', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    const result = await executor.execute(
      { language: 'node', code: 'console.log(JSON.stringify({ value: 42 }))', timeout: 5000, outputFormat: 'json' },
      'test-wf-node', 0,
    );
    expect(result.success).toBe(true);
    expect(result.data.value).toBe(42);
  });

  it('executes node and returns text output', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    const result = await executor.execute(
      { language: 'node', code: 'console.log("hello world")', timeout: 5000, outputFormat: 'text' },
      'test-wf-node', 1,
    );
    expect(result.success).toBe(true);
    expect(result.data.raw).toBe('hello world');
  });

  it('handles script errors', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    const result = await executor.execute(
      { language: 'bash', code: 'exit 1', timeout: 5000 },
      'test-wf', 2,
    );
    expect(result.success).toBe(false);
  });

  it('cleans up script files', async () => {
    const executor = new ScriptExecutor(TEST_DIR, mockLogger);
    await executor.execute({ language: 'bash', code: 'echo ok', timeout: 5000 }, 'cleanup-wf', 0);
    executor.cleanup('cleanup-wf');
    // Should not throw
  });
});
