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
import { PromptBuilder } from '@alfred/llm';
import type { UserRepository } from '@alfred/storage';
import type { SecurityManager } from '@alfred/security';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';

const MAX_TOOL_ITERATIONS = 10;

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

      // 3. Load conversation history
      const history = this.conversationManager.getHistory(conversation.id);

      // 4. Save user message
      this.conversationManager.addMessage(conversation.id, 'user', message.text);

      // 5. Build LLM request
      const system = this.promptBuilder.buildSystemPrompt();
      const messages: LLMMessage[] = this.promptBuilder.buildMessages(history);
      messages.push({ role: 'user', content: message.text });

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
}
