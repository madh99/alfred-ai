import type { WatchCondition } from '@alfred/types';

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
      const triggered =
        operator === 'lt' ? num < thresh :
        operator === 'gt' ? num > thresh :
        operator === 'lte' ? num <= thresh :
        num >= thresh;
      return { triggered, displayValue };
    }

    case 'eq':
      return { triggered: String(currentValue) === String(threshold), displayValue };

    case 'neq':
      return { triggered: String(currentValue) !== String(threshold), displayValue };

    case 'contains':
      return { triggered: String(currentValue).includes(String(threshold ?? '')), displayValue };

    case 'not_contains':
      return { triggered: !String(currentValue).includes(String(threshold ?? '')), displayValue };

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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const n = parseFloat(String(value));
  return isNaN(n) ? null : n;
}

function formatValue(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
