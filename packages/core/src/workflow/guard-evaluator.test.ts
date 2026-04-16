import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuardEvaluator } from './guard-evaluator.js';
import type { WorkflowGuard } from '@alfred/types';

function createMocks() {
  const skillRegistry = {
    get: vi.fn(),
    has: vi.fn(),
  } as any;

  const skillSandbox = {
    execute: vi.fn(),
  } as any;

  return { skillRegistry, skillSandbox };
}

describe('GuardEvaluator', () => {
  let evaluator: GuardEvaluator;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    evaluator = new GuardEvaluator(mocks.skillRegistry, mocks.skillSandbox);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes time_window inside overnight window (23:00 in 22:00-06:00)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T23:00:00'));
    expect(evaluator.evaluateTimeWindow('22:00-06:00')).toBe(true);
  });

  it('fails time_window outside overnight window (12:00 in 22:00-06:00)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00'));
    expect(evaluator.evaluateTimeWindow('22:00-06:00')).toBe(false);
  });

  it('passes same-day window (10:00 in 09:00-17:00)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T10:00:00'));
    expect(evaluator.evaluateTimeWindow('09:00-17:00')).toBe(true);
  });

  it('passes weekday on matching day (Thursday in mon-fri)', () => {
    vi.useFakeTimers();
    // 2026-04-16 is a Thursday
    vi.setSystemTime(new Date('2026-04-16T12:00:00'));
    expect(evaluator.evaluateWeekday('mon,tue,wed,thu,fri')).toBe(true);
  });

  it('fails weekday on non-matching day (Saturday in mon-fri)', () => {
    vi.useFakeTimers();
    // 2026-04-18 is a Saturday
    vi.setSystemTime(new Date('2026-04-18T12:00:00'));
    expect(evaluator.evaluateWeekday('mon,tue,wed,thu,fri')).toBe(false);
  });

  it('evaluates skill_condition (soc=45, operator lt, value 60 → true)', async () => {
    const fakeSkill = { metadata: { name: 'battery' } };
    mocks.skillRegistry.get.mockReturnValue(fakeSkill);
    mocks.skillSandbox.execute.mockResolvedValue({
      success: true,
      data: { soc: 45 },
    });

    const guard: WorkflowGuard = {
      type: 'skill_condition',
      skillName: 'battery',
      skillParams: {},
      field: 'soc',
      operator: 'lt',
      compareValue: 60,
    };

    expect(await evaluator.evaluateSkillCondition(guard)).toBe(true);
  });

  it('returns true when skill not found (guard skipped)', async () => {
    mocks.skillRegistry.get.mockReturnValue(undefined);

    const guard: WorkflowGuard = {
      type: 'skill_condition',
      skillName: 'nonexistent',
      field: 'value',
      operator: 'gt',
      compareValue: 0,
    };

    expect(await evaluator.evaluateSkillCondition(guard)).toBe(true);
  });

  it('evaluateAll returns false when one guard fails', async () => {
    vi.useFakeTimers();
    // 12:00 on a Tuesday — weekday passes but time window fails
    vi.setSystemTime(new Date('2026-04-14T12:00:00')); // Tuesday

    const guards: WorkflowGuard[] = [
      { type: 'weekday', value: 'mon,tue,wed,thu,fri' },
      { type: 'time_window', value: '22:00-06:00' },
    ];

    expect(await evaluator.evaluateAll(guards)).toBe(false);
  });
});
