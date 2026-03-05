import fs from 'node:fs';
import path from 'node:path';
import type {
  NormalizedMessage,
  LLMResponse,
  LLMMessage,
  LLMContentBlock,
  ToolCall,
  SkillContext,
  SkillResultAttachment,
  Attachment,
} from '@alfred/types';
import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import { PromptBuilder, estimateTokens, estimateMessageTokens } from '@alfred/llm';
import type { UserRepository, MemoryRepository } from '@alfred/storage';
import type { SecurityManager } from '@alfred/security';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';
import type { SpeechTranscriber } from './speech-transcriber.js';
import type { EmbeddingService } from './embedding-service.js';
import type { ActiveLearningService } from './active-learning/active-learning-service.js';
import type { MemoryRetriever } from './active-learning/memory-retriever.js';
import { buildSkillContext } from './context-factory.js';
import { selectCategories, filterSkills } from './skill-filter.js';

const MAX_TOOL_DURATION_MS = 15 * 60 * 1000; // 15 minutes timeout for tool loop
const MAX_TOOL_ITERATIONS = 50; // Abort tool loop after N iterations
const MAX_REPEATED_ERRORS = 2; // Abort tool loop after N identical consecutive errors
const TOKEN_BUDGET_RATIO = 0.85; // Use at most 85% of input window for context
const MAX_INLINE_FILE_SIZE = 100_000; // Include text file content inline up to 100KB
const MEMORY_TOKEN_BUDGET = 2000; // Max tokens for all memories in system prompt
const MIN_MEMORY_SCORE = 0.1; // Minimum relevance score for memory inclusion
const TOOL_LOOP_KEEP_RECENT = 3; // Keep last N tool pairs uncompressed during re-trimming

export type ProgressCallback = (status: string) => void;

export interface PipelineResult {
  text: string;
  attachments?: SkillResultAttachment[];
}

export interface PipelineOptions {
  llm: LLMProvider;
  conversationManager: ConversationManager;
  users: UserRepository;
  logger: Logger;
  skillRegistry?: SkillRegistry;
  skillSandbox?: SkillSandbox;
  securityManager?: SecurityManager;
  memoryRepo?: MemoryRepository;
  speechTranscriber?: SpeechTranscriber;
  inboxPath?: string;
  embeddingService?: EmbeddingService;
  activeLearning?: ActiveLearningService;
  memoryRetriever?: MemoryRetriever;
  maxHistoryMessages?: number;
}

/** Tracks a running delegate agent so other messages can query its status. */
interface ActiveAgent {
  chatId: string;
  task: string;
  tracker: import('@alfred/skills').ActivityTracker;
  startedAt: number;
}

export class MessagePipeline {
  private readonly promptBuilder: PromptBuilder;
  private readonly llm: LLMProvider;
  private readonly conversationManager: ConversationManager;
  private readonly users: UserRepository;
  private readonly logger: Logger;
  private readonly skillRegistry?: SkillRegistry;
  private readonly skillSandbox?: SkillSandbox;
  private readonly securityManager?: SecurityManager;
  private readonly memoryRepo?: MemoryRepository;
  private readonly speechTranscriber?: SpeechTranscriber;
  private readonly inboxPath?: string;
  private readonly embeddingService?: EmbeddingService;
  private readonly activeLearning?: ActiveLearningService;
  private readonly memoryRetriever?: MemoryRetriever;
  private readonly maxHistoryMessages: number;

  /** Registry of currently running delegate agents, keyed by a unique agent ID. */
  private readonly activeAgents = new Map<string, ActiveAgent>();
  private agentIdCounter = 0;

  constructor(options: PipelineOptions) {
    this.llm = options.llm;
    this.conversationManager = options.conversationManager;
    this.users = options.users;
    this.logger = options.logger;
    this.skillRegistry = options.skillRegistry;
    this.skillSandbox = options.skillSandbox;
    this.securityManager = options.securityManager;
    this.memoryRepo = options.memoryRepo;
    this.speechTranscriber = options.speechTranscriber;
    this.inboxPath = options.inboxPath;
    this.embeddingService = options.embeddingService;
    this.activeLearning = options.activeLearning;
    this.memoryRetriever = options.memoryRetriever;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 100;
    this.promptBuilder = new PromptBuilder();
  }

  async process(message: NormalizedMessage, onProgress?: ProgressCallback): Promise<PipelineResult> {
    const startTime = Date.now();
    this.logger.info({ platform: message.platform, userId: message.userId, chatId: message.chatId }, 'Processing message');

    try {
      // 1. Resolve user, master ID, and linked platform IDs via central factory
      const { user, masterUserId, linkedPlatformUserIds, context: baseContext } = buildSkillContext(
        this.users,
        {
          platformUserId: message.userId,
          platform: message.platform,
          chatId: message.chatId,
          chatType: message.chatType,
          userName: message.userName,
          displayName: message.displayName,
        },
      );

      // 2. Find or create conversation
      const conversation = this.conversationManager.getOrCreateConversation(
        message.platform,
        message.chatId,
        user.id,
      );

      // 3. Load conversation history (fetch generously, we'll trim by tokens later)
      const history = this.conversationManager.getHistory(conversation.id, this.maxHistoryMessages);

      // 4. Save user message
      this.conversationManager.addMessage(conversation.id, 'user', message.text);

      // 5. Load user memories for prompt injection (hybrid retrieval or fallback)
      //    Uses masterUserId so linked cross-platform accounts share memories.
      //    Skip memory loading entirely for media without captions (files, images) to avoid
      //    context contamination from irrelevant memories. Voice messages still load memories
      //    because the transcribed audio is the real user content.
      let memories: { key: string; value: string; category: string; type?: string; score?: number }[] | undefined;
      const syntheticInput = this.isSyntheticLabel(message.text);
      const hasAudioAttachment = message.attachments?.some(a => a.type === 'audio') ?? false;
      const skipMemories = syntheticInput && !hasAudioAttachment;
      if (this.memoryRetriever && message.text && !skipMemories) {
        try {
          memories = await this.memoryRetriever.retrieve(masterUserId, message.text, 15, linkedPlatformUserIds);
        } catch (err) { this.logger.debug({ err }, 'Hybrid memory retrieval failed'); }
      }
      if (!memories && this.memoryRepo && !skipMemories) {
        try {
          // Build all user IDs for cross-platform memory access
          const memUserIds = [masterUserId, ...(linkedPlatformUserIds ?? []).filter(id => id !== masterUserId)];
          if (this.embeddingService && message.text && this.llm.supportsEmbeddings()) {
            // Use semantic search: top-10 relevant + 5 newest across all linked IDs
            const seen = new Set<string>();
            memories = [];
            for (const uid of memUserIds) {
              for (const m of await this.embeddingService.semanticSearch(uid, message.text, 10)) {
                if (!seen.has(m.key)) { seen.add(m.key); memories.push(m); }
              }
            }
            for (const uid of memUserIds) {
              for (const m of this.memoryRepo.getRecentForPrompt(uid, 5)) {
                if (!seen.has(m.key)) { seen.add(m.key); memories.push(m); }
              }
            }
          } else {
            const seen = new Set<string>();
            memories = [];
            for (const uid of memUserIds) {
              for (const m of this.memoryRepo.getRecentForPrompt(uid, 20)) {
                if (!seen.has(m.key)) { seen.add(m.key); memories.push(m); }
              }
            }
          }
        } catch (err) { this.logger.debug({ err }, 'Memory loading failed'); }
      }

      // 5a. Apply memory token budget: filter low-relevance and cap by token count
      if (memories && memories.length > 0) {
        memories = this.applyMemoryBudget(memories);
      }

      // 5b. Load user profile for prompt injection
      let userProfile: import('@alfred/llm').UserProfile | undefined;
      try {
        if ('getProfile' in this.users) {
          userProfile = (this.users as { getProfile(id: string): import('@alfred/llm').UserProfile | undefined }).getProfile(masterUserId);
          if (userProfile && !userProfile.displayName) {
            userProfile.displayName = user.displayName ?? user.username;
          }
        }
      } catch (err) { this.logger.debug({ err }, 'Profile loading failed'); }

      // 5c. Timezone already resolved by buildSkillContext
      const resolvedTimezone = baseContext.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

      // 6. Build tools and LLM request with token-aware context trimming
      //    Filter skills by category keywords in the user message to avoid
      //    sending all 30+ tool schemas in every request.
      const allSkillMetas = this.skillRegistry
        ? this.skillRegistry.getAll().map(s => s.metadata)
        : undefined;
      let skillMetas = allSkillMetas;
      if (allSkillMetas && message.text) {
        const availableCategories = new Set(allSkillMetas.map(s => s.category ?? 'core' as const));
        const selectedCategories = selectCategories(message.text, availableCategories);
        skillMetas = filterSkills(allSkillMetas, selectedCategories);
      }
      const tools = skillMetas
        ? this.promptBuilder.buildTools(skillMetas)
        : undefined;
      let system = this.promptBuilder.buildSystemPrompt({
        memories,
        skills: skillMetas,
        userProfile,
      });

      // Inject active agent status so the LLM can answer "what is the agent doing?"
      const agentStatusBlock = this.buildActiveAgentStatus();
      if (agentStatusBlock) {
        system += '\n\n' + agentStatusBlock;
      }
      const rawMessages: LLMMessage[] = this.promptBuilder.buildMessages(history);

      // Collapse repeated tool-error loops (e.g. 68x the same file.write failure)
      // into a single representative pair + a note, to avoid wasting the context window.
      const allMessages = this.collapseRepeatedToolErrors(rawMessages);

      // Build user message with attachments (images, transcribed audio)
      const userContent = await this.buildUserContent(message, onProgress);
      allMessages.push({ role: 'user', content: userContent });

      // Estimate tokens consumed by tool definitions (skill schemas)
      const toolTokens = tools
        ? estimateTokens(JSON.stringify(tools))
        : 0;

      // Trim with retry: if the API rejects as "prompt is too long",
      // re-trim with a tighter budget and retry (up to 3 times).
      let budgetMultiplier = 1.0;
      let messages = this.trimToContextWindow(system, allMessages, toolTokens, budgetMultiplier);

      // 7. Agentic tool-use loop (timeout-based + repeated-error detection)
      let response: LLMResponse;
      let iteration = 0;
      const toolLoopStart = Date.now();
      let lastErrorSignature = '';
      let consecutiveErrors = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const pendingAttachments: SkillResultAttachment[] = [];
      onProgress?.('Thinking...');

      while (true) {
        // Re-trim if tool loop has grown beyond the context budget
        if (iteration > 0) {
          this.compressToolLoop(messages, system, toolTokens);
        }

        try {
          response = await this.llm.complete({
            messages,
            system,
            tools: tools && tools.length > 0 ? tools : undefined,
          });
          totalInputTokens += response.usage?.inputTokens ?? 0;
          totalOutputTokens += response.usage?.outputTokens ?? 0;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('prompt is too long') && budgetMultiplier > 0.3) {
            budgetMultiplier *= 0.5;
            this.logger.warn({ budgetMultiplier }, 'Prompt too long, retrimming with reduced budget');
            messages = this.trimToContextWindow(system, allMessages, toolTokens, budgetMultiplier);
            continue;
          }
          throw err;
        }

        // If no tool calls, we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        // Timeout check
        const elapsed = Date.now() - toolLoopStart;
        if (elapsed >= MAX_TOOL_DURATION_MS) {
          const elapsedMin = Math.round(elapsed / 60_000);
          this.logger.warn({ iteration, elapsedMin, pendingToolCalls: response.toolCalls.length }, 'Tool loop timeout reached');
          response = await this.abortToolLoop(
            messages, response, conversation.id, system,
            `Das Zeitlimit von ${elapsedMin} Minuten für Tool-Aufrufe wurde erreicht.`,
          );
          break;
        }

        // Iteration cap check
        if (iteration >= MAX_TOOL_ITERATIONS) {
          this.logger.warn({ iteration, pendingToolCalls: response.toolCalls.length }, 'Tool loop iteration cap reached');
          response = await this.abortToolLoop(
            messages, response, conversation.id, system,
            `Das Iterationslimit von ${MAX_TOOL_ITERATIONS} Tool-Aufrufen wurde erreicht.`,
          );
          break;
        }

        iteration++;
        this.logger.info({ iteration, toolCalls: response.toolCalls.length }, 'Processing tool calls');

        // Build assistant message with text + tool_use blocks
        const assistantContent: LLMContentBlock[] = [];
        if (response.content) {
          assistantContent.push({ type: 'text', text: response.content });
        }
        for (const tc of response.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // Execute tool calls in parallel
        const toolExecResult = await this.executeToolCallsParallel(
          response.toolCalls,
          { ...baseContext, conversationId: conversation.id, timezone: resolvedTimezone },
          onProgress,
        );
        const toolResultBlocks = toolExecResult.blocks;
        if (toolExecResult.attachments.length > 0) {
          pendingAttachments.push(...toolExecResult.attachments);
        }

        // Save intermediate tool interaction to DB so follow-up questions have context.
        this.conversationManager.addMessage(
          conversation.id, 'assistant', response.content ?? '', JSON.stringify(response.toolCalls),
        );
        this.conversationManager.addMessage(
          conversation.id, 'user', '', JSON.stringify(toolResultBlocks),
        );

        // Detect repeated identical errors: build a signature from error results
        const errorSignature = this.buildErrorSignature(toolResultBlocks);
        if (errorSignature) {
          if (errorSignature === lastErrorSignature) {
            consecutiveErrors++;
          } else {
            consecutiveErrors = 1;
            lastErrorSignature = errorSignature;
          }

          if (consecutiveErrors >= MAX_REPEATED_ERRORS) {
            this.logger.warn(
              { iteration, consecutiveErrors, errorSignature },
              'Tool loop aborted: same error repeated consecutively',
            );
            response = await this.abortToolLoop(
              messages, response, conversation.id, system,
              `Der gleiche Tool-Fehler ist ${consecutiveErrors}x hintereinander aufgetreten: "${lastErrorSignature.slice(0, 200)}". Erkläre dem User kurz was nicht funktioniert hat und schlage eine Alternative vor.`,
              true,
            );
            break;
          }
        } else {
          // Successful tool call — reset error tracking
          consecutiveErrors = 0;
          lastErrorSignature = '';
        }

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResultBlocks });
        onProgress?.('Thinking...');
      }

      // Use the final response content, or fall back to the last assistant text
      // from a previous tool iteration (the LLM may have already answered inline
      // with a tool_use and then returned empty content after the tool_result).
      let responseText = response.content;
      if (!responseText) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const textBlock = msg.content.find(b => b.type === 'text');
            if (textBlock && 'text' in textBlock && textBlock.text) {
              responseText = textBlock.text;
              break;
            }
          }
        }
      }
      if (!responseText) responseText = '(no response)';

      // 8. Save final assistant response
      this.conversationManager.addMessage(
        conversation.id,
        'assistant',
        responseText,
      );

      // 9. Active learning: extract memories from conversation (fire-and-forget)
      if (this.activeLearning) {
        this.activeLearning.onMessageProcessed(masterUserId, message.text, responseText);
      }

      const duration = Date.now() - startTime;
      this.logger.info(
        {
          duration,
          tokens: response.usage,
          totalTokens: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          stopReason: response.stopReason,
          toolIterations: iteration,
        },
        'Message processed',
      );

      return {
        text: responseText,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      };
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to process message');
      throw error;
    }
  }

  /**
   * Abort the tool loop: inject synthetic tool_results for pending calls,
   * persist to DB, and ask the LLM to produce a user-facing summary.
   */
  private async abortToolLoop(
    messages: LLMMessage[],
    response: LLMResponse,
    conversationId: string,
    system: string,
    reason: string,
    assistantAlreadyPushed = false,
  ): Promise<LLMResponse> {
    if (!assistantAlreadyPushed) {
      const assistantContent: LLMContentBlock[] = [];
      if (response.content) {
        assistantContent.push({ type: 'text', text: response.content });
      }
      for (const tc of response.toolCalls!) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });
    }

    const syntheticResults: LLMContentBlock[] = response.toolCalls!.map(tc => ({
      type: 'tool_result' as const,
      tool_use_id: tc.id,
      content: `Error: tool loop aborted — ${reason}`,
      is_error: true,
    }));
    messages.push({ role: 'user', content: syntheticResults });

    // Persist to DB so the pair is complete.
    // Only save the assistant message if it wasn't already saved by the main loop.
    if (!assistantAlreadyPushed) {
      this.conversationManager.addMessage(
        conversationId, 'assistant', response.content ?? '', JSON.stringify(response.toolCalls),
      );
    }
    this.conversationManager.addMessage(
      conversationId, 'user', '', JSON.stringify(syntheticResults),
    );

    // Ask the LLM to summarize for the user.
    // Append the system instruction to the last user message (which contains
    // synthetic tool_results) instead of pushing a second consecutive 'user'
    // message — Gemini rejects two consecutive same-role turns.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content.push({
        type: 'text' as const,
        text: `[System: ${reason} Fasse dem User kurz zusammen was du bisher geschafft hast und was noch offen ist.]`,
      } as LLMContentBlock);
    } else {
      messages.push({
        role: 'user',
        content: `[System: ${reason} Fasse dem User kurz zusammen was du bisher geschafft hast und was noch offen ist.]`,
      });
    }
    return await this.llm.complete({ messages, system });
  }

  /**
   * Build a signature string from error tool_result blocks.
   * Returns empty string if no errors (= all tools succeeded).
   */
  private buildErrorSignature(toolResultBlocks: LLMContentBlock[]): string {
    const errors: string[] = [];
    for (const block of toolResultBlocks) {
      if (block.type === 'tool_result' && block.is_error) {
        errors.push(block.content);
      }
    }
    return errors.length > 0 ? errors.join('|') : '';
  }

  /**
   * Collapse runs of identical tool-error pairs into a single representative pair.
   * When the LLM called the same tool with the same broken input N times in a row,
   * keep only the first pair and replace the rest with a short note.
   * This prevents old error loops from filling the entire context window.
   */
  private collapseRepeatedToolErrors(messages: LLMMessage[]): LLMMessage[] {
    const result: LLMMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      // Detect assistant tool_use message
      if (msg.role === 'assistant' && Array.isArray(msg.content) &&
          msg.content.some(b => b.type === 'tool_use')) {
        // Check if next message is a user tool_result with errors
        const next = i + 1 < messages.length ? messages[i + 1] : null;
        if (next && next.role === 'user' && Array.isArray(next.content) &&
            next.content.every(b => b.type === 'tool_result' && b.is_error)) {

          // Build a signature for this error pair
          const sig = this.toolPairSignature(msg, next);

          // Count how many consecutive identical error pairs follow
          let runLength = 1;
          let j = i + 2;
          while (j + 1 < messages.length) {
            const nextAssistant = messages[j];
            const nextUser = messages[j + 1];
            if (nextAssistant.role === 'assistant' && nextUser?.role === 'user' &&
                this.toolPairSignature(nextAssistant, nextUser) === sig) {
              runLength++;
              j += 2;
            } else {
              break;
            }
          }

          if (runLength > 1) {
            // Keep only the first pair + a note about the repetitions.
            // The note is a 'user' message so that we don't create two
            // consecutive 'assistant' turns (Gemini rejects that).
            result.push(msg);
            result.push(next);
            result.push({
              role: 'user',
              content: `[System: The above tool error repeated ${runLength} times with identical input. The loop was aborted.]`,
            });
            i = j; // Skip all repeated pairs
            continue;
          }
        }
      }

      result.push(msg);
      i++;
    }
    return result;
  }

  /**
   * Build a stable signature for a tool_use + tool_result pair for deduplication.
   */
  private toolPairSignature(assistant: LLMMessage, user: LLMMessage): string {
    const toolUses = Array.isArray(assistant.content)
      ? assistant.content.filter(b => b.type === 'tool_use').map(b => `${b.name}:${JSON.stringify(b.input)}`).join(',')
      : '';
    const toolResults = Array.isArray(user.content)
      ? user.content.filter(b => b.type === 'tool_result').map(b => b.content).join(',')
      : '';
    return `${toolUses}|${toolResults}`;
  }

  private async executeToolCallsParallel(
    toolCalls: ToolCall[],
    context: SkillContext,
    onProgress?: ProgressCallback,
  ): Promise<{ blocks: LLMContentBlock[]; attachments: SkillResultAttachment[] }> {
    const allAttachments: SkillResultAttachment[] = [];

    const buildBlock = (
      tc: ToolCall,
      result: { content: string; isError?: boolean; attachments?: SkillResultAttachment[] },
    ): LLMContentBlock => {
      let content = result.content;
      if (result.attachments && result.attachments.length > 0) {
        allAttachments.push(...result.attachments);
        const names = result.attachments.map(a => a.fileName).join(', ');
        content += `\n\n[${result.attachments.length} Datei(en) werden dem User gesendet: ${names}]`;
      }
      return {
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content,
        is_error: result.isError,
      };
    };

    // For single tool call, run directly (no overhead)
    if (toolCalls.length === 1) {
      const tc = toolCalls[0];
      const toolLabel = this.getToolLabel(tc.name, tc.input);
      onProgress?.(toolLabel);
      const result = await this.executeToolCall(tc, context, onProgress);
      return { blocks: [buildBlock(tc, result)], attachments: allAttachments };
    }

    // Multiple tool calls: execute in parallel
    onProgress?.(`Running ${toolCalls.length} tools in parallel...`);

    const results = await Promise.allSettled(
      toolCalls.map(tc => this.executeToolCall(tc, context, onProgress))
    );

    const blocks = toolCalls.map((tc, i) => {
      const settled = results[i];
      if (settled.status === 'fulfilled') {
        return buildBlock(tc, settled.value);
      } else {
        return {
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: `Tool execution failed: ${settled.reason}`,
          is_error: true,
        };
      }
    });

    return { blocks, attachments: allAttachments };
  }

  private async executeToolCall(
    toolCall: ToolCall,
    context: SkillContext,
    onProgress?: ProgressCallback,
  ): Promise<{ content: string; isError?: boolean; attachments?: SkillResultAttachment[] }> {
    const skill = this.skillRegistry?.get(toolCall.name);
    if (!skill) {
      this.logger.warn({ tool: toolCall.name }, 'Unknown skill requested');
      return { content: `Error: Unknown tool "${toolCall.name}"`, isError: true };
    }

    // Security check
    if (this.securityManager) {
      const evaluation = this.securityManager.evaluate({
        userId: context.userId,
        action: toolCall.name,
        riskLevel: skill.metadata.riskLevel,
        platform: context.platform,
        chatId: context.chatId,
        chatType: context.chatType,
      });

      if (!evaluation.allowed) {
        this.logger.warn(
          { tool: toolCall.name, reason: evaluation.reason, rule: evaluation.matchedRule?.id },
          'Skill execution denied by security rules',
        );
        return {
          content: `Access denied: ${evaluation.reason}`,
          isError: true,
        };
      }
    }

    // Execute via sandbox
    if (this.skillSandbox) {
      // For delegate skill: create per-invocation tracker and pass via context
      let tracker: import('@alfred/skills').ActivityTracker | undefined;
      let agentId: string | undefined;
      if (toolCall.name === 'delegate') {
        const { ActivityTracker } = await import('@alfred/skills');
        tracker = new ActivityTracker(onProgress);

        // Register so other messages can query the agent's status
        agentId = `agent-${++this.agentIdCounter}`;
        this.activeAgents.set(agentId, {
          chatId: context.chatId,
          task: String(toolCall.input.task ?? '').slice(0, 200),
          tracker,
          startedAt: Date.now(),
        });
      }

      // Pass tracker and onProgress via context
      const execContext = toolCall.name === 'delegate'
        ? { ...context, tracker, onProgress }
        : onProgress
          ? { ...context, onProgress }
          : context;

      try {
        const result = await this.skillSandbox.execute(skill, toolCall.input, execContext, undefined, tracker);
        return {
          content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
          isError: !result.success,
          attachments: result.attachments,
        };
      } finally {
        if (agentId) {
          this.activeAgents.delete(agentId);
        }
      }
    }

    // Fallback: direct execution without sandbox
    try {
      const result = await skill.execute(toolCall.input, context);
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
        attachments: result.attachments,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Skill execution failed: ${msg}`, isError: true };
    }
  }

  private getToolLabel(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'shell': return `Running: ${String(input.command ?? '').slice(0, 60)}`;
      case 'web_search': return `Searching: ${String(input.query ?? '')}`;
      case 'email': return `Email: ${String(input.action ?? '')}`;
      case 'memory': return `Memory: ${String(input.action ?? '')}`;
      case 'reminder': return `Reminder: ${String(input.action ?? '')}`;
      case 'calculator': return `Calculating...`;
      case 'system_info': return `Getting system info...`;
      case 'delegate': return `Delegating sub-task...`;
      case 'http': return `Fetching: ${String(input.url ?? '').slice(0, 60)}`;
      case 'file': return `File: ${String(input.action ?? '')} ${String(input.path ?? '').slice(0, 50)}`;
      case 'clipboard': return `Clipboard: ${String(input.action ?? '')}`;
      case 'screenshot': return `Taking screenshot...`;
      case 'browser': return `Browser: ${String(input.action ?? '')} ${String(input.url ?? '').slice(0, 50)}`;
      case 'weather': return `Weather: ${String(input.location ?? '')}`;
      case 'note': return `Note: ${String(input.action ?? '')}`;
      case 'profile': return `Profile: ${String(input.action ?? '')}`;
      case 'calendar': return `Calendar: ${String(input.action ?? '')}`;
      case 'background_task': return `Background task: ${String(input.action ?? '')}`;
      case 'scheduled_task': return `Scheduled task: ${String(input.action ?? '')}`;
      case 'cross_platform': return `Cross-platform: ${String(input.action ?? '')}`;
      case 'code_sandbox': return `Running code...`;
      case 'document': return `Document: ${String(input.action ?? '')}`;
      default: return `Using ${toolName}...`;
    }
  }

  /**
   * Build a status block describing currently running delegate agents.
   * Injected into the system prompt so the LLM can answer user questions
   * like "What is the agent doing right now?".
   */
  private buildActiveAgentStatus(): string | undefined {
    if (this.activeAgents.size === 0) return undefined;

    const lines: string[] = ['## Currently running sub-agents'];
    for (const [id, agent] of this.activeAgents) {
      const snapshot = agent.tracker.getSnapshot();
      const elapsedSec = Math.round(snapshot.totalElapsedMs / 1000);
      lines.push(
        `- **${id}**: "${agent.task}"`,
        `  Status: ${agent.tracker.formatStatus()}`,
        `  Running for ${elapsedSec}s | Last activity ${Math.round(snapshot.idleMs / 1000)}s ago`,
      );
    }
    lines.push('');
    lines.push('If the user asks what you or the agent is doing, describe the above status in natural language.');

    return lines.join('\n');
  }

  /**
   * Filter memories by relevance score and cap total token usage.
   * Memories are already sorted by score (highest first) from the retriever.
   */
  private applyMemoryBudget(
    memories: { key: string; value: string; category: string; type?: string; score?: number }[],
  ): typeof memories {
    // Filter by minimum relevance score (only when scores are present)
    const hasScores = memories.some(m => m.score != null && m.score > 0);
    let filtered = memories;
    if (hasScores) {
      filtered = memories.filter(m => (m.score ?? 1) >= MIN_MEMORY_SCORE);
    }

    // Apply token budget: keep highest-scored memories until budget exhausted
    let tokenCount = 0;
    const budgeted: typeof memories = [];
    for (const m of filtered) {
      const memTokens = estimateTokens(`[${m.category}] ${m.key}: ${m.value}`);
      if (tokenCount + memTokens > MEMORY_TOKEN_BUDGET) break;
      tokenCount += memTokens;
      budgeted.push(m);
    }

    if (budgeted.length < memories.length) {
      this.logger.info(
        { original: memories.length, kept: budgeted.length, tokenCount, droppedByScore: memories.length - filtered.length },
        'Memory budget applied',
      );
    }

    return budgeted;
  }

  /**
   * Compress older tool interactions when the tool loop exceeds the context budget.
   * Keeps the last TOOL_LOOP_KEEP_RECENT tool pairs intact and summarizes the rest.
   * Modifies the messages array in-place.
   */
  private compressToolLoop(messages: LLMMessage[], system: string, toolTokens = 0): void {
    const contextWindow = this.llm.getContextWindow();
    const maxInputTokens = Math.floor(contextWindow.maxInputTokens * TOKEN_BUDGET_RATIO);
    const systemTokens = estimateTokens(system) + toolTokens;
    const totalTokens = systemTokens + messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    if (totalTokens <= maxInputTokens) return;

    // Find all tool pairs (assistant with tool_use + user with tool_result)
    const toolPairs: { start: number; end: number }[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      const next = messages[i + 1];
      if (msg.role === 'assistant' && Array.isArray(msg.content) &&
          msg.content.some(b => b.type === 'tool_use') &&
          next.role === 'user' && Array.isArray(next.content) &&
          next.content.some(b => b.type === 'tool_result')) {
        toolPairs.push({ start: i, end: i + 1 });
      }
    }

    if (toolPairs.length <= TOOL_LOOP_KEEP_RECENT) return;

    // Compress all but the last TOOL_LOOP_KEEP_RECENT pairs
    const compressUpTo = toolPairs.length - TOOL_LOOP_KEEP_RECENT;
    const toCompress = toolPairs.slice(0, compressUpTo);

    const summaryLines: string[] = [];
    for (const pair of toCompress) {
      const assistantMsg = messages[pair.start];
      const toolNames: string[] = [];
      if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content) {
          if (block.type === 'tool_use') toolNames.push(block.name);
        }
      }
      const resultMsg = messages[pair.end];
      let status = 'ok';
      if (Array.isArray(resultMsg.content)) {
        const hasError = resultMsg.content.some(b => b.type === 'tool_result' && b.is_error);
        if (hasError) status = 'error';
      }
      summaryLines.push(`- ${toolNames.join(', ')}: ${status}`);
    }

    // Replace compressed pairs with an assistant+user pair to maintain alternation
    const firstIdx = toCompress[0].start;
    const lastIdx = toCompress[toCompress.length - 1].end;
    const removeCount = lastIdx - firstIdx + 1;

    messages.splice(firstIdx, removeCount,
      { role: 'assistant', content: `[Earlier tool interactions compressed (${toCompress.length} pairs):\n${summaryLines.join('\n')}\n]` },
      { role: 'user', content: '[Context compressed to fit context window. Continue with the current task.]' },
    );

    this.logger.info(
      { compressedPairs: toCompress.length, removedMessages: removeCount - 2 },
      'Compressed tool loop to fit context window',
    );
  }

  /**
   * Trim messages to fit within the LLM's context window.
   * Groups tool_use/tool_result pairs as atomic units so they are never
   * split during trimming. Drops oldest groups first.
   * When messages are trimmed, builds a compact summary of the dropped
   * messages so the LLM retains conversational context.
   */
  private trimToContextWindow(system: string, messages: LLMMessage[], toolTokens = 0, budgetMultiplier = 1.0): LLMMessage[] {
    const contextWindow = this.llm.getContextWindow();
    const maxInputTokens = Math.floor(contextWindow.maxInputTokens * TOKEN_BUDGET_RATIO * budgetMultiplier);

    const systemTokens = estimateTokens(system) + toolTokens;
    // Always keep the latest message (current user input)
    const latestMsg = messages[messages.length - 1];
    const latestTokens = estimateMessageTokens(latestMsg);

    // Reserve tokens for system + latest message + output buffer + summary
    const summaryBudget = 500; // tokens reserved for the trimmed-context summary
    const reservedTokens = systemTokens + latestTokens + 200 + summaryBudget;
    let availableTokens = maxInputTokens - reservedTokens;

    if (availableTokens <= 0) {
      // Even a single message barely fits — just send the latest
      this.logger.warn({ maxInputTokens, systemTokens, latestTokens }, 'Context window very tight, sending only latest message');
      return [latestMsg];
    }

    // Group history into atomic units (tool_use + tool_result stay together)
    const history = messages.slice(0, -1);
    const groups = this.groupToolPairs(history);

    // Walk backwards through groups, keeping the most recent that fit
    const keptGroups: LLMMessage[][] = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const groupTokens = groups[i].reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
      if (groupTokens > availableTokens) break;
      availableTokens -= groupTokens;
      keptGroups.unshift(groups[i]);
    }

    const keptMessages = keptGroups.flat();
    const trimmedCount = history.length - keptMessages.length;

    if (trimmedCount > 0) {
      this.logger.info(
        { trimmedCount, totalMessages: messages.length, maxInputTokens },
        'Trimmed conversation history to fit context window',
      );

      // Build a compact summary of the trimmed (dropped) messages
      const droppedMessages = history.slice(0, history.length - keptMessages.length);
      const summary = this.summarizeTrimmedMessages(droppedMessages);

      // Use 'user' role for the summary so it never creates consecutive
      // same-role turns with the first kept message (which may be 'assistant').
      keptMessages.unshift({
        role: 'user',
        content: `[Earlier conversation summary — ${trimmedCount} messages were trimmed to fit the context window:\n${summary}\n\nThe conversation continues below with the most recent messages.]`,
      });
    }

    keptMessages.push(latestMsg);

    // Final sanitization pass: trimming can skip groups and create new orphaned
    // tool_use/tool_result blocks. Re-sanitize to ensure sequential pairing.
    return this.promptBuilder.sanitizeToolMessages(keptMessages);
  }

  /**
   * Build a compact text summary of messages that were trimmed from history.
   * Extracts the key topics, user requests, and assistant actions so the LLM
   * retains conversational context without needing the full messages.
   */
  private summarizeTrimmedMessages(messages: LLMMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const text = this.extractMessageText(msg);
      if (!text) continue;

      // Truncate long messages to keep the summary compact
      const truncated = text.length > 150 ? text.slice(0, 150) + '...' : text;
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`- ${prefix}: ${truncated}`);

      // Also note tool usage without the full result
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            const inputSummary = JSON.stringify(block.input).slice(0, 80);
            lines.push(`  → Tool: ${block.name}(${inputSummary})`);
          }
        }
      }
    }

    // Cap the summary to avoid using too many tokens itself
    const MAX_SUMMARY_LINES = 40;
    if (lines.length > MAX_SUMMARY_LINES) {
      const kept = lines.slice(0, MAX_SUMMARY_LINES);
      kept.push(`  ... and ${lines.length - MAX_SUMMARY_LINES} more interactions`);
      return kept.join('\n');
    }
    return lines.join('\n');
  }

  /**
   * Extract the plain text content from an LLM message, ignoring tool blocks.
   */
  private extractMessageText(msg: LLMMessage): string {
    if (typeof msg.content === 'string') return msg.content;
    if (!Array.isArray(msg.content)) return '';
    const texts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        texts.push(block.text);
      }
    }
    return texts.join(' ');
  }

  /**
   * Group messages so that tool_use (assistant) + tool_result (user) pairs
   * are treated as atomic units that are never split during trimming.
   */
  private groupToolPairs(messages: LLMMessage[]): LLMMessage[][] {
    const groups: LLMMessage[][] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_use')) {
        const group = [msg];
        // Look ahead for the matching tool_result user message
        if (i + 1 < messages.length && messages[i + 1].role === 'user') {
          const next = messages[i + 1];
          if (Array.isArray(next.content) && next.content.some(b => b.type === 'tool_result')) {
            group.push(next);
            i += 2;
            groups.push(group);
            continue;
          }
        }
        // Orphaned tool_use with no matching tool_result: include the next user message in the group if present
        if (group.length === 1 && i + 1 < messages.length && messages[i + 1].role === 'user') {
          group.push(messages[i + 1]);
          i += 2;
          groups.push(group);
          continue;
        }
        groups.push(group);
        i++;
      } else {
        groups.push([msg]);
        i++;
      }
    }
    return groups;
  }

  /**
   * Build the user content for the LLM request.
   * Handles images (as vision blocks), audio (transcribed via Whisper),
   * documents/files (saved to inbox), and plain text.
   */
  private async buildUserContent(
    message: NormalizedMessage,
    onProgress?: ProgressCallback,
  ): Promise<string | LLMContentBlock[]> {
    const attachments = message.attachments?.filter(a => a.data) ?? [];

    if (attachments.length === 0) {
      return message.text;
    }

    const blocks: LLMContentBlock[] = [];

    // Process attachments
    for (const attachment of attachments) {
      if (attachment.type === 'image' && attachment.data) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mimeType ?? 'image/jpeg',
            data: attachment.data.toString('base64'),
          },
        });
        this.logger.info({ mimeType: attachment.mimeType, size: attachment.size }, 'Image attached to LLM request');
      } else if (attachment.type === 'audio' && attachment.data) {
        // Transcribe audio via Whisper
        if (this.speechTranscriber) {
          onProgress?.('Transcribing voice...');
          try {
            const transcript = await this.speechTranscriber.transcribe(
              attachment.data,
              attachment.mimeType ?? 'audio/ogg',
            );
            const label = message.text === '[Voice message]' ? '' : `${message.text}\n\n`;
            blocks.push({
              type: 'text',
              text: `${label}[Voice transcript]: ${transcript}`,
            });
            this.logger.info({ transcriptLength: transcript.length }, 'Voice message transcribed');
            if (attachments.length === 1) {
              return blocks.length === 1 ? blocks[0].type === 'text' ? (blocks[0] as { type: 'text'; text: string }).text : blocks : blocks;
            }
          } catch (err) {
            this.logger.error({ err }, 'Voice transcription failed');
            blocks.push({
              type: 'text',
              text: '[Voice message could not be transcribed]',
            });
          }
        } else {
          blocks.push({
            type: 'text',
            text: '[Voice message received but speech-to-text is not configured. Add speech config to enable transcription.]',
          });
        }
      } else if ((attachment.type === 'document' || attachment.type === 'video' || attachment.type === 'other') && attachment.data) {
        // Save file to inbox and tell the LLM about it
        const savedPath = this.saveToInbox(attachment);
        if (savedPath) {
          const isTextFile = this.isTextMimeType(attachment.mimeType);
          let fileNote = `[File received: "${attachment.fileName ?? 'unknown'}" (${this.formatBytes(attachment.data.length)}, ${attachment.mimeType ?? 'unknown type'})]\n[Saved to: ${savedPath}]`;

          // For text-based files, include the content inline
          if (isTextFile && attachment.data.length <= MAX_INLINE_FILE_SIZE) {
            const textContent = attachment.data.toString('utf-8');
            fileNote += `\n[File content]:\n${textContent}`;
          }

          blocks.push({ type: 'text', text: fileNote });
          this.logger.info({ fileName: attachment.fileName, savedPath, size: attachment.data.length }, 'File saved to inbox');
        }
      }
    }

    // Add the text content — skip synthetic platform labels (e.g. "[Document: file.pdf]", "[Photo]")
    const isSynthetic = this.isSyntheticLabel(message.text);
    if (message.text && !isSynthetic) {
      blocks.push({ type: 'text', text: message.text });
    }

    // Fallbacks when no real user text is present
    const hasTextBlock = blocks.some(b => b.type === 'text');
    if (blocks.some(b => b.type === 'image') && !hasTextBlock) {
      blocks.push({ type: 'text', text: 'What do you see in this image?' });
    } else if (isSynthetic && blocks.some(b => b.type === 'text' && (b as { text: string }).text.startsWith('[File received:'))) {
      // File sent without any accompanying text — ask the user what they want.
      // Strong instruction to prevent the LLM from acting on conversation history or memories.
      blocks.push({ type: 'text', text: 'The user sent this file without any instructions. Ask them what they would like you to do with it. Do NOT take any other actions, do NOT use any tools, and do NOT act on conversation history or memories. ONLY ask what the user wants.' });
    } else if (blocks.length === 0) {
      blocks.push({ type: 'text', text: message.text || '(empty message)' });
    }

    return blocks;
  }

  /**
   * Check if a message text is a synthetic platform label (e.g. "[Document: file.pdf]", "[Photo]")
   * rather than real user-typed text. These labels are generated by messaging adapters
   * when the user sends media without a caption.
   */
  private isSyntheticLabel(text: string | undefined): boolean {
    if (!text) return true;
    const prefixes = ['[Photo', '[Voice message', '[Video', '[Document', '[File', '[Sticker', '[Audio'];
    return prefixes.some(p => text.startsWith(p));
  }

  /**
   * Save an attachment to the inbox directory.
   * Returns the saved file path, or undefined on failure.
   */
  private saveToInbox(attachment: Attachment): string | undefined {
    if (!attachment.data) return undefined;

    const inboxDir = this.inboxPath ?? path.resolve('./data/inbox');
    try {
      fs.mkdirSync(inboxDir, { recursive: true });
    } catch {
      this.logger.error({ inboxDir }, 'Cannot create inbox directory');
      return undefined;
    }

    // Generate unique filename: timestamp_originalname
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const originalName = attachment.fileName ?? `file_${timestamp}`;
    const safeName = originalName.replace(/[<>:"/\\|?*]/g, '_');
    const fileName = `${timestamp}_${safeName}`;
    const filePath = path.join(inboxDir, fileName);

    try {
      fs.writeFileSync(filePath, attachment.data);
      return filePath;
    } catch (err) {
      this.logger.error({ err, filePath }, 'Failed to save file to inbox');
      return undefined;
    }
  }

  private isTextMimeType(mimeType?: string): boolean {
    if (!mimeType) return false;
    const textTypes = [
      'text/', 'application/json', 'application/xml', 'application/javascript',
      'application/typescript', 'application/x-yaml', 'application/yaml',
      'application/toml', 'application/x-sh', 'application/sql',
      'application/csv', 'application/x-csv',
    ];
    return textTypes.some(t => mimeType.startsWith(t));
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
