import type {
  NormalizedMessage,
  LLMResponse,
  LLMMessage,
  LLMContentBlock,
  ToolCall,
  SkillContext,
} from '@alfred/types';
import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import { PromptBuilder, estimateTokens, estimateMessageTokens } from '@alfred/llm';
import type { UserRepository, MemoryRepository } from '@alfred/storage';
import type { SecurityManager } from '@alfred/security';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';

const MAX_TOOL_ITERATIONS = 10;
const TOKEN_BUDGET_RATIO = 0.85; // Use at most 85% of input window for context

export class MessagePipeline {
  private readonly promptBuilder: PromptBuilder;

  constructor(
    private readonly llm: LLMProvider,
    private readonly conversationManager: ConversationManager,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly skillRegistry?: SkillRegistry,
    private readonly skillSandbox?: SkillSandbox,
    private readonly securityManager?: SecurityManager,
    private readonly memoryRepo?: MemoryRepository,
  ) {
    this.promptBuilder = new PromptBuilder();
  }

  async process(message: NormalizedMessage): Promise<string> {
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

      // 5. Load user memories for prompt injection
      let memories: { key: string; value: string; category: string }[] | undefined;
      if (this.memoryRepo) {
        try {
          memories = this.memoryRepo.getRecentForPrompt(user.id, 20);
        } catch {
          // Memory loading is non-critical
        }
      }

      // 6. Build LLM request with token-aware context trimming
      const system = this.promptBuilder.buildSystemPrompt(memories);
      const allMessages: LLMMessage[] = this.promptBuilder.buildMessages(history);
      allMessages.push({ role: 'user', content: message.text });

      const messages = this.trimToContextWindow(system, allMessages);

      // 6. Build tools from registered skills
      const tools = this.skillRegistry
        ? this.promptBuilder.buildTools(this.skillRegistry.getAll().map(s => s.metadata))
        : undefined;

      // 7. Agentic tool-use loop
      let response: LLMResponse;
      let iteration = 0;

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
          const result = await this.executeToolCall(toolCall, {
            userId: user.id,
            chatId: message.chatId,
            chatType: message.chatType,
            platform: message.platform,
            conversationId: conversation.id,
          });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResultBlocks });
      }

      const responseText = response.content || '(no response)';

      // 8. Save assistant response
      this.conversationManager.addMessage(
        conversation.id,
        'assistant',
        responseText,
        response.toolCalls ? JSON.stringify(response.toolCalls) : undefined,
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
      const result = await this.skillSandbox.execute(skill, toolCall.input, context);
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
      };
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
}
