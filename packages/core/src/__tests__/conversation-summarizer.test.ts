import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationSummarizer } from '../conversation-summarizer.js';

function createMockLLM() {
  return {
    complete: vi.fn().mockResolvedValue({ content: '**Ziel:** Test\n**Thema:** Unit Test\n**Fakten:** —\n**Entscheidungen:** —\n**Offen:** —' }),
    initialize: vi.fn(),
  } as any;
}

function createMockSummaryRepo() {
  const store = new Map<string, any>();
  return {
    get: vi.fn((id: string) => store.get(id)),
    upsert: vi.fn((entry: any) => store.set(entry.conversationId, entry)),
    delete: vi.fn((id: string) => store.delete(id)),
    _store: store,
  } as any;
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('ConversationSummarizer', () => {
  let summarizer: ConversationSummarizer;
  let llm: ReturnType<typeof createMockLLM>;
  let summaryRepo: ReturnType<typeof createMockSummaryRepo>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    llm = createMockLLM();
    summaryRepo = createMockSummaryRepo();
    logger = createMockLogger();
    summarizer = new ConversationSummarizer(llm, summaryRepo, logger);
  });

  it('getSummary() returns undefined for unknown conversation', () => {
    expect(summarizer.getSummary('unknown-id')).toBeUndefined();
    expect(summaryRepo.get).toHaveBeenCalledWith('unknown-id');
  });

  it('onMessageProcessed() skips when fewer than 6 messages', () => {
    summarizer.onMessageProcessed('conv-1', 3, 'hello', 'hi there', []);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('onMessageProcessed() skips when fewer than 3 new messages since last update', () => {
    summaryRepo._store.set('conv-1', { conversationId: 'conv-1', summary: 'old', messageCount: 10, updatedAt: new Date().toISOString() });
    summarizer.onMessageProcessed('conv-1', 11, 'hello', 'hi there', []);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('onMessageProcessed() triggers summary creation at threshold', async () => {
    summarizer.onMessageProcessed('conv-1', 7, 'Explain monorepos', 'A monorepo is...', []);
    // Wait for fire-and-forget
    await vi.waitFor(() => expect(llm.complete).toHaveBeenCalled());
    await vi.waitFor(() => expect(summaryRepo.upsert).toHaveBeenCalled());
  });

  it('onMessageProcessed() triggers summary update after interval', async () => {
    summaryRepo._store.set('conv-1', { conversationId: 'conv-1', summary: 'old summary', messageCount: 6, updatedAt: new Date().toISOString() });
    summarizer.onMessageProcessed('conv-1', 10, 'new question', 'new answer', []);
    await vi.waitFor(() => expect(llm.complete).toHaveBeenCalled());
  });

  it('skips upsert when LLM returns too-short response', async () => {
    llm.complete.mockResolvedValue({ content: 'hi' });
    summarizer.onMessageProcessed('conv-1', 7, 'test', 'response', []);
    await vi.waitFor(() => expect(llm.complete).toHaveBeenCalled());
    // Short response should NOT trigger upsert
    expect(summaryRepo.upsert).not.toHaveBeenCalled();
  });

  it('buildSummaryPrompt includes existing summary when present', async () => {
    summaryRepo._store.set('conv-1', { conversationId: 'conv-1', summary: 'Previous context', messageCount: 6, updatedAt: new Date().toISOString() });
    summarizer.onMessageProcessed('conv-1', 10, 'follow up', 'response', [
      { role: 'user', content: 'earlier message' },
    ]);
    await vi.waitFor(() => expect(llm.complete).toHaveBeenCalled());
    const prompt = llm.complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Previous context');
    expect(prompt).toContain('Aktualisiere');
  });
});
