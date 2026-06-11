import { describe, it, expect } from 'vitest';
import { applyMutation, assessPlanProgress, type AssessInput } from './plan-assessor.js';
import type { PlanMutation } from './project-planner.js';
import type { LLMProvider } from '@alfred/llm';

function mockLLM(response: string): LLMProvider {
  return {
    async complete() { return { content: response, model: 'test', costUsd: 0, inputTokens: 0, outputTokens: 0 }; },
    async chat() { throw new Error('not implemented'); },
    async embed() { throw new Error('not implemented'); },
  } as unknown as LLMProvider;
}

describe('applyMutation', () => {
  const remaining = ['Phase A', 'Phase B', 'Phase C', 'Phase D'];

  it('done → empty remaining', () => {
    const r = applyMutation(remaining, 0, { kind: 'done', reasoning: 'goal met' });
    expect(r.newRemaining).toEqual([]);
  });

  it('proceed → unchanged', () => {
    const r = applyMutation(remaining, 0, { kind: 'proceed' });
    expect(r.newRemaining).toEqual(remaining);
  });

  it('skip [1, 2] → removes Phase B and C', () => {
    const r = applyMutation(remaining, 0, { kind: 'skip', phaseIndices: [1, 2], reasoning: 'already done' });
    expect(r.newRemaining).toEqual(['Phase A', 'Phase D']);
  });

  it('merge [0, 1] → combines into new phase at position 0', () => {
    const r = applyMutation(remaining, 0, {
      kind: 'merge', phaseIndices: [0, 1], newPhase: 'Phase A+B combined', reasoning: 'overlap',
    });
    expect(r.newRemaining).toEqual(['Phase A+B combined', 'Phase C', 'Phase D']);
  });

  it('extend → adds new phase at start of remaining', () => {
    const r = applyMutation(remaining, 0, {
      kind: 'extend', afterIndex: 0, newPhase: 'Phase A.5 inserted', reasoning: 'more work needed',
    });
    expect(r.newRemaining).toEqual(['Phase A.5 inserted', ...remaining]);
  });

  it('replace [1, 2] with two new phases', () => {
    const r = applyMutation(remaining, 0, {
      kind: 'replace', phaseIndices: [1, 2], newPhases: ['Phase X', 'Phase Y'], reasoning: 'better approach',
    });
    expect(r.newRemaining).toEqual(['Phase A', 'Phase X', 'Phase Y', 'Phase D']);
  });
});

describe('assessPlanProgress', () => {
  const baseInput: AssessInput = {
    goal: 'Fix the chat bug',
    completedPhases: [{ index: 0, description: 'Analyze code', modifiedFiles: ['a.ts'] }],
    remainingPhases: ['Apply fix', 'Add test'],
    buildPassed: true,
  };

  it('parses "done" decision', async () => {
    const llm = mockLLM('{"kind":"done","reasoning":"Bug fixed in phase 1"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('done');
    if (m.kind === 'done') expect(m.reasoning).toContain('Bug fixed');
  });

  it('parses "proceed" decision', async () => {
    const llm = mockLLM('{"kind":"proceed","reasoning":"still need to apply"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('parses "skip" with phaseIndices', async () => {
    const llm = mockLLM('{"kind":"skip","phaseIndices":[0],"reasoning":"already applied in phase 1"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('skip');
    if (m.kind === 'skip') expect(m.phaseIndices).toEqual([0]);
  });

  it('parses "merge" with newPhase', async () => {
    const llm = mockLLM('{"kind":"merge","phaseIndices":[0,1],"newPhase":"Apply fix + add test","reasoning":"combine"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('merge');
    if (m.kind === 'merge') {
      expect(m.phaseIndices).toEqual([0, 1]);
      expect(m.newPhase).toBe('Apply fix + add test');
    }
  });

  it('parses "extend"', async () => {
    const llm = mockLLM('{"kind":"extend","newPhase":"Migration cleanup","reasoning":"complex DB change"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('extend');
    if (m.kind === 'extend') expect(m.newPhase).toBe('Migration cleanup');
  });

  it('parses "replace"', async () => {
    const llm = mockLLM('{"kind":"replace","phaseIndices":[0],"newPhases":["A","B"],"reasoning":"split it"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('replace');
    if (m.kind === 'replace') expect(m.newPhases).toEqual(['A', 'B']);
  });

  // v864 — resultSummary (Agent-Abschluss-Text) muss im Assessor-Prompt landen.
  // Vorher sah der Assessor nur Beschreibung + Dateinamen — das Audit-Fazit
  // "alles bereits fertig" erreichte ihn nie (Vorfall b67ed039: 2 redundante Phasen).
  it('v864: resultSummary der completed Phase landet im Prompt', async () => {
    let captured = '';
    const llm: LLMProvider = {
      async complete(req: { messages: Array<{ content: string }> }) {
        captured = req.messages[0].content;
        return { content: '{"kind":"proceed"}', model: 'test', costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    } as unknown as LLMProvider;
    await assessPlanProgress(llm, {
      ...baseInput,
      completedPhases: [{
        index: 0,
        description: 'Repo-Stand auditieren',
        modifiedFiles: ['docs/audit.md'],
        resultSummary: 'Audit abgeschlossen — das Feature war bereits fertig, Build grün, nur Push fehlte (erledigt). Keine offenen Arbeiten.',
      }],
    });
    expect(captured).toContain('Ergebnis: Audit abgeschlossen');
    expect(captured).toContain('Keine offenen Arbeiten');
  });

  it('v864: ohne resultSummary keine Ergebnis-Zeile (backwards-compat)', async () => {
    let captured = '';
    const llm: LLMProvider = {
      async complete(req: { messages: Array<{ content: string }> }) {
        captured = req.messages[0].content;
        return { content: '{"kind":"proceed"}', model: 'test', costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    } as unknown as LLMProvider;
    await assessPlanProgress(llm, baseInput);
    expect(captured).not.toContain('Ergebnis:');
    expect(captured).toContain('Analyze code');
  });

  it('v864: resultSummary wird auf 400 Zeichen (Ende) gekürzt und einzeilig', async () => {
    let captured = '';
    const llm: LLMProvider = {
      async complete(req: { messages: Array<{ content: string }> }) {
        captured = req.messages[0].content;
        return { content: '{"kind":"proceed"}', model: 'test', costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    } as unknown as LLMProvider;
    const longSummary = 'A'.repeat(500) + '\nMehrzeiliges\nFazit ENDE-MARKER';
    await assessPlanProgress(llm, {
      ...baseInput,
      completedPhases: [{ index: 0, description: 'X', modifiedFiles: [], resultSummary: longSummary }],
    });
    expect(captured).toContain('ENDE-MARKER');
    expect(captured).toContain('Mehrzeiliges Fazit ENDE-MARKER'); // newlines gequetscht
    const line = captured.split('\n').find(l => l.includes('Ergebnis:'))!;
    expect(line.length).toBeLessThan(430);
  });

  it('LLM error → fallback proceed', async () => {
    const llm: LLMProvider = { async complete() { throw new Error('LLM down'); } } as unknown as LLMProvider;
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('malformed JSON → fallback proceed', async () => {
    const llm = mockLLM('not json at all');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('invalid kind → fallback proceed', async () => {
    const llm = mockLLM('{"kind":"invalid_action"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('skip with empty phaseIndices → fallback proceed', async () => {
    const llm = mockLLM('{"kind":"skip","phaseIndices":[]}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('merge with only 1 phase index → fallback proceed', async () => {
    const llm = mockLLM('{"kind":"merge","phaseIndices":[0],"newPhase":"X"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('proceed');
  });

  it('sanitizes out-of-range phase indices', async () => {
    const llm = mockLLM('{"kind":"skip","phaseIndices":[0,99,-1,1],"reasoning":"x"}');
    const m = await assessPlanProgress(llm, baseInput);
    // remaining has 2 phases (indices 0,1) — 99 and -1 should be dropped
    expect(m.kind).toBe('skip');
    if (m.kind === 'skip') expect(m.phaseIndices).toEqual([0, 1]);
  });

  it('strips "Phase X:" prefix from newPhase', async () => {
    const llm = mockLLM('{"kind":"extend","newPhase":"Phase 5: New thing","reasoning":"x"}');
    const m = await assessPlanProgress(llm, baseInput);
    expect(m.kind).toBe('extend');
    if (m.kind === 'extend') expect(m.newPhase).toBe('New thing');
  });
});
