import { describe, it, expect, vi } from 'vitest';
import { CmdbSkill } from './cmdb.js';
import type { CmdbRepository } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

/**
 * v857 Fix A+C+D — CMDB discover() Verhalten:
 *  - Fix A (mikrotik-spezifisch, in alfred.ts) — getestet indirekt via Fix C
 *  - Fix C — malformed relations werden geskippt + gezählt + im Result-Text sichtbar
 *  - Fix D — Source mit failedCalls > 0 + assets.length === 0 → Result-Text zeigt
 *    "X Skill-Calls fehlgeschlagen" statt nur "0 Assets"
 */

function makeRepo(): CmdbRepository {
  return {
    upsertAsset: vi.fn(async (_uid: string, a: any) => ({ id: `asset-${a.sourceId}`, ...a })),
    getAssetBySource: vi.fn(async (_uid: string, _src: string, _sid: string) => ({ id: 'asset-found', name: 'x' })),
    upsertRelation: vi.fn(async () => true),
    markStaleAssets: vi.fn(async () => 0),
    listAssets: vi.fn(async () => []),
    updateAsset: vi.fn(),
  } as unknown as CmdbRepository;
}

function makeSkill(repo: CmdbRepository): CmdbSkill {
  return new CmdbSkill(repo, 7);
}

const ctx: SkillContext = {
  userId: 'u1', chatId: 'c1', platform: 'api', conversationId: 'conv1', masterUserId: 'u1',
} as SkillContext;

describe('CmdbSkill v857 discover() Fix C+D', () => {
  it('skips malformed relations and reports count in result-line (Fix C)', async () => {
    const repo = makeRepo();
    const skill = makeSkill(repo);
    skill.registerDiscoverySource('badsrc', async () => ({
      assets: [{ name: 'a1', assetType: 'service', sourceSkill: 'badsrc', sourceId: 'a1', attributes: {} }],
      relations: [
        // Eine korrekte Relation
        { sourceKey: 'badsrc:a1', targetKey: 'badsrc:a1', relationType: 'depends_on' as const },
        // Drei kaputte (so wie mikrotik vor Fix A)
        { sourceEntityName: 'foo', targetEntityName: 'bar', relationType: 'part_of' },
        { sourceKey: 'badsrc:a1' },
        { targetKey: 'badsrc:a1', sourceKey: '', relationType: 'foo' },
      ] as any[],
    }));
    const r = await skill.execute({ action: 'discover' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('badsrc: 1 Assets');
    expect(r.display).toContain('3 Relations skipped: malformed');
  });

  it('does NOT crash entire source when ALL relations are malformed', async () => {
    const repo = makeRepo();
    const skill = makeSkill(repo);
    skill.registerDiscoverySource('mikrotik', async () => ({
      assets: [
        { name: 'router1', assetType: 'network_device', sourceSkill: 'mikrotik', sourceId: 'router:r1', attributes: {} },
        { name: 'iface1', assetType: 'network', sourceSkill: 'mikrotik', sourceId: 'if:r1:eth0', attributes: {} },
      ],
      relations: [
        // Schema-Drift wie pre-v857 mikrotik
        { sourceEntityName: 'iface1', targetEntityName: 'router1', relationType: 'part_of' },
      ] as any[],
    }));
    const r = await skill.execute({ action: 'discover' }, ctx);
    expect(r.success).toBe(true);
    // Vor v857: "mikrotik: Fehler — Cannot read properties of undefined (reading 'split')"
    expect(r.display).not.toContain('Fehler — Cannot read properties');
    // Nach v857: assets-count erscheint + skipped-Hinweis
    expect(r.display).toContain('mikrotik: 2 Assets');
    expect(r.display).toContain('1 Relations skipped: malformed');
  });

  it('reports failedCalls in result-line when source had 0 assets + reported skill-call failures (Fix D)', async () => {
    const repo = makeRepo();
    const skill = makeSkill(repo);
    skill.registerDiscoverySource('nginx_proxy_manager', async () => ({
      assets: [],
      relations: [],
      failedCalls: 2,
      failedReason: 'fetch failed',
    } as any));
    const r = await skill.execute({ action: 'discover' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('nginx_proxy_manager: 0 Assets');
    expect(r.display).toMatch(/2 Skill-Calls fehlgeschlagen: fetch failed/);
  });

  it('does NOT show failedCalls suffix when source returned non-zero assets (Fix D)', async () => {
    const repo = makeRepo();
    const skill = makeSkill(repo);
    skill.registerDiscoverySource('partial', async () => ({
      assets: [{ name: 'a1', assetType: 'service', sourceSkill: 'partial', sourceId: 'a1', attributes: {} }],
      relations: [],
      failedCalls: 1,
      failedReason: 'one endpoint down',
    } as any));
    const r = await skill.execute({ action: 'discover' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('partial: 1 Assets');
    expect(r.display).not.toContain('fehlgeschlagen');
  });

  it('legacy source without failedCalls field still works (backwards-compat)', async () => {
    const repo = makeRepo();
    const skill = makeSkill(repo);
    skill.registerDiscoverySource('legacy', async () => ({
      assets: [{ name: 'a1', assetType: 'service', sourceSkill: 'legacy', sourceId: 'a1', attributes: {} }],
      relations: [],
    }));
    const r = await skill.execute({ action: 'discover' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('legacy: 1 Assets');
  });
});
