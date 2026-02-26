import { describe, it, expect, beforeEach } from 'vitest';
import type { SecurityRule } from '@alfred/types';
import { RuleEngine } from './rule-engine.js';
import type { EvaluationContext } from './rule-engine.js';

function makeRule(overrides: Partial<SecurityRule> & { id: string }): SecurityRule {
  return {
    effect: 'allow',
    priority: 50,
    scope: 'global',
    actions: ['*'],
    riskLevels: ['read', 'write', 'destructive', 'admin'],
    ...overrides,
  };
}

function makeContext(overrides?: Partial<EvaluationContext>): EvaluationContext {
  return {
    userId: 'user1',
    action: 'calculator',
    riskLevel: 'read',
    platform: 'telegram',
    ...overrides,
  };
}

describe('RuleEngine', () => {
  let engine: RuleEngine;

  beforeEach(() => {
    engine = new RuleEngine();
    engine.resetRateLimits();
  });

  it('should default deny when no rules loaded', () => {
    const result = engine.evaluate(makeContext());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No matching rule found');
  });

  it('should allow when matching allow rule', () => {
    engine.loadRules([
      makeRule({ id: 'allow-read', effect: 'allow', actions: ['calculator'], riskLevels: ['read'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'calculator', riskLevel: 'read' }));
    expect(result.allowed).toBe(true);
    expect(result.matchedRule?.id).toBe('allow-read');
  });

  it('should deny when matching deny rule', () => {
    engine.loadRules([
      makeRule({ id: 'deny-write', effect: 'deny', actions: ['write-action'], riskLevels: ['write'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'write-action', riskLevel: 'write' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule?.id).toBe('deny-write');
  });

  it('should match rules by priority order (lower number = higher priority)', () => {
    engine.loadRules([
      makeRule({ id: 'allow-high', effect: 'allow', priority: 100, actions: ['test'], riskLevels: ['read'] }),
      makeRule({ id: 'deny-low', effect: 'deny', priority: 10, actions: ['test'], riskLevels: ['read'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'test', riskLevel: 'read' }));
    // Priority 10 is evaluated first (lower number = higher priority)
    expect(result.allowed).toBe(false);
    expect(result.matchedRule?.id).toBe('deny-low');
  });

  it('should filter by action', () => {
    engine.loadRules([
      makeRule({ id: 'calc-only', effect: 'allow', actions: ['calculator'], riskLevels: ['read'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'weather', riskLevel: 'read' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should match wildcard actions', () => {
    engine.loadRules([
      makeRule({ id: 'allow-all', effect: 'allow', actions: ['*'], riskLevels: ['read'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'anything', riskLevel: 'read' }));
    expect(result.allowed).toBe(true);
    expect(result.matchedRule?.id).toBe('allow-all');
  });

  it('should filter by risk level', () => {
    engine.loadRules([
      makeRule({ id: 'read-only', effect: 'allow', actions: ['*'], riskLevels: ['read'] }),
    ]);

    const result = engine.evaluate(makeContext({ action: 'calculator', riskLevel: 'write' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should filter by platform condition', () => {
    engine.loadRules([
      makeRule({
        id: 'telegram-only',
        effect: 'allow',
        actions: ['*'],
        riskLevels: ['read'],
        conditions: { platforms: ['telegram'] },
      }),
    ]);

    const result = engine.evaluate(makeContext({ platform: 'discord', riskLevel: 'read' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should filter by user condition', () => {
    engine.loadRules([
      makeRule({
        id: 'user1-only',
        effect: 'allow',
        actions: ['*'],
        riskLevels: ['read'],
        conditions: { users: ['user1'] },
      }),
    ]);

    const result = engine.evaluate(makeContext({ userId: 'user2', riskLevel: 'read' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should filter by chatType condition', () => {
    engine.loadRules([
      makeRule({
        id: 'dm-only',
        effect: 'allow',
        actions: ['*'],
        riskLevels: ['read'],
        conditions: { chatType: 'dm' },
      }),
    ]);

    const result = engine.evaluate(makeContext({ chatType: 'group', riskLevel: 'read' }));
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should enforce rate limits', () => {
    engine.loadRules([
      makeRule({
        id: 'rate-limited',
        effect: 'allow',
        actions: ['*'],
        riskLevels: ['read'],
        rateLimit: { maxInvocations: 2, windowSeconds: 3600 },
      }),
    ]);

    const ctx = makeContext({ riskLevel: 'read' });

    const first = engine.evaluate(ctx);
    expect(first.allowed).toBe(true);

    const second = engine.evaluate(ctx);
    expect(second.allowed).toBe(true);

    const third = engine.evaluate(ctx);
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain('Rate limit exceeded');
  });

  it('should sort rules by priority on load', () => {
    engine.loadRules([
      makeRule({ id: 'mid', priority: 50 }),
      makeRule({ id: 'high', priority: 10 }),
      makeRule({ id: 'low', priority: 100 }),
    ]);

    const rules = engine.getRules();
    expect(rules[0].id).toBe('high');
    expect(rules[1].id).toBe('mid');
    expect(rules[2].id).toBe('low');
  });
});
