import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AlfredConfig, NormalizedMessage, Platform, SecurityRule } from '@alfred/types';
import type { Logger } from 'pino';
import type { MessagingAdapter } from '@alfred/messaging';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository, AuditRepository, MemoryRepository, ReminderRepository, NoteRepository, EmbeddingRepository, LinkTokenRepository, BackgroundTaskRepository, ScheduledActionRepository, DocumentRepository } from '@alfred/storage';
import { ConfigLoader, reloadDotenv } from '@alfred/config';
import { createModelRouter } from '@alfred/llm';
import { RuleEngine, SecurityManager } from '@alfred/security';
import {
  SkillRegistry,
  SkillSandbox,
  CalculatorSkill,
  SystemInfoSkill,
  WebSearchSkill,
  ReminderSkill,
  NoteSkill,
  WeatherSkill,
  ShellSkill,
  MemorySkill,
  DelegateSkill,
  EmailSkill,
  createEmailProvider,
  HttpSkill,
  FileSkill,
  ClipboardSkill,
  ScreenshotSkill,
  BrowserSkill,
  ProfileSkill,
  CalendarSkill,
  createCalendarProvider,
  CrossPlatformSkill,
  BackgroundTaskSkill,
  ScheduledTaskSkill,
  DocumentSkill,
  TTSSkill,
  ConfigureSkill,
} from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';
import { MessagePipeline } from './message-pipeline.js';
import { ReminderScheduler } from './reminder-scheduler.js';
import { SpeechTranscriber } from './speech-transcriber.js';
import { SpeechSynthesizer } from './speech-synthesizer.js';
import { ResponseFormatter } from './response-formatter.js';
import { EmbeddingService } from './embedding-service.js';
import { DocumentProcessor } from './document-processor.js';
import { BackgroundTaskRunner } from './background-task-runner.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { ActiveLearningService } from './active-learning/active-learning-service.js';
import { MemoryRetriever } from './active-learning/memory-retriever.js';

export class Alfred {
  private readonly logger: Logger;
  private database!: Database;
  private pipeline!: MessagePipeline;
  private reminderScheduler?: ReminderScheduler;
  private backgroundTaskRunner?: BackgroundTaskRunner;
  private proactiveScheduler?: ProactiveScheduler;
  private readonly adapters: Map<Platform, MessagingAdapter> = new Map();
  private readonly formatter = new ResponseFormatter();
  private userRepo!: UserRepository;
  private skillRegistry!: SkillRegistry;
  private mcpManager?: import('@alfred/skills').MCPManager;
  private calendarSkill?: any; // CalendarSkill instance for today's events

  constructor(private config: AlfredConfig) {
    this.logger = createLogger('alfred', config.logger.level);
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Alfred...');

    // 1. Initialize storage
    this.database = new Database(this.config.storage.path);
    const db = this.database.getDb();
    const conversationRepo = new ConversationRepository(db);
    const userRepo = new UserRepository(db);
    this.userRepo = userRepo;
    const auditRepo = new AuditRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const noteRepo = new NoteRepository(db);
    const embeddingRepo = new EmbeddingRepository(db);
    const linkTokenRepo = new LinkTokenRepository(db);
    const backgroundTaskRepo = new BackgroundTaskRepository(db);
    const scheduledActionRepo = new ScheduledActionRepository(db);
    this.logger.info('Storage initialized');

    // 2. Initialize security — load rules from YAML files
    const ruleEngine = new RuleEngine();
    const rules = this.loadSecurityRules();
    ruleEngine.loadRules(rules);
    const securityManager = new SecurityManager(
      ruleEngine,
      auditRepo,
      this.logger.child({ component: 'security' }),
    );
    this.logger.info({ ruleCount: rules.length }, 'Security engine initialized');

    // 3. Initialize LLM provider (multi-model router)
    const llmProvider = createModelRouter(this.config.llm);
    await llmProvider.initialize();
    this.logger.info({ provider: this.config.llm.default.provider, model: this.config.llm.default.model }, 'LLM provider initialized');

    // Create embedding service
    const embeddingService = new EmbeddingService(
      llmProvider,
      embeddingRepo,
      this.logger.child({ component: 'embeddings' }),
    );

    // 3b. Active learning & memory retriever
    const activeLearningEnabled = this.config.activeLearning?.enabled !== false;
    let activeLearning: ActiveLearningService | undefined;
    let memoryRetriever: MemoryRetriever | undefined;

    if (activeLearningEnabled) {
      activeLearning = new ActiveLearningService({
        llm: llmProvider,
        memoryRepo,
        logger: this.logger.child({ component: 'active-learning' }),
        embeddingService,
        minMessageLength: this.config.activeLearning?.minMessageLength,
        minConfidence: this.config.activeLearning?.minConfidence,
        maxExtractionsPerMinute: this.config.activeLearning?.maxExtractionsPerMinute,
      });

      memoryRetriever = new MemoryRetriever(
        memoryRepo,
        this.logger.child({ component: 'memory-retriever' }),
        embeddingService,
      );

      this.logger.info('Active learning & memory retriever initialized');
    }

    // 4. Initialize skills
    const skillSandbox = new SkillSandbox(
      this.logger.child({ component: 'sandbox' }),
    );
    const skillRegistry = this.skillRegistry = new SkillRegistry();
    skillRegistry.register(new CalculatorSkill());
    skillRegistry.register(new SystemInfoSkill());
    skillRegistry.register(new WebSearchSkill(this.config.search ? {
      provider: this.config.search.provider,
      apiKey: this.config.search.apiKey,
      baseUrl: this.config.search.baseUrl,
    } : undefined));
    skillRegistry.register(new ReminderSkill(reminderRepo));
    skillRegistry.register(new NoteSkill(noteRepo));
    skillRegistry.register(new WeatherSkill());
    skillRegistry.register(new ShellSkill());
    skillRegistry.register(new MemorySkill(memoryRepo, embeddingService));
    skillRegistry.register(new DelegateSkill(llmProvider, skillRegistry, skillSandbox, securityManager));
    // 4a-email. Initialize email (optional, provider-based)
    if (this.config.email) {
      try {
        // Share Microsoft credentials from calendar if not set
        if (this.config.email.provider === 'microsoft' && !this.config.email.microsoft?.clientId) {
          if (this.config.calendar?.microsoft) {
            this.config.email.microsoft = { ...this.config.calendar.microsoft };
          }
        }
        const emailProvider = await createEmailProvider(this.config.email);
        skillRegistry.register(new EmailSkill(emailProvider));
        this.logger.info({ provider: this.config.email.provider ?? 'imap-smtp' }, 'Email initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Email initialization failed, continuing without email');
        skillRegistry.register(new EmailSkill());
      }
    } else {
      skillRegistry.register(new EmailSkill());
    }
    skillRegistry.register(new HttpSkill());
    skillRegistry.register(new FileSkill());
    const configureSkill = new ConfigureSkill();
    configureSkill.setReloadCallback((service) => this.reloadService(service as 'proxmox' | 'unifi'));
    skillRegistry.register(configureSkill);
    skillRegistry.register(new ClipboardSkill());
    skillRegistry.register(new ScreenshotSkill());
    skillRegistry.register(new BrowserSkill());
    skillRegistry.register(new ProfileSkill(userRepo));
    skillRegistry.register(new CrossPlatformSkill(userRepo, linkTokenRepo, this.adapters, (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId)));
    skillRegistry.register(new BackgroundTaskSkill(backgroundTaskRepo));
    skillRegistry.register(new ScheduledTaskSkill(scheduledActionRepo));

    // 4a. Document intelligence
    const documentRepo = new DocumentRepository(db);
    const documentProcessor = new DocumentProcessor(documentRepo, embeddingService, this.logger.child({ component: 'documents' }));
    skillRegistry.register(new DocumentSkill(documentRepo, documentProcessor, embeddingService));

    // 4b. Initialize calendar (optional)
    let calendarSkill: CalendarSkill | undefined;
    if (this.config.calendar) {
      try {
        const calendarProvider = await createCalendarProvider(this.config.calendar);
        calendarSkill = new CalendarSkill(calendarProvider);
        skillRegistry.register(calendarSkill);
        this.logger.info({ provider: this.config.calendar.provider }, 'Calendar initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Calendar initialization failed, continuing without calendar');
      }
    }
    this.calendarSkill = calendarSkill;

    // 4c. Initialize MCP servers (optional)
    if (this.config.mcp?.servers?.length) {
      const { MCPManager } = await import('@alfred/skills');
      this.mcpManager = new MCPManager(this.logger.child({ component: 'mcp' }));
      await this.mcpManager.initialize(this.config.mcp);
      for (const skill of this.mcpManager.getSkills()) {
        skillRegistry.register(skill);
      }
      this.logger.info({ mcpSkills: this.mcpManager.getSkills().length }, 'MCP skills registered');
    }

    // 4d. Code sandbox (optional, requires explicit enable)
    if (this.config.codeSandbox?.enabled) {
      const { CodeExecutionSkill } = await import('@alfred/skills');
      skillRegistry.register(new CodeExecutionSkill({
        allowedLanguages: this.config.codeSandbox.allowedLanguages,
        maxTimeoutMs: this.config.codeSandbox.maxTimeoutMs,
      }));
      this.logger.info('Code sandbox enabled');
    }

    // 4e. Code agents (optional, requires explicit enable)
    if (this.config.codeAgents?.enabled) {
      const { CodeAgentSkill } = await import('@alfred/skills');
      skillRegistry.register(new CodeAgentSkill(
        { agents: this.config.codeAgents.agents, forge: this.config.codeAgents.forge },
        llmProvider,
      ));
      this.logger.info({ agents: this.config.codeAgents.agents.map(a => a.name) }, 'Code agent skill enabled');
    }

    // 4f. Proxmox (optional)
    if (this.config.proxmox) {
      const { ProxmoxSkill } = await import('@alfred/skills');
      skillRegistry.register(new ProxmoxSkill(this.config.proxmox));
      this.logger.info({ baseUrl: this.config.proxmox.baseUrl }, 'Proxmox skill enabled');
    }

    // 4g. UniFi (optional)
    if (this.config.unifi) {
      const { UniFiSkill } = await import('@alfred/skills');
      skillRegistry.register(new UniFiSkill(this.config.unifi));
      this.logger.info({ baseUrl: this.config.unifi.baseUrl }, 'UniFi skill enabled');
    }

    this.logger.info({ skills: skillRegistry.getAll().map(s => s.metadata.name) }, 'Skills registered');

    // 5. Initialize speech-to-text (optional)
    let speechTranscriber: SpeechTranscriber | undefined;
    if (this.config.speech?.apiKey) {
      speechTranscriber = new SpeechTranscriber(
        this.config.speech,
        this.logger.child({ component: 'speech' }),
      );
      this.logger.info({ provider: this.config.speech.provider }, 'Speech-to-text initialized');
    }

    // 5b. Initialize text-to-speech (optional)
    if (this.config.speech?.ttsEnabled) {
      const synthesizer = new SpeechSynthesizer(
        this.config.speech,
        this.logger.child({ component: 'tts' }),
      );
      skillRegistry.register(new TTSSkill(synthesizer));
      this.logger.info('Text-to-speech skill registered');
    }

    // 6. Create conversation manager and pipeline
    const conversationManager = new ConversationManager(conversationRepo);
    // Derive inbox path from storage path (e.g. ./data/alfred.db → ./data/inbox)
    const inboxPath = path.resolve(path.dirname(this.config.storage.path), 'inbox');
    this.pipeline = new MessagePipeline({
      llm: llmProvider,
      conversationManager,
      users: userRepo,
      logger: this.logger.child({ component: 'pipeline' }),
      skillRegistry,
      skillSandbox,
      securityManager,
      memoryRepo,
      speechTranscriber,
      inboxPath,
      embeddingService,
      activeLearning,
      memoryRetriever,
    });

    // 6. Initialize reminder scheduler
    this.reminderScheduler = new ReminderScheduler(
      reminderRepo,
      async (platform, chatId, text) => {
        const adapter = this.adapters.get(platform);
        if (adapter) {
          await adapter.sendMessage(chatId, text);
        } else {
          this.logger.warn({ platform, chatId }, 'No adapter for reminder platform');
        }
      },
      this.logger.child({ component: 'reminders' }),
      15_000,
      {
        getMasterUserId: (userId) => userRepo.getMasterUserId(userId),
        getLinkedUsers: (masterUserId) => userRepo.getLinkedUsers(masterUserId),
        findConversation: (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId),
      },
    );

    // 7b. Initialize background task runner
    this.backgroundTaskRunner = new BackgroundTaskRunner(
      skillRegistry,
      skillSandbox,
      backgroundTaskRepo,
      this.adapters,
      this.logger.child({ component: 'background-tasks' }),
    );

    // 7c. Initialize proactive scheduler
    this.proactiveScheduler = new ProactiveScheduler(
      scheduledActionRepo,
      skillRegistry,
      skillSandbox,
      llmProvider,
      this.adapters,
      this.logger.child({ component: 'proactive-scheduler' }),
      this.pipeline,
      this.formatter,
    );

    // 8. Initialize messaging adapters
    await this.initializeAdapters();

    this.logger.info('Alfred initialized');
  }

  private async initializeAdapters(): Promise<void> {
    const { config } = this;

    if (config.telegram.enabled && config.telegram.token) {
      const { TelegramAdapter } = await import('@alfred/messaging');
      this.adapters.set('telegram', new TelegramAdapter(config.telegram.token));
      this.logger.info('Telegram adapter registered');
    }

    if (config.discord?.enabled && config.discord.token) {
      const { DiscordAdapter } = await import('@alfred/messaging');
      this.adapters.set('discord', new DiscordAdapter(config.discord.token));
      this.logger.info('Discord adapter registered');
    }

    if (config.whatsapp?.enabled) {
      const { WhatsAppAdapter } = await import('@alfred/messaging');
      this.adapters.set('whatsapp', new WhatsAppAdapter(config.whatsapp.dataPath));
      this.logger.info('WhatsApp adapter registered');
    }

    if (config.matrix?.enabled && config.matrix.accessToken) {
      const { MatrixAdapter } = await import('@alfred/messaging');
      this.adapters.set('matrix', new MatrixAdapter(
        config.matrix.homeserverUrl,
        config.matrix.accessToken,
        config.matrix.userId,
      ));
      this.logger.info('Matrix adapter registered');
    }

    if (config.signal?.enabled && config.signal.phoneNumber) {
      const { SignalAdapter } = await import('@alfred/messaging');
      this.adapters.set('signal', new SignalAdapter(
        config.signal.apiUrl,
        config.signal.phoneNumber,
      ));
      this.logger.info('Signal adapter registered');
    }

    if (config.api?.enabled !== false) {
      const { HttpAdapter } = await import('@alfred/messaging');
      const port = config.api?.port ?? 3420;
      const host = config.api?.host ?? '127.0.0.1';
      this.adapters.set('api', new HttpAdapter(port, host));
      this.logger.info({ port, host }, 'HTTP API adapter registered');
    }
  }

  async start(): Promise<void> {
    this.logger.info('Starting Alfred...');

    for (const [platform, adapter] of this.adapters) {
      this.setupAdapterHandlers(platform, adapter);
      await adapter.connect();
      this.logger.info({ platform }, 'Adapter connected');
    }

    // Start schedulers
    this.reminderScheduler?.start();
    this.backgroundTaskRunner?.start();
    this.proactiveScheduler?.start();

    if (this.adapters.size === 0) {
      this.logger.warn('No messaging adapters enabled. Configure at least one platform.');
    }

    this.logger.info(`Alfred is running with ${this.adapters.size} adapter(s)`);
  }

  async startWithCLI(): Promise<void> {
    // Clear any adapters registered during initialize() — CLI mode
    // should NOT start Telegram/Discord/etc. to avoid conflicts
    // with a running `alfred start` instance.
    this.adapters.clear();

    const { CLIAdapter } = await import('@alfred/messaging');
    const cli = new CLIAdapter();
    this.adapters.set('cli', cli);
    this.setupAdapterHandlers('cli', cli);
    cli.on('disconnected', () => {
      this.stop().then(() => process.exit(0));
    });
    await this.start();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Alfred...');

    // Stop schedulers
    this.reminderScheduler?.stop();
    this.backgroundTaskRunner?.stop();
    this.proactiveScheduler?.stop();

    // Shutdown MCP servers
    if (this.mcpManager) {
      await this.mcpManager.shutdown();
    }

    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
        this.logger.info({ platform }, 'Adapter disconnected');
      } catch (error) {
        this.logger.error({ platform, err: error }, 'Failed to disconnect adapter');
      }
    }

    this.database.close();
    this.logger.info('Alfred stopped');
  }

  async reloadService(service: 'proxmox' | 'unifi'): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Reload .env → process.env updated
      reloadDotenv();

      // 2. Reload config from env + yaml
      const freshConfig = new ConfigLoader().loadConfig();

      // 3. Unregister old skill if present
      if (this.skillRegistry.has(service)) {
        this.skillRegistry.unregister(service);
      }

      // 4. Register new skill if config is present
      if (service === 'proxmox' && freshConfig.proxmox) {
        const { ProxmoxSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new ProxmoxSkill(freshConfig.proxmox));
        this.config.proxmox = freshConfig.proxmox;
        this.logger.info({ baseUrl: freshConfig.proxmox.baseUrl }, 'Proxmox skill hot-reloaded');
      }
      if (service === 'unifi' && freshConfig.unifi) {
        const { UniFiSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new UniFiSkill(freshConfig.unifi));
        this.config.unifi = freshConfig.unifi;
        this.logger.info({ baseUrl: freshConfig.unifi.baseUrl }, 'UniFi skill hot-reloaded');
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, service }, 'Failed to hot-reload service');
      return { success: false, error: message };
    }
  }

  private autoLinkApiUser(message: NormalizedMessage): void {
    if (message.platform !== 'api') return;

    try {
      const apiUser = this.userRepo.findOrCreate('api', message.userId, message.userName);
      const masterUserId = this.userRepo.getMasterUserId(apiUser.id);

      // Already linked to another user
      if (masterUserId !== apiUser.id) return;

      // Find the first non-API/non-CLI user to link with
      const existingUser = this.userRepo.findFirstByPlatformNotIn(['api', 'cli']);
      if (existingUser) {
        const targetMasterId = this.userRepo.getMasterUserId(existingUser.id);
        this.userRepo.setMasterUser(apiUser.id, targetMasterId);
        this.logger.info({ apiUserId: apiUser.id, masterUserId: targetMasterId }, 'Auto-linked API user');
      }
    } catch (err) {
      this.logger.debug({ err }, 'Auto-link API user failed');
    }
  }

  private setupAdapterHandlers(platform: Platform, adapter: MessagingAdapter): void {
    adapter.on('message', async (message: NormalizedMessage) => {
      try {
        // Auto-link API user with existing platform user
        this.autoLinkApiUser(message);

        // Send a placeholder message and update it with progress
        let statusMessageId: string | undefined;
        let lastStatus = '';

        const onProgress = async (status: string) => {
          if (status === lastStatus) return;
          lastStatus = status;
          try {
            if (!statusMessageId) {
              statusMessageId = await adapter.sendMessage(message.chatId, status);
            } else {
              await adapter.editMessage(message.chatId, statusMessageId, status);
            }
          } catch (err) {
            this.logger.debug({ err, chatId: message.chatId }, 'Status message edit failed');
          }
        };

        const result = await this.pipeline.process(message, onProgress);
        const formatted = this.formatter.format(result.text, message.platform);
        const sendOpts = formatted.parseMode !== 'text'
          ? { parseMode: formatted.parseMode as 'markdown' | 'html' }
          : undefined;

        // Replace status message with final response, or send new if no status was shown.
        // For the API adapter, always use sendMessage so the client receives a 'response' event.
        try {
          if (statusMessageId && platform !== 'api') {
            try {
              await adapter.editMessage(message.chatId, statusMessageId, formatted.text, sendOpts);
            } catch (err) {
              this.logger.debug({ err, chatId: message.chatId }, 'Final response edit failed, sending as new message');
              await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
            }
          } else {
            await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
          }
        } catch (fmtErr) {
          // HTML/Markdown parsing failed (e.g. stray < in text) — retry as plain text
          this.logger.warn({ err: fmtErr, chatId: message.chatId }, 'Formatted send failed, retrying as plain text');
          const plain = this.formatter.format(result.text, 'signal'); // strips all formatting
          await adapter.sendMessage(message.chatId, plain.text);
        }

        // Send file attachments (e.g. from code_sandbox) after the text reply
        if (result.attachments) {
          for (const att of result.attachments) {
            try {
              const isImage = att.mimeType.startsWith('image/');
              const isVoice = att.mimeType === 'audio/ogg' || att.mimeType === 'audio/opus';
              if (isImage) {
                await adapter.sendPhoto(message.chatId, att.data, att.fileName);
              } else if (isVoice) {
                await adapter.sendVoice(message.chatId, att.data);
              } else {
                await adapter.sendFile(message.chatId, att.data, att.fileName);
              }
            } catch (err) {
              this.logger.warn({ err, fileName: att.fileName, chatId: message.chatId }, 'Failed to send attachment');
            }
          }
        }

        // Signal end of stream (closes SSE for HttpAdapter, no-op for others)
        adapter.endStream(message.chatId);
      } catch (error) {
        this.logger.error({ platform, err: error, chatId: message.chatId }, 'Failed to handle message');
        try {
          await adapter.sendMessage(message.chatId, 'Sorry, I encountered an error processing your message. Please try again.');
        } catch (sendError) {
          this.logger.error({ err: sendError }, 'Failed to send error message');
        }
        adapter.endStream(message.chatId);
      }
    });

    adapter.on('error', (error: Error) => {
      this.logger.error({ platform, err: error }, 'Adapter error');
    });

    adapter.on('connected', () => {
      this.logger.info({ platform }, 'Adapter connected');
    });

    adapter.on('disconnected', () => {
      this.logger.warn({ platform }, 'Adapter disconnected');
    });
  }

  private loadSecurityRules(): SecurityRule[] {
    const rulesPath = path.resolve(this.config.security.rulesPath);
    const rules: SecurityRule[] = [];

    if (!fs.existsSync(rulesPath)) {
      this.logger.warn({ rulesPath }, 'Security rules directory not found, using default deny');
      return rules;
    }

    const stat = fs.statSync(rulesPath);
    if (!stat.isDirectory()) {
      this.logger.warn({ rulesPath }, 'Security rules path is not a directory');
      return rules;
    }

    const files = fs.readdirSync(rulesPath).filter(
      f => f.endsWith('.yml') || f.endsWith('.yaml'),
    );

    for (const file of files) {
      try {
        const filePath = path.join(rulesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(content) as { rules?: SecurityRule[] };
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          rules.push(...parsed.rules);
          this.logger.info({ file, count: parsed.rules.length }, 'Loaded security rules');
        }
      } catch (err) {
        this.logger.error({ err, file }, 'Failed to load security rules file');
      }
    }

    return rules;
  }
}
