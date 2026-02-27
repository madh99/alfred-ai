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

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is intentionally conservative (overestimates) to avoid exceeding limits.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(msg: LLMMessage): number {
  if (typeof msg.content === 'string') {
    return estimateTokens(msg.content) + 4; // +4 for role/message overhead
  }
  let tokens = 4;
  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        tokens += estimateTokens(block.text);
        break;
      case 'tool_use':
        tokens += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
        break;
      case 'tool_result':
        tokens += estimateTokens(block.content);
        break;
    }
  }
  return tokens;
}

export class PromptBuilder {
  buildSystemPrompt(memories?: MemoryForPrompt[], skills?: SkillMetadata[]): string {
    const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '~';

    let prompt = `You are Alfred, a personal AI assistant. You run on ${os} (home: ${homeDir}).

## Core principles
- ACT, don't just talk. When the user asks you to do something, USE YOUR TOOLS immediately. Never say "I could do X" — just do X.
- Respond in the same language the user writes in.
- Be concise. No filler text, no unnecessary explanations.
- If a tool fails or is denied, explain why and try an alternative approach.

## Multi-step reasoning
For complex tasks, work through multiple steps:
1. **Understand** what the user wants.
2. **Execute** using the right tools — chain multiple tool calls if needed.
3. **Continue** after each tool result. If the task isn't done, use the next tool. Don't stop after one call.
4. **Summarize** the final result clearly.

## Environment
- OS: ${os}
- Home: ${homeDir}
- Documents: ${homeDir}/Documents
- Desktop: ${homeDir}/Desktop
- Downloads: ${homeDir}/Downloads`;

    // List available skills so the LLM knows what it can do
    if (skills && skills.length > 0) {
      prompt += '\n\n## Available tools\n';
      for (const s of skills) {
        prompt += `- **${s.name}** (${s.riskLevel}): ${s.description}\n`;
      }
    }

    if (memories && memories.length > 0) {
      prompt += '\n\n## Memories about this user\n';
      for (const m of memories) {
        prompt += `- [${m.category}] ${m.key}: ${m.value}\n`;
      }
      prompt += '\nUse these memories to personalize your responses. When the user tells you new facts or preferences, use the memory tool to save them.';
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
