import { describe, it, expect } from 'vitest';
import { evaluateCompositeCondition } from '../condition-evaluator.js';

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

  it('baseline (null lastValues) — returns triggered: false', () => {
    const data = { price: 10, soc: 50 };
    const composite = {
      logic: 'and' as const,
      conditions: [
        { field: 'price', operator: 'lt' as const, value: 15 },
        { field: 'soc', operator: 'lt' as const, value: 80 },
      ],
    };

    const result = evaluateCompositeCondition(data, composite, null);

    // First poll — baseline — never triggers
    expect(result.triggered).toBe(false);
    // But newLastValues should be populated
    expect(result.newLastValues.price).toBe(10);
    expect(result.newLastValues.soc).toBe(50);
  });
});
