import { describe, it, expect, vi } from 'vitest';
import { isDegradation, HealthMonitor, type ClusterClaim } from './health-monitor.js';
import type { ProjectRepository } from '@alfred/storage';
import type { Logger } from 'pino';

const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => noopLogger } as unknown as Logger;

describe('isDegradation', () => {
  it('detects ok → warning as degradation', () => {
    expect(isDegradation('ok', 'warning')).toBe(true);
  });
  it('detects ok → error as degradation', () => {
    expect(isDegradation('ok', 'error')).toBe(true);
  });
  it('detects warning → error as degradation', () => {
    expect(isDegradation('warning', 'error')).toBe(true);
  });
  it('does NOT consider warning → ok a degradation', () => {
    expect(isDegradation('warning', 'ok')).toBe(false);
  });
  it('does NOT consider error → warning a degradation (improvement)', () => {
    expect(isDegradation('error', 'warning')).toBe(false);
  });
  it('does NOT consider same status a degradation', () => {
    expect(isDegradation('error', 'error')).toBe(false);
    expect(isDegradation('ok', 'ok')).toBe(false);
  });
  it('unknown → error counts as degradation (new failure)', () => {
    expect(isDegradation('unknown', 'error')).toBe(true);
    expect(isDegradation('unknown', 'warning')).toBe(true);
  });
  it('unknown → ok is not degradation', () => {
    expect(isDegradation('unknown', 'ok')).toBe(false);
  });
  it('treats skipped same as ok (no noise)', () => {
    expect(isDegradation('skipped', 'ok')).toBe(false);
    expect(isDegradation('ok', 'skipped')).toBe(false);
  });
});

describe('HealthMonitor cluster-claim gate', () => {
  function mkRepo(): ProjectRepository {
    return {
      list: vi.fn().mockResolvedValue([]),
      getLatestHealth: vi.fn(),
      recordHealth: vi.fn(),
    } as unknown as ProjectRepository;
  }

  it('runs the cycle when no cluster claim is configured (single-node)', async () => {
    const repo = mkRepo();
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger);
    await monitor.runCycle();
    expect(repo.list).toHaveBeenCalled();
  });

  it('runs the cycle when the cluster claim is acquired', async () => {
    const repo = mkRepo();
    const claim: ClusterClaim = { tryClaim: vi.fn().mockResolvedValue(true) };
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger, {}, () => claim);
    await monitor.runCycle();
    expect(claim.tryClaim).toHaveBeenCalledWith('project-health-monitor');
    expect(repo.list).toHaveBeenCalled();
  });

  it('skips the cycle when claim is held by another node', async () => {
    const repo = mkRepo();
    const claim: ClusterClaim = { tryClaim: vi.fn().mockResolvedValue(false) };
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger, {}, () => claim);
    await monitor.runCycle();
    expect(claim.tryClaim).toHaveBeenCalled();
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('skips the cycle when claim check throws', async () => {
    const repo = mkRepo();
    const claim: ClusterClaim = { tryClaim: vi.fn().mockRejectedValue(new Error('db gone')) };
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger, {}, () => claim);
    await monitor.runCycle();
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('falls back to single-node behavior when resolver returns undefined (late-init)', async () => {
    const repo = mkRepo();
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger, {}, () => undefined);
    await monitor.runCycle();
    expect(repo.list).toHaveBeenCalled();
  });

  it('skips when previous cycle still running (idempotent overlap guard)', async () => {
    const repo = mkRepo();
    (repo.list as any) = vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return [];
    });
    const monitor = new HealthMonitor(repo, () => 'user-1', noopLogger);
    const c1 = monitor.runCycle();
    const c2 = monitor.runCycle(); // should immediately skip
    await Promise.all([c1, c2]);
    expect((repo.list as any).mock.calls.length).toBe(2); // both active + maintenance lists in single run
  });
});
