import type {
  ConversationMessage,
  LLMMessage,
  LLMContentBlock,
  SkillMetadata,
  ToolDefinition,
  ToolCall,
} from '@alfred/types';

export interface MemoryForPrompt {
  key: string;
  value: string;
  category: string;
}

export class PromptBuilder {
  buildSystemPrompt(memories?: MemoryForPrompt[]): string {
    let prompt = 'You are Alfred, a personal AI assistant. You are helpful, precise, and security-conscious. You have access to various tools (skills) that you can use to help the user. Always explain what you are doing before using a tool. Be concise but thorough.';

    if (memories && memories.length > 0) {
      prompt += '\n\nYou have the following memories about this user. Use them to personalize your responses:\n';
      for (const m of memories) {
        prompt += `- [${m.category}] ${m.key}: ${m.value}\n`;
      }
      prompt += '\nWhen the user tells you new facts or preferences, use the memory tool to save them for future reference.';
    } else {
      prompt += '\n\nWhen the user tells you facts about themselves or preferences, use the memory tool to save them for future reference.';
    }

    return prompt;
  }

  buildMessages(history: ConversationMessage[]): LLMMessage[] {
    return history
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg): LLMMessage => {
        if (msg.toolCalls) {
          const toolCalls = JSON.parse(msg.toolCalls) as ToolCall[];
          const content: LLMContentBlock[] = [];

          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }

          for (const tc of toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }

          return { role: msg.role as 'user' | 'assistant', content };
        }

        return { role: msg.role as 'user' | 'assistant', content: msg.content };
      });
  }

  buildTools(skills: SkillMetadata[]): ToolDefinition[] {
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema,
    }));
  }
}
