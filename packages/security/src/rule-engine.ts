import type { SecurityRule, SecurityEvaluation, RiskLevel } from '@alfred/types';

export interface EvaluationContext {
  userId: string;
  action: string;
  riskLevel: RiskLevel;
  platform: string;
  chatType?: string;
}

export class RuleEngine {
  private rules: SecurityRule[] = [];

  loadRules(rules: SecurityRule[]): void {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
  }

  getRules(): ReadonlyArray<SecurityRule> {
    return this.rules;
  }

  evaluate(context: EvaluationContext): SecurityEvaluation {
    // Phase 1: Simple allow-all evaluator
    // TODO Phase 2: Full rule evaluation with conditions, rate limiting, etc.

    for (const rule of this.rules) {
      if (this.ruleMatches(rule, context)) {
        return {
          allowed: rule.effect === 'allow',
          matchedRule: rule,
          reason: `Matched rule: ${rule.id}`,
          timestamp: new Date(),
        };
      }
    }

    // Default deny if no rules match
    return {
      allowed: false,
      matchedRule: undefined,
      reason: 'No matching rule found — default deny',
      timestamp: new Date(),
    };
  }

  private ruleMatches(rule: SecurityRule, context: EvaluationContext): boolean {
    // Check action match
    if (!rule.actions.includes('*') && !rule.actions.includes(context.action)) {
      return false;
    }

    // Check risk level match
    if (!rule.riskLevels.includes(context.riskLevel)) {
      return false;
    }

    // Check conditions
    if (rule.conditions) {
      if (rule.conditions.users && rule.conditions.users.length > 0) {
        if (!rule.conditions.users.includes(context.userId)) {
          return false;
        }
      }

      if (rule.conditions.platforms && rule.conditions.platforms.length > 0) {
        if (!rule.conditions.platforms.includes(context.platform)) {
          return false;
        }
      }

      if (rule.conditions.chatType && context.chatType) {
        if (rule.conditions.chatType !== context.chatType) {
          return false;
        }
      }

      // TODO Phase 2: Time window evaluation
      // TODO Phase 2: Rate limit evaluation
    }

    return true;
  }
}
