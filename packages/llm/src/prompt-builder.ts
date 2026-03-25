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
  alfredUsername?: string;
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
  conversationSummary?: string;
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

export interface ToolResultTrimOptions {
  keepRecentPairs?: number;    // Default: 3
  maxTrimmedLength?: number;   // Default: 120 characters
  minContentLength?: number;   // Default: 300 — only trim when content ≥ this length
}

/**
 * Trim old, large tool_result blocks to a short summary.
 * The last `keepRecentPairs` tool pairs stay untouched.
 * Small results (< minContentLength) are never trimmed.
 * Pure function — does not mutate the input array.
 */
export function trimOldToolResults(
  messages: LLMMessage[],
  options?: ToolResultTrimOptions,
): LLMMessage[] {
  const keepRecent = options?.keepRecentPairs ?? 3;
  const maxLen = options?.maxTrimmedLength ?? 120;
  const minLen = options?.minContentLength ?? 300;

  // Build a map of tool_use_id → tool name from assistant messages
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
        }
      }
    }
  }

  // Count tool pairs backwards to find which ones are "recent"
  // A tool pair = user message containing tool_result blocks
  const toolResultMsgIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (msg.content.some(b => b.type === 'tool_result')) {
        toolResultMsgIndices.push(i);
      }
    }
  }

  // The last `keepRecent` tool-result messages are protected
  const protectedIndices = new Set(toolResultMsgIndices.slice(-keepRecent));

  // Build new array, trimming old large tool results
  return messages.map((msg, idx) => {
    if (protectedIndices.has(idx) || msg.role !== 'user' || !Array.isArray(msg.content)) {
      return msg;
    }

    let changed = false;
    const newContent = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;
      const content = block.content;
      if (typeof content !== 'string' || content.length < minLen) return block;

      changed = true;
      const toolName = toolNames.get(block.tool_use_id) || 'unknown';
      const firstLine = content.split('\n')[0].slice(0, maxLen);
      const prefix = block.is_error ? 'Fehler' : 'Ergebnis';
      return { ...block, content: `[${prefix}: ${toolName} — ${firstLine}]` };
    });

    return changed ? { ...msg, content: newContent } : msg;
  });
}

export class PromptBuilder {
  buildSystemPrompt(context: SystemPromptContext = {}): string {
    const { memories, skills, userProfile, todayEvents, conversationSummary } = context;
    const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '~';

    let prompt = `You are Alfred, a personal AI assistant. You run on ${os} (home: ${homeDir}).

## Core principles
- **When the user's intent is clear**, ACT immediately using your tools. Don't explain what you'll do — just do it.
- **When the user's intent is unclear or ambiguous**, ASK before doing anything. This includes: files sent without instructions, vague requests, or anything where you'd have to guess what the user wants.
- **Ask before acting** ONLY on dangerous/irreversible system changes: installing software, deleting files, running destructive commands. Briefly confirm what you'll do.
- **Do NOT ask for confirmation** when the user explicitly requests an action you can perform with your tools. This includes: creating/modifying calendar entries, setting reminders, creating todos, sending/searching emails, route calculations, file searches, web searches, running read-only commands. The user's message IS the confirmation.
- Do exactly what the user asks. If the user asks for X, don't install Y instead. If you think an alternative is better, **recommend it first** and let the user decide.
- **Use your memories** about the user proactively. If you know the user's home address, workplace, preferences, or other facts from memory, USE them automatically instead of asking. For example, if the user says "route from home to X", look up their home address from your memories.
- Respond in the same language the user writes in.
- Be concise. No filler text, no unnecessary explanations.
- **NEVER guess or estimate** facts that a tool can provide (travel times, prices, weather, dates, counts, etc.). ALWAYS call the appropriate tool first. A wrong answer is worse than a tool call.
- If a tool fails or is denied, explain why and try an alternative approach.
- **If a tool call fails with the same error twice, STOP.** Tell the user what went wrong and ask how to proceed. Do NOT retry the same call.
- **If a delegate sub-agent fails or returns incomplete results, do NOT re-delegate the same task.** Analyze the failure, fix the issue yourself, and continue directly.

## Proactive thinking
When the user mentions plans, places, times, trips, or intentions, **think ahead**:
1. **Check the calendar** for conflicts or related events (use the calendar tool for upcoming days, not just today).
2. **Cross-reference your memories** — shopping watches, children's schedules, commitments, preferences. If you know something relevant, mention it.
3. **Anticipate needs** — does the car need charging? Is there a todo deadline affected? Is there a price alert for a shop near the destination?
4. Do this **proactively without being asked**. You are not a passive assistant — you think along.

Example: User says "I'm driving to Vienna on Sunday" →
- Check calendar: Any conflicts on Sunday? Kids have activities?
- Check memories: Shopping watch active? Something to pick up in Vienna?
- Check todos: Anything due by Monday that should be done before?
- Mention what's relevant, skip what's not.

If you find nothing relevant, just answer normally — don't mention that you checked.

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
      // Received files / attachments guidance
      prompt += `
## Received files (attachments)
When the user sends a file, you'll see these markers in their message:
- \`[File received: "filename" (size, type)]\` — the file was received and saved
- \`[Saved to: /local/path]\` — saved locally; use \`file\` skill with that path
- \`[Saved to FileStore (s3): key="<key>"]\` — saved in cloud storage; use \`file\` skill with action "read_store" or "send" and path="<key>"
- \`[Document has been indexed (N chunks)]\` — use \`document\` skill with action "search" to query content

**Rules:**
- The file is ALREADY saved. Do NOT ask for a path or tell the user you can't access it.
- For FileStore keys: use \`file\` with "read_store", "list_store", "delete_store", or "send". Do NOT use local file paths.
- For indexed documents: prefer \`document\` skill with "search" to read content.
- To send a stored file back to the user: use \`file\` with action "send" and the key as path.
- To list all uploaded files: use \`file\` with action "list_store".
- If the user sends a file without instructions, briefly confirm receipt and ask what they want.
`;

      if (skills.some(s => s.name === 'code_sandbox')) {
        prompt += `
## File generation (PDF, DOCX, Excel, HTML, images, etc.)
To generate and send a file to the user:
1. Use \`code_sandbox\` to run code that creates the file. Available JS libraries (no install needed): **pdfkit** (PDF), **docx** (Word DOCX), **exceljs** (Excel XLSX), **pdf-parse** (read PDFs).
2. The sandbox **automatically collects all files** written to the working directory and sends them as attachments to the user. Files are also saved to the FileStore (S3) — the response includes \`fileStoreKeys\` for later reference.
3. Do NOT use \`file send\` afterwards — the files are already delivered. Using \`file send\` on sandbox-generated files will fail because the sandbox runs in an isolated temp directory.
4. When the user asks for a PDF, DOCX, or Excel file, ALWAYS use \`code_sandbox\` — do NOT say you can't generate files.
5. To save a file to the FileStore without generating it via code, use \`file\` with action \`write_store\`.

## Sending files via email
To attach files to an email (send, draft, or reply):
- Use the \`attachmentKeys\` parameter with an array of FileStore keys or local file paths.
- FileStore keys look like \`userId/timestamp_filename.pdf\` — get them from \`file list_store\` or from \`code_sandbox\` response (\`fileStoreKeys\`).
- Example flow: user says "send my CV to hr@company.com" → \`file list_store\` to find the key → \`email send\` with \`attachmentKeys: ["key"]\`.
- Works with send, draft, and reply actions.

## Sending files to other platforms (cross-platform messaging)
When the user asks to send a file to another platform (e.g. "schick mir meinen Lebenslauf auf Matrix"):
1. Use \`file list_store\` to find the file's FileStore key
2. Use \`cross_platform\` with action \`send_to_user\`, set \`platform\`, \`username\`, \`message\`, and \`attachment_key\` (the FileStore key)
- ALWAYS include \`platform\` parameter when the user specifies a target platform
- ALWAYS use \`attachment_key\` for files — do NOT paste file content into the \`message\` field
- If sending to yourself on another platform ("schick mir", "sende mir", "an mich"), use your own Alfred username (from \`whoami\`) as \`username\`. Words like "mir", "mich", "me", "myself" mean self-send — do NOT ask for the username.
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
## Automation: watch vs. scheduled_task vs. reminder
- **"Alert me when X happens"** → use \`watch\` (polls a skill, evaluates condition, no LLM cost per check)
- **"If X then do Y"** → use \`watch\` with \`action_skill_name\` + \`action_skill_params\` (e.g. price < 15ct → switch on wallbox via home_assistant)
- **"Do X every day at 9 AM"** / **"Check X and report"** / **"Do X in 5 minutes"** → use \`scheduled_task\` (time-based, can use LLM via prompt_template, can execute any skill)
- **"Remind me to X"** → use \`reminder\` ONLY for simple text reminders that just send a notification message
- **IMPORTANT:** When the user asks to **execute a task** at a future time (e.g. "führe ein Briefing in 2 Minuten aus", "run a backup at 9 PM"), ALWAYS use \`scheduled_task\` with \`prompt_template\`, NOT \`reminder\`. Reminders cannot execute skills or call the LLM.
- For infrastructure monitoring on a schedule, use \`scheduled_task\` with \`prompt_template\` that instructs you to run the \`monitor\` tool and report only problems.
- **IMPORTANT:** When creating a scheduled briefing task, use \`skill_name: "briefing"\` with \`skill_input: {"action":"run"}\` instead of \`prompt_template\`. This executes the briefing directly without LLM overhead.`;
      }

      // Direct skill calls vs delegate guidance
      if (skills.some(s => s.name === 'delegate')) {
        prompt += `
## IMPORTANT: Direct skill calls vs. delegate
- **Always prefer calling a skill DIRECTLY** when a single skill call can answer the user's request.
- Example WRONG: User asks "Zeig Ladevorgänge" → delegate with BMW skill. Example RIGHT: Call BMW skill directly.
- Example WRONG: User asks "Wie ist das Wetter?" → delegate with weather skill. Example RIGHT: Call weather skill directly.
- **\`delegate\`**: ONLY use when the task requires **iterative work** — multiple rounds of tool calls with intermediate reasoning (e.g. research → analyze → synthesize, or searching emails across multiple queries).
- A single data lookup, status check, or simple action is NEVER a reason to delegate.`;
      }

      // Background task guidance
      if (skills.some(s => s.name === 'background_task')) {
        prompt += `
## background_task
- **\`background_task\`**: Runs a **single skill call** asynchronously (e.g. schedule one email send, one file download). It does NOT support multi-step workflows.
- For complex tasks requiring multiple different skill calls in sequence, use \`delegate\` instead.`;
      }
    }

    // User profile section
    if (userProfile) {
      prompt += '\n\n## User profile';
      if (userProfile.displayName) {
        prompt += `\n- Name: ${userProfile.displayName}`;
      }
      if (userProfile.alfredUsername) {
        prompt += `\n- Alfred Username: ${userProfile.alfredUsername} (use this as "username" for send_to_user when sending to yourself)`;
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

    if (conversationSummary) {
      prompt += '\n\n## Conversation context\n';
      prompt += conversationSummary;
      prompt += '\n\nThis summarizes the earlier conversation. Use it to maintain continuity. The most recent messages follow below.';
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
          feedback: 'Behavior Feedback',
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

    // Final validation: ensure strict alternating user/assistant pattern.
    // If a user message with tool_result content is followed by another user
    // message (orphaned from a failed LLM call), insert a synthetic assistant
    // response to maintain the required alternation.
    const validated: LLMMessage[] = [];
    for (let i = 0; i < merged.length; i++) {
      const msg = merged[i];
      const prev = validated[validated.length - 1];

      // Detect two consecutive user messages
      if (prev && prev.role === 'user' && msg.role === 'user') {
        // Insert synthetic assistant response
        validated.push({ role: 'assistant', content: '(previous request failed)' });
      }

      // Detect assistant[tool_use] followed by user[text] (not tool_result)
      // This means the tool execution was never completed — drop the tool_use
      if (prev && prev.role === 'assistant' && Array.isArray(prev.content) && msg.role === 'user') {
        const hasToolUse = prev.content.some(b => b.type === 'tool_use');
        const hasToolResult = Array.isArray(msg.content) && msg.content.some((b: any) => b.type === 'tool_result');
        if (hasToolUse && !hasToolResult) {
          // Replace the tool_use assistant message with a text-only version
          const textOnly = prev.content.filter(b => b.type === 'text');
          validated[validated.length - 1] = {
            role: 'assistant',
            content: textOnly.length > 0 ? textOnly : '(tool execution failed)',
          };
        }
      }

      // Detect assistant with tool_use at the very end (no tool_result follows)
      if (i === merged.length - 1 && msg.role === 'assistant' && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(b => b.type === 'tool_use');
        if (hasToolUse) {
          // Replace with text-only content
          const textOnly = (msg.content as any[]).filter(b => b.type === 'text');
          validated.push({
            role: 'assistant',
            content: textOnly.length > 0 ? textOnly : '(tool execution incomplete)',
          });
          continue;
        }
      }

      validated.push(msg);
    }

    return validated;
  }

  buildTools(skills: SkillMetadata[]): ToolDefinition[] {
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema,
    }));
  }
}
