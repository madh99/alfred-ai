import { describe, it, expect } from 'vitest';
import { ProjectSkill } from './project.js';
import type { SkillContext } from '@alfred/types';

/**
 * v898.3 — consolidate_milestones (Milestone(s) → EIN Feature, KOMPLETT neu geplant).
 * Synchron testbar: Validierung (≥1 Milestone, Items vorhanden), Default-Namens-
 * ableitung, der Re-Tag-Fallback (with_plan=false) und der sofortige Return des
 * echten Plan-Laufs (with_plan=true → planned:true + liveTaskId, preserved/toReplace).
 * Der eigentliche Bestandsumbau läuft im Hintergrund (runCodeAgent) und wird hier
 * nur über den Sync-Return verifiziert.
 */
const UUID = '11111111-1111-1111-1111-111111111111';

interface FakeItem { id: string; title: string; roadmapMilestone?: string; roadmapOrder?: number; createdAt: string; status: string; dependsOn?: string[]; description?: string; }

function makeSkill(
  items: FakeItem[],
  retagCalls: Array<{ id: string; milestone?: string | null; order?: number | null }> = [],
  depCalls: Array<{ id: string; dependsOn?: string[] | null }> = [],
  runner?: () => Promise<{ success: boolean; output: string }>,
): ProjectSkill {
  const repo = {
    // process.cwd() existiert → existsSync-Check im canPlan-Pfad besteht
    getById: async (_u: string, id: string) => ({ id, name: 'Projekt', cwd: process.cwd() }),
    findIdByPrefixOrName: async () => null,
    listOpenItemsForProject: async () => items,
    updateOpenItemRoadmap: async (id: string, patch: { milestone?: string | null; order?: number | null }) => {
      retagCalls.push({ id, milestone: patch.milestone, order: patch.order });
      return true;
    },
    updateOpenItemStatus: async () => true,
    addOpenItem: async () => ({ id: 'new-item' }),
    updateOpenItemFields: async (id: string, patch: { dependsOn?: string[] | null }) => {
      depCalls.push({ id, dependsOn: patch.dependsOn });
      return true;
    },
  } as unknown as ConstructorParameters<typeof ProjectSkill>[0];
  const skill = new ProjectSkill(repo);
  if (runner) skill.setCodeAgentRunner(runner);
  return skill;
}

const ctx = { userId: 'u', masterUserId: 'u' } as unknown as SkillContext;

const ITEMS: FakeItem[] = [
  { id: 'a1', title: 'A1', roadmapMilestone: 'Feature: Album-Tracker', roadmapOrder: 1, createdAt: '2026-01-01', status: 'open' },
  { id: 'a2', title: 'A2', roadmapMilestone: 'Feature: Album-Tracker', roadmapOrder: 2, createdAt: '2026-01-02', status: 'done', dependsOn: ['a1'] },
  { id: 'b1', title: 'B1', roadmapMilestone: 'Feature: Tausch-Matching', roadmapOrder: 1, createdAt: '2026-01-03', status: 'open' },
  { id: 'c1', title: 'C1', roadmapMilestone: 'Andere', roadmapOrder: 1, createdAt: '2026-01-04', status: 'open' },
];

describe('v898.3 consolidate_milestones (echte Neuplanung)', () => {
  it('lehnt leere Milestone-Liste ab (mindestens 1)', async () => {
    const r = await makeSkill(ITEMS).execute(
      { action: 'consolidate_milestones', project_id: UUID, milestones: [] }, ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mindestens 1/i);
  });

  it('lehnt ab, wenn keine Items in den gewählten Milestones existieren', async () => {
    const r = await makeSkill(ITEMS).execute(
      { action: 'consolidate_milestones', project_id: UUID, milestones: ['Nicht-da-1', 'Nicht-da-2'], with_plan: false }, ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/keine roadmap-items/i);
  });

  it('Fallback (with_plan=false): hängt Items auf EINEN Milestone um, neu nummeriert', async () => {
    const retag: Array<{ id: string; milestone?: string | null; order?: number | null }> = [];
    const r = await makeSkill(ITEMS, retag).execute({
      action: 'consolidate_milestones', project_id: UUID, name: 'Sticker-Tausch',
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    const d = r.data as { milestone?: string; retagged?: number; planned?: boolean };
    expect(d.milestone).toBe('Feature: Sticker-Tausch');
    expect(d.retagged).toBe(3); // a1, a2, b1 — NICHT c1
    expect(d.planned).toBe(false);
    expect(retag.map(c => c.id)).toEqual(['a1', 'a2', 'b1']);
    expect(retag.every(c => c.milestone === 'Feature: Sticker-Tausch')).toBe(true);
    expect(retag.map(c => c.order)).toEqual([1, 2, 3]);
  });

  it('Fallback (with_plan=false): verkettet durchgehend, nicht-destruktiv', async () => {
    const deps: Array<{ id: string; dependsOn?: string[] | null }> = [];
    const r = await makeSkill(ITEMS, [], deps).execute({
      action: 'consolidate_milestones', project_id: UUID,
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    expect(deps.map(d => d.id)).toEqual(['a2', 'b1']);
    expect(deps.find(d => d.id === 'a2')?.dependsOn).toEqual(['a1']); // bestehende Dep bleibt, kein Duplikat
    expect(deps.find(d => d.id === 'b1')?.dependsOn).toEqual(['a2']);
  });

  it('ohne name → Default aus erstem Milestone (ohne "Feature:"-Präfix) + Anzahl', async () => {
    const r = await makeSkill(ITEMS).execute({
      action: 'consolidate_milestones', project_id: UUID,
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { milestone?: string }).milestone).toBe('Feature: Album-Tracker + 1 weitere');
  });

  it('akzeptiert EINEN Milestone (Neuplanung in place), Name ohne Suffix', async () => {
    const r = await makeSkill(ITEMS).execute({
      action: 'consolidate_milestones', project_id: UUID,
      milestones: ['Feature: Album-Tracker'], with_plan: false,
    }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as { milestone?: string; retagged?: number }).milestone).toBe('Feature: Album-Tracker');
  });

  it('echte Neuplanung (with_plan=true): startet Lauf, planned:true + liveTaskId, preserved/toReplace', async () => {
    const runner = async () => ({ success: true, output: '[{"title":"P1","description":"d"}]' });
    const r = await makeSkill(ITEMS, [], [], runner).execute({
      action: 'consolidate_milestones', project_id: UUID, name: 'Sticker-Tausch',
      milestones: ['Feature: Album-Tracker', 'Feature: Tausch-Matching'], // with_plan default true
    }, ctx);
    expect(r.success).toBe(true);
    const d = r.data as { planned?: boolean; liveTaskId?: string; preserved?: number; toReplace?: number; milestone?: string };
    expect(d.planned).toBe(true);
    expect(d.liveTaskId).toBeTruthy();
    expect(d.preserved).toBe(1);   // a2 (done) bleibt
    expect(d.toReplace).toBe(2);   // a1, b1 (open) werden ersetzt
  });
});
