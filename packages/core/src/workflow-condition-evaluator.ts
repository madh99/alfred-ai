import type { WorkflowConditionExpr } from '@alfred/types';
import { extractField } from './condition-evaluator.js';

/**
 * Stateless condition evaluation for workflow branching.
 * Unlike the watch condition evaluator, this has no lastValue/state-change semantics.
 */
export function evaluateWorkflowCondition(
  expr: WorkflowConditionExpr,
  context: Record<string, unknown>,
): boolean {
  const raw = extractField(context, expr.field);
  if (raw === undefined || raw === null) return false;

  const value = expr.value;

  switch (expr.operator) {
    case 'eq':
      return String(raw) === String(value);
    case 'neq':
      return String(raw) !== String(value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const numRaw = toNumber(raw);
      const numVal = toNumber(value);
      if (numRaw === null || numVal === null) return false;
      if (expr.operator === 'gt') return numRaw > numVal;
      if (expr.operator === 'gte') return numRaw >= numVal;
      if (expr.operator === 'lt') return numRaw < numVal;
      return numRaw <= numVal; // lte
    }
    case 'contains':
      return String(raw).toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains':
      return !String(raw).toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'changed':
      // Stateless: field exists → treat as "changed from nothing"
      return true;
    case 'increased':
    case 'decreased':
      // Not applicable without history — return false
      return false;
    default:
      return false;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const n = parseFloat(String(value));
  return isNaN(n) || !isFinite(n) ? null : n;
}
