import { describe, it, expect, vi } from 'vitest';
import { SkillFailureReflector } from './skill-failure-reflector.js';
import type { ActivityRepository } from '@alfred/storage';
import type { Logger } from 'pino';

const noopLogger = {
  info: vi.fn(), warn: vi.fn(), errorMessage: vi.fn(), debug: vi.fn(), child: () => noopLogger,
} as unknown as Logger;

function makeRepoStub(entries: Array<{
  id: string; action?: string; outcome: 'success' | 'error';
  errorMessage?: string; details?: Record<string, unknown>; timestamp: string;
}>): ActivityRepository {
  // Map test-friendly shape to real ActivityEntry shape
  const realRows = entries.map(e => ({
    id: e.id, action: e.action ?? '', outcome: e.outcome,
    errorMessage: e.errorMessage, details: e.details, timestamp: e.timestamp,
    eventType: 'skill_call', source: 'user' as const,
  }));
  return {
    query: vi.fn().mockResolvedValue(realRows),
  } as unknown as ActivityRepository;
}

describe('SkillFailureReflector', () => {
  it('returns empty when no activity', async () => {
    const repo = makeRepoStub([]);
    const r = new SkillFailureReflector(repo, noopLogger);
    const out = await r.detect('user-1');
    expect(out).toEqual([]);
  });

  it('detects the alpbyte-games deploy-skill workaround pattern', async () => {
    // Reproduces the 19.05. 18:32 pattern: deploy failed 2x (command not found),
    // then shell calls with workaround, last shell succeeded
    const repo = makeRepoStub([
      { id: '1', action: 'deploy', outcome: 'error',
        errorMessage: "Service-Start fehlgeschlagen: docker-compose: command not found",
        details: { host: '192.168.1.96', user: 'ubuntu', project: 'alpbyte-games' },
        timestamp: '2026-05-19T16:34:11Z' },
      { id: '2', action: 'deploy', outcome: 'error',
        errorMessage: "Service-Start fehlgeschlagen: docker-compose: command not found",
        details: { host: '192.168.1.96', user: 'ubuntu' },
        timestamp: '2026-05-19T16:37:23Z' },
      { id: '3', action: 'shell', outcome: 'success',
        details: { command: "ssh ubuntu@192.168.1.96 'docker compose version'" },
        timestamp: '2026-05-19T16:38:12Z' },
      { id: '4', action: 'shell', outcome: 'success',
        details: { command: "ssh ubuntu@192.168.1.96 'cd /home/ubuntu/alpbyte-games && docker compose up -d --build'" },
        timestamp: '2026-05-19T16:40:33Z' },
    ]);
    const r = new SkillFailureReflector(repo, noopLogger);
    const patterns = await r.detect('user-1');
    expect(patterns.length).toBe(1);
    expect(patterns[0].failedSkill).toBe('deploy');
    expect(patterns[0].errorClass).toBe('COMMAND_NOT_FOUND');
    expect(patterns[0].scope).toBe('host=192.168.1.96');
    expect(patterns[0].workaroundSteps.length).toBe(2);
    expect(patterns[0].finalSuccess).toBe(true);
  });

  it('ignores single failures (below minConsecutiveFails)', async () => {
    const repo = makeRepoStub([
      { id: '1', action: 'deploy', outcome: 'error', errorMessage: 'something failed', timestamp: '2026-05-19T10:00:00Z' },
      { id: '2', action: 'shell', outcome: 'success', details: { command: 'workaround' }, timestamp: '2026-05-19T10:01:00Z' },
    ]);
    const r = new SkillFailureReflector(repo, noopLogger);
    expect(await r.detect('u')).toEqual([]);
  });

  it('ignores failures without workaround', async () => {
    const repo = makeRepoStub([
      { id: '1', action: 'deploy', outcome: 'error', errorMessage: 'fail', timestamp: '2026-05-19T10:00:00Z' },
      { id: '2', action: 'deploy', outcome: 'error', errorMessage: 'fail', timestamp: '2026-05-19T10:01:00Z' },
      // No follow-up shell/code_agent/deploy
    ]);
    const r = new SkillFailureReflector(repo, noopLogger);
    expect(await r.detect('u')).toEqual([]);
  });

  it('ignores failures where workaround also failed', async () => {
    const repo = makeRepoStub([
      { id: '1', action: 'deploy', outcome: 'error', errorMessage: 'fail', timestamp: '2026-05-19T10:00:00Z' },
      { id: '2', action: 'deploy', outcome: 'error', errorMessage: 'fail', timestamp: '2026-05-19T10:01:00Z' },
      { id: '3', action: 'shell', outcome: 'error', errorMessage: 'still broken', details: { command: 'x' }, timestamp: '2026-05-19T10:02:00Z' },
    ]);
    const r = new SkillFailureReflector(repo, noopLogger);
    expect(await r.detect('u')).toEqual([]);
  });

  it('extracts cwd scope when host absent', async () => {
    const repo = makeRepoStub([
      { id: '1', action: 'project_agent', outcome: 'error', errorMessage: 'fail',
        details: { cwd: '/tmp/proj' }, timestamp: '2026-05-19T10:00:00Z' },
      { id: '2', action: 'project_agent', outcome: 'error', errorMessage: 'fail',
        details: { cwd: '/tmp/proj' }, timestamp: '2026-05-19T10:01:00Z' },
      { id: '3', action: 'shell', outcome: 'success',
        details: { command: 'fix-it' }, timestamp: '2026-05-19T10:02:00Z' },
    ]);
    const r = new SkillFailureReflector(repo, noopLogger);
    const patterns = await r.detect('u');
    expect(patterns.length).toBe(1);
    expect(patterns[0].scope).toBe('cwd=/tmp/proj');
  });
});
