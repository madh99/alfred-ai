import { describe, it, expect } from 'vitest';
import { PromptBuilder } from './prompt-builder.js';
import type { ConversationMessage, SkillMetadata } from '@alfred/types';

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  describe('buildSystemPrompt', () => {
    it('should return a non-empty string', () => {
      const prompt = builder.buildSystemPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe('buildMessages', () => {
    it('should map ConversationMessage[] to LLMMessage[]', () => {
      const history: ConversationMessage[] = [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there!',
          createdAt: new Date().toISOString(),
        },
      ];

      const messages = builder.buildMessages(history);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should filter out system messages', () => {
      const history: ConversationMessage[] = [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          role: 'system',
          content: 'System init',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      ];

      const messages = builder.buildMessages(history);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('should handle messages with toolCalls', () => {
      const toolCalls = JSON.stringify([
        { id: 'tc1', name: 'calculator', input: { expression: '2+2' } },
      ]);

      const history: ConversationMessage[] = [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Let me calculate that.',
          toolCalls,
          createdAt: new Date().toISOString(),
        },
      ];

      const messages = builder.buildMessages(history);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      // Content should be an array of LLMContentBlock when toolCalls are present
      expect(Array.isArray(messages[0].content)).toBe(true);
      const content = messages[0].content as any[];
      expect(content[0]).toEqual({ type: 'text', text: 'Let me calculate that.' });
      expect(content[1]).toEqual({
        type: 'tool_use',
        id: 'tc1',
        name: 'calculator',
        input: { expression: '2+2' },
      });
    });
  });

  describe('buildTools', () => {
    it('should map SkillMetadata[] to ToolDefinition[]', () => {
      const skills: SkillMetadata[] = [
        {
          name: 'calculator',
          description: 'Performs calculations',
          riskLevel: 'read',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: { expression: { type: 'string' } },
          },
        },
        {
          name: 'weather',
          description: 'Gets weather info',
          riskLevel: 'read',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ];

      const tools = builder.buildTools(skills);
      expect(tools).toHaveLength(2);
      expect(tools[0]).toEqual({
        name: 'calculator',
        description: 'Performs calculations',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string' } },
        },
      });
      expect(tools[1]).toEqual({
        name: 'weather',
        description: 'Gets weather info',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      });
    });
  });
});
