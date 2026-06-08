import { describe, it, expect, vi } from 'vitest';
import { OpenItemMatcher } from './open-item-matcher.js';
import type { LLMProvider } from '@alfred/llm';
import type { ProjectRepository, ProjectOpenItem } from '@alfred/storage';
import type { Logger } from 'pino';

function makeItem(id: string, title: string): ProjectOpenItem {
  return {
    id,
    projectId: 'p1',
    title,
    description: '',
    sourceType: 'note',
    sourceId: 'src1',
    status: 'open',
    priority: 'normal',
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as ProjectOpenItem;
}

function makeLogger(): Logger & { calls: Array<{ level: string; obj: Record<string, unknown>; msg: string }> } {
  const calls: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const log = {
    calls,
    warn: vi.fn((obj: Record<string, unknown>, msg: string) => calls.push({ level: 'warn', obj, msg })),
    info: vi.fn((obj: Record<string, unknown>, msg: string) => calls.push({ level: 'info', obj, msg })),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  } as unknown as Logger & { calls: typeof calls };
  return log;
}

function makeRepo(openItems: ProjectOpenItem[]): ProjectRepository {
  return {
    listOpenItemsForProject: vi.fn(async () => openItems),
    autoResolveOpenItem: vi.fn(async () => true),
    getByIdAnyOwner: vi.fn(async () => null),
  } as unknown as ProjectRepository;
}

function makeLLM(content: string, outputTokens = 0): LLMProvider {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'test-model',
      usage: { inputTokens: 1000, outputTokens, cacheReadTokens: 0 },
    })),
  } as unknown as LLMProvider;
}

describe('OpenItemMatcher v855 — Fix 1+2', () => {
  it('uses tier:"fast" and maxTokens:4000 for LLM call (v855 Fix 1)', async () => {
    const items = [makeItem('i1', 'Chat-Bug fixen')];
    const llm = makeLLM('[{"item_id":"i1","resolved":true,"confidence":0.9,"reason":"matched"}]');
    const matcher = new OpenItemMatcher(makeRepo(items), llm, makeLogger());
    await matcher.matchAfterSession({
      projectId: 'p1', sessionId: 's1', goal: 'Fix chat', milestones: ['done'],
      totalFilesChanged: 5,
    });
    const completeMock = llm.complete as ReturnType<typeof vi.fn>;
    expect(completeMock).toHaveBeenCalledOnce();
    const callArg = completeMock.mock.calls[0][0];
    expect(callArg.tier).toBe('fast');
    expect(callArg.maxTokens).toBe(4000);
  });

  it('returns 0 resolved + diagnose-warn when LLM returns empty content with high outputTokens (reasoning model)', async () => {
    const items = [makeItem('i1', 'Bug')];
    const llm = makeLLM('', 1500); // empty content, high outputTokens → reasoning verbraucht
    const logger = makeLogger();
    const matcher = new OpenItemMatcher(makeRepo(items), llm, logger);
    const r = await matcher.matchAfterSession({
      projectId: 'p1', sessionId: 's1', goal: 'g', milestones: ['m1'],
      totalFilesChanged: 5,
    });
    expect(r.resolved).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.considered).toBe(1);
    // v855 Fix 2: diagnose-warn mit suspectedCause
    const warnCall = logger.calls.find(c => c.level === 'warn' && c.msg.includes('LLM-Content leer'));
    expect(warnCall).toBeDefined();
    expect(warnCall!.obj.suspectedCause).toMatch(/Reasoning-Model/);
    expect(warnCall!.obj.outputTokens).toBe(1500);
  });

  it('diagnose-warn distinguishes truly-empty output vs reasoning-eaten output', async () => {
    const items = [makeItem('i1', 'Bug')];
    const llm = makeLLM('', 0); // empty AND zero outputTokens → truly empty
    const logger = makeLogger();
    const matcher = new OpenItemMatcher(makeRepo(items), llm, logger);
    await matcher.matchAfterSession({
      projectId: 'p1', sessionId: 's1', goal: 'g', milestones: ['m1'],
      totalFilesChanged: 5,
    });
    const warnCall = logger.calls.find(c => c.level === 'warn' && c.msg.includes('LLM-Content leer'));
    expect(warnCall).toBeDefined();
    expect(warnCall!.obj.suspectedCause).toMatch(/Auth\/Rate-Limit/);
  });

  it('normal path still works: valid JSON → items resolved', async () => {
    const items = [makeItem('i1', 'A'), makeItem('i2', 'B')];
    const llm = makeLLM(
      '[{"item_id":"i1","resolved":true,"confidence":0.9,"reason":"done"},' +
      '{"item_id":"i2","resolved":false,"confidence":0.2,"reason":"unrelated"}]',
      500,
    );
    const matcher = new OpenItemMatcher(makeRepo(items), llm, makeLogger());
    const r = await matcher.matchAfterSession({
      projectId: 'p1', sessionId: 's1', goal: 'g', milestones: ['m1'],
      totalFilesChanged: 5,
    });
    expect(r.matched).toBe(2);
    expect(r.resolved).toBe(1); // only i1 with confidence >= 0.6 AND resolved=true counts
  });

  it('skips early when totalFilesChanged is 0', async () => {
    const items = [makeItem('i1', 'A')];
    const llm = makeLLM('[]');
    const matcher = new OpenItemMatcher(makeRepo(items), llm, makeLogger());
    const r = await matcher.matchAfterSession({
      projectId: 'p1', sessionId: 's1', goal: 'g', milestones: [],
      totalFilesChanged: 0,
    });
    expect(r).toEqual({ matched: 0, resolved: 0, considered: 0, candidates: 0 });
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
