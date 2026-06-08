import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectTestRunner,
  sanitizeTestCommands,
  looksLikeTestRunnerFlagMismatch,
} from './test-runner-detect.js';

function makeTempProject(pkg: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-runner-detect-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return dir;
}

describe('detectTestRunner', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('returns vitest when scripts.test references vitest', async () => {
    tmpDir = makeTempProject({ scripts: { test: 'vitest run' } });
    expect(await detectTestRunner(tmpDir)).toBe('vitest');
  });

  it('returns jest when scripts.test references jest', async () => {
    tmpDir = makeTempProject({ scripts: { test: 'jest --runInBand' } });
    expect(await detectTestRunner(tmpDir)).toBe('jest');
  });

  it('returns vitest when only devDependencies has vitest', async () => {
    tmpDir = makeTempProject({ scripts: { test: 'tsc --noEmit && node test.js' }, devDependencies: { vitest: '^1.0.0' } });
    expect(await detectTestRunner(tmpDir)).toBe('vitest');
  });

  it('prefers script reference over devDependencies', async () => {
    tmpDir = makeTempProject({ scripts: { test: 'jest' }, devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' } });
    expect(await detectTestRunner(tmpDir)).toBe('jest');
  });

  it('returns unknown when no test runner found', async () => {
    tmpDir = makeTempProject({ scripts: { test: 'echo no tests' } });
    expect(await detectTestRunner(tmpDir)).toBe('unknown');
  });

  it('returns unknown when package.json missing', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-empty-'));
    expect(await detectTestRunner(tmpDir)).toBe('unknown');
  });

  it('returns jest when ts-jest is present', async () => {
    tmpDir = makeTempProject({ devDependencies: { 'ts-jest': '^29.0.0' } });
    expect(await detectTestRunner(tmpDir)).toBe('jest');
  });
});

describe('sanitizeTestCommands', () => {
  it('strips --runInBand from vitest commands', () => {
    const r = sanitizeTestCommands(
      ['npm test -- --runInBand src/foo.test.ts'],
      'vitest',
    );
    expect(r.testCommands).toEqual(['npm test -- src/foo.test.ts']);
    expect(r.strippedFlags).toHaveLength(1);
    expect(r.strippedFlags[0].flags).toContain('--runInBand');
  });

  it('strips multiple jest-only flags for vitest', () => {
    const r = sanitizeTestCommands(
      ['vitest run --runInBand --detectOpenHandles --forceExit src/'],
      'vitest',
    );
    expect(r.testCommands[0]).toBe('vitest run src/');
    expect(r.strippedFlags[0].flags.sort()).toEqual(['--detectOpenHandles', '--forceExit', '--runInBand']);
  });

  it('strips vitest-only flags for jest', () => {
    const r = sanitizeTestCommands(
      ['npm test -- --no-threads --pool=threads src/'],
      'jest',
    );
    expect(r.testCommands[0]).toBe('npm test -- src/');
    expect(r.strippedFlags[0].flags).toContain('--no-threads');
    expect(r.strippedFlags[0].flags).toContain('--pool=threads');
  });

  it('does NOT strip generic flags both runners support', () => {
    const r = sanitizeTestCommands(
      ['vitest run --reporter=verbose --watch=false src/'],
      'vitest',
    );
    expect(r.testCommands[0]).toBe('vitest run --reporter=verbose --watch=false src/');
    expect(r.strippedFlags).toHaveLength(0);
  });

  it('passes through unchanged when runner unknown', () => {
    const r = sanitizeTestCommands(
      ['npm test -- --runInBand src/'],
      'unknown',
    );
    expect(r.testCommands[0]).toBe('npm test -- --runInBand src/');
    expect(r.strippedFlags).toHaveLength(0);
  });

  it('preserves command order', () => {
    const r = sanitizeTestCommands(
      ['vitest run a.test.ts', 'npm test -- --runInBand b.test.ts'],
      'vitest',
    );
    expect(r.testCommands).toHaveLength(2);
    expect(r.testCommands[0]).toBe('vitest run a.test.ts');
    expect(r.testCommands[1]).toBe('npm test -- b.test.ts');
  });

  it('handles empty input', () => {
    const r = sanitizeTestCommands([], 'vitest');
    expect(r.testCommands).toEqual([]);
    expect(r.strippedFlags).toEqual([]);
  });
});

describe('looksLikeTestRunnerFlagMismatch', () => {
  it('detects vitest unknown-option errors', () => {
    expect(looksLikeTestRunnerFlagMismatch('vitest: error: unknown option: --runInBand')).toBe(true);
  });

  it('detects jest unrecognized-cli errors', () => {
    expect(looksLikeTestRunnerFlagMismatch('● Unrecognized CLI Parameter: --no-threads')).toBe(true);
  });

  it('detects yargs unknown-argument with known cross-runner flag', () => {
    expect(looksLikeTestRunnerFlagMismatch('Unknown argument: --runInBand')).toBe(true);
  });

  it('returns false on unrelated build errors', () => {
    expect(looksLikeTestRunnerFlagMismatch('error TS2304: Cannot find name foo')).toBe(false);
  });

  it('returns false on empty output', () => {
    expect(looksLikeTestRunnerFlagMismatch('')).toBe(false);
  });
});
