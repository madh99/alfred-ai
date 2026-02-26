import type { AlfredConfig, NormalizedMessage, Platform } from '@alfred/types';
import type { Logger } from 'pino';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository, AuditRepository } from '@alfred/storage';
import { AnthropicProvider } from '@alfred/llm';
import {
  TelegramAdapter,
  DiscordAdapter,
  MatrixAdapter,
  WhatsAppAdapter,
  SignalAdapter,
  type MessagingAdapter,
} from '@alfred/messaging';
import { RuleEngine, SecurityManager } from '@alfred/security';
import { SkillRegistry, SkillSandbox, CalculatorSkill, SystemInfoSkill, WebSearchSkill } from '@alfred/skills';
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
    const db = this.database.getDb();
    const conversationRepo = new ConversationRepository(db);
    const userRepo = new UserRepository(db);
    const auditRepo = new AuditRepository(db);
    this.logger.info('Storage initialized');

    // 2. Initialize security
    const ruleEngine = new RuleEngine();
    const securityManager = new SecurityManager(
      ruleEngine,
      auditRepo,
      this.logger.child({ component: 'security' }),
    );
    this.logger.info('Security engine initialized');

    // 3. Initialize skills
    const skillRegistry = new SkillRegistry();
    skillRegistry.register(new CalculatorSkill());
    skillRegistry.register(new SystemInfoSkill());
    skillRegistry.register(new WebSearchSkill());
    this.logger.info({ skills: skillRegistry.getAll().map(s => s.metadata.name) }, 'Skills registered');

    const skillSandbox = new SkillSandbox(
      this.logger.child({ component: 'sandbox' }),
    );

    // 4. Initialize LLM provider
    const llmProvider = new AnthropicProvider(this.config.llm);
    await llmProvider.initialize();
    this.logger.info({ provider: this.config.llm.provider, model: this.config.llm.model }, 'LLM provider initialized');

    // 5. Create conversation manager and pipeline
    const conversationManager = new ConversationManager(conversationRepo);
    this.pipeline = new MessagePipeline(
      llmProvider,
      conversationManager,
      userRepo,
      this.logger.child({ component: 'pipeline' }),
      skillRegistry,
      skillSandbox,
      securityManager,
    );

    // 6. Initialize messaging adapters
    this.initializeAdapters();

    this.logger.info('Alfred initialized');
  }

  private initializeAdapters(): void {
    const { config } = this;

    if (config.telegram.enabled && config.telegram.token) {
      this.adapters.set('telegram', new TelegramAdapter(config.telegram.token));
      this.logger.info('Telegram adapter registered');
    }

    if (config.discord?.enabled && config.discord.token) {
      this.adapters.set('discord', new DiscordAdapter(config.discord.token));
      this.logger.info('Discord adapter registered');
    }

    if (config.whatsapp?.enabled) {
      this.adapters.set('whatsapp', new WhatsAppAdapter(config.whatsapp.dataPath));
      this.logger.info('WhatsApp adapter registered');
    }

    if (config.matrix?.enabled && config.matrix.accessToken) {
      this.adapters.set('matrix', new MatrixAdapter(
        config.matrix.homeserverUrl,
        config.matrix.accessToken,
        config.matrix.userId,
      ));
      this.logger.info('Matrix adapter registered');
    }

    if (config.signal?.enabled && config.signal.phoneNumber) {
      this.adapters.set('signal', new SignalAdapter(
        config.signal.apiUrl,
        config.signal.phoneNumber,
      ));
      this.logger.info('Signal adapter registered');
    }
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
