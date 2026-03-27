import { describe, it, expect } from 'vitest';
import {
  extractField,
  evaluateCondition,
  evaluateCompositeCondition,
} from '../condition-evaluator.js';

// ── extractField ──────────────────────────────────────────────────────

describe('extractField', () => {
  it('extracts a top-level field', () => {
    expect(extractField({ price: 42 }, 'price')).toBe(42);
  });

  it('extracts a nested field via dot-path', () => {
    expect(extractField({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('extracts array element by index', () => {
    expect(extractField({ items: ['a', 'b', 'c'] }, 'items.1')).toBe('b');
  });

  it('extracts nested value inside array element', () => {
    const data = { items: [{ name: 'first' }, { name: 'second' }] };
    expect(extractField(data, 'items.1.name')).toBe('second');
  });

  it('extracts array length', () => {
    expect(extractField({ items: [1, 2, 3] }, 'items.length')).toBe(3);
  });

  it('returns undefined for missing path', () => {
    expect(extractField({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined for path through null', () => {
    expect(extractField({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined for path through primitive', () => {
    expect(extractField({ a: 42 }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when data is null', () => {
    expect(extractField(null, 'a')).toBeUndefined();
  });
});

// ── evaluateCondition ─────────────────────────────────────────────────

describe('evaluateCondition', () => {
  // ── Threshold operators (gt, lt, gte, lte) ──

  describe('gt', () => {
    it('triggers when current > threshold and last did not meet', () => {
      const r = evaluateCondition(15, 'gt', 10, 5);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when condition was already met (state-change)', () => {
      const r = evaluateCondition(15, 'gt', 10, 12);
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when condition is not met', () => {
      const r = evaluateCondition(5, 'gt', 10, 3);
      expect(r.triggered).toBe(false);
    });

    it('triggers on first poll (lastValue=null) when condition is met', () => {
      const r = evaluateCondition(15, 'gt', 10, null);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger on first poll when condition is not met', () => {
      const r = evaluateCondition(5, 'gt', 10, null);
      expect(r.triggered).toBe(false);
    });
  });

  describe('lt', () => {
    it('triggers when current < threshold and last did not meet', () => {
      const r = evaluateCondition(5, 'lt', 10, 15);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already met', () => {
      const r = evaluateCondition(5, 'lt', 10, 8);
      expect(r.triggered).toBe(false);
    });
  });

  describe('gte', () => {
    it('triggers on boundary (equal)', () => {
      const r = evaluateCondition(10, 'gte', 10, 5);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already met', () => {
      const r = evaluateCondition(12, 'gte', 10, 11);
      expect(r.triggered).toBe(false);
    });
  });

  describe('lte', () => {
    it('triggers on boundary (equal)', () => {
      const r = evaluateCondition(10, 'lte', 10, 15);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when not met', () => {
      const r = evaluateCondition(15, 'lte', 10, 20);
      expect(r.triggered).toBe(false);
    });
  });

  // ── eq / neq ──

  describe('eq', () => {
    it('triggers on numeric equality with state change', () => {
      const r = evaluateCondition(42, 'eq', 42, 41);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already equal', () => {
      const r = evaluateCondition(42, 'eq', 42, 42);
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when not equal', () => {
      const r = evaluateCondition(43, 'eq', 42, 41);
      expect(r.triggered).toBe(false);
    });

    it('works with string comparison', () => {
      const r = evaluateCondition('active', 'eq', 'active', 'inactive');
      expect(r.triggered).toBe(true);
    });

    it('string: no trigger when already equal', () => {
      const r = evaluateCondition('active', 'eq', 'active', 'active');
      expect(r.triggered).toBe(false);
    });
  });

  describe('neq', () => {
    it('triggers when value differs from threshold with state change', () => {
      const r = evaluateCondition(43, 'neq', 42, 42);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already not equal', () => {
      const r = evaluateCondition(43, 'neq', 42, 41);
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when equal to threshold', () => {
      const r = evaluateCondition(42, 'neq', 42, 41);
      expect(r.triggered).toBe(false);
    });

    it('works with string comparison', () => {
      const r = evaluateCondition('error', 'neq', 'ok', 'ok');
      expect(r.triggered).toBe(true);
    });
  });

  // ── contains / not_contains ──

  describe('contains', () => {
    it('triggers when string contains threshold and previously did not', () => {
      const r = evaluateCondition('error: timeout', 'contains', 'error', 'all ok');
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already contained', () => {
      const r = evaluateCondition('error: timeout', 'contains', 'error', 'error: disk');
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when not contained', () => {
      const r = evaluateCondition('all ok', 'contains', 'error', 'all ok');
      expect(r.triggered).toBe(false);
    });
  });

  describe('not_contains', () => {
    it('triggers when string no longer contains threshold', () => {
      const r = evaluateCondition('all ok', 'not_contains', 'error', 'error: disk');
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when already not contained', () => {
      const r = evaluateCondition('all ok', 'not_contains', 'error', 'all fine');
      expect(r.triggered).toBe(false);
    });
  });

  // ── Change-detection operators ──

  describe('changed', () => {
    it('triggers when value changed', () => {
      const r = evaluateCondition('new', 'changed', undefined, 'old');
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when same', () => {
      const r = evaluateCondition('same', 'changed', undefined, 'same');
      expect(r.triggered).toBe(false);
    });

    it('does NOT trigger on baseline (lastValue=null)', () => {
      const r = evaluateCondition('any', 'changed', undefined, null);
      expect(r.triggered).toBe(false);
    });

    it('detects object changes via JSON comparison', () => {
      const r = evaluateCondition({ a: 1 }, 'changed', undefined, { a: 2 });
      expect(r.triggered).toBe(true);
    });
  });

  describe('increased', () => {
    it('triggers when current > previous', () => {
      const r = evaluateCondition(15, 'increased', undefined, 10);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when equal', () => {
      const r = evaluateCondition(10, 'increased', undefined, 10);
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when decreased', () => {
      const r = evaluateCondition(5, 'increased', undefined, 10);
      expect(r.triggered).toBe(false);
    });

    it('does NOT trigger on baseline (lastValue=null)', () => {
      const r = evaluateCondition(15, 'increased', undefined, null);
      expect(r.triggered).toBe(false);
    });

    it('does not trigger when values are non-numeric', () => {
      const r = evaluateCondition('abc', 'increased', undefined, 'def');
      expect(r.triggered).toBe(false);
    });
  });

  describe('decreased', () => {
    it('triggers when current < previous', () => {
      const r = evaluateCondition(5, 'decreased', undefined, 10);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when increased', () => {
      const r = evaluateCondition(15, 'decreased', undefined, 10);
      expect(r.triggered).toBe(false);
    });

    it('does NOT trigger on baseline (lastValue=null)', () => {
      const r = evaluateCondition(5, 'decreased', undefined, null);
      expect(r.triggered).toBe(false);
    });
  });

  // ── always_* operators ──

  describe('always_gt', () => {
    it('triggers every time condition is met (no state-change check)', () => {
      const r = evaluateCondition(15, 'always_gt', 10, 12);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when not met', () => {
      const r = evaluateCondition(5, 'always_gt', 10, 3);
      expect(r.triggered).toBe(false);
    });

    it('handles non-numeric values gracefully', () => {
      const r = evaluateCondition('abc', 'always_gt', 10, null);
      expect(r.triggered).toBe(false);
    });
  });

  describe('always_lt', () => {
    it('triggers every time condition is met', () => {
      const r = evaluateCondition(5, 'always_lt', 10, 8);
      expect(r.triggered).toBe(true);
    });

    it('does not trigger when not met', () => {
      const r = evaluateCondition(15, 'always_lt', 10, 8);
      expect(r.triggered).toBe(false);
    });
  });

  describe('always_gte', () => {
    it('triggers on exact boundary', () => {
      const r = evaluateCondition(10, 'always_gte', 10, 10);
      expect(r.triggered).toBe(true);
    });
  });

  describe('always_lte', () => {
    it('triggers on exact boundary', () => {
      const r = evaluateCondition(10, 'always_lte', 10, 10);
      expect(r.triggered).toBe(true);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('returns displayValue as formatted string', () => {
      const r = evaluateCondition(42, 'gt', 10, 5);
      expect(r.displayValue).toBe('42');
    });

    it('formats null as "null"', () => {
      const r = evaluateCondition(null, 'changed', undefined, 'old');
      expect(r.displayValue).toBe('null');
    });

    it('formats object as JSON', () => {
      const r = evaluateCondition({ a: 1 }, 'changed', undefined, { b: 2 });
      expect(r.displayValue).toBe('{"a":1}');
    });

    it('unknown operator returns triggered: false', () => {
      const r = evaluateCondition(1, 'nonexistent' as any, 2, 0);
      expect(r.triggered).toBe(false);
    });

    it('non-numeric threshold returns triggered: false for numeric operators', () => {
      const r = evaluateCondition(10, 'gt', 'abc' as any, 5);
      expect(r.triggered).toBe(false);
    });
  });
});

// ── evaluateCompositeCondition ────────────────────────────────────────

describe('evaluateCompositeCondition', () => {
  it('AND logic — all conditions must match', () => {
    const data = { price: 10, soc: 50 };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };
    const lastValues = { price: 20, soc: 90 };

    const result = evaluateCompositeCondition(data, composite, lastValues);

    expect(result.triggered).toBe(true);
    expect(result.displayValues.price).toBe('10');
    expect(result.displayValues.soc).toBe('50');
    expect(result.newLastValues.price).toBe(10);
    expect(result.newLastValues.soc).toBe(50);
  });

  it('AND logic — partial match does not trigger', () => {
    const data = { price: 10, soc: 90 };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };
    const lastValues = { price: 20, soc: 70 };

    const result = evaluateCompositeCondition(data, composite, lastValues);

    expect(result.triggered).toBe(false);
  });

  it('OR logic — triggers when any condition matches', () => {
    const data = { price: 10, soc: 90 };
    const composite = {
      logic: 'or' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };
    const lastValues = { price: 20, soc: 70 };

    const result = evaluateCompositeCondition(data, composite, lastValues);

    // price=10 < 15 matches, so OR triggers even though soc=90 >= 80
    expect(result.triggered).toBe(true);
  });

  it('OR logic — no conditions match does not trigger', () => {
    const data = { price: 20, soc: 90 };
    const composite = {
      logic: 'or' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };
    const lastValues = { price: 25, soc: 95 };

    const result = evaluateCompositeCondition(data, composite, lastValues);

    expect(result.triggered).toBe(false);
  });

  it('baseline (null lastValues) — threshold operators trigger on first poll', () => {
    const data = { price: 10, soc: 50 };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };

    const result = evaluateCompositeCondition(data, composite, null);

    // Threshold operators (lt) trigger on first poll when condition is met
    expect(result.triggered).toBe(true);
    expect(result.newLastValues.price).toBe(10);
    expect(result.newLastValues.soc).toBe(50);
  });

  it('baseline (null lastValues) — change-detection operators do NOT trigger', () => {
    const data = { status: 'active' };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'status', operator: 'changed' as const },
      ],
    };

    const result = evaluateCompositeCondition(data, composite, null);

    expect(result.triggered).toBe(false);
    expect(result.newLastValues.status).toBe('active');
  });

  it('uses extractField to read nested data', () => {
    const data = { sensor: { temp: 35 } };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'sensor.temp', operator: 'gt' as const, value: 30 },
      ],
    };
    const lastValues = { 'sensor.temp': 25 };

    const result = evaluateCompositeCondition(data, composite, lastValues);

    expect(result.triggered).toBe(true);
  });
});
