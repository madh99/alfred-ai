import { describe, it, expect, vi } from 'vitest';
import { checkResourcesForCompose, getHostFreeMb } from './resource-guard.js';

describe('checkResourcesForCompose', () => {
  it('returns ok when host has enough free RAM', async () => {
    // mock by stubbing the internal getHostFreeMb (not possible without spy on module re-import,
    // so we test via real os.freemem which on dev-machine should pass for 1 service × 384 MB)
    const r = await checkResourcesForCompose({ serviceCount: 1, perServiceMb: 64 });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.estimatedNeedMb).toBe(64);
  });

  it('blocks when need + headroom exceeds free', async () => {
    // exaggerated need: 200 services × 1 GB = 200 GB
    const r = await checkResourcesForCompose({ serviceCount: 200, perServiceMb: 1024 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Compose-Stack benötigt geschätzt');
    expect(r.reason).toContain('200 Services');
  });

  it('logger.warn called when blocked', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    await checkResourcesForCompose({ serviceCount: 500, perServiceMb: 1024, logger });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logger.info called when ok', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    await checkResourcesForCompose({ serviceCount: 1, perServiceMb: 32, logger });
    expect(logger.info).toHaveBeenCalled();
  });

  it('getHostFreeMb returns sensible values', async () => {
    const { free, total } = await getHostFreeMb();
    expect(total).toBeGreaterThan(0);
    expect(free).toBeGreaterThanOrEqual(0);
    expect(free).toBeLessThanOrEqual(total);
  });
});
