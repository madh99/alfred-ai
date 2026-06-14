import { describe, it, expect } from 'vitest';
import { ProjectSkill } from './project.js';
import type { SkillContext } from '@alfred/types';

/**
 * v897 — plan_features (konsolidierter Plan für mehrere zusammengehörige Facetten).
 * Getestet wird der synchrone Teil: Validierung (≥2 Facetten) + sofortiger Return
 * (liveTaskId + EIN Milestone "Feature: <name>"). Der Hintergrund-Lauf (runCodeAgent)
 * ist gestubbt; die Item-/Phasen-Mechanik teilt sich planFeature (separat getestet via
 * parseFeaturePlanPhases).
 */
const UUID1 = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';
const UUID3 = '33333333-3333-3333-3333-333333333333';

function makeSkill(): ProjectSkill {
  const repo = {
    getById: async (_u: string, id: string) => ({ id, name: 'Projekt', cwd: '/tmp/proj' }),
    findIdByPrefixOrName: async () => null,
    addOpenItem: async () => ({ id: 'item-1' }),
    updateOpenItemRoadmap: async () => {},
    updateOpenItemFields: async () => {},
  } as unknown as ConstructorParameters<typeof ProjectSkill>[0];
  const skill = new ProjectSkill(repo);
  // Hintergrund-Lauf neutralisieren (sync-Return wird VOR dem await geliefert)
  skill.setCodeAgentRunner(async () => ({ success: false, output: '' }));
  return skill;
}

const ctx = { userId: 'u', masterUserId: 'u' } as unknown as SkillContext;

describe('v897 plan_features (konsolidiert)', () => {
  it('lehnt < 2 Facetten ab (dafür gibt es plan_feature)', async () => {
    const r = await makeSkill().execute(
      { action: 'plan_features', project_id: UUID1, features: [{ title: 'Nur eine' }] }, ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mindestens 2/i);
  });

  it('lehnt leere features ab', async () => {
    const r = await makeSkill().execute({ action: 'plan_features', project_id: UUID2, features: [] }, ctx);
    expect(r.success).toBe(false);
  });

  it('≥2 Facetten → ein Lauf, ein Milestone "Feature: <name>", liveTaskId', async () => {
    const r = await makeSkill().execute({
      action: 'plan_features', project_id: UUID3, name: 'Tauschbörse',
      features: [{ title: 'Album-Tracker', description: 'Sticker erfassen' }, { title: 'Tausch-Matching' }],
    }, ctx);
    expect(r.success).toBe(true);
    const d = r.data as { liveTaskId?: string; milestone?: string };
    expect(d.liveTaskId).toBeTruthy();
    expect(d.milestone).toBe('Feature: Tauschbörse');
  });

  it('ohne name → Default-Milestone aus erster Facette + Anzahl', async () => {
    const r = await makeSkill().execute({
      action: 'plan_features', project_id: '44444444-4444-4444-4444-444444444444',
      features: [{ title: 'Erste' }, { title: 'Zweite' }, { title: 'Dritte' }],
    }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { milestone?: string }).milestone).toBe('Feature: Erste + 2 weitere');
  });
});
