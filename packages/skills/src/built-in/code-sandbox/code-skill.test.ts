import { describe, it, expect, beforeEach } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { CodeExecutionSkill } from './code-skill.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

describe('CodeExecutionSkill', () => {
  let skill: CodeExecutionSkill;

  beforeEach(() => {
    skill = new CodeExecutionSkill();
  });

  it('should have correct metadata', () => {
    expect(skill.metadata.name).toBe('code_sandbox');
    expect(skill.metadata.riskLevel).toBe('write');
  });

  it('run action executes JavaScript code', async () => {
    const result = await skill.execute(
      {
        action: 'run',
        code: 'console.log(2 + 2);',
        language: 'javascript',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain('4');
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('run_with_data injects data for JavaScript', async () => {
    const result = await skill.execute(
      {
        action: 'run_with_data',
        code: 'console.log("Data:", INPUT_DATA);',
        language: 'javascript',
        data: 'hello world',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain('hello world');
  });

  it('missing code returns error', async () => {
    const result = await skill.execute(
      {
        action: 'run',
        code: '',
        language: 'javascript',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('code');
  });

  it('disallowed language returns error', async () => {
    const restrictedSkill = new CodeExecutionSkill({ allowedLanguages: ['javascript'] });

    const result = await restrictedSkill.execute(
      {
        action: 'run',
        code: 'print("hello")',
        language: 'python',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
    expect(result.error).toContain('python');
  });

  it('failed code execution returns success=false with exit code', async () => {
    const result = await skill.execute(
      {
        action: 'run',
        code: 'process.exit(1);',
        language: 'javascript',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.exitCode).toBe(1);
    expect(result.error).toContain('exit code');
  });

  it('display includes stdout and exit code', async () => {
    const result = await skill.execute(
      {
        action: 'run',
        code: 'console.log("test output");',
        language: 'javascript',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.display).toContain('test output');
    expect(result.display).toContain('Exit code: 0');
  });

  it('display includes stderr when present', async () => {
    const result = await skill.execute(
      {
        action: 'run',
        code: 'console.error("err msg"); console.log("ok");',
        language: 'javascript',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.display).toContain('err msg');
    expect(result.display).toContain('Errors:');
  });

  it('rejects oversized code with action "run"', async () => {
    const result = await skill.execute(
      { action: 'run', code: 'x'.repeat(5000), language: 'javascript' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
    expect(result.error).toContain('run_with_data');
  });

  it('allows large data with run_with_data', async () => {
    const bigData = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i })));
    const result = await skill.execute(
      {
        action: 'run_with_data',
        code: 'console.log(INPUT_DATA.length);',
        language: 'javascript',
        data: bigData,
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).stdout).toContain('100');
  });

  it('run_with_data without data still runs code', async () => {
    const result = await skill.execute(
      {
        action: 'run_with_data',
        code: 'console.log("no data provided");',
        language: 'javascript',
        // no data field
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.stdout).toContain('no data provided');
  });
});
