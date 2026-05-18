import { describe, it, expect } from 'vitest';
import { gitProbe } from './git-probe.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('gitProbe', () => {
  it('returns skipped when no cwd is configured', async () => {
    const result = await gitProbe({});
    expect(result.probe).toBe('git');
    expect(result.status).toBe('skipped');
    expect(result.details).toContain('no cwd');
  });

  it('returns error for non-existing cwd', async () => {
    const result = await gitProbe({ cwd: '/nonexistent/path/that/should/not/be/here-12345' });
    expect(result.status).toBe('error');
    expect(result.details).toContain('does not exist');
  });

  it('returns error for a cwd without .git/', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-git-probe-'));
    try {
      const result = await gitProbe({ cwd: tmp });
      expect(result.status).toBe('error');
      expect(result.details).toContain('not a git repository');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok for a fresh repo with a recent commit', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-git-probe-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
      const result = await gitProbe({ cwd: tmp });
      expect(result.status).toBe('ok');
      expect(result.details).toContain('branch=');
      expect(result.details).toContain('age_days=');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records duration_ms', async () => {
    const result = await gitProbe({});
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
