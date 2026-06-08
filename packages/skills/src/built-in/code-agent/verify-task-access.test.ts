import { describe, it, expect, vi } from 'vitest';
import { ProjectAgentSkill } from './project-agent-skill.js';
import type { SkillContext } from '@alfred/types';
import type { ProjectAgentSession, ProjectAgentSessionRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

/**
 * v856 — verifyTaskAccess Owner-Check via cwd → project → user_id.
 * Bisheriger Bug: `(session as any).chatId` war immer undefined weil keine
 * chat_id-Spalte in project_agent_sessions. Folge: jeder Non-Admin-Owner
 * bekam "Task ... nicht gefunden oder keine Berechtigung." obwohl er
 * legitimer Projekt-Eigentümer war.
 *
 * Diese Tests rufen verifyTaskAccess INDIREKT über die status-Action auf
 * (verifyTaskAccess ist private). status() returnt `{ success: false, error:
 * 'Task "..." nicht gefunden oder keine Berechtigung.' }` wenn Access verweigert.
 */

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const SESSION_CWD = '/home/madh/projects/alpbyte';

function makeSession(overrides: Partial<ProjectAgentSession> = {}): ProjectAgentSession {
  return {
    id: 'sess-1',
    taskId: 'task-abc',
    goal: 'do stuff',
    cwd: SESSION_CWD,
    agentName: 'claude-code',
    currentPhase: 'done',
    currentIteration: 0,
    totalFilesChanged: 0,
    lastBuildPassed: false,
    milestones: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    autoResumeCount: 0,
    mode: 'classic',
    ...overrides,
  } as unknown as ProjectAgentSession;
}

function makeSessionRepo(session: ProjectAgentSession | null): ProjectAgentSessionRepository {
  return {
    getByTaskId: vi.fn(async () => session),
    create: vi.fn(),
    addMilestone: vi.fn(),
  } as unknown as ProjectAgentSessionRepository;
}

function makeLLM(): LLMProvider {
  return { complete: vi.fn() } as unknown as LLMProvider;
}

function makeContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    userId: 'platform-user',
    chatId: 'project:abc-def',
    platform: 'api',
    conversationId: 'conv-1',
    masterUserId: OWNER_ID,
    ...overrides,
  } as SkillContext;
}

function makeSkill(opts: {
  session: ProjectAgentSession | null;
  projectOwnerForCwd?: string | null;  // null = project not found
  injectedOwnerUserId?: string;
}): ProjectAgentSkill {
  const skill = new ProjectAgentSkill(
    { enabled: true, agents: [{ name: 'claude-code', command: 'claude', argsTemplate: [] } as any] },
    makeLLM(),
    makeSessionRepo(opts.session),
  );
  // setProjectLookup: project repo with findByCwdAnyOwner
  const repoStub = {
    findByCwd: vi.fn(),
    findByCwdAnyOwner: vi.fn(async (_cwd: string) => {
      if (opts.projectOwnerForCwd === undefined) return null;
      if (opts.projectOwnerForCwd === null) return null;
      return { id: 'proj-1', name: 'p', userId: opts.projectOwnerForCwd, cwd: SESSION_CWD };
    }),
    list: vi.fn(async () => []),
  };
  // setProjectLookup signatur: (repo, ownerUserId)
  skill.setProjectLookup(repoStub as any, opts.injectedOwnerUserId as any);
  return skill;
}

/** Wrapper: ruft status-Action und liefert success-Flag + ggf. Fehler. */
async function tryStatus(skill: ProjectAgentSkill, context: SkillContext) {
  const r = await skill.execute({ action: 'status', task_id: 'task-abc' }, context);
  return { success: r.success, error: r.error };
}

describe('verifyTaskAccess (v856) — Owner-Check via cwd', () => {
  it('grants access when context.userRole === "admin"', async () => {
    const skill = makeSkill({ session: makeSession(), projectOwnerForCwd: OTHER_ID });
    const r = await tryStatus(skill, makeContext({ userRole: 'admin', masterUserId: 'someone-else' }));
    expect(r.success).toBe(true);
  });

  it('grants access when context.masterUserId matches project owner (via findByCwdAnyOwner)', async () => {
    const skill = makeSkill({ session: makeSession(), projectOwnerForCwd: OWNER_ID });
    const r = await tryStatus(skill, makeContext({ masterUserId: OWNER_ID }));
    expect(r.success).toBe(true);
  });

  it('grants access via ownerUserId fallback in single-user setup', async () => {
    const skill = makeSkill({
      session: makeSession(),
      projectOwnerForCwd: null,  // no project entry for this cwd
      injectedOwnerUserId: OWNER_ID,
    });
    const r = await tryStatus(skill, makeContext({ masterUserId: OWNER_ID }));
    expect(r.success).toBe(true);
  });

  it('denies access when caller is neither admin nor owner', async () => {
    const skill = makeSkill({ session: makeSession(), projectOwnerForCwd: OTHER_ID });
    const r = await tryStatus(skill, makeContext({ masterUserId: 'random-user' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nicht gefunden oder keine Berechtigung/);
  });

  it('denies access when session does not exist (getByTaskId returns null)', async () => {
    const skill = makeSkill({ session: null, projectOwnerForCwd: OWNER_ID });
    const r = await tryStatus(skill, makeContext({ userRole: 'admin' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nicht gefunden oder keine Berechtigung/);
  });

  it('denies access when context.masterUserId missing AND not admin', async () => {
    const skill = makeSkill({ session: makeSession(), projectOwnerForCwd: OWNER_ID });
    const r = await tryStatus(skill, makeContext({ masterUserId: undefined }));
    expect(r.success).toBe(false);
  });

  it('does not silently allow when findByCwdAnyOwner throws — falls through to other checks', async () => {
    const skill = new ProjectAgentSkill(
      { enabled: true, agents: [{ name: 'claude-code', command: 'claude', argsTemplate: [] } as any] },
      makeLLM(),
      makeSessionRepo(makeSession()),
    );
    const throwingRepo = {
      findByCwd: vi.fn(),
      findByCwdAnyOwner: vi.fn(async () => { throw new Error('db down'); }),
      list: vi.fn(async () => []),
    };
    skill.setProjectLookup(throwingRepo as any, OWNER_ID as any);
    // Admin should still pass even if repo throws (didn't reach repo check)
    const adminResult = await tryStatus(skill, makeContext({ userRole: 'admin' }));
    expect(adminResult.success).toBe(true);
    // Non-admin owner falls through to ownerUserId fallback (which matches)
    const ownerResult = await tryStatus(skill, makeContext({ masterUserId: OWNER_ID }));
    expect(ownerResult.success).toBe(true);
    // Non-admin non-owner: still denied
    const otherResult = await tryStatus(skill, makeContext({ masterUserId: 'random' }));
    expect(otherResult.success).toBe(false);
  });
});
