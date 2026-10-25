import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagePipeline } from '../message-pipeline.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLLM = {
  initialize: vi.fn(),
  complete: vi.fn(),
  stream: vi.fn(),
  isAvailable: vi.fn(() => true),
  getContextWindow: vi.fn(() => ({ maxInputTokens: 200_000, maxOutputTokens: 4_096 })),
  supportsEmbeddings: vi.fn(() => false),
  embed: vi.fn(),
  config: { provider: 'anthropic' as const, model: 'test', apiKey: 'test' },
};

const mockConversationManager = {
  getOrCreateConversation: vi.fn(() => ({
    id: 'conv-1',
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  getHistory: vi.fn(() => []),
  addMessage: vi.fn(),
};

const mockUsers = {
  findOrCreate: vi.fn(() => ({
    id: 'user-1',
    platform: 'telegram',
    platformUserId: 'u1',
    username: 'testuser',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  update: vi.fn(),
  findById: vi.fn(),
  findByPlatformId: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeMessage(overrides?: Record<string, unknown>) {
  return {
    id: 'msg-1',
    platform: 'telegram' as const,
    chatId: 'chat-1',
    chatType: 'dm' as const,
    userId: 'u1',
    userName: 'testuser',
    text: 'Hello Alfred',
    timestamp: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessagePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Test 1: Simple message without tools ----
  it('should process a simple message without tools', async () => {
    mockLLM.complete.mockResolvedValueOnce({
      content: 'Hello!',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    });

    const pipeline = new MessagePipeline({
      llm: mockLLM as any,
      conversationManager: mockConversationManager as any,
      users: mockUsers as any,
      logger: mockLogger as any,
    });

    const result = await pipeline.process(makeMessage());

    expect(result.text).toBe('Hello!');
    expect(result.attachments).toBeUndefined();
    expect(mockUsers.findOrCreate).toHaveBeenCalled();
    expect(mockConversationManager.getOrCreateConversation).toHaveBeenCalled();
    // addMessage is called twice: once for the user message, once for the assistant response
    expect(mockConversationManager.addMessage).toHaveBeenCalledTimes(2);
  });

  // ---- Test 2: Message with tool use ----
  it('should process a message with tool calls', async () => {
    // First LLM call returns a tool call
    mockLLM.complete.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'calculator', input: { expression: '2+2' } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    });

    // Second LLM call returns plain text after processing tool result
    mockLLM.complete.mockResolvedValueOnce({
      content: 'The result is 4',
      usage: { inputTokens: 20, outputTokens: 10 },
      stopReason: 'end_turn',
    });

    // Mock skill
    const mockSkill = {
      metadata: {
        name: 'calculator',
        description: 'Calculator',
        riskLevel: 'read' as const,
        version: '1.0.0',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    };

    const mockSkillRegistry = {
      get: vi.fn((name: string) => (name === 'calculator' ? mockSkill : undefined)),
      getAll: vi.fn(() => [mockSkill]),
      has: vi.fn(),
      toToolDefinitions: vi.fn(),
    };

    const mockSkillSandbox = {
      execute: vi.fn().mockResolvedValueOnce({
        success: true,
        data: 4,
        display: '2+2 = 4',
      }),
    };

    const pipeline = new MessagePipeline({
      llm: mockLLM as any,
      conversationManager: mockConversationManager as any,
      users: mockUsers as any,
      logger: mockLogger as any,
      skillRegistry: mockSkillRegistry as any,
      skillSandbox: mockSkillSandbox as any,
    });

    const result = await pipeline.process(makeMessage());

    expect(result.text).toBe('The result is 4');
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockSkillSandbox.execute).toHaveBeenCalledTimes(1);
  });

  // ---- v1659: Anfragekosten = Summe der echten Kosten je Aufruf (Cache berücksichtigt) ----
  it('v1659 Realfall web-v1: Kosten der Anfrage aus den Aufrufen, nicht aus der Token-Summe', async () => {
    mockLLM.complete.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'tc1', name: 'calculator', input: { expression: '1+1' } }], usage: { inputTokens: 120_000, outputTokens: 200, cacheReadTokens: 119_000 }, stopReason: 'tool_use', model: 'gpt-6.1-sol', kostenUsd: 0.015 });
    mockLLM.complete.mockResolvedValueOnce({ content: 'Fertig.', usage: { inputTokens: 121_000, outputTokens: 300, cacheReadTokens: 120_000 }, stopReason: 'end_turn', model: 'gpt-6.1-sol', kostenUsd: 0.017 });
    const skill = { metadata: { name: 'calculator', description: 'Calculator', riskLevel: 'read' as const, version: '1.0.0', inputSchema: { type: 'object', properties: {} } }, execute: vi.fn() };
    const pipeline = new MessagePipeline({
      llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
      skillRegistry: { get: vi.fn(() => skill), getAll: vi.fn(() => [skill]), has: vi.fn(), toToolDefinitions: vi.fn() } as any,
      skillSandbox: { execute: vi.fn().mockResolvedValue({ success: true, data: 2, display: '2' }) } as any,
    });
    const vorher = pipeline.getMetrics().totalCostUsd;
    await pipeline.process(makeMessage());
    expect(pipeline.getMetrics().totalCostUsd - vorher).toBeCloseTo(0.032, 6);
  });

  // ---- v1650: abgeschnittener Werkzeugaufruf wird nie mit {} ausgeführt ----
  for (const fall of [
    { name: 'Wiederholung mit größerem Limit liefert den vollständigen Aufruf', zweiterAbgeschnitten: false, erwarteteAusfuehrungen: 1 },
    { name: 'bleibt abgeschnitten → verworfen, Hinweis zum Aufteilen, nichts ausgeführt', zweiterAbgeschnitten: true, erwarteteAusfuehrungen: 0 },
  ]) {
    it(`v1650 ${fall.name}`, async () => {
      const abgeschnitten = { content: '', toolCalls: [{ id: 'tc1', name: 'calculator', input: {} }], usage: { inputTokens: 1, outputTokens: 4096 }, stopReason: 'max_tokens' };
      mockLLM.complete.mockResolvedValueOnce(abgeschnitten);
      mockLLM.complete.mockResolvedValueOnce(fall.zweiterAbgeschnitten ? abgeschnitten
        : { content: '', toolCalls: [{ id: 'tc2', name: 'calculator', input: { expression: '2+2' } }], usage: { inputTokens: 1, outputTokens: 5000 }, stopReason: 'tool_use' });
      mockLLM.complete.mockResolvedValueOnce({ content: 'Fertig.', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
      const skill = { metadata: { name: 'calculator', description: 'Calculator', riskLevel: 'read' as const, version: '1.0.0', inputSchema: { type: 'object', properties: {} } }, execute: vi.fn() };
      const sandbox = { execute: vi.fn().mockResolvedValue({ success: true, data: 4, display: '4' }) };
      const pipeline = new MessagePipeline({
        llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
        skillRegistry: { get: vi.fn(() => skill), getAll: vi.fn(() => [skill]), has: vi.fn(), toToolDefinitions: vi.fn() } as any,
        skillSandbox: sandbox as any,
      });
      const result = await pipeline.process(makeMessage());
      expect(result.text).toBe('Fertig.');
      expect(mockLLM.complete.mock.calls[1][0].maxTokens).toBe(4096);
      const schleife = sandbox.execute.mock.calls.filter((c: any[]) => !(c[1] as Record<string, unknown>)?.action); // ohne Kontext-Vorladung
      expect(schleife).toHaveLength(fall.erwarteteAusfuehrungen);
      expect(schleife.every((c: any[]) => Object.keys(c[1] as object).length > 0)).toBe(true);
      if (fall.zweiterAbgeschnitten) {
        const letzte = mockLLM.complete.mock.calls[2][0].messages.at(-1);
        expect(letzte.content).toContain('abgeschnitten und NICHT ausgeführt');
      }
    });
  }

  // ---- v1674: leere Antwort am Ausgabelimit (Denkblock) → einmal mit größerem Limit, Werkzeugaufruf wird ausgeführt ----
  it('v1674 leere max_tokens-Antwort: Wiederholung mit größerem Limit, danach Werkzeug ausgeführt statt „(no response)“', async () => {
    const leer = { content: '', usage: { inputTokens: 1, outputTokens: 4096 }, stopReason: 'max_tokens' };
    mockLLM.complete.mockResolvedValueOnce(leer);
    mockLLM.complete.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'tc1', name: 'calculator', input: { expression: '2+2' } }], usage: { inputTokens: 1, outputTokens: 6000 }, stopReason: 'tool_use' });
    mockLLM.complete.mockResolvedValueOnce({ content: 'Change vorgelegt.', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
    const skill = { metadata: { name: 'calculator', description: 'Calculator', riskLevel: 'read' as const, version: '1.0.0', inputSchema: { type: 'object', properties: {} } }, execute: vi.fn() };
    const sandbox = { execute: vi.fn().mockResolvedValue({ success: true, data: 4, display: '4' }) };
    const pipeline = new MessagePipeline({
      llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
      skillRegistry: { get: vi.fn(() => skill), getAll: vi.fn(() => [skill]), has: vi.fn(), toToolDefinitions: vi.fn() } as any,
      skillSandbox: sandbox as any,
    });
    const result = await pipeline.process(makeMessage());
    expect(result.text).toBe('Change vorgelegt.');
    expect(mockLLM.complete.mock.calls[1][0].maxTokens).toBeGreaterThan(0);
    expect(mockLLM.complete.mock.calls[1][0].messages).toEqual(mockLLM.complete.mock.calls[0][0].messages); // dieselbe Anfrage, kein „kürzer“-Zusatz
    expect(sandbox.execute.mock.calls.filter((c: any[]) => !(c[1] as Record<string, unknown>)?.action)).toHaveLength(1);
  });

  it('v1674 Fortsetzung liefert einen Werkzeugaufruf → wird ausgeführt', async () => {
    mockLLM.complete.mockResolvedValueOnce({ content: 'Teil 1 ', usage: { inputTokens: 1, outputTokens: 4096 }, stopReason: 'max_tokens' });
    mockLLM.complete.mockResolvedValueOnce({ content: 'Teil 2', toolCalls: [{ id: 'tc1', name: 'calculator', input: { expression: '1+1' } }], usage: { inputTokens: 1, outputTokens: 10 }, stopReason: 'tool_use' });
    mockLLM.complete.mockResolvedValueOnce({ content: 'Ergebnis 2.', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
    const skill = { metadata: { name: 'calculator', description: 'Calculator', riskLevel: 'read' as const, version: '1.0.0', inputSchema: { type: 'object', properties: {} } }, execute: vi.fn() };
    const sandbox = { execute: vi.fn().mockResolvedValue({ success: true, data: 2, display: '2' }) };
    const pipeline = new MessagePipeline({
      llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
      skillRegistry: { get: vi.fn(() => skill), getAll: vi.fn(() => [skill]), has: vi.fn(), toToolDefinitions: vi.fn() } as any,
      skillSandbox: sandbox as any,
    });
    const result = await pipeline.process(makeMessage());
    expect(sandbox.execute.mock.calls.filter((c: any[]) => !(c[1] as Record<string, unknown>)?.action)).toHaveLength(1);
    expect(result.text).toContain('Ergebnis 2.');
  });

  // ---- v1450: frühere Runden nur bei echten geplanten Aufgaben, nie aus dem Verlauf ----
  for (const fall of [
    { name: 'geplante Aufgabe (ohne Verlauf): Bericht aus Runde 1 wird mitgeliefert', metadata: { scheduled: true, skipHistory: true }, erwartetBericht: true },
    { name: 'Fortsetzung nach Freigabe (mit Verlauf): keine alten Texte, nur die Antwort', metadata: { scheduled: true }, erwartetBericht: false },
  ]) {
    it(`v1450 ${fall.name}`, async () => {
      const alt = '✅ Etappe 5/8 alte Meldung aus dem Faden. ' + 'x'.repeat(300);
      mockConversationManager.getHistory.mockReturnValueOnce([{ id: 'h1', conversationId: 'conv-1', role: 'assistant', content: alt, createdAt: new Date().toISOString() }] as any);
      const bericht = '## Bericht\n' + 'Zeile mit Inhalt. '.repeat(20);
      mockLLM.complete.mockResolvedValueOnce({ content: bericht, toolCalls: [{ id: 'tc1', name: 'calculator', input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_use' });
      mockLLM.complete.mockResolvedValueOnce({ content: 'Notiz gespeichert.', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
      const skill = { metadata: { name: 'calculator', description: 'c', riskLevel: 'read' as const, version: '1', inputSchema: { type: 'object', properties: {} } }, execute: vi.fn() };
      const pipeline = new MessagePipeline({
        llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
        skillRegistry: { get: vi.fn(() => skill), getAll: vi.fn(() => [skill]), has: vi.fn(), toToolDefinitions: vi.fn() } as any,
        skillSandbox: { execute: vi.fn().mockResolvedValue({ success: true, display: 'ok' }) } as any,
      });
      const r = await pipeline.process(makeMessage({ metadata: fall.metadata }));
      expect(r.text).not.toContain('alte Meldung aus dem Faden');
      expect(r.text.includes('## Bericht')).toBe(fall.erwartetBericht);
      expect(r.text).toContain('Notiz gespeichert.');
    });
  }

  // ---- v1483: interne Nachrichten (metadata.scheduled) lernen keine Korrekturen ----
  for (const fall of [
    { name: 'Owner-Nachricht wird ausgewertet', metadata: undefined, erwartet: 1 },
    { name: 'Fortsetzung nach Freigabe wird nicht ausgewertet', metadata: { scheduled: true }, erwartet: 0 },
  ]) {
    it(`v1483 ${fall.name}`, async () => {
      mockLLM.complete.mockResolvedValueOnce({ content: 'Erledigt.', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' });
      const activeLearning = { onMessageProcessed: vi.fn() };
      const pipeline = new MessagePipeline({
        llm: mockLLM as any, conversationManager: mockConversationManager as any, users: mockUsers as any, logger: mockLogger as any,
        activeLearning: activeLearning as any,
      });
      await pipeline.process(makeMessage({ text: 'Die von mir freigegebene Aktion wurde gerade ausgeführt.', metadata: fall.metadata }));
      expect(activeLearning.onMessageProcessed).toHaveBeenCalledTimes(fall.erwartet);
    });
  }

  // ---- Test 3: Security deny ----
  it('should deny tool execution when security manager denies', async () => {
    // First LLM call returns a tool call
    mockLLM.complete.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'calculator', input: { expression: '2+2' } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    });

    // Second LLM call returns text after receiving the access denied error
    mockLLM.complete.mockResolvedValueOnce({
      content: 'Sorry, access was denied.',
      usage: { inputTokens: 20, outputTokens: 10 },
      stopReason: 'end_turn',
    });

    const mockSkill = {
      metadata: {
        name: 'calculator',
        description: 'Calculator',
        riskLevel: 'read' as const,
        version: '1.0.0',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    };

    const mockSkillRegistry = {
      get: vi.fn((name: string) => (name === 'calculator' ? mockSkill : undefined)),
      getAll: vi.fn(() => [mockSkill]),
      has: vi.fn(),
      toToolDefinitions: vi.fn(),
    };

    const mockSecurityManager = {
      evaluate: vi.fn(() => ({
        allowed: false,
        reason: 'Denied by rule',
        matchedRule: { id: 'deny-all' },
        timestamp: new Date(),
      })),
    };

    const pipeline = new MessagePipeline({
      llm: mockLLM as any,
      conversationManager: mockConversationManager as any,
      users: mockUsers as any,
      logger: mockLogger as any,
      skillRegistry: mockSkillRegistry as any,
      securityManager: mockSecurityManager as any,
    });

    const result = await pipeline.process(makeMessage());

    // The LLM gets an "Access denied" tool result and responds accordingly
    // Verify that the second LLM call received a tool_result with the access denied message
    const secondCallMessages = mockLLM.complete.mock.calls[1][0].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = toolResultMessage.content[0];
    expect(toolResultBlock.content).toContain('Access denied');
    expect(toolResultBlock.is_error).toBe(true);
  });

  // ---- Test 4: Unknown tool ----
  it('should handle unknown tool calls gracefully', async () => {
    // First LLM call returns a tool call for a skill that does not exist
    mockLLM.complete.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'nonexistent_skill', input: {} },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    });

    // Second LLM call returns text after processing the error
    mockLLM.complete.mockResolvedValueOnce({
      content: 'I could not find that tool. Let me help you another way.',
      usage: { inputTokens: 20, outputTokens: 10 },
      stopReason: 'end_turn',
    });

    const mockSkillRegistry = {
      get: vi.fn(() => undefined), // skill not found
      getAll: vi.fn(() => []),
      has: vi.fn(() => false),
      toToolDefinitions: vi.fn(() => []),
    };

    const pipeline = new MessagePipeline({
      llm: mockLLM as any,
      conversationManager: mockConversationManager as any,
      users: mockUsers as any,
      logger: mockLogger as any,
      skillRegistry: mockSkillRegistry as any,
    });

    const result = await pipeline.process(makeMessage());

    expect(result.text).toBe('I could not find that tool. Let me help you another way.');
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);

    // Verify the error was passed back to the LLM as a tool result
    const secondCallMessages = mockLLM.complete.mock.calls[1][0].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = toolResultMessage.content[0];
    expect(toolResultBlock.content).toContain('Unknown tool');
    expect(toolResultBlock.is_error).toBe(true);
  });

  // ---- Test 5: Attachments from skill are propagated through pipeline ----
  it('should propagate attachments from skill results', async () => {
    // First LLM call returns a tool call
    mockLLM.complete.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'code_sandbox', input: { action: 'run', code: 'print("hi")', language: 'python' } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    });

    // Second LLM call returns text after processing tool result
    mockLLM.complete.mockResolvedValueOnce({
      content: 'Here is your chart.',
      usage: { inputTokens: 20, outputTokens: 10 },
      stopReason: 'end_turn',
    });

    const mockSkill = {
      metadata: {
        name: 'code_sandbox',
        description: 'Run code',
        riskLevel: 'destructive' as const,
        version: '1.0.0',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    };

    const mockSkillRegistry = {
      get: vi.fn((name: string) => (name === 'code_sandbox' ? mockSkill : undefined)),
      getAll: vi.fn(() => [mockSkill]),
      has: vi.fn(),
      toToolDefinitions: vi.fn(),
    };

    const pdfBuffer = Buffer.from('fake-pdf-data');
    const pngBuffer = Buffer.from('fake-png-data');

    const mockSkillSandbox = {
      execute: vi.fn().mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0 },
        display: 'Output:\nDone\n\nExit code: 0',
        attachments: [
          { fileName: 'report.pdf', data: pdfBuffer, mimeType: 'application/pdf' },
          { fileName: 'chart.png', data: pngBuffer, mimeType: 'image/png' },
        ],
      }),
    };

    const pipeline = new MessagePipeline({
      llm: mockLLM as any,
      conversationManager: mockConversationManager as any,
      users: mockUsers as any,
      logger: mockLogger as any,
      skillRegistry: mockSkillRegistry as any,
      skillSandbox: mockSkillSandbox as any,
    });

    const result = await pipeline.process(makeMessage());

    expect(result.text).toBe('Here is your chart.');
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments![0].fileName).toBe('report.pdf');
    expect(result.attachments![0].data).toBe(pdfBuffer);
    expect(result.attachments![1].fileName).toBe('chart.png');
    expect(result.attachments![1].mimeType).toBe('image/png');

    // Verify the LLM was informed about the attachments in the tool_result
    const secondCallMessages = mockLLM.complete.mock.calls[1][0].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = toolResultMessage.content[0];
    expect(toolResultBlock.content).toContain('Datei(en) werden dem User gesendet');
    expect(toolResultBlock.content).toContain('report.pdf');
  });
});
