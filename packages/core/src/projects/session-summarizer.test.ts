import { describe, it, expect, vi } from 'vitest';
import { SessionSummarizer, type SummarizerInput } from './session-summarizer.js';
import type { LLMProvider } from '@alfred/llm';

function mkLlm(content: string): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({ content, usage: { promptTokens: 0, completionTokens: 0 } }),
  } as unknown as LLMProvider;
}

const baseInput: SummarizerInput = {
  goal: 'Build a thing',
  sessionType: 'project_agent',
  cwd: '/tmp/x',
  milestones: ['m1', 'm2', 'm3'],
  totalFilesChanged: 5,
  success: true,
  files: ['a.ts', 'b.ts'],
};

describe('SessionSummarizer — parsing', () => {
  it('parses a well-formed JSON response', async () => {
    const llm = mkLlm(JSON.stringify({
      what_was_done: 'Skeleton angelegt + Tests grün.',
      key_decisions: [{ choice: 'Postgres statt SQLite', rationale: 'Concurrency' }],
      files_touched: ['a.ts', 'b.ts'],
      open_items: [{ title: 'Auth nachziehen', priority: 'high' }],
      status: 'success',
      next_check_in_days: 7,
    }));
    const s = new SessionSummarizer(llm);
    const out = await s.summarize(baseInput);
    expect(out).not.toBeNull();
    expect(out!.whatWasDone).toBe('Skeleton angelegt + Tests grün.');
    expect(out!.keyDecisions).toEqual([{ choice: 'Postgres statt SQLite', rationale: 'Concurrency' }]);
    expect(out!.filesTouched).toEqual(['a.ts', 'b.ts']);
    expect(out!.openItems).toEqual([{ title: 'Auth nachziehen', priority: 'high', description: undefined }]);
    expect(out!.status).toBe('success');
    expect(out!.nextCheckInDays).toBe(7);
  });

  it('strips markdown fences around JSON', async () => {
    const llm = mkLlm('```json\n{"what_was_done":"ok","status":"success"}\n```');
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out?.whatWasDone).toBe('ok');
    expect(out?.status).toBe('success');
  });

  it('returns null on unparseable output', async () => {
    const llm = mkLlm('Sorry, I cannot help with that.');
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out).toBeNull();
  });

  it('clamps absurd next_check_in_days values', async () => {
    const llm = mkLlm(JSON.stringify({ next_check_in_days: 9999 }));
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out?.nextCheckInDays).toBeUndefined();
  });

  it('defaults invalid priority to normal', async () => {
    const llm = mkLlm(JSON.stringify({
      open_items: [{ title: 'X', priority: 'urgent' }],
    }));
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out?.openItems?.[0].priority).toBe('normal');
  });

  it('drops empty-title open items', async () => {
    const llm = mkLlm(JSON.stringify({
      open_items: [{ title: '' }, { title: 'valid' }],
    }));
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out?.openItems).toEqual([{ title: 'valid', priority: 'normal', description: undefined }]);
  });

  it('caps long arrays to safe limits', async () => {
    const longDecisions = Array.from({ length: 20 }, (_, i) => ({ choice: `d${i}` }));
    const longOpenItems = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` }));
    const llm = mkLlm(JSON.stringify({
      key_decisions: longDecisions,
      open_items: longOpenItems,
    }));
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out?.keyDecisions?.length).toBe(5);
    expect(out?.openItems?.length).toBe(8);
  });

  it('infers status from input.success when LLM omits it', async () => {
    const llm = mkLlm(JSON.stringify({ what_was_done: 'x' }));
    const out = await new SessionSummarizer(llm).summarize({ ...baseInput, success: false });
    expect(out?.status).toBe('failed');
  });

  it('returns null when LLM throws', async () => {
    const llm = {
      complete: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as LLMProvider;
    const out = await new SessionSummarizer(llm).summarize(baseInput);
    expect(out).toBeNull();
  });
});
