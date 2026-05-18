import { describe, it, expect } from 'vitest';
import { validateSkillAction } from '../validate-skill-action.js';
import type { SkillRegistry } from '../skill-registry.js';

// Minimal mock SkillRegistry: only `get` is called by the validator.
function mkRegistry(skills: Record<string, { actionEnum?: string[]; required?: string[] }>): SkillRegistry {
  return {
    get: (name: string) => {
      const s = skills[name];
      if (!s) return undefined;
      return {
        metadata: {
          name,
          inputSchema: {
            properties: s.actionEnum ? { action: { enum: s.actionEnum } } : {},
            required: s.required ?? [],
          },
        },
      } as any;
    },
  } as unknown as SkillRegistry;
}

describe('validateSkillAction', () => {
  it('allows valid action from enum', () => {
    const reg = mkRegistry({ homeassistant: { actionEnum: ['states', 'state', 'turn_on'] } });
    const result = validateSkillAction(reg, 'homeassistant', { action: 'states' });
    expect(result.ok).toBe(true);
  });

  it('rejects hallucinated action (regression: ceb5f96c watch with list_entities)', () => {
    const reg = mkRegistry({ homeassistant: { actionEnum: ['states', 'state', 'turn_on'] } });
    const result = validateSkillAction(reg, 'homeassistant', { action: 'list_entities' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('list_entities');
      expect(result.error).toContain('states');
    }
  });

  it('rejects hallucinated action (regression: get_state vs state)', () => {
    const reg = mkRegistry({ homeassistant: { actionEnum: ['states', 'state'] } });
    const result = validateSkillAction(reg, 'homeassistant', { action: 'get_state' });
    expect(result.ok).toBe(false);
  });

  it('rejects hallucinated action (regression: check_job_runtime for commvault)', () => {
    const reg = mkRegistry({ commvault: { actionEnum: ['status', 'jobs', 'storage'] } });
    const result = validateSkillAction(reg, 'commvault', { action: 'check_job_runtime' });
    expect(result.ok).toBe(false);
  });

  it('returns ok when target skill has no action-enum (free-form skills)', () => {
    const reg = mkRegistry({ web_search: {} });
    const result = validateSkillAction(reg, 'web_search', { query: 'foo' });
    expect(result.ok).toBe(true);
  });

  it('returns ok when params lack action key (caller checks required separately)', () => {
    const reg = mkRegistry({ homeassistant: { actionEnum: ['states'] } });
    const result = validateSkillAction(reg, 'homeassistant', {});
    expect(result.ok).toBe(true);
  });

  it('rejects unknown skill', () => {
    const reg = mkRegistry({});
    const result = validateSkillAction(reg, 'nonexistent', { action: 'foo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('nonexistent');
    }
  });

  it('passes through if registry undefined (validator is opt-in)', () => {
    const result = validateSkillAction(undefined, 'homeassistant', { action: 'list_entities' });
    expect(result.ok).toBe(true);
  });
});
