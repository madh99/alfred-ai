import { describe, it, expect } from 'vitest';
import { wouldCreateDependencyCycle, isItemBlocked, blockingItemIds } from './item-deps.js';

const items = [
  { id: 'a', status: 'open', dependsOn: ['b'] },
  { id: 'b', status: 'open', dependsOn: ['c'] },
  { id: 'c', status: 'open' },
  { id: 'd', status: 'done' },
  { id: 'e', status: 'cancelled' },
];

describe('wouldCreateDependencyCycle', () => {
  it('rejects self-reference', () => {
    expect(wouldCreateDependencyCycle(items, 'a', ['a'])).toBe(true);
  });

  it('rejects direct cycle (c→a while a→b→c)', () => {
    expect(wouldCreateDependencyCycle(items, 'c', ['a'])).toBe(true);
  });

  it('rejects transitive cycle (c→b while b→c)', () => {
    expect(wouldCreateDependencyCycle(items, 'c', ['b'])).toBe(true);
  });

  it('allows acyclic dependency', () => {
    expect(wouldCreateDependencyCycle(items, 'a', ['c'])).toBe(false);
    expect(wouldCreateDependencyCycle(items, 'a', ['d', 'e'])).toBe(false);
  });

  it('tolerates unknown ids (no crash, no false cycle)', () => {
    expect(wouldCreateDependencyCycle(items, 'a', ['nope'])).toBe(false);
  });

  it('handles diamond shapes without infinite loop', () => {
    const diamond = [
      { id: 'x', dependsOn: ['y', 'z'] },
      { id: 'y', dependsOn: ['w'] },
      { id: 'z', dependsOn: ['w'] },
      { id: 'w' },
    ];
    expect(wouldCreateDependencyCycle(diamond, 'q', ['x'])).toBe(false);
    expect(wouldCreateDependencyCycle(diamond, 'w', ['x'])).toBe(true);
  });
});

describe('isItemBlocked / blockingItemIds', () => {
  it('blocked while dependency is open', () => {
    expect(isItemBlocked(items[0], items)).toBe(true); // a hängt an b (open)
    expect(blockingItemIds(items[0], items)).toEqual(['b']);
  });

  it('not blocked when dependencies are done/cancelled', () => {
    const it1 = { id: 'f', status: 'open', dependsOn: ['d', 'e'] };
    expect(isItemBlocked(it1, items)).toBe(false);
    expect(blockingItemIds(it1, items)).toEqual([]);
  });

  it('not blocked without dependencies', () => {
    expect(isItemBlocked(items[2], items)).toBe(false);
  });

  it('deleted/unknown dependency does not block forever', () => {
    const it1 = { id: 'g', status: 'open', dependsOn: ['vanished'] };
    expect(isItemBlocked(it1, items)).toBe(false);
  });
});
