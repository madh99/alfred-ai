import { describe, it, expect } from 'vitest';
import { ProjectSkill } from './project.js';
import type { SkillContext } from '@alfred/types';

/**
 * v898 — consolidate_milestones (bestehende Milestones → EIN Feature, Re-Tag B-a).
 * Getestet wird der synchrone Teil: Validierung (≥2 Milestones, Items vorhanden),
 * deterministisches Re-Tag (Items werden auf den neuen Milestone umgehängt + neu
 * nummeriert) und die Default-Namensableitung. Der optionale Plan-Lauf (runCodeAgent)
 * wird durch with_plan=false umgangen.
 */
const UUID = '11111111-1111-1111-1111-111111111111';

interface FakeItem { id: string; title: string; roadmapMilestone?: string; roadmapOrder?: number; createdAt: string; status: string; dependsOn?: string[]; }

function makeSkill(
  items: FakeItem[],
  retagCalls: Array<{ id: string; milestone?: string | null; order?: number | null }>,
  depCalls: Array<{ id: string; dependsOn?: string[] | null }> = [],
): ProjectSkill {
  const repo = {
    getById: async (_u: string, id: string) => ({ id, name: 'Projekt', cwd: '/tmp/proj' }),
    findIdByPrefixOrName: async () => null,
    listOpenItemsForProject: async () => items,
    updateOpenItemRoadmap: async (id: string, patch: { milestone?: string | null; order?: number | null }) => {
      retagCalls.push({ id, milestone: patch.milestone, order: patch.order });
      return true;
    },
    addOpenItem: async () => ({ id: 'new-item' }),
    updateOpenItemFields: async (id: string, patch: { dependsOn?: string[] | null }) => {
      depCalls.push({ id, dependsOn: patch.dependsOn });
      return true;
    },
  } as unknown as ConstructorParameters<typeof ProjectSkill>[0];
  return new ProjectSkill(repo);
}

const ctx = { userId: 'u', masterUserId: 'u' } as unknown as SkillContext;

const ITEMS: FakeItem[] = [
  { id: 'a1', title: 'A1', roadmapMilestone: 'Feature: Album-Tracker', roadmapOrder: 1, createdAt: '2026-01-01', status: 'open' },
  { id: 'a2', title: 'A2', roadmapMilestone: 'Feature: Album-Tracker', roadmapOrder: 2, createdAt: '2026-01-02', status: 'done', dependsOn: ['a1'] },
  { id: 'b1', title: 'B1', roadmapMilestone: 'Feature: Tausch-Matching', roadmapOrder: 1, createdAt: '2026-01-03', status: 'open' },
  { id: 'c1', title: 'C1', roadmapMilestone: 'Andere', roadmapOrder: 1, createdAt: '2026-01-04', status: 'open' },
];

describe('v898 consolidate_milestones (Re-Tag B-a)', () => {
  it('lehnt < 2 Milestones ab', async () => {
    const r = await makeSkill(ITEMS, []).execute(
      { action: 'consolidate_milestones', project_id: UUID, milestones: ['Feature: Album-Tracker'] }, ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mindestens 2/i);
  });

  it('lehnt ab, wenn keine Items in den gewählten Milestones existieren', async () => {
    const r = await makeSkill(ITEMS, []).execute(
      { action: 'consolidate_milestones', project_id: UUID, milestones: ['Nicht-da-1', 'Nicht-da-2'], with_plan: false }, ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/keine roadmap-items/i);
  });

  it('hängt alle Items der gewählten Milestones auf EINEN neuen Milestone um (neu nummeriert)', async () => {
    const retag: Array<{ id: string; milestone?: string | null; order?: number | null }> = [];
    const r = await makeSkill(ITEMS, retag).execute({
      action: 'consolidate_milestones', project_id: UUID, name: 'Sticker-Tausch',
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    const d = r.data as { milestone?: string; retagged?: number; planned?: boolean };
    expect(d.milestone).toBe('Feature: Sticker-Tausch');
    expect(d.retagged).toBe(3); // a1, a2, b1 — NICHT c1 (anderer Milestone)
    expect(d.planned).toBe(false);
    // alle Re-Tags auf den neuen Milestone, fortlaufende Reihenfolge 1..3
    expect(retag.map(c => c.id)).toEqual(['a1', 'a2', 'b1']);
    expect(retag.every(c => c.milestone === 'Feature: Sticker-Tausch')).toBe(true);
    expect(retag.map(c => c.order)).toEqual([1, 2, 3]);
  });

  it('verkettet die Items durchgehend über die Milestones (nicht-destruktiv)', async () => {
    const retag: Array<{ id: string; milestone?: string | null; order?: number | null }> = [];
    const deps: Array<{ id: string; dependsOn?: string[] | null }> = [];
    const r = await makeSkill(ITEMS, retag, deps).execute({
      action: 'consolidate_milestones', project_id: UUID,
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    // erstes Item (a1) bekommt keinen Kettenlink; a2 hängt an a1 (bestehende Dep bleibt, kein Duplikat); b1 hängt an a2
    expect(deps.map(d => d.id)).toEqual(['a2', 'b1']);
    expect(deps.find(d => d.id === 'a2')?.dependsOn).toEqual(['a1']);
    expect(deps.find(d => d.id === 'b1')?.dependsOn).toEqual(['a2']);
  });

  it('ohne name → Default aus erstem Milestone (ohne "Feature:"-Präfix) + Anzahl', async () => {
    const r = await makeSkill(ITEMS, []).execute({
      action: 'consolidate_milestones', project_id: UUID,
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { milestone?: string }).milestone).toBe('Feature: Album-Tracker + 1 weitere');
  });
});
