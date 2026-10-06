import { describe, it, expect } from 'vitest';
import { PromptBuilder, alterText, MEMORY_ZUSTANDS_REGEL } from './prompt-builder.js';

// v1216 — Erinnerungen tragen ihr Alter; Zustandsaussagen kommen aus dem Weltmodell.
describe('alterText', () => {
  const now = new Date('2026-10-06T12:00:00Z').getTime();
  it('heute, gestern, Tage, Monate, Jahre', () => {
    expect(alterText('2026-10-06T08:00:00Z', now)).toBe('heute');
    expect(alterText('2026-10-05T08:00:00Z', now)).toBe('gestern');
    expect(alterText('2026-09-26T08:00:00Z', now)).toBe('vor 10 Tagen');
    expect(alterText('2026-05-13T01:32:00Z', now)).toBe('vor 4 Monaten');
    expect(alterText('2024-10-01T00:00:00Z', now)).toBe('vor 2 Jahren');
    expect(alterText(undefined, now)).toBeUndefined();
  });
});

describe('Memories im Prompt (v1216)', () => {
  it('zeigt das Alter je Erinnerung und die Weltmodell-Regel', () => {
    const p = new PromptBuilder().buildSystemPrompt({
      memories: [
        { key: 'homeassistant_skill_critical_outage', value: 'HomeAssistant Skill deaktiviert seit 07:31', category: 'infra', type: 'general', updatedAt: new Date(Date.now() - 140 * 86_400_000).toISOString() },
        { key: 'name', value: 'Markus', category: 'personal', type: 'fact' },
      ],
    });
    expect(p).toContain(MEMORY_ZUSTANDS_REGEL);
    expect(p).toMatch(/HomeAssistant Skill deaktiviert seit 07:31 \(vor 4 Monaten\)/);
    expect(p).toMatch(/- name: Markus\n/);
  });
});
