import { describe, it, expect } from 'vitest';
import { extractBuildError } from './error-extractor.js';

describe('extractBuildError', () => {
  it('returns "no output" for empty input', () => {
    const result = extractBuildError('');
    expect(result.recognized).toBe(false);
    expect(result.summary).toContain('Kein Output');
  });

  it('recognizes the alpbyte-games EACCES /root/ trap', () => {
    const output = `
npm verbose stack Error: EACCES: permission denied, mkdir '/root/alpbyte-games'
npm error code EACCES
npm error path /root/alpbyte-games
npm error errno -13
`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('EACCES');
    expect(result.summary).toContain('/root/alpbyte-games');
    expect(result.summary).toContain('non-root User');
    expect(result.summary).toContain('/home/<user>/');
  });

  it('recognizes generic EACCES (non-/root path)', () => {
    const output = `Error: EACCES: permission denied, open '/var/log/somefile.log'`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('EACCES');
    expect(result.summary).toContain('/var/log/somefile.log');
    expect(result.summary).not.toContain('non-root User'); // generic, not the /root-specific recognizer
  });

  it('recognizes npm registry unreachable', () => {
    const output = `npm error code ETIMEDOUT\nnpm error errno ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/ failed`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('NPM_REGISTRY');
    expect(result.summary).toContain('Registry');
  });

  it('recognizes disk full', () => {
    const output = `Error: ENOSPC: no space left on device, write`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('ENOSPC');
    expect(result.summary).toContain('Disk voll');
  });

  it('recognizes missing module', () => {
    const output = `Error: Cannot find module 'react-router-dom'`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('MODULE_NOT_FOUND');
    expect(result.summary).toContain('react-router-dom');
  });

  it('recognizes TypeScript compile errors', () => {
    const output = `src/foo.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const result = extractBuildError(output);
    expect(result.recognized).toBe(true);
    expect(result.code).toBe('TS_COMPILE');
    expect(result.summary).toContain('TS2322');
  });

  it('falls back to tail for unrecognized errors', () => {
    const output = 'random unhelpful output\n'.repeat(50);
    const result = extractBuildError(output);
    expect(result.recognized).toBe(false);
    expect(result.contextSnippet.length).toBeGreaterThan(0);
  });

  it('captures context around error line (3 before, 5 after)', () => {
    const output = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'Error: something failed',  // index 4 — matches /^\s*Error:\s/i
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ].join('\n');
    const result = extractBuildError(output);
    // errorLine = index 4. Window: slice(start=max(0,1), end=min(12,10)) → indices 1..9
    expect(result.contextSnippet).toContain('line 2');           // index 1
    expect(result.contextSnippet).toContain('Error: something'); // index 4 (the marker)
    expect(result.contextSnippet).toContain('line 9');           // index 8
    expect(result.contextSnippet).not.toContain('line 11');      // index 10 — outside window
    expect(result.contextSnippet).not.toContain('line 12');
  });

  it('truncates very long context with "[...]" marker', () => {
    const output = 'EACCES permission denied\n' + 'a'.repeat(2000);
    const result = extractBuildError(output, 200);
    expect(result.contextSnippet.length).toBeLessThanOrEqual(220);
  });
});
