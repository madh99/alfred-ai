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

    const pipeline = new MessagePipeline(
      mockLLM as any,
      mockConversationManager as any,
      mockUsers as any,
      mockLogger as any,
    );

    const result = await pipeline.process(makeMessage());

    expect(result).toBe('Hello!');
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

    const pipeline = new MessagePipeline(
      mockLLM as any,
      mockConversationManager as any,
      mockUsers as any,
      mockLogger as any,
      mockSkillRegistry as any,
      mockSkillSandbox as any,
    );

    const result = await pipeline.process(makeMessage());

    expect(result).toBe('The result is 4');
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockSkillSandbox.execute).toHaveBeenCalledTimes(1);
  });

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

    const pipeline = new MessagePipeline(
      mockLLM as any,
      mockConversationManager as any,
      mockUsers as any,
      mockLogger as any,
      mockSkillRegistry as any,
      undefined, // no sandbox
      mockSecurityManager as any,
    );

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

    const pipeline = new MessagePipeline(
      mockLLM as any,
      mockConversationManager as any,
      mockUsers as any,
      mockLogger as any,
      mockSkillRegistry as any,
    );

    const result = await pipeline.process(makeMessage());

    expect(result).toBe('I could not find that tool. Let me help you another way.');
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);

    // Verify the error was passed back to the LLM as a tool result
    const secondCallMessages = mockLLM.complete.mock.calls[1][0].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = toolResultMessage.content[0];
    expect(toolResultBlock.content).toContain('Unknown tool');
    expect(toolResultBlock.is_error).toBe(true);
  });
});
