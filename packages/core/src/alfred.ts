import type { AlfredConfig, NormalizedMessage, Platform } from '@alfred/types';
import type { Logger } from 'pino';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository } from '@alfred/storage';
import { AnthropicProvider } from '@alfred/llm';
import { TelegramAdapter, type MessagingAdapter } from '@alfred/messaging';
import { ConversationManager } from './conversation-manager.js';
import { MessagePipeline } from './message-pipeline.js';

export class Alfred {
  private readonly logger: Logger;
  private database!: Database;
  private pipeline!: MessagePipeline;
  private readonly adapters: Map<Platform, MessagingAdapter> = new Map();

  constructor(private readonly config: AlfredConfig) {
    this.logger = createLogger('alfred', config.logger.level);
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Alfred...');

    // 1. Initialize storage
    this.database = new Database(this.config.storage.path);
    const conversationRepo = new ConversationRepository(this.database.getDb());
    const userRepo = new UserRepository(this.database.getDb());
    this.logger.info('Storage initialized');

    // 2. Initialize LLM provider
    const llmProvider = new AnthropicProvider(this.config.llm);
    await llmProvider.initialize();
    this.logger.info({ provider: this.config.llm.provider, model: this.config.llm.model }, 'LLM provider initialized');

    // 3. Create conversation manager and pipeline
    const conversationManager = new ConversationManager(conversationRepo);
    this.pipeline = new MessagePipeline(llmProvider, conversationManager, userRepo, this.logger);

    // 4. Initialize messaging adapters
    if (this.config.telegram.enabled && this.config.telegram.token) {
      const telegram = new TelegramAdapter(this.config.telegram.token);
      this.adapters.set('telegram', telegram);
      this.logger.info('Telegram adapter registered');
    }

    this.logger.info('Alfred initialized');
  }

  async start(): Promise<void> {
    this.logger.info('Starting Alfred...');

    for (const [platform, adapter] of this.adapters) {
      this.setupAdapterHandlers(platform, adapter);
      await adapter.connect();
      this.logger.info({ platform }, 'Adapter connected');
    }

    if (this.adapters.size === 0) {
      this.logger.warn('No messaging adapters enabled. Configure at least one platform.');
    }

    this.logger.info(`Alfred is running with ${this.adapters.size} adapter(s)`);
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Alfred...');

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
        this.logger.info({ platform }, 'Adapter disconnected');
      } catch (error) {
        this.logger.error({ platform, error }, 'Failed to disconnect adapter');
      }
    }

    this.database.close();
    this.logger.info('Alfred stopped');
  }

  private setupAdapterHandlers(platform: Platform, adapter: MessagingAdapter): void {
    adapter.on('message', async (message: NormalizedMessage) => {
      try {
        const response = await this.pipeline.process(message);
        await adapter.sendMessage(message.chatId, response);
      } catch (error) {
        this.logger.error({ platform, error, chatId: message.chatId }, 'Failed to handle message');
        try {
          await adapter.sendMessage(message.chatId, 'Sorry, I encountered an error processing your message. Please try again.');
        } catch (sendError) {
          this.logger.error({ error: sendError }, 'Failed to send error message');
        }
      }
    });

    adapter.on('error', (error: Error) => {
      this.logger.error({ platform, error }, 'Adapter error');
    });

    adapter.on('connected', () => {
      this.logger.info({ platform }, 'Adapter connected');
    });

    adapter.on('disconnected', () => {
      this.logger.warn({ platform }, 'Adapter disconnected');
    });
  }
}
