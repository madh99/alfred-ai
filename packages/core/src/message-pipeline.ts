import type { NormalizedMessage, LLMResponse } from '@alfred/types';
import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import { PromptBuilder } from '@alfred/llm';
import type { UserRepository } from '@alfred/storage';
import { ConversationManager } from './conversation-manager.js';

export class MessagePipeline {
  private readonly promptBuilder: PromptBuilder;

  constructor(
    private readonly llm: LLMProvider,
    private readonly conversationManager: ConversationManager,
    private readonly users: UserRepository,
    private readonly logger: Logger,
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
      const messages = this.promptBuilder.buildMessages(history);

      // Add current message
      messages.push({ role: 'user', content: message.text });

      // 6. Call LLM
      const response: LLMResponse = await this.llm.complete({
        messages,
        system,
        maxTokens: undefined,
        temperature: undefined,
      });

      const responseText = response.content;

      // 7. Save assistant response
      this.conversationManager.addMessage(
        conversation.id,
        'assistant',
        responseText,
        response.toolCalls ? JSON.stringify(response.toolCalls) : undefined,
      );

      const duration = Date.now() - startTime;
      this.logger.info(
        { duration, tokens: response.usage, stopReason: response.stopReason },
        'Message processed',
      );

      return responseText;
    } catch (error) {
      this.logger.error({ error }, 'Failed to process message');
      throw error;
    }
  }
}
