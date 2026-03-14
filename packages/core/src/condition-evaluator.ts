import type { WatchCondition, CompositeCondition } from '@alfred/types';

/**
 * Extract a value from nested data using a dot-path.
 * Supports array indices: "items.0.name", "items.length"
 */
export function extractField(data: unknown, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (current == null) return undefined;

    if (typeof current === 'object') {
      // Handle "length" on arrays
      if (part === 'length' && Array.isArray(current)) {
        current = current.length;
        continue;
      }
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Evaluate a watch condition against current and last values.
 * Returns whether the condition triggered and a display string.
 *
 * First check (lastValue === null): stores baseline, never triggers.
 */
export function evaluateCondition(
  currentValue: unknown,
  operator: WatchCondition['operator'],
  threshold: string | number | undefined,
  lastValue: unknown,
): { triggered: boolean; displayValue: string } {
  const displayValue = formatValue(currentValue);

  // Baseline check — never trigger on first poll
  if (lastValue === null) {
    return { triggered: false, displayValue };
  }

  switch (operator) {
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const num = toNumber(currentValue);
      const thresh = toNumber(threshold);
      if (num === null || thresh === null) return { triggered: false, displayValue };
      const met =
        operator === 'lt' ? num < thresh :
        operator === 'gt' ? num > thresh :
        operator === 'lte' ? num <= thresh :
        num >= thresh;
      if (!met) return { triggered: false, displayValue };
      // Only trigger on state change: previous value must NOT have met the condition
      const prev = toNumber(lastValue);
      if (prev !== null) {
        const wasMet =
          operator === 'lt' ? prev < thresh :
          operator === 'gt' ? prev > thresh :
          operator === 'lte' ? prev <= thresh :
          prev >= thresh;
        if (wasMet) return { triggered: false, displayValue };
      }
      return { triggered: true, displayValue };
    }

    case 'eq': {
      const numC = toNumber(currentValue);
      const numT = toNumber(threshold);
      if (numC !== null && numT !== null) {
        if (numC !== numT) return { triggered: false, displayValue };
        const prevNum = toNumber(lastValue);
        if (prevNum !== null && prevNum === numT) return { triggered: false, displayValue };
        return { triggered: true, displayValue };
      }
      const currStr = String(currentValue);
      const threshStr = String(threshold);
      if (currStr !== threshStr) return { triggered: false, displayValue };
      if (String(lastValue) === threshStr) return { triggered: false, displayValue };
      return { triggered: true, displayValue };
    }

    case 'neq': {
      const numC = toNumber(currentValue);
      const numT = toNumber(threshold);
      if (numC !== null && numT !== null) {
        if (numC === numT) return { triggered: false, displayValue };
        const prevNum = toNumber(lastValue);
        if (prevNum !== null && prevNum !== numT) return { triggered: false, displayValue };
        return { triggered: true, displayValue };
      }
      const currStr = String(currentValue);
      const threshStr = String(threshold);
      if (currStr === threshStr) return { triggered: false, displayValue };
      if (String(lastValue) !== threshStr) return { triggered: false, displayValue };
      return { triggered: true, displayValue };
    }

    case 'contains': {
      const met = String(currentValue).includes(String(threshold ?? ''));
      if (!met) return { triggered: false, displayValue };
      const wasMet = String(lastValue).includes(String(threshold ?? ''));
      if (wasMet) return { triggered: false, displayValue };
      return { triggered: true, displayValue };
    }

    case 'not_contains': {
      const met = !String(currentValue).includes(String(threshold ?? ''));
      if (!met) return { triggered: false, displayValue };
      const wasMet = !String(lastValue).includes(String(threshold ?? ''));
      if (wasMet) return { triggered: false, displayValue };
      return { triggered: true, displayValue };
    }

    case 'changed':
      return {
        triggered: JSON.stringify(currentValue) !== JSON.stringify(lastValue),
        displayValue,
      };

    case 'increased': {
      const curr = toNumber(currentValue);
      const prev = toNumber(lastValue);
      if (curr === null || prev === null) return { triggered: false, displayValue };
      return { triggered: curr > prev, displayValue };
    }

    case 'decreased': {
      const curr = toNumber(currentValue);
      const prev = toNumber(lastValue);
      if (curr === null || prev === null) return { triggered: false, displayValue };
      return { triggered: curr < prev, displayValue };
    }

    default:
      return { triggered: false, displayValue };
  }
}

/**
 * Evaluate a composite condition (AND/OR logic over multiple conditions).
 * Returns whether the composite triggered, display values per field, and new last-values.
 */
export function evaluateCompositeCondition(
  data: unknown,
  composite: CompositeCondition,
  lastValues: Record<string, unknown> | null,
): {
  triggered: boolean;
  displayValues: Record<string, string>;
  newLastValues: Record<string, unknown>;
} {
  const displayValues: Record<string, string> = {};
  const newLastValues: Record<string, unknown> = {};
  const results: boolean[] = [];

  for (const cond of composite.conditions) {
    const currentValue = extractField(data, cond.field);
    const lastValue = lastValues?.[cond.field] ?? null;

    const { triggered, displayValue } = evaluateCondition(
      currentValue,
      cond.operator,
      cond.value,
      lastValue,
    );

    results.push(triggered);
    displayValues[cond.field] = displayValue;
    newLastValues[cond.field] = currentValue;
  }

  const triggered = composite.logic === 'and'
    ? results.every(Boolean)
    : results.some(Boolean);

  return { triggered, displayValues, newLastValues };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const n = parseFloat(String(value));
  return isNaN(n) || !isFinite(n) ? null : n;
}

function formatValue(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
