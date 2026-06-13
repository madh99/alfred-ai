import { describe, it, expect } from 'vitest';
import { resolveAgentForRun } from './resolve-agent.js';
import { AgentBusyRegistry } from './agent-busy-registry.js';

const AVAIL = ['claude-code', 'codex', 'mistral-vibe'];

describe('resolveAgentForRun', () => {
  it('expliziter Picker-Wert gewinnt immer', () => {
    expect(resolveAgentForRun({ available: AVAIL, requestedAgent: 'codex', strategy: { mode: 'auto', preferred: 'claude-code' } }).agent).toBe('codex');
  });

  it('ungültiger requestedAgent wird ignoriert → Strategie greift', () => {
    expect(resolveAgentForRun({ available: AVAIL, requestedAgent: 'gemini' }).agent).toBe('claude-code');
  });

  it('Default (keine Strategie) = erster verfügbarer', () => {
    expect(resolveAgentForRun({ available: AVAIL }).agent).toBe('claude-code');
  });

  it('auto: preferred wenn frei', () => {
    expect(resolveAgentForRun({ available: AVAIL, strategy: { mode: 'auto', preferred: 'codex' } }).agent).toBe('codex');
  });

  it('auto: weicht aus, wenn preferred busy', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'auto', preferred: 'claude-code', fallbackOrder: ['codex', 'mistral-vibe'] }, busy: new Set(['claude-code']) });
    expect(r.agent).toBe('codex');
    expect(r.note).toContain('ausgewichen');
  });

  it('auto: zweite Ausweich-Stufe, wenn preferred+erste fallback busy', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'auto', preferred: 'claude-code', fallbackOrder: ['codex', 'mistral-vibe'] }, busy: new Set(['claude-code', 'codex']) });
    expect(r.agent).toBe('mistral-vibe');
  });

  it('auto: alle busy → preferred mit Hinweis', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'auto', preferred: 'claude-code', fallbackOrder: ['codex', 'mistral-vibe'] }, busy: new Set(AVAIL) });
    expect(r.agent).toBe('claude-code');
    expect(r.note).toContain('ausgelastet');
  });

  it('resume: dieselbe CLU bevorzugt, auch wenn busy (Kontinuität)', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'auto', preferred: 'codex' }, resumeAgent: 'claude-code', busy: new Set(['claude-code']) });
    expect(r.agent).toBe('claude-code');
  });

  it('manual interaktiv: preferred als Vorauswahl + Vermerk', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'manual', preferred: 'codex' }, isAutomatic: false });
    expect(r.agent).toBe('codex');
    expect(r.note).toContain('UI-Picker');
  });

  it('manual automatisch: Fallback auf preferred MIT Vermerk (User-Wunsch)', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'manual', preferred: 'codex' }, isAutomatic: true });
    expect(r.agent).toBe('codex');
    expect(r.note).toContain('nicht möglich');
  });

  it('manual automatisch + preferred busy: weicht aus, Vermerk kombiniert', () => {
    const r = resolveAgentForRun({ available: AVAIL, strategy: { mode: 'manual', preferred: 'claude-code', fallbackOrder: ['codex'] }, isAutomatic: true, busy: new Set(['claude-code']) });
    expect(r.agent).toBe('codex');
    expect(r.note).toContain('nicht möglich');
    expect(r.note).toContain('ausgewichen');
  });

  it('keine Agents konfiguriert → leerer Agent', () => {
    expect(resolveAgentForRun({ available: [] }).agent).toBe('');
  });
});

describe('AgentBusyRegistry', () => {
  it('register/release + busyClis', () => {
    const r = new AgentBusyRegistry();
    const t1 = r.register('claude-code', 'projA', 'review', 1000);
    r.register('codex', 'projB', 'work', 1001);
    expect(r.busyClis()).toEqual(new Set(['claude-code', 'codex']));
    r.release(t1);
    expect(r.busyClis()).toEqual(new Set(['codex']));
  });

  it('isBusy mit exceptProjectId (eigenes Projekt zählt nicht als Konflikt)', () => {
    const r = new AgentBusyRegistry();
    r.register('claude-code', 'projA', 'review', 1000);
    expect(r.isBusy('claude-code')).toBe(true);
    expect(r.isBusy('claude-code', 'projA')).toBe(false); // nur in projA → kein fremder Konflikt
    expect(r.isBusy('claude-code', 'projB')).toBe(true);
  });

  it('release ist idempotent', () => {
    const r = new AgentBusyRegistry();
    const t = r.register('codex', 'p', 'k', 1);
    r.release(t); r.release(t);
    expect(r.busyClis().size).toBe(0);
  });
});
