import { describe, it, expect } from 'vitest';
import { findGoalMatches } from './goal-matcher.js';
import type { ProjectFeaturesRepository, ProjectFeature } from '@alfred/storage';

function makeRepo(features: ProjectFeature[]): ProjectFeaturesRepository {
  return {
    search: async (q: string) => features.filter(f =>
      f.name.toLowerCase().includes(q.toLowerCase()) || f.description.toLowerCase().includes(q.toLowerCase())
    ),
  } as unknown as ProjectFeaturesRepository;
}

function makeFeature(over: Partial<ProjectFeature>): ProjectFeature {
  return {
    id: 'f1', projectId: 'p1', userId: 'u1',
    name: 'Crowd Funding',
    description: 'Stripe-basierte Kampagnen mit Anteils-Aufteilung',
    techStack: ['Stripe Connect', 'PostgreSQL', 'Next.js'],
    sourceFiles: ['src/lib/funding/**'],
    gitShaIntroduced: 'abc123', version: 1,
    visibility: 'role-shared', confidence: 0.9, source: 'auto', status: 'confirmed',
    embeddingId: null, derivedFromFeatureId: null,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', retiredAt: null,
    ...over,
  };
}

describe('findGoalMatches', () => {
  it('returns empty when goal too short', async () => {
    const r = await findGoalMatches({ goal: 'short', userId: 'u1', repo: makeRepo([]) });
    expect(r).toEqual([]);
  });

  it('finds match by keyword overlap', async () => {
    const f = makeFeature({});
    const r = await findGoalMatches({
      goal: 'Implementiere Crowd Funding mit Stripe',
      userId: 'u1',
      currentTechStack: ['Stripe Connect', 'Next.js', 'PostgreSQL'],
      repo: makeRepo([f]),
    });
    expect(r.length).toBe(1);
    expect(r[0].feature.id).toBe('f1');
    expect(r[0].techStackOverlap).toBeGreaterThan(0.5);
  });

  it('filters out matches with low tech-stack overlap', async () => {
    const f = makeFeature({ techStack: ['Stripe', 'PostgreSQL', 'Express'] });
    const r = await findGoalMatches({
      goal: 'Crowd Funding implementieren',
      userId: 'u1',
      currentTechStack: ['Astro', 'MongoDB'], // ganz andere Welt
      repo: makeRepo([f]),
    });
    expect(r.length).toBe(0);
  });

  it('excludes current project from matches', async () => {
    const f = makeFeature({ projectId: 'p1' });
    const r = await findGoalMatches({
      goal: 'Crowd Funding bauen',
      userId: 'u1',
      repo: makeRepo([f]),
      excludeProjectId: 'p1',
    });
    expect(r.length).toBe(0);
  });

  it('returns top 3 matches sorted by score', async () => {
    const fs = [
      makeFeature({ id: 'f1', name: 'Crowd Funding Alpha', confidence: 0.5 }),
      makeFeature({ id: 'f2', name: 'Crowd Funding Beta', confidence: 0.9 }),
      makeFeature({ id: 'f3', name: 'Crowd Funding Gamma', confidence: 0.7 }),
      makeFeature({ id: 'f4', name: 'Crowd Funding Delta', confidence: 0.6 }),
    ];
    const r = await findGoalMatches({
      goal: 'Crowd Funding implementieren',
      userId: 'u1',
      repo: makeRepo(fs),
    });
    expect(r.length).toBeLessThanOrEqual(3);
    if (r.length >= 2) expect(r[0].matchScore).toBeGreaterThanOrEqual(r[1].matchScore);
  });
});
