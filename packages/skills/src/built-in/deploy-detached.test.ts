import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeploySkill, buildDetachedLaunch } from './deploy.js';

describe('buildDetachedLaunch (v931.1)', () => {
  it('backgroundet NUR das nohup in einer Subshell-Klammer — nie die ganze &&-Kette', () => {
    const cmd = buildDetachedLaunch('/home/u/app', 'docker compose up -d --build', '/tmp/x.log');
    // Regression .96 02.07.: ohne Klammer hielt die backgroundete Kette die
    // SSH-Session offen bis der Build fertig war → Skill-Timeout.
    expect(cmd).toContain('&& (nohup sh -c');
    expect(cmd).toMatch(/<\/dev\/null &\) && echo started$/);
    expect(cmd).toContain('>/tmp/x.log 2>&1');
    expect(cmd).toContain('docker compose up -d --build && echo ALFRED_DEPLOY_OK || echo ALFRED_DEPLOY_FAIL');
  });
});

/**
 * v931 — Detached Compose-Start: der Skill-/SSH-Timeout darf einen laufenden
 * Build nie wieder killen. pollDeployLog pollt das Remote-Log bis OK/FAIL.
 */
describe('DeploySkill.pollDeployLog (v931)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeSkill(sshResponses: string[]) {
    const skill = new DeploySkill({});
    const ssh = vi.fn();
    for (const r of sshResponses) ssh.mockResolvedValueOnce(r);
    ssh.mockResolvedValue(sshResponses[sshResponses.length - 1] ?? '');
    (skill as any).ssh = ssh;
    return { skill, ssh };
  }

  async function poll(skill: DeploySkill, maxWaitMs: number, onProgress?: (e: number) => void) {
    const p = (skill as any).pollDeployLog('h', 'u', '/tmp/x.log', maxWaitMs, onProgress) as Promise<{ ok: boolean; tail: string; elapsedMs: number }>;
    // Fake-Timer vorspulen bis das Promise auflöst
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      const settled = await Promise.race([p.then(() => true), Promise.resolve(false)]);
      if (settled) break;
    }
    return p;
  }

  it('OK-Marker im Log → ok:true', async () => {
    const { skill } = makeSkill(['Building 12.3s', 'Container app Started\nALFRED_DEPLOY_OK']);
    const r = await poll(skill, 15 * 60_000);
    expect(r.ok).toBe(true);
  });

  it('FAIL-Marker → ok:false mit Log-Auszug', async () => {
    const { skill } = makeSkill(['ERROR: failed to solve: no space left on device\nALFRED_DEPLOY_FAIL']);
    const r = await poll(skill, 15 * 60_000);
    expect(r.ok).toBe(false);
    expect(r.tail).toContain('no space left');
    expect(r.tail).not.toContain('ALFRED_DEPLOY_FAIL');
  });

  it('maxWait erreicht → ok:false mit Timeout-Hinweis', async () => {
    const { skill } = makeSkill(['Building …']);
    const r = await poll(skill, 30_000);
    expect(r.ok).toBe(false);
    expect(r.tail).toContain('Timeout');
    expect(r.tail).toContain('/tmp/x.log');
  });

  it('transiente SSH-Fehler brechen das Polling nicht ab', async () => {
    const skill = new DeploySkill({});
    const ssh = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue('ALFRED_DEPLOY_OK');
    (skill as any).ssh = ssh;
    const r = await poll(skill, 15 * 60_000);
    expect(r.ok).toBe(true);
    expect(ssh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('Progress-Callback feuert höchstens 1×/Minute', async () => {
    const { skill } = makeSkill(['Building …']);
    const onProgress = vi.fn();
    await poll(skill, 3 * 60_000, onProgress);
    // 3 Minuten Timeout → maximal ~3 Progress-Meldungen (nicht 18 bei 10s-Takt)
    expect(onProgress.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('DeploySkill Metadaten (v931)', () => {
  it('Skill-Timeout deckt lange Docker-Builds ab (≥15 min)', () => {
    const skill = new DeploySkill({});
    expect(skill.metadata.timeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
