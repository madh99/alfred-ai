import type { WorkflowGuard } from '@alfred/types';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const SKILL_TIMEOUT_MS = 10_000;

export class GuardEvaluator {
  private readonly skillRegistry: SkillRegistry;
  private readonly skillSandbox: SkillSandbox;

  constructor(skillRegistry: SkillRegistry, skillSandbox: SkillSandbox) {
    this.skillRegistry = skillRegistry;
    this.skillSandbox = skillSandbox;
  }

  async evaluateAll(guards: WorkflowGuard[]): Promise<boolean> {
    for (const guard of guards) {
      let result: boolean;
      switch (guard.type) {
        case 'time_window':
          result = this.evaluateTimeWindow(guard.value ?? '');
          break;
        case 'weekday':
          result = this.evaluateWeekday(guard.value ?? '');
          break;
        case 'skill_condition':
          result = await this.evaluateSkillCondition(guard);
          break;
        default:
          result = true;
      }
      if (!result) return false;
    }
    return true;
  }

  evaluateTimeWindow(window: string): boolean {
    const parts = window.split('-');
    if (parts.length !== 2) return true;

    const [startStr, endStr] = parts;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const toMinutes = (s: string): number => {
      const [h, m] = s.trim().split(':').map(Number);
      return h * 60 + m;
    };

    const start = toMinutes(startStr);
    const end = toMinutes(endStr);

    if (start <= end) {
      // Same-day window: 09:00-17:00
      return currentMinutes >= start && currentMinutes < end;
    }
    // Overnight window: 22:00-06:00
    return currentMinutes >= start || currentMinutes < end;
  }

  evaluateWeekday(days: string): boolean {
    const now = new Date();
    const currentDay = now.getDay();
    const allowedDays = days.split(',').map((d) => DAY_MAP[d.trim().toLowerCase()]);
    return allowedDays.includes(currentDay);
  }

  async evaluateSkillCondition(guard: WorkflowGuard): Promise<boolean> {
    const { skillName, skillParams, field, operator, compareValue } = guard;
    if (!skillName) return true;

    const skill = this.skillRegistry.get(skillName);
    if (!skill) return true;

    try {
      const result = await this.skillSandbox.execute(
        skill,
        skillParams ?? {},
        {} as never,
        SKILL_TIMEOUT_MS,
      );
      if (!result.success || result.data == null) return true;

      const actual = field ? (result.data as Record<string, unknown>)[field] : result.data;
      return this.compare(actual, operator, compareValue);
    } catch {
      return true;
    }
  }

  private compare(actual: unknown, operator: string | undefined, expected: unknown): boolean {
    switch (operator) {
      case 'lt':       return Number(actual) < Number(expected);
      case 'gt':       return Number(actual) > Number(expected);
      case 'lte':      return Number(actual) <= Number(expected);
      case 'gte':      return Number(actual) >= Number(expected);
      case 'eq':       return actual === expected;
      case 'neq':      return actual !== expected;
      case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
      default:         return true;
    }
  }
}
