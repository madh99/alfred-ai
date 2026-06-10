import { describe, it, expect } from 'vitest';
import { validateSkillAction, healActionSynonym } from './validate-skill-action.js';
import type { SkillRegistry } from './skill-registry.js';

/**
 * v861 — Heal-Integration in validateSkillAction.
 * Referenz-Fall: aWATTar-Workflow 10.06. scheiterte an 'file.save' —
 * semantisch ambiguous (write vs write_binary) → bleibt korrekt ein Fehler.
 * Eindeutige Fälle (todo.create→add) werden ab jetzt geheilt.
 */

const FILE_ACTIONS = ['read', 'write', 'write_binary', 'append', 'list', 'info', 'exists', 'move', 'copy', 'delete', 'send', 'read_store', 'write_store', 'list_store', 'delete_store'];
const TODO_ACTIONS = ['add', 'list', 'complete', 'uncomplete', 'delete', 'lists', 'clear'];

function makeRegistry(skillName: string, actions: string[]): SkillRegistry {
  return {
    get: (name: string) => name === skillName
      ? { metadata: { name: skillName, inputSchema: { properties: { action: { enum: actions } } } } }
      : undefined,
  } as unknown as SkillRegistry;
}

describe('v861 validateSkillAction mit heal', () => {
  it('heilt todo.create → add in-place', () => {
    const params: Record<string, unknown> = { action: 'create', text: 'Milch kaufen' };
    const r = validateSkillAction(makeRegistry('todo', TODO_ACTIONS), 'todo', params, { heal: true });
    expect(r.ok).toBe(true);
    expect(params.action).toBe('add');
    expect((r as { healed?: { from: string; to: string } }).healed).toEqual({ from: 'create', to: 'add' });
  });

  it('file.save bleibt Fehler — ambiguous write vs write_binary (PDF-Korruptions-Schutz)', () => {
    const params: Record<string, unknown> = { action: 'save', path: '/tmp/rechnung.pdf' };
    const r = validateSkillAction(makeRegistry('file', FILE_ACTIONS), 'file', params, { heal: true });
    expect(r.ok).toBe(false);
    expect(params.action).toBe('save'); // NICHT mutiert
    expect((r as { error: string }).error).toMatch(/no action "save"/);
  });

  it('save heilt zu write wenn write_binary NICHT im Enum (eindeutig)', () => {
    expect(healActionSynonym('save', ['read', 'write', 'list'])).toBe('write');
  });

  it('ohne heal-Option: bisheriges Verhalten (reject)', () => {
    const params: Record<string, unknown> = { action: 'create' };
    const r = validateSkillAction(makeRegistry('todo', TODO_ACTIONS), 'todo', params, undefined);
    expect(r.ok).toBe(false);
    expect(params.action).toBe('create');
  });

  it('valide Action: unverändert ok, kein healed-Feld', () => {
    const params: Record<string, unknown> = { action: 'add' };
    const r = validateSkillAction(makeRegistry('todo', TODO_ACTIONS), 'todo', params, { heal: true });
    expect(r.ok).toBe(true);
    expect((r as { healed?: unknown }).healed).toBeUndefined();
  });

  it('unbekannter Skill bleibt Fehler (heal ändert nichts daran)', () => {
    const r = validateSkillAction(makeRegistry('todo', TODO_ACTIONS), 'ghost', { action: 'create' }, { heal: true });
    expect(r.ok).toBe(false);
  });
});
