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
  type?: string;
}

export interface UserProfile {
  displayName?: string;
  timezone?: string;
  language?: string;
  bio?: string;
  preferences?: Record<string, unknown>;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  allDay?: boolean;
}

export interface SystemPromptContext {
  memories?: MemoryForPrompt[];
  skills?: SkillMetadata[];
  userProfile?: UserProfile;
  todayEvents?: CalendarEvent[];
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
      case 'image':
        tokens += 1000; // Rough estimate for vision tokens
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
  buildSystemPrompt(context: SystemPromptContext = {}): string {
    const { memories, skills, userProfile, todayEvents } = context;
    const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '~';

    let prompt = `You are Alfred, a personal AI assistant. You run on ${os} (home: ${homeDir}).

## Core principles
- ACT, don't just talk. For simple, safe tasks (searches, calculations, reminders, reading files), USE YOUR TOOLS immediately.
- **Ask before acting** on anything that changes the system: installing software, deleting files, writing to disk, running commands with side effects. Briefly confirm what you'll do and wait for the user's OK.
- Do exactly what the user asks. If the user asks for X, don't install Y instead. If you think an alternative is better, **recommend it first** and let the user decide.
- Respond in the same language the user writes in.
- Be concise. No filler text, no unnecessary explanations.
- If a tool fails or is denied, explain why and try an alternative approach.

## Follow-ups and corrections
- When the user refers back to a previous request or corrects you, **reconnect to the original task**. Don't start fresh — continue where you left off.
- If the user says "I asked for X" or "you should have done X", understand this as a correction and execute X immediately, don't explain what X is.

## Multi-step reasoning
For complex tasks, work through multiple steps:
1. **Understand** what the user actually wants — ask if unclear.
2. **Confirm** before doing anything irreversible (installs, downloads, deletions).
3. **Execute** using the right tools — chain multiple tool calls if needed.
4. **Continue** after each tool result. If the task isn't done, use the next tool. Don't stop after one call.
5. **Summarize** the final result clearly.

## Environment
- OS: ${os}
- Home: ${homeDir}
- Documents: ${homeDir}/Documents
- Desktop: ${homeDir}/Desktop
- Downloads: ${homeDir}/Downloads`;

    // Always inject current date/time — critical for time-based tasks (reminders, scheduling)
    const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const effectiveTimezone = userProfile?.timezone || serverTimezone;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      timeZone: effectiveTimezone,
      hour: '2-digit',
      minute: '2-digit',
    });
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: effectiveTimezone }); // YYYY-MM-DD
    const dayStr = now.toLocaleDateString('en-US', { timeZone: effectiveTimezone, weekday: 'long' });
    prompt += `\n\n## Current date & time`;
    prompt += `\n- Timezone: ${effectiveTimezone}`;
    prompt += `\n- Date: ${dateStr} (${dayStr})`;
    prompt += `\n- Time: ${timeStr}`;
    if (userProfile?.timezone && userProfile.timezone !== serverTimezone) {
      prompt += `\n- Server timezone: ${serverTimezone}`;
    }

    // List available skills so the LLM knows what it can do
    if (skills && skills.length > 0) {
      prompt += '\n\n## Available tools\n';
      for (const s of skills) {
        prompt += `- **${s.name}** (${s.riskLevel}): ${s.description}\n`;
      }
    }

    // User profile section
    if (userProfile) {
      prompt += '\n\n## User profile';
      if (userProfile.displayName) {
        prompt += `\n- Name: ${userProfile.displayName}`;
      }
      if (userProfile.timezone) {
        prompt += `\n- Timezone: ${userProfile.timezone}`;
      }
      if (userProfile.language) {
        prompt += `\n- Language: ${userProfile.language}`;
      }
      if (userProfile.bio) {
        prompt += `\n- Bio: ${userProfile.bio}`;
      }
    }

    // Today's calendar events
    if (todayEvents && todayEvents.length > 0) {
      prompt += '\n\n## Today\'s events';
      for (const event of todayEvents) {
        const startTime = event.allDay
          ? 'All day'
          : event.start.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              ...(userProfile?.timezone ? { timeZone: userProfile.timezone } : {}),
            });
        const endTime = event.allDay
          ? ''
          : `-${event.end.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              ...(userProfile?.timezone ? { timeZone: userProfile.timezone } : {}),
            })}`;
        const location = event.location ? ` @ ${event.location}` : '';
        prompt += `\n- ${startTime}${endTime}: ${event.title}${location}`;
      }
    }

    if (memories && memories.length > 0) {
      prompt += '\n\n## Memories about this user\n';

      // Group by type if type info is available
      const hasTypes = memories.some(m => m.type && m.type !== 'general');
      if (hasTypes) {
        const groups = new Map<string, MemoryForPrompt[]>();
        for (const m of memories) {
          const type = m.type || 'general';
          let group = groups.get(type);
          if (!group) {
            group = [];
            groups.set(type, group);
          }
          group.push(m);
        }

        const typeLabels: Record<string, string> = {
          fact: 'Facts',
          preference: 'Preferences',
          correction: 'Corrections',
          entity: 'Entities',
          decision: 'Decisions',
          relationship: 'Relationships',
          principle: 'Principles',
          commitment: 'Commitments',
          moment: 'Moments',
          skill: 'Skills',
          general: 'General',
        };

        for (const [type, items] of groups) {
          prompt += `\n### ${typeLabels[type] || type}\n`;
          for (const m of items) {
            prompt += `- ${m.key}: ${m.value}\n`;
          }
        }
      } else {
        for (const m of memories) {
          prompt += `- [${m.category}] ${m.key}: ${m.value}\n`;
        }
      }

      prompt += '\nUse these memories to personalize your responses. When the user tells you new facts or preferences, use the memory tool to save them.';
    } else {
      prompt += '\n\nWhen the user tells you facts about themselves or preferences, use the memory tool to save them for future reference.';
    }

    return prompt;
  }

  buildMessages(history: ConversationMessage[]): LLMMessage[] {
    const messages = history
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg): LLMMessage => {
        if (msg.toolCalls) {
          let parsed: unknown[];
          try { parsed = JSON.parse(msg.toolCalls) as unknown[]; }
          catch { parsed = []; }

          // Determine if this is tool_use (assistant) or tool_result (user) data
          if (msg.role === 'assistant') {
            // Assistant: tool_use blocks
            const toolCalls = parsed as ToolCall[];
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
            return { role: 'assistant', content };
          }

          // User: tool_result blocks
          const blocks = parsed as LLMContentBlock[];
          const content: LLMContentBlock[] = [];
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              content.push(block);
            }
          }
          if (content.length > 0) {
            return { role: 'user', content };
          }
          // Fallback for legacy format: treat as plain text
          return { role: 'user', content: msg.content || '' };
        }

        return { role: msg.role as 'user' | 'assistant', content: msg.content };
      });

    return this.sanitizeToolMessages(messages);
  }

  /**
   * Remove messages with orphaned tool_use or tool_result blocks.
   * This heals corrupt DB entries where tool_use/tool_result pairs were
   * broken (e.g. by partial trimming or data loss). Without this,
   * the Anthropic API rejects the entire request with a 400 error.
   */
  private sanitizeToolMessages(messages: LLMMessage[]): LLMMessage[] {
    // Collect all tool_use IDs from assistant messages
    const toolUseIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolUseIds.add(block.id);
          }
        }
      }
    }

    // Collect all tool_result IDs from user messages
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    }

    // Filter individual orphaned blocks, not entire messages.
    // This avoids cascade effects where removing a message with one
    // orphaned block also removes valid text/tool blocks.
    const result: LLMMessage[] = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }

      const filtered = msg.content.filter(block => {
        if (block.type === 'tool_use') return toolResultIds.has(block.id);
        if (block.type === 'tool_result') return toolUseIds.has(block.tool_use_id);
        return true;
      });

      // Drop message only if all content was removed
      if (filtered.length === 0) continue;
      result.push({ ...msg, content: filtered });
    }
    return result;
  }

  buildTools(skills: SkillMetadata[]): ToolDefinition[] {
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema,
    }));
  }
}
