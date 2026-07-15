import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { collectRepoStatus } from './repo-status.js';
import { gitProbe } from './probes/git-probe.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Lokales "Remote" (bare) + Clone — damit ahead/behind ohne Netz testbar sind. */
async function setupRepoWithRemote(): Promise<{ root: string; clone: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'alfred-repo-status-'));
  const bare = path.join(root, 'remote.git');
  const clone = path.join(root, 'work');
  await execFileAsync('git', ['init', '-q', '--bare', bare]);
  await execFileAsync('git', ['clone', '-q', bare, clone]);
  await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: clone });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: clone });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: clone });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: clone });
  return { root, clone };
}

describe('collectRepoStatus', () => {
  let root: string;
  let clone: string;

  beforeAll(async () => {
    ({ root, clone } = await setupRepoWithRemote());
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws for missing cwd', async () => {
    await expect(collectRepoStatus('/nonexistent/path-12345')).rejects.toThrow('does not exist');
  });

  it('throws for a cwd without .git/', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-repo-status-nogit-'));
    try {
      await expect(collectRepoStatus(tmp)).rejects.toThrow('not a git repository');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports clean + synced state with upstream', async () => {
    const rs = await collectRepoStatus(clone);
    expect(rs.sha).toHaveLength(8);
    expect(rs.dirtyCount).toBe(0);
    expect(rs.dirtyFiles).toEqual([]);
    expect(rs.upstream).toMatch(/^origin\//);
    expect(rs.ahead).toBe(0);
    expect(rs.behind).toBe(0);
    expect(rs.commitAgeDays).toBe(0);
  });

  it('reports dirty files (untracked) with sample paths', async () => {
    writeFileSync(path.join(clone, 'wip.txt'), 'work in progress\n', 'utf8');
    try {
      const rs = await collectRepoStatus(clone);
      expect(rs.dirtyCount).toBe(1);
      expect(rs.dirtyFiles).toContain('wip.txt');
    } finally {
      rmSync(path.join(clone, 'wip.txt'), { force: true });
    }
  });

  it('reports ahead after a local commit without push', async () => {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'local-only'], { cwd: clone });
    const rs = await collectRepoStatus(clone);
    expect(rs.ahead).toBe(1);
    expect(rs.behind).toBe(0);
    // zurücksetzen für Folge-Tests
    await execFileAsync('git', ['push', '-q'], { cwd: clone });
  });

  it('reports null ahead/behind without upstream', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-repo-status-noup-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
      const rs = await collectRepoStatus(tmp);
      expect(rs.upstream).toBeNull();
      expect(rs.ahead).toBeNull();
      expect(rs.behind).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('compares branch against defaultBranch', async () => {
    const rs = await collectRepoStatus(clone, { defaultBranch: 'definitely-other-branch' });
    expect(rs.onDefaultBranch).toBe(false);
    const rs2 = await collectRepoStatus(clone, { defaultBranch: rs.branch });
    expect(rs2.onDefaultBranch).toBe(true);
  });

  it('v1119: mergedIntoDefault — gemergter Feature-Branch erkannt, eigener Commit nicht, auf Default undefined', async () => {
    const base = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clone })).stdout.trim();
    await execFileAsync('git', ['checkout', '-q', '-b', 'feature/merged'], { cwd: clone });
    try {
      // gleicher Commit wie der Default-Branch → vollständig enthalten
      const rs = await collectRepoStatus(clone, { defaultBranch: base });
      expect(rs.onDefaultBranch).toBe(false);
      expect(rs.mergedIntoDefault).toBe(true);
      // eigener Commit auf dem Feature-Branch → nicht mehr enthalten
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'nur-im-feature'], { cwd: clone });
      const rs2 = await collectRepoStatus(clone, { defaultBranch: base });
      expect(rs2.mergedIntoDefault).toBe(false);
    } finally {
      await execFileAsync('git', ['checkout', '-q', base], { cwd: clone });
      await execFileAsync('git', ['branch', '-q', '-D', 'feature/merged'], { cwd: clone });
    }
    // auf dem Default-Branch selbst bleibt das Feld leer (kein Vergleichsfall)
    const rs3 = await collectRepoStatus(clone, { defaultBranch: base });
    expect(rs3.mergedIntoDefault).toBeUndefined();
  });
});

describe('gitProbe v872 (dirty/ahead → warning)', () => {
  let root: string;
  let clone: string;

  beforeAll(async () => {
    ({ root, clone } = await setupRepoWithRemote());
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clean + pushed repo is ok with extended details', async () => {
    const result = await gitProbe({ cwd: clone });
    expect(result.status).toBe('ok');
    expect(result.details).toContain('dirty=0');
    expect(result.details).toContain('ahead=0');
  });

  it('uncommitted file flips to warning', async () => {
    writeFileSync(path.join(clone, 'uncommitted.txt'), 'x\n', 'utf8');
    try {
      const result = await gitProbe({ cwd: clone });
      expect(result.status).toBe('warning');
      expect(result.details).toContain('dirty=1');
    } finally {
      rmSync(path.join(clone, 'uncommitted.txt'), { force: true });
    }
  });

  it('unpushed commit flips to warning', async () => {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'not pushed'], { cwd: clone });
    const result = await gitProbe({ cwd: clone });
    expect(result.status).toBe('warning');
    expect(result.details).toContain('ahead=1');
    await execFileAsync('git', ['push', '-q'], { cwd: clone });
  });

  it('repo without upstream stays ok when clean (upstream=none)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alfred-git-probe-noup-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@local'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
      const result = await gitProbe({ cwd: tmp });
      expect(result.status).toBe('ok');
      expect(result.details).toContain('upstream=none');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
