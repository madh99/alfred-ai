import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeAgentSkill } from './code-agent-skill.js';
import type { SkillContext } from '@alfred/types';

/**
 * v863 — Branch-Integritäts-Warnung bei code_agent.push.
 * Vorfall 11.06.: Push ging auf 'main', Projekt deployed von 'master' —
 * der User fand es erst nach dem Deploy. Jetzt warnt das Push-Result
 * wenn gepushter Branch ≠ projects.default_branch.
 */

let workDir = '';
let bareDir = '';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-bare-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-work-'));
  git(['init', '--bare'], bareDir);
  git(['init', '-b', 'main'], workDir);
  git(['config', 'user.email', 'test@local'], workDir);
  git(['config', 'user.name', 'Test'], workDir);
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'hello', 'utf8');
  git(['add', '-A'], workDir);
  git(['commit', '-m', 'init'], workDir);
  git(['remote', 'add', 'origin', bareDir], workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(bareDir, { recursive: true, force: true });
});

const ctx: SkillContext = {
  userId: 'u1', chatId: 'c1', platform: 'api', conversationId: 'cv1',
} as SkillContext;

describe('v863 code_agent.push Branch-Warnung', () => {
  it('warnt wenn gepushter Branch != project.defaultBranch', async () => {
    const skill = new CodeAgentSkill({ agents: [] });
    skill.setProjectLookup({
      findByCwdAnyOwner: async () => ({ defaultBranch: 'master', name: 'testproj' }),
    });
    fs.writeFileSync(path.join(workDir, 'b.txt'), 'change', 'utf8');
    const r = await skill.execute({ action: 'push', cwd: workDir, commitMessage: 'test change' }, ctx);
    expect(r.success).toBe(true);
    const data = r.data as { branch: string; branchMismatchWarning?: string };
    expect(data.branch).toBe('main');
    expect(data.branchMismatchWarning).toBeDefined();
    expect(data.branchMismatchWarning).toContain('deployed von "master"');
    expect(r.display).toContain('⚠️');
  });

  it('KEINE Warnung wenn Branch == defaultBranch', async () => {
    const skill = new CodeAgentSkill({ agents: [] });
    skill.setProjectLookup({
      findByCwdAnyOwner: async () => ({ defaultBranch: 'main', name: 'testproj' }),
    });
    fs.writeFileSync(path.join(workDir, 'c.txt'), 'change2', 'utf8');
    const r = await skill.execute({ action: 'push', cwd: workDir, commitMessage: 'test 2' }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { branchMismatchWarning?: string }).branchMismatchWarning).toBeUndefined();
  });

  it('KEINE Warnung ohne projectLookup (backwards-compat)', async () => {
    const skill = new CodeAgentSkill({ agents: [] });
    fs.writeFileSync(path.join(workDir, 'd.txt'), 'change3', 'utf8');
    const r = await skill.execute({ action: 'push', cwd: workDir, commitMessage: 'test 3' }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { branchMismatchWarning?: string }).branchMismatchWarning).toBeUndefined();
  });

  it('Lookup-Fehler bricht den Push nicht (best-effort)', async () => {
    const skill = new CodeAgentSkill({ agents: [] });
    skill.setProjectLookup({
      findByCwdAnyOwner: async () => { throw new Error('db down'); },
    });
    fs.writeFileSync(path.join(workDir, 'e.txt'), 'change4', 'utf8');
    const r = await skill.execute({ action: 'push', cwd: workDir, commitMessage: 'test 4' }, ctx);
    expect(r.success).toBe(true);
  });
});
