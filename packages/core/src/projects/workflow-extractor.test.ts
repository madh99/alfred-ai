import { describe, it, expect, vi } from 'vitest';
import { WorkflowExtractor, type ExtractorInput } from './workflow-extractor.js';
import type { LLMProvider } from '@alfred/llm';

function mkLlm(content: string): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({ content, usage: { promptTokens: 0, completionTokens: 0 } }),
  } as unknown as LLMProvider;
}

const availableSkills = new Set(['code_agent', 'shell', 'ssh', 'file', 'http']);

const baseInput: ExtractorInput = {
  goal: 'Deploy alfred-ai release',
  toolCalls: [
    { name: 'shell', input: { command: 'pnpm build' }, success: true, output: 'ok' },
    { name: 'shell', input: { command: 'node scripts/bundle.mjs' }, success: true, output: 'ok' },
    { name: 'shell', input: { command: 'npm publish' }, success: true, output: 'published' },
    { name: 'ssh', input: { host: '192.168.1.92', cmd: 'sudo npm install -g alfred@1.0' }, success: true },
    { name: 'ssh', input: { host: '192.168.1.93', cmd: 'sudo npm install -g alfred@1.0' }, success: true },
  ],
  availableSkills,
};

describe('WorkflowExtractor — early skips', () => {
  it('returns reusable=false when fewer than 2 successful calls', async () => {
    const llm = mkLlm('should not be called');
    const out = await new WorkflowExtractor(llm).analyze({
      ...baseInput,
      toolCalls: [{ name: 'shell', input: {}, success: true }],
    });
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('too few');
    expect((llm.complete as any).mock.calls.length).toBe(0); // no LLM call
  });

  it('returns reusable=false for trivial single-skill sequences', async () => {
    const llm = mkLlm('should not be called');
    const out = await new WorkflowExtractor(llm).analyze({
      ...baseInput,
      toolCalls: [
        { name: 'shell', input: {}, success: true },
        { name: 'shell', input: {}, success: true },
      ],
    });
    expect(out.reusable).toBe(false);
    expect((llm.complete as any).mock.calls.length).toBe(0);
  });
});

describe('WorkflowExtractor — parsing', () => {
  it('parses a valid reusable workflow', async () => {
    const llm = mkLlm(JSON.stringify({
      reusable: true,
      suggested_name: 'deploy-uboot',
      suggested_description: 'Build, publish und Deployment auf .92 + .93',
      steps: [
        { type: 'action', skillName: 'shell', inputMapping: { command: 'pnpm build' }, onError: 'stop' },
        { type: 'action', skillName: 'shell', inputMapping: { command: 'npm publish' }, onError: 'stop' },
        { type: 'action', skillName: 'ssh', inputMapping: { host: '{{host_a}}', cmd: 'install' }, onError: 'stop' },
      ],
    }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(true);
    expect(out.suggestedName).toBe('deploy-uboot');
    expect(out.steps?.length).toBe(3);
    expect((out.steps![0] as any).skillName).toBe('shell');
  });

  it('strips markdown fences', async () => {
    const llm = mkLlm('```json\n{"reusable":true,"suggested_name":"sync-x","suggested_description":"abc def","steps":[{"type":"action","skillName":"shell","inputMapping":{},"onError":"stop"},{"type":"action","skillName":"http","inputMapping":{},"onError":"skip"}]}\n```');
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(true);
    expect(out.suggestedName).toBe('sync-x');
  });

  it('rejects when LLM marks reusable=false', async () => {
    const llm = mkLlm(JSON.stringify({ reusable: false, rationale: 'ad-hoc query' }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toBe('ad-hoc query');
  });

  it('rejects invalid suggested_name (not kebab-case)', async () => {
    const llm = mkLlm(JSON.stringify({
      reusable: true, suggested_name: 'Deploy UBoot!', suggested_description: 'desc',
      steps: [{ type: 'action', skillName: 'shell', inputMapping: {}, onError: 'stop' }],
    }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('kebab-case');
  });

  it('rejects steps referencing unknown skills (anti-hallucination)', async () => {
    const llm = mkLlm(JSON.stringify({
      reusable: true, suggested_name: 'test-flow', suggested_description: 'desc valid',
      steps: [{ type: 'action', skillName: 'made_up_skill', inputMapping: {}, onError: 'stop' }],
    }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('made_up_skill');
  });

  it('rejects unparseable LLM output', async () => {
    const llm = mkLlm('Sorry I cannot help');
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('unparseable');
  });

  it('rejects too short description', async () => {
    const llm = mkLlm(JSON.stringify({
      reusable: true, suggested_name: 'test-flow', suggested_description: 'x',
      steps: [{ type: 'action', skillName: 'shell', inputMapping: {}, onError: 'stop' }],
    }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('too short');
  });

  it('rejects when LLM throws', async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as LLMProvider;
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(false);
    expect(out.rationale).toContain('LLM call failed');
  });

  it('skips non-action steps but keeps action ones', async () => {
    const llm = mkLlm(JSON.stringify({
      reusable: true, suggested_name: 'test-flow', suggested_description: 'desc valid',
      steps: [
        { type: 'action', skillName: 'shell', inputMapping: {}, onError: 'stop' },
        { type: 'condition', condition: {}, then: 'end', else: null },
        { type: 'action', skillName: 'http', inputMapping: {}, onError: 'skip' },
      ],
    }));
    const out = await new WorkflowExtractor(llm).analyze(baseInput);
    expect(out.reusable).toBe(true);
    expect(out.steps?.length).toBe(2);
  });
});
