import fs from 'node:fs';
import path from 'node:path';
import type {
  NormalizedMessage,
  LLMResponse,
  LLMMessage,
  LLMContentBlock,
  ToolCall,
  SkillContext,
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

const MAX_TOOL_ITERATIONS = 10;
const TOKEN_BUDGET_RATIO = 0.85; // Use at most 85% of input window for context
const MAX_INLINE_FILE_SIZE = 100_000; // Include text file content inline up to 100KB

export type ProgressCallback = (status: string) => void;

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
    this.promptBuilder = new PromptBuilder();
  }

  async process(message: NormalizedMessage, onProgress?: ProgressCallback): Promise<string> {
    const startTime = Date.now();
    this.logger.info({ platform: message.platform, userId: message.userId, chatId: message.chatId }, 'Processing message');

    try {
      // 1. Find or create user
      const user = this.users.findOrCreate(
        message.platform,
        message.userId,
        message.userName,
        message.displayName,
      );

      // 2. Find or create conversation
      const conversation = this.conversationManager.getOrCreateConversation(
        message.platform,
        message.chatId,
        user.id,
      );

      // 3. Load conversation history (fetch more than needed, we'll trim by tokens)
      const history = this.conversationManager.getHistory(conversation.id, 50);

      // 4. Save user message
      this.conversationManager.addMessage(conversation.id, 'user', message.text);

      // 5. Load user memories for prompt injection (semantic search if available)
      let memories: { key: string; value: string; category: string }[] | undefined;
      if (this.memoryRepo) {
        try {
          if (this.embeddingService && message.text) {
            // Use semantic search: top-10 relevant + 5 newest
            const semanticResults = await this.embeddingService.semanticSearch(user.id, message.text, 10);
            const recentResults = this.memoryRepo.getRecentForPrompt(user.id, 5);
            // Merge and deduplicate by key
            const seen = new Set<string>();
            memories = [];
            for (const m of semanticResults) {
              if (!seen.has(m.key)) {
                seen.add(m.key);
                memories.push(m);
              }
            }
            for (const m of recentResults) {
              if (!seen.has(m.key)) {
                seen.add(m.key);
                memories.push(m);
              }
            }
          } else {
            memories = this.memoryRepo.getRecentForPrompt(user.id, 20);
          }
        } catch {
          // Memory loading is non-critical
        }
      }

      // 5b. Load user profile for prompt injection
      let userProfile: import('@alfred/llm').UserProfile | undefined;
      try {
        if ('getProfile' in this.users) {
          userProfile = (this.users as any).getProfile(user.id);
          if (userProfile && !userProfile.displayName) {
            userProfile.displayName = user.displayName ?? user.username;
          }
        }
      } catch {
        // Profile loading is non-critical
      }

      // 6. Build tools and LLM request with token-aware context trimming
      const skillMetas = this.skillRegistry
        ? this.skillRegistry.getAll().map(s => s.metadata)
        : undefined;
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
      const allMessages: LLMMessage[] = this.promptBuilder.buildMessages(history);

      // Build user message with attachments (images, transcribed audio)
      const userContent = await this.buildUserContent(message, onProgress);
      allMessages.push({ role: 'user', content: userContent });

      const messages = this.trimToContextWindow(system, allMessages);

      // 7. Agentic tool-use loop
      let response: LLMResponse;
      let iteration = 0;
      onProgress?.('Thinking...');

      while (true) {
        response = await this.llm.complete({
          messages,
          system,
          tools: tools && tools.length > 0 ? tools : undefined,
        });

        // If no tool calls or max iterations reached, break
        if (!response.toolCalls || response.toolCalls.length === 0 || iteration >= MAX_TOOL_ITERATIONS) {
          if (iteration >= MAX_TOOL_ITERATIONS && response.toolCalls?.length) {
            this.logger.warn({ iteration }, 'Max tool iterations reached, stopping loop');
          }
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

        // Execute each tool call
        const toolResultBlocks: LLMContentBlock[] = [];
        for (const toolCall of response.toolCalls) {
          const toolLabel = this.getToolLabel(toolCall.name, toolCall.input);
          onProgress?.(toolLabel);
          const result = await this.executeToolCall(toolCall, {
            userId: message.userId,
            chatId: message.chatId,
            chatType: message.chatType,
            platform: message.platform,
            conversationId: conversation.id,
          }, onProgress);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // Save intermediate tool interaction to DB so follow-up questions have context
        const toolCallSummary = response.toolCalls.map(tc =>
          `[Used ${tc.name}: ${JSON.stringify(tc.input)}]`
        ).join('\n');
        const toolResultSummary = toolResultBlocks.map(tr => {
          const output = tr.type === 'tool_result' ? String(tr.content).slice(0, 1000) : '';
          return `[Result: ${output}]`;
        }).join('\n');
        this.conversationManager.addMessage(
          conversation.id,
          'assistant',
          `${response.content ? response.content + '\n' : ''}${toolCallSummary}`,
          JSON.stringify(response.toolCalls),
        );
        this.conversationManager.addMessage(
          conversation.id,
          'user',
          toolResultSummary,
        );

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResultBlocks });
        if (iteration < MAX_TOOL_ITERATIONS) {
          onProgress?.('Thinking...');
        }
      }

      const responseText = response.content || '(no response)';

      // 8. Save final assistant response
      this.conversationManager.addMessage(
        conversation.id,
        'assistant',
        responseText,
      );

      const duration = Date.now() - startTime;
      this.logger.info(
        { duration, tokens: response.usage, stopReason: response.stopReason, toolIterations: iteration },
        'Message processed',
      );

      return responseText;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to process message');
      throw error;
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    context: SkillContext,
    onProgress?: ProgressCallback,
  ): Promise<{ content: string; isError?: boolean }> {
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
      // For delegate skill: wire up progress callback + activity tracker
      let tracker: import('@alfred/skills').ActivityTracker | undefined;
      let agentId: string | undefined;
      if (toolCall.name === 'delegate' && 'setProgressCallback' in skill && 'createTracker' in skill) {
        const delegateSkill = skill as import('@alfred/skills').DelegateSkill;
        if (onProgress) {
          delegateSkill.setProgressCallback(onProgress);
        }
        tracker = delegateSkill.createTracker();

        // Register so other messages can query the agent's status
        agentId = `agent-${++this.agentIdCounter}`;
        this.activeAgents.set(agentId, {
          chatId: context.chatId,
          task: String(toolCall.input.task ?? '').slice(0, 200),
          tracker,
          startedAt: Date.now(),
        });
      }

      try {
        const result = await this.skillSandbox.execute(skill, toolCall.input, context, undefined, tracker);
        return {
          content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
          isError: !result.success,
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
   * Trim messages to fit within the LLM's context window.
   * Keeps the system prompt, the latest user message, and as many
   * recent history messages as possible. Drops oldest messages first.
   * Injects a summary note when messages are trimmed.
   */
  private trimToContextWindow(system: string, messages: LLMMessage[]): LLMMessage[] {
    const contextWindow = this.llm.getContextWindow();
    const maxInputTokens = Math.floor(contextWindow.maxInputTokens * TOKEN_BUDGET_RATIO);

    const systemTokens = estimateTokens(system);
    // Always keep the latest message (current user input)
    const latestMsg = messages[messages.length - 1];
    const latestTokens = estimateMessageTokens(latestMsg);

    // Reserve tokens for system + latest message + output buffer
    const reservedTokens = systemTokens + latestTokens + 200; // 200 for overhead
    let availableTokens = maxInputTokens - reservedTokens;

    if (availableTokens <= 0) {
      // Even a single message barely fits — just send the latest
      this.logger.warn({ maxInputTokens, systemTokens, latestTokens }, 'Context window very tight, sending only latest message');
      return [latestMsg];
    }

    // Walk backwards from the second-to-last message, keeping as many as fit
    const keptMessages: LLMMessage[] = [];
    for (let i = messages.length - 2; i >= 0; i--) {
      const msgTokens = estimateMessageTokens(messages[i]);
      if (msgTokens > availableTokens) break;
      availableTokens -= msgTokens;
      keptMessages.unshift(messages[i]);
    }

    const trimmedCount = messages.length - 1 - keptMessages.length;
    if (trimmedCount > 0) {
      this.logger.info(
        { trimmedCount, totalMessages: messages.length, maxInputTokens },
        'Trimmed conversation history to fit context window',
      );
      // Prepend a context note so the LLM knows history was trimmed
      keptMessages.unshift({
        role: 'user',
        content: `[System note: ${trimmedCount} older message(s) were omitted to fit the context window. The conversation continues from the most recent messages.]`,
      });
    }

    keptMessages.push(latestMsg);
    return keptMessages;
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
            return blocks.length === 1 ? blocks[0].type === 'text' ? (blocks[0] as { type: 'text'; text: string }).text : blocks : blocks;
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

    // Add the text content
    const skipTexts = ['[Photo]', '[Voice message]', '[Video]', '[Video note]', '[Document]', '[File]'];
    if (message.text && !skipTexts.includes(message.text)) {
      blocks.push({ type: 'text', text: message.text });
    } else if (blocks.some(b => b.type === 'image') && !blocks.some(b => b.type === 'text')) {
      blocks.push({ type: 'text', text: 'What do you see in this image?' });
    } else if (blocks.length === 0) {
      blocks.push({ type: 'text', text: message.text || '(empty message)' });
    }

    return blocks;
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
