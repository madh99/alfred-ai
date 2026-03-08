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
- **When the user's intent is clear**, ACT immediately using your tools. Don't explain what you'll do — just do it.
- **When the user's intent is unclear or ambiguous**, ASK before doing anything. This includes: files sent without instructions, vague requests, or anything where you'd have to guess what the user wants.
- **Ask before acting** on anything that changes the system: installing software, deleting files, writing to disk, running commands with side effects. Briefly confirm what you'll do and wait for the user's OK.
- Do exactly what the user asks. If the user asks for X, don't install Y instead. If you think an alternative is better, **recommend it first** and let the user decide.
- Respond in the same language the user writes in.
- Be concise. No filler text, no unnecessary explanations.
- If a tool fails or is denied, explain why and try an alternative approach.
- **If a tool call fails with the same error twice, STOP.** Tell the user what went wrong and ask how to proceed. Do NOT retry the same call.
- **If a delegate sub-agent fails or returns incomplete results, do NOT re-delegate the same task.** Analyze the failure, fix the issue yourself, and continue directly.

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

    // List available skills so the LLM knows what it can do
    if (skills && skills.length > 0) {
      prompt += '\n\n## Available tools\n';
      for (const s of skills) {
        prompt += `- **${s.name}** (${s.riskLevel}): ${s.description}\n`;
      }

      // File generation workflow hint
      if (skills.some(s => s.name === 'code_sandbox')) {
        prompt += `
## File generation (PDF, HTML, images, etc.)
To generate and send a file to the user:
1. Use \`code_sandbox\` to run code that creates the file (e.g. pdfkit for PDF, HTML generation, etc.)
2. The sandbox **automatically collects all files** written to the working directory and sends them as attachments to the user.
3. Do NOT use \`file send\` afterwards — the files are already delivered. Using \`file send\` on sandbox-generated files will fail because the sandbox runs in an isolated temp directory.
`;
      }

      // Delegation instruction: when code agents are configured, instruct the
      // LLM to delegate coding/file-editing tasks to them instead of doing it
      // via conversation or shell.
      if (skills.some(s => s.name === 'code_agent')) {
        prompt += `
## Code agent delegation
When the user asks you to **write code, edit files, fix bugs, refactor, implement features, or perform any coding task in a repository**, delegate to the \`code_agent\` tool. You are an orchestrator, not a coder.

- For **single, focused tasks**: use \`code_agent\` with \`action: "run"\` and pick the best agent.
- For **complex, multi-step tasks**: use \`code_agent\` with \`action: "orchestrate"\` — the system will decompose the task, run agents in parallel, and validate results.
- Add \`git: true\` when the user wants the changes committed, pushed, and a PR/MR created.
- Use \`action: "list_agents"\` if you're unsure which agents are available.

**Do NOT delegate to code_agent** when the task requires your own data or tools (documents, memories, emails, todos, calendar, etc.). For these tasks, use your tools directly — the code agent has no access to your skills or data.

## Data-to-file workflow
When the user asks to **collect data and produce a file** (e.g. "list all invoices in an Excel"):
1. **Gather data** using your own tools first (document search/summarize, file list, email, etc.)
2. **Generate the file** using \`code_sandbox\` — pass the collected data as variables in the code, then write the output file (Excel via exceljs, PDF via pdfkit, CSV, etc.)
3. Do NOT try to do both steps inside code_sandbox — it cannot access your documents or skills.`;
      }

      // Automation guidance: help the LLM choose between watch and scheduled_task
      if (skills.some(s => s.name === 'watch') && skills.some(s => s.name === 'scheduled_task')) {
        prompt += `
## Automation: watch vs. scheduled_task
- **"Alert me when X happens"** → use \`watch\` (polls a skill, evaluates condition, no LLM cost per check)
- **"Do X every day at 9 AM"** / **"Check X and report"** → use \`scheduled_task\` (time-based, can use LLM via prompt_template)
- For infrastructure monitoring on a schedule, use \`scheduled_task\` with \`prompt_template\` that instructs you to run the \`monitor\` tool and report only problems.`;
      }

      // Background task vs delegate guidance
      if (skills.some(s => s.name === 'background_task') && skills.some(s => s.name === 'delegate')) {
        prompt += `
## background_task vs. delegate
- **\`background_task\`**: Runs a **single skill call** asynchronously (e.g. schedule one email send, one file download). It does NOT support multi-step workflows.
- **\`delegate\`**: Runs a **multi-step sub-agent** with full tool access. Use for any task that requires multiple tool calls (search → read → process → generate).
- **NEVER use \`background_task\` for complex tasks** like "search emails and create a report" — use \`delegate\` instead.`;
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

    // Dynamic sections below — kept at the end to maximize OpenAI prefix caching
    // (static Core + Tools + Profile prefix stays identical between calls → 50% cache hit)

    // Current date/time — critical for time-based tasks (reminders, scheduling)
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
            // Ensure content is not empty — APIs reject assistant messages with empty content
            if (content.length === 0) {
              content.push({ type: 'text', text: '' });
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
   * Uses SEQUENTIAL pairing: a tool_result is valid only if its matching
   * tool_use appeared in a PRECEDING assistant message. This matches the
   * Anthropic API requirement that "each tool_result block must have a
   * corresponding tool_use block in the previous message".
   *
   * Handles: broken DB pairs, same-timestamp reordering, trimming gaps,
   * duplicate tool_use IDs, and any other data corruption.
   */
  sanitizeToolMessages(messages: LLMMessage[]): LLMMessage[] {
    // Forward scan: track tool_use IDs seen so far in assistant messages.
    // A tool_result is valid only if its tool_use_id was seen in a preceding
    // assistant message (not just anywhere in the conversation).
    const seenToolUseIds = new Set<string>();
    const validPairIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            seenToolUseIds.add(block.id);
          }
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && seenToolUseIds.has(block.tool_use_id)) {
            validPairIds.add(block.tool_use_id);
          }
        }
      }
    }

    // Filter: only keep tool_use/tool_result blocks that are in valid pairs.
    // Also deduplicate: each tool_use_id may only have ONE tool_result
    // (concurrent message processing can create duplicates in the DB).
    const emittedUseIds = new Set<string>();
    const seenResultIds = new Set<string>();
    const result: LLMMessage[] = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }

      const filtered = msg.content.filter(block => {
        if (block.type === 'tool_use') {
          if (!validPairIds.has(block.id)) return false;
          if (emittedUseIds.has(block.id)) return false;
          emittedUseIds.add(block.id);
          return true;
        }
        if (block.type === 'tool_result') {
          if (!validPairIds.has(block.tool_use_id)) return false;
          // Keep only the first tool_result per tool_use_id
          if (seenResultIds.has(block.tool_use_id)) return false;
          seenResultIds.add(block.tool_use_id);
          return true;
        }
        return true;
      });

      // Drop message only if all content was removed
      if (filtered.length === 0) continue;
      result.push({ ...msg, content: filtered });
    }

    // Merge consecutive same-role messages that may have been created by
    // dropping empty messages above.
    const merged: LLMMessage[] = [];
    for (const msg of result) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        // Merge content: normalise both to arrays then concatenate
        const prevContent = typeof prev.content === 'string'
          ? [{ type: 'text' as const, text: prev.content }]
          : prev.content;
        const curContent = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content;
        merged[merged.length - 1] = { ...prev, content: [...prevContent, ...curContent] };
      } else {
        merged.push(msg);
      }
    }
    return merged;
  }

  buildTools(skills: SkillMetadata[]): ToolDefinition[] {
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema,
    }));
  }
}
