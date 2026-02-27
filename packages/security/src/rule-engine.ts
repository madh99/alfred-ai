import type { SecurityRule, SecurityEvaluation, RiskLevel, RuleScope } from '@alfred/types';
import { RateLimiter } from './rate-limiter.js';

export interface EvaluationContext {
  userId: string;
  action: string;
  riskLevel: RiskLevel;
  platform: string;
  chatType?: string;
  chatId?: string;
}

export class RuleEngine {
  private rules: SecurityRule[] = [];
  private rateLimiter = new RateLimiter();

  loadRules(rules: SecurityRule[]): void {
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
  }

  getRules(): ReadonlyArray<SecurityRule> {
    return this.rules;
  }

  evaluate(context: EvaluationContext): SecurityEvaluation {
    for (const rule of this.rules) {
      if (this.ruleMatches(rule, context)) {
        // If rule has a rate limit and the effect is 'allow', check the rate limit
        if (rule.rateLimit && rule.effect === 'allow') {
          const rateLimitResult = this.checkRateLimit(rule, context);
          if (!rateLimitResult) {
            return {
              allowed: false,
              matchedRule: rule,
              reason: `Rate limit exceeded for rule: ${rule.id}`,
              timestamp: new Date(),
            };
          }
        }

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

  /**
   * Checks and increments the rate limit counter for a given rule and context.
   * Returns true if the action is within the rate limit, false if exceeded.
   */
  checkRateLimit(rule: SecurityRule, context: EvaluationContext): boolean {
    if (!rule.rateLimit) {
      return true;
    }

    const scopeKey = this.getScopeKey(rule.scope, context);
    const key = `${rule.id}:${scopeKey}`;

    const result = this.rateLimiter.check(key, rule.rateLimit);
    if (!result.allowed) {
      return false;
    }

    this.rateLimiter.increment(key, rule.rateLimit);
    return true;
  }

  /**
   * Resets all rate limit counters. Useful for testing.
   */
  resetRateLimits(): void {
    this.rateLimiter.reset();
  }

  private getScopeKey(scope: RuleScope, context: EvaluationContext): string {
    switch (scope) {
      case 'global':
        return 'global';
      case 'user':
        return context.userId;
      case 'conversation':
        return context.chatId ?? 'unknown';
      case 'platform':
        return context.platform;
    }
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

      // Time window evaluation
      if (rule.conditions.timeWindow) {
        if (!this.matchesTimeWindow(rule.conditions.timeWindow)) {
          return false;
        }
      }
    }

    return true;
  }

  private matchesTimeWindow(timeWindow: NonNullable<SecurityRule['conditions']>['timeWindow']): boolean {
    if (!timeWindow) {
      return true;
    }

    const now = new Date();

    // Check day of week (0 = Sunday, 6 = Saturday)
    if (timeWindow.daysOfWeek && timeWindow.daysOfWeek.length > 0) {
      if (!timeWindow.daysOfWeek.includes(now.getDay())) {
        return false;
      }
    }

    // Check hour range
    const currentHour = now.getHours();

    if (timeWindow.startHour !== undefined && timeWindow.endHour !== undefined) {
      if (timeWindow.startHour <= timeWindow.endHour) {
        // Normal range, e.g., 9-17
        if (currentHour < timeWindow.startHour || currentHour >= timeWindow.endHour) {
          return false;
        }
      } else {
        // Overnight range, e.g., 22-6 (wraps around midnight)
        // Allow: hour >= start OR hour < end. Deny: hour >= end AND hour < start
        if (currentHour >= timeWindow.endHour && currentHour < timeWindow.startHour) {
          return false;
        }
      }
    } else if (timeWindow.startHour !== undefined) {
      if (currentHour < timeWindow.startHour) {
        return false;
      }
    } else if (timeWindow.endHour !== undefined) {
      if (currentHour >= timeWindow.endHour) {
        return false;
      }
    }

    return true;
  }
}
