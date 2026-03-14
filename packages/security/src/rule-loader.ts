import type { SecurityRule, RiskLevel, RuleEffect, RuleScope } from '@alfred/types';

const VALID_EFFECTS: RuleEffect[] = ['allow', 'deny'];
const VALID_SCOPES: RuleScope[] = ['global', 'user', 'conversation', 'platform'];
const VALID_RISK_LEVELS: RiskLevel[] = ['read', 'write', 'destructive', 'admin'];

export class RuleLoader {
  /**
   * Validates and returns a typed array of SecurityRule objects from a
   * pre-parsed data object. The config/bootstrap layer is responsible for
   * YAML parsing; this method only validates structure.
   */
  loadFromObject(data: { rules: unknown[] }): SecurityRule[] {
    if (!data || !Array.isArray(data.rules)) {
      throw new Error('Invalid data: expected an object with a "rules" array');
    }

    return data.rules.map((raw, index) => this.validateRule(raw, index));
  }

  private validateRule(raw: unknown, index: number): SecurityRule {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Rule at index ${index} is not an object`);
    }

    const rule = raw as Record<string, unknown>;

    // Required string fields
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new Error(`Rule at index ${index} is missing a valid "id" string`);
    }

    if (typeof rule.effect !== 'string' || !VALID_EFFECTS.includes(rule.effect as RuleEffect)) {
      throw new Error(
        `Rule "${rule.id}" has invalid "effect": expected one of ${VALID_EFFECTS.join(', ')}`,
      );
    }

    if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
      throw new Error(`Rule "${rule.id}" is missing a valid "priority" number`);
    }

    if (typeof rule.scope !== 'string' || !VALID_SCOPES.includes(rule.scope as RuleScope)) {
      throw new Error(
        `Rule "${rule.id}" has invalid "scope": expected one of ${VALID_SCOPES.join(', ')}`,
      );
    }

    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      throw new Error(`Rule "${rule.id}" is missing a valid "actions" array`);
    }
    for (const action of rule.actions) {
      if (typeof action !== 'string') {
        throw new Error(`Rule "${rule.id}" has a non-string entry in "actions"`);
      }
    }

    if (!Array.isArray(rule.riskLevels) || rule.riskLevels.length === 0) {
      throw new Error(`Rule "${rule.id}" is missing a valid "riskLevels" array`);
    }
    for (const level of rule.riskLevels) {
      if (!VALID_RISK_LEVELS.includes(level as RiskLevel)) {
        throw new Error(
          `Rule "${rule.id}" has invalid risk level "${level}": expected one of ${VALID_RISK_LEVELS.join(', ')}`,
        );
      }
    }

    // Build the validated rule
    const validated: SecurityRule = {
      id: rule.id as string,
      effect: rule.effect as RuleEffect,
      priority: rule.priority as number,
      scope: rule.scope as RuleScope,
      actions: rule.actions as string[],
      riskLevels: rule.riskLevels as RiskLevel[],
    };

    // Optional fields
    if (rule.conditions !== undefined) {
      if (typeof rule.conditions !== 'object' || rule.conditions === null) {
        throw new Error(`Rule "${rule.id}" has invalid "conditions": expected an object`);
      }
      const cond = rule.conditions as Record<string, unknown>;
      if (cond.users !== undefined && !Array.isArray(cond.users)) {
        throw new Error(`Rule "${rule.id}" has invalid "conditions.users": expected an array`);
      }
      if (cond.platforms !== undefined && !Array.isArray(cond.platforms)) {
        throw new Error(`Rule "${rule.id}" has invalid "conditions.platforms": expected an array`);
      }
      if (cond.chatType !== undefined && typeof cond.chatType !== 'string') {
        throw new Error(`Rule "${rule.id}" has invalid "conditions.chatType": expected a string`);
      }
      if (cond.timeWindow !== undefined) {
        const tw = cond.timeWindow as Record<string, unknown>;
        if (typeof tw !== 'object' || tw === null) {
          throw new Error(`Rule "${rule.id}" has invalid "conditions.timeWindow": expected an object`);
        }
        if (tw.startHour !== undefined && (typeof tw.startHour !== 'number' || tw.startHour < 0 || tw.startHour > 23)) {
          throw new Error(`Rule "${rule.id}" has invalid "conditions.timeWindow.startHour": expected 0-23`);
        }
        if (tw.endHour !== undefined && (typeof tw.endHour !== 'number' || tw.endHour < 0 || tw.endHour > 23)) {
          throw new Error(`Rule "${rule.id}" has invalid "conditions.timeWindow.endHour": expected 0-23`);
        }
        if (tw.daysOfWeek !== undefined) {
          if (!Array.isArray(tw.daysOfWeek) || !tw.daysOfWeek.every((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6)) {
            throw new Error(`Rule "${rule.id}" has invalid "conditions.timeWindow.daysOfWeek": expected array of 0-6`);
          }
        }
      }
      validated.conditions = rule.conditions as SecurityRule['conditions'];
    }

    if (rule.rateLimit !== undefined) {
      if (typeof rule.rateLimit !== 'object' || rule.rateLimit === null) {
        throw new Error(`Rule "${rule.id}" has invalid "rateLimit": expected an object`);
      }
      const rl = rule.rateLimit as Record<string, unknown>;
      if (typeof rl.maxInvocations !== 'number' || typeof rl.windowSeconds !== 'number') {
        throw new Error(
          `Rule "${rule.id}" has invalid "rateLimit": expected maxInvocations and windowSeconds numbers`,
        );
      }
      validated.rateLimit = rule.rateLimit as SecurityRule['rateLimit'];
    }

    return validated;
  }
}
