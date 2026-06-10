import { describe, it, expect } from 'vitest';
import { ReasoningEngine } from './reasoning-engine.js';

/**
 * v859 — Synonym-Selfheal für LLM-halluzinierte Action-Namen.
 * Log-Befund 08.-10.06.: 6x todo.create, 4x memory.create, 2x todo.update,
 * je 1x memory.get / todo.mark_done — alle rejected obwohl Intention klar.
 */

// Reale Enums der betroffenen Skills (aus den inputSchemas):
const TODO_ACTIONS = ['add', 'list', 'complete', 'uncomplete', 'delete', 'lists', 'clear'];
const MEMORY_ACTIONS = ['save', 'recall', 'search', 'list', 'delete', 'semantic_search', 'kg_analyze', 'learn_recipe'];
const REMINDER_ACTIONS = ['set', 'list', 'cancel'];

describe('ReasoningEngine.healActionSynonym (v859)', () => {
  it('heilt todo.create → add (häufigster Fall, 6x in Logs)', () => {
    expect(ReasoningEngine.healActionSynonym('create', TODO_ACTIONS)).toBe('add');
  });

  it('heilt memory.create → save (4x in Logs)', () => {
    expect(ReasoningEngine.healActionSynonym('create', MEMORY_ACTIONS)).toBe('save');
  });

  it('heilt reminder.create → set', () => {
    expect(ReasoningEngine.healActionSynonym('create', REMINDER_ACTIONS)).toBe('set');
  });

  it('heilt todo.mark_done → complete', () => {
    expect(ReasoningEngine.healActionSynonym('mark_done', TODO_ACTIONS)).toBe('complete');
  });

  it('heilt todo.done → complete', () => {
    expect(ReasoningEngine.healActionSynonym('done', TODO_ACTIONS)).toBe('complete');
  });

  it('rejected memory.get — ambiguous (recall UND list beide im Enum)', () => {
    expect(ReasoningEngine.healActionSynonym('get', MEMORY_ACTIONS)).toBeNull();
  });

  it('rejected todo.update — kein Kandidat im Enum (edit/set fehlen)', () => {
    expect(ReasoningEngine.healActionSynonym('update', TODO_ACTIONS)).toBeNull();
  });

  it('rejected unbekannte Halluzinationen ohne Mapping', () => {
    expect(ReasoningEngine.healActionSynonym('prioritize_project_items', TODO_ACTIONS)).toBeNull();
    expect(ReasoningEngine.healActionSynonym('flag', ['inbox', 'read', 'send'])).toBeNull();
  });

  it('ist case-insensitive auf der halluzinierten Action', () => {
    expect(ReasoningEngine.healActionSynonym('CREATE', TODO_ACTIONS)).toBe('add');
  });

  it('heilt remove → delete wenn cancel nicht im Enum', () => {
    expect(ReasoningEngine.healActionSynonym('remove', TODO_ACTIONS)).toBe('delete');
  });

  it('rejected remove bei reminder — delete fehlt, nur cancel → eindeutig → heilt zu cancel', () => {
    expect(ReasoningEngine.healActionSynonym('remove', REMINDER_ACTIONS)).toBe('cancel');
  });
});
