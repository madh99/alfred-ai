import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AlfredConfig, NormalizedMessage, Platform, SecurityRule } from '@alfred/types';
import type { Logger } from 'pino';
import type { MessagingAdapter } from '@alfred/messaging';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository, AuditRepository, MemoryRepository, ReminderRepository, NoteRepository, EmbeddingRepository, LinkTokenRepository, BackgroundTaskRepository, ScheduledActionRepository, DocumentRepository, TodoRepository, WatchRepository, SummaryRepository, UsageRepository, CalendarNotificationRepository, ConfirmationRepository, ActivityRepository, SkillHealthRepository, WorkflowRepository, FeedbackRepository } from '@alfred/storage';
import { ConfigLoader, reloadDotenv } from '@alfred/config';
import { createModelRouter } from '@alfred/llm';
import { RuleEngine, SecurityManager, RuleLoader } from '@alfred/security';
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
  WatchSkill,
  WorkflowSkill,
  DocumentSkill,
  TTSSkill,
  ImageGenerateSkill,
  TransitSkill,
  ConfigureSkill,
  TodoSkill,
  FeedReaderSkill,
} from '@alfred/skills';
import { ConversationManager } from './conversation-manager.js';
import { MessagePipeline } from './message-pipeline.js';
import { ReminderScheduler } from './reminder-scheduler.js';
import { SpeechTranscriber } from './speech-transcriber.js';
import { SpeechSynthesizer } from './speech-synthesizer.js';
import { ImageGenerator } from './image-generator.js';
import { TransitClient } from './transit-client.js';
import { ResponseFormatter } from './response-formatter.js';
import { EmbeddingService } from './embedding-service.js';
import { DocumentProcessor } from './document-processor.js';
import { BackgroundTaskRunner } from './background-task-runner.js';
import { PersistentAgentRunner } from './persistent-agent-runner.js';
import { ProactiveScheduler } from './proactive-scheduler.js';
import { WatchEngine } from './watch-engine.js';
import { ConfirmationQueue } from './confirmation-queue.js';
import { ActiveLearningService } from './active-learning/active-learning-service.js';
import { FeedbackService } from './feedback/feedback-service.js';
import { MemoryRetriever } from './active-learning/memory-retriever.js';
import { ConversationSummarizer } from './conversation-summarizer.js';
import { CalendarWatcher } from './calendar-watcher.js';
import { TodoWatcher } from './todo-watcher.js';
import { ActivityLogger } from './activity-logger.js';
import { SkillHealthTracker } from './skill-health-tracker.js';
import { WorkflowRunner } from './workflow-runner.js';
import { ReasoningEngine } from './reasoning-engine.js';

export class Alfred {
  private readonly logger: Logger;
  private database!: Database;
  private pipeline!: MessagePipeline;
  private llmProvider!: import('@alfred/llm').ModelRouter;
  private reminderScheduler?: ReminderScheduler;
  private backgroundTaskRunner?: BackgroundTaskRunner;
  private proactiveScheduler?: ProactiveScheduler;
  private watchEngine?: WatchEngine;
  private confirmationQueue?: ConfirmationQueue;
  private readonly adapters: Map<Platform, MessagingAdapter> = new Map();
  private readonly formatter = new ResponseFormatter();
  private userRepo!: UserRepository;
  private skillRegistry!: SkillRegistry;
  private mcpManager?: import('@alfred/skills').MCPManager;
  private calendarSkill?: any; // CalendarSkill instance for today's events
  private calendarWatcher?: CalendarWatcher;
  private todoWatcher?: TodoWatcher;
  private reasoningEngine?: ReasoningEngine;
  private usageRepo?: UsageRepository;
  private auditRepo?: AuditRepository;
  private summaryRepo?: SummaryRepository;
  private activityRepo?: ActivityRepository;
  private memoryRepo?: MemoryRepository;
  private watchRepo?: WatchRepository;
  private scheduledActionRepo?: ScheduledActionRepository;
  private skillHealthRepo?: SkillHealthRepository;
  private clusterManager?: import('./cluster/cluster-manager.js').ClusterManager;
  private webAuthCallback?: {
    loginWithCode: (code: string) => { success: boolean; userId?: string; username?: string; role?: string; token?: string; error?: string };
    getUserByToken: (token: string) => { userId: string; username: string; role: string } | null;
  };
  private reminderRepo?: ReminderRepository;
  private skillHealthTracker?: SkillHealthTracker;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private readonly startedAt = new Date().toISOString();

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
    this.auditRepo = auditRepo;
    const memoryRepo = new MemoryRepository(db);
    this.memoryRepo = memoryRepo;
    const reminderRepo = new ReminderRepository(db);
    this.reminderRepo = reminderRepo;
    const noteRepo = new NoteRepository(db);
    const embeddingRepo = new EmbeddingRepository(db);
    const linkTokenRepo = new LinkTokenRepository(db);
    const backgroundTaskRepo = new BackgroundTaskRepository(db);
    const scheduledActionRepo = new ScheduledActionRepository(db);
    this.scheduledActionRepo = scheduledActionRepo;
    const activityRepo = new ActivityRepository(db);
    this.activityRepo = activityRepo;
    const activityLogger = new ActivityLogger(activityRepo, this.logger.child({ component: 'activity' }));
    const skillHealthRepo = new SkillHealthRepository(db);
    this.skillHealthRepo = skillHealthRepo;
    const skillHealthTracker = new SkillHealthTracker(
      skillHealthRepo,
      this.logger.child({ component: 'skill-health' }),
      activityLogger,
    );
    this.skillHealthTracker = skillHealthTracker;
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
    const llmProvider = createModelRouter(this.config.llm, this.logger.child({ component: 'llm' }));
    await llmProvider.initialize();
    this.llmProvider = llmProvider;

    // Wire SQLite usage persistence
    const usageRepo = new UsageRepository(db);
    this.usageRepo = usageRepo;
    llmProvider.setPersist((model, inp, out, cacheR, cacheW, cost) => {
      usageRepo.record(model, inp, out, cacheR, cacheW, cost);
    });

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

    // 3c. Conversation summarizer
    const summaryRepo = new SummaryRepository(db);
    this.summaryRepo = summaryRepo;
    const conversationSummarizer = new ConversationSummarizer(
      llmProvider,
      summaryRepo,
      this.logger.child({ component: 'summarizer' }),
    );
    this.logger.info('Conversation summarizer initialized');

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
    const todoRepo = new TodoRepository(db);
    skillRegistry.register(new TodoSkill(todoRepo));
    skillRegistry.register(new WeatherSkill());
    skillRegistry.register(new ShellSkill());
    skillRegistry.register(new MemorySkill(memoryRepo, embeddingService));
    skillRegistry.register(new DelegateSkill(llmProvider, skillRegistry, skillSandbox, securityManager));
    // 4a-email. Initialize email (optional, multi-account)
    if (this.config.email?.accounts?.length) {
      const providers = new Map<string, import('@alfred/skills').EmailProvider>();
      for (const account of this.config.email.accounts) {
        try {
          // Share Microsoft credentials from calendar if not set
          if (account.provider === 'microsoft' && !account.microsoft?.clientId) {
            if (this.config.calendar?.microsoft) {
              account.microsoft = { ...this.config.calendar.microsoft };
            }
          }
          const provider = await createEmailProvider(account);
          providers.set(account.name, provider);
          this.logger.info({ account: account.name, provider: account.provider ?? 'imap-smtp' }, 'Email account initialized');
        } catch (err) {
          this.logger.warn({ err, account: account.name }, 'Email account initialization failed, skipping');
        }
      }
      const emailSkill = providers.size > 0 ? new EmailSkill(providers) : new EmailSkill();
      emailSkill.setLLM(llmProvider);
      skillRegistry.register(emailSkill);
    } else {
      const emailSkill = new EmailSkill();
      emailSkill.setLLM(llmProvider);
      skillRegistry.register(emailSkill);
    }
    skillRegistry.register(new HttpSkill());
    skillRegistry.register(new FileSkill());
    const configureSkill = new ConfigureSkill();
    configureSkill.setReloadCallback((service) => this.reloadService(service as 'proxmox' | 'unifi' | 'homeassistant' | 'todo'));
    skillRegistry.register(configureSkill);
    skillRegistry.register(new ClipboardSkill());
    skillRegistry.register(new ScreenshotSkill());
    skillRegistry.register(new BrowserSkill());
    skillRegistry.register(new ProfileSkill(userRepo));
    skillRegistry.register(new CrossPlatformSkill(userRepo, linkTokenRepo, this.adapters, (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId)));
    const backgroundTaskSkill = new BackgroundTaskSkill(backgroundTaskRepo);
    skillRegistry.register(backgroundTaskSkill);
    skillRegistry.register(new ScheduledTaskSkill(scheduledActionRepo));

    // 4a. Document intelligence
    const documentRepo = new DocumentRepository(db);
    const documentProcessor = new DocumentProcessor(documentRepo, embeddingService, this.logger.child({ component: 'documents' }));
    skillRegistry.register(new DocumentSkill(documentRepo, documentProcessor, embeddingService));

    // 4b. Initialize calendar (optional)
    let calendarSkill: CalendarSkill | undefined;
    let calendarProvider: import('@alfred/skills').CalendarProvider | undefined;
    if (this.config.calendar) {
      try {
        calendarProvider = await createCalendarProvider(this.config.calendar);
        calendarSkill = new CalendarSkill(calendarProvider);
        skillRegistry.register(calendarSkill);
        this.logger.info({ provider: this.config.calendar.provider }, 'Calendar initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Calendar initialization failed, continuing without calendar');
      }
    }
    this.calendarSkill = calendarSkill;

    // 4b2. Initialize calendar vorlauf watcher (optional)
    if (calendarProvider && this.config.calendar?.vorlauf?.enabled) {
      const calNotifRepo = new CalendarNotificationRepository(db);
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId) {
        this.calendarWatcher = new CalendarWatcher(
          calendarProvider,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          'telegram' as Platform,
          this.config.calendar.vorlauf,
          this.logger.child({ component: 'calendar-watcher' }),
          activityLogger,
        );
      }
    }

    // 4b3. Initialize todo watcher — reminds about upcoming/overdue todos
    {
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId) {
        const calNotifRepo = new CalendarNotificationRepository(db);
        this.todoWatcher = new TodoWatcher(
          todoRepo,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          'telegram' as Platform,
          { minutesBefore: 30 },
          this.logger.child({ component: 'todo-watcher' }),
          activityLogger,
        );
      }
    }


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

    // 4e2. Project agent (optional, requires code agents)
    if (this.config.projectAgents?.enabled && this.config.codeAgents?.agents) {
      const { ProjectAgentSkill } = await import('@alfred/skills');
      const { ProjectAgentSessionRepository } = await import('@alfred/storage');
      const projectSessionRepo = new ProjectAgentSessionRepository(db);
      const projectAgentSkill = new ProjectAgentSkill(
        { ...this.config.projectAgents, agents: this.config.codeAgents.agents },
        llmProvider,
        projectSessionRepo,
      );

      // Wire the runner and connect it to the skill
      const { ProjectAgentRunner } = await import('./project-agent-runner.js');
      const projectRunner = new ProjectAgentRunner(
        new Map(this.config.codeAgents.agents.map(a => [a.name, a])),
        llmProvider,
        projectSessionRepo,
        this.adapters,
        this.logger.child({ component: 'project-agent' }),
      );
      projectAgentSkill.setRunner(projectRunner);

      skillRegistry.register(projectAgentSkill);
      this.logger.info('Project agent skill enabled');
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

    // 4h. Home Assistant (optional)
    if (this.config.homeassistant) {
      const { HomeAssistantSkill } = await import('@alfred/skills');
      skillRegistry.register(new HomeAssistantSkill(this.config.homeassistant));
      this.logger.info({ baseUrl: this.config.homeassistant.baseUrl }, 'Home Assistant skill enabled');
    }

    // 4i. Contacts (optional)
    if (this.config.contacts) {
      try {
        const { ContactsSkill, createContactsProvider } = await import('@alfred/skills');
        const contactsProvider = await createContactsProvider(this.config.contacts);
        skillRegistry.register(new ContactsSkill(contactsProvider));
        this.logger.info({ provider: this.config.contacts.provider }, 'Contacts skill enabled');
      } catch (err) {
        this.logger.warn({ err }, 'Contacts initialization failed, continuing without contacts');
      }
    }

    // 4j. Docker (optional — auto-detect socket if no explicit config)
    if (this.config.docker) {
      const { DockerSkill } = await import('@alfred/skills');
      skillRegistry.register(new DockerSkill(this.config.docker));
      this.logger.info('Docker skill enabled');
    }

    // 4k. BMW CarData (optional)
    if (this.config.bmw) {
      const { BMWSkill } = await import('@alfred/skills');
      skillRegistry.register(new BMWSkill(this.config.bmw));
      this.logger.info('BMW CarData skill enabled');
    }

    // 4l. Routing (optional)
    if (this.config.routing) {
      const { RoutingSkill } = await import('@alfred/skills');
      skillRegistry.register(new RoutingSkill(this.config.routing));
      this.logger.info('Routing skill enabled');
    }

    // 4m. Microsoft To Do (optional)
    if (this.config.todo) {
      const { MicrosoftTodoSkill } = await import('@alfred/skills');
      skillRegistry.register(new MicrosoftTodoSkill(this.config.todo));
      this.logger.info('Microsoft To Do skill enabled');
    }

    // 4n. Infrastructure Monitor (auto-enabled when any infra skill is configured)
    if (this.config.proxmox || this.config.unifi || this.config.homeassistant || this.config.proxmoxBackup) {
      const { MonitorSkill } = await import('@alfred/skills');
      skillRegistry.register(new MonitorSkill({
        proxmox: this.config.proxmox,
        unifi: this.config.unifi,
        homeassistant: this.config.homeassistant,
        proxmoxBackup: this.config.proxmoxBackup,
      }));
      this.logger.info('Infrastructure monitor skill enabled');
    }

    // 4o. Energy price / aWATTar (always available, config optional for grid costs)
    {
      const { EnergyPriceSkill } = await import('@alfred/skills');
      skillRegistry.register(new EnergyPriceSkill(this.config.energy));
      this.logger.info({ grid: this.config.energy?.gridName }, 'Energy price skill registered');
    }

    // 4p. Marketplace (willhaben + eBay — willhaben always available, eBay needs credentials)
    {
      const { MarketplaceSkill } = await import('@alfred/skills');
      skillRegistry.register(new MarketplaceSkill(this.config.marketplace));
      this.logger.info('Marketplace skill registered');
    }

    // 4q. Briefing (always available — gathers data from registered skills, reads memories for addresses)
    {
      const { BriefingSkill } = await import('@alfred/skills');
      skillRegistry.register(new BriefingSkill(skillRegistry, this.config, memoryRepo));
      this.logger.info('Briefing skill registered');
    }

    // 4s. Feed reader (always available — stores subscriptions in memory)
    skillRegistry.register(new FeedReaderSkill(memoryRepo));
    this.logger.info('Feed reader skill registered');

    // 4t. User Management (always available)
    {
      const { AlfredUserRepository } = await import('@alfred/storage');
      const { UserManagementSkill } = await import('@alfred/skills');
      const alfredUserRepo = new AlfredUserRepository(db);

      // Auto-create admin user from ownerUserId if not exists
      // Link to ALL enabled platforms (not just Telegram)
      if (this.config.security?.ownerUserId) {
        const ownerUid = this.config.security.ownerUserId;
        const admins = alfredUserRepo.getAll().filter(u => u.role === 'admin');
        let adminUser = admins[0];

        if (!adminUser) {
          adminUser = alfredUserRepo.create({ username: 'admin', role: 'admin', displayName: 'Admin' });
          alfredUserRepo.clearInviteCode(adminUser.id);
          this.logger.info({ userId: ownerUid }, 'Auto-created admin user from ownerUserId');
        }

        // Link to all configured platforms with the ownerUserId
        const platforms = ['telegram', 'discord', 'matrix', 'signal', 'api'] as const;
        for (const platform of platforms) {
          const existing = alfredUserRepo.getUserByPlatform(platform, ownerUid);
          if (!existing) {
            try { alfredUserRepo.linkPlatform(adminUser.id, platform, ownerUid); } catch { /* already linked */ }
          }
        }
      }

      skillRegistry.register(new UserManagementSkill(alfredUserRepo));
      this.logger.info('User management skill registered');

      // Sharing skill
      const { SharingSkill } = await import('@alfred/skills');
      const { SharedResourceRepository } = await import('@alfred/storage');
      const sharedResourceRepo = new SharedResourceRepository(db);
      skillRegistry.register(new SharingSkill(sharedResourceRepo, alfredUserRepo));
      this.logger.info('Sharing skill registered');

      // Setup web auth callback for HTTP API login
      const webSessions = new Map<string, { userId: string; username: string; role: string }>();
      this.webAuthCallback = {
        loginWithCode: (code: string) => {
          const tempWebId = `web-pending-${Date.now()}`;
          const user = alfredUserRepo.consumeInviteCode(code, 'api', tempWebId);
          if (!user) return { success: false, error: 'Ungültiger oder abgelaufener Code' };

          const token = `alf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          webSessions.set(token, { userId: user.id, username: user.username, role: user.role });

          return { success: true, userId: user.id, username: user.username, role: user.role, token };
        },
        getUserByToken: (token: string) => webSessions.get(token) ?? null,
      };
    }

    // 4u. Database (optional)
    if (this.config.database?.enabled) {
      const { DatabaseSkill } = await import('@alfred/skills');
      const { DatabaseConnectionRepository } = await import('@alfred/storage');
      const dbConnRepo = new DatabaseConnectionRepository(db);
      const dbSkill = new DatabaseSkill(this.config.database, dbConnRepo);

      // Pre-load connections from config
      if (this.config.database.connections) {
        for (const conn of this.config.database.connections) {
          if (!dbConnRepo.getByName(conn.name)) {
            dbConnRepo.create({
              name: conn.name, type: conn.type, host: conn.host, port: conn.port,
              databaseName: conn.database, username: conn.username,
              authConfig: conn.password ? { password: conn.password } : undefined,
              options: { readOnly: conn.options?.readOnly ?? true, rowLimit: conn.options?.rowLimit, timeoutMs: conn.options?.timeoutMs },
            });
          }
        }
      }

      skillRegistry.register(dbSkill);
      this.logger.info('Database skill registered');
    }

    // 4u. YouTube (optional, requires API key)
    if (this.config.youtube?.apiKey) {
      const { YouTubeSkill } = await import('@alfred/skills');
      skillRegistry.register(new YouTubeSkill(this.config.youtube));
      this.logger.info('YouTube skill registered');
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

    // 5c. Initialize image generation (auto-detect from LLM config)
    const imageGenProvider = this.detectImageGenProvider();
    if (imageGenProvider) {
      const generator = new ImageGenerator(imageGenProvider, this.logger.child({ component: 'image-gen' }));
      skillRegistry.register(new ImageGenerateSkill(generator));
      this.logger.info({ provider: imageGenProvider.provider }, 'Image generation skill registered');
    }

    // 5d. Initialize public transit (always available, no config needed)
    try {
      const transitClient = new TransitClient(this.logger.child({ component: 'transit' }));
      skillRegistry.register(new TransitSkill(transitClient));
      this.logger.info('Public transit skill registered');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to register transit skill');
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
      maxHistoryMessages: this.config.conversation?.maxHistoryMessages ?? 100,
      documentProcessor,
      conversationSummarizer,
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
      userRepo,
      this.logger.child({ component: 'background-tasks' }),
      activityLogger,
      skillHealthTracker,
    );

    // 7b2. Initialize persistent agent runner (checkpoint/resume for long-running tasks)
    const persistentRunner = new PersistentAgentRunner(
      skillRegistry,
      skillSandbox,
      backgroundTaskRepo,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'persistent-agents' }),
      activityLogger,
    );
    this.backgroundTaskRunner.setPersistentRunner(persistentRunner);
    backgroundTaskSkill.setPersistentRunner(persistentRunner);

    // 7c. Initialize proactive scheduler
    this.proactiveScheduler = new ProactiveScheduler(
      scheduledActionRepo,
      skillRegistry,
      skillSandbox,
      llmProvider,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'proactive-scheduler' }),
      this.pipeline,
      this.formatter,
      conversationManager,
      activityLogger,
    );

    // 7d. Initialize watch engine (condition-based alerts)
    const watchRepo = new WatchRepository(db);
    this.watchRepo = watchRepo;
    skillRegistry.register(new WatchSkill(watchRepo, skillRegistry));

    // 7d. Initialize cluster manager BEFORE watch engine (for distributed locking)
    if (this.config.cluster?.enabled) {
      const { ClusterManager } = await import('./cluster/cluster-manager.js');
      this.clusterManager = new ClusterManager(
        this.config.cluster,
        this.logger.child({ component: 'cluster' }),
      );
      await this.clusterManager.connect();
      this.logger.info({ nodeId: this.config.cluster.nodeId, role: this.config.cluster.role }, 'Cluster manager initialized');
    }

    // 7e. Initialize confirmation queue (human-in-the-loop for watch actions)
    const confirmRepo = new ConfirmationRepository(db);
    this.confirmationQueue = new ConfirmationQueue(
      confirmRepo,
      skillRegistry,
      skillSandbox,
      this.adapters,
      this.logger.child({ component: 'confirmation-queue' }),
      activityLogger,
    );

    // 7e2. Initialize feedback service (rejection/correction tracking)
    const feedbackRepo = new FeedbackRepository(db);
    const feedbackService = new FeedbackService(
      feedbackRepo,
      memoryRepo,
      this.logger.child({ component: 'feedback' }),
    );
    this.confirmationQueue.setFeedbackService(feedbackService);
    if (activeLearning) {
      activeLearning.setFeedbackService(feedbackService);
    }

    this.watchEngine = new WatchEngine(
      watchRepo,
      skillRegistry,
      skillSandbox,
      this.adapters,
      userRepo,
      this.logger.child({ component: 'watch-engine' }),
      this.confirmationQueue,
      activityLogger,
      skillHealthTracker,
      llmProvider,
      this.clusterManager ?? undefined,
    );

    // 7f. Initialize workflow chains
    const workflowRepo = new WorkflowRepository(db);
    const workflowSkill = new WorkflowSkill(workflowRepo);
    skillRegistry.register(workflowSkill);
    const workflowRunner = new WorkflowRunner(
      workflowRepo,
      skillRegistry,
      skillSandbox,
      this.logger.child({ component: 'workflow-runner' }),
      activityLogger,
      skillHealthTracker,
    );
    workflowSkill.setRunner(workflowRunner);

    // 7g. Initialize reasoning engine — proactive cross-domain insights
    {
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId && this.config.reasoning?.enabled !== false) {
        const reasoningNotifRepo = new CalendarNotificationRepository(db);
        this.reasoningEngine = new ReasoningEngine(
          calendarProvider,
          todoRepo,
          watchRepo,
          memoryRepo,
          activityRepo,
          skillHealthRepo,
          reasoningNotifRepo,
          skillRegistry,
          skillSandbox,
          llmProvider,
          this.adapters,
          userRepo,
          ownerUserId,
          'telegram' as Platform,
          this.config.reasoning,
          this.logger.child({ component: 'reasoning-engine' }),
          activityLogger,
          this.config.briefing?.location,
          feedbackRepo,
          this.confirmationQueue,
        );
      }
    }

    // Wire confirmation queue, activity logger, and skill health tracker into pipeline
    this.pipeline.setConfirmationQueue(this.confirmationQueue);
    this.pipeline.setActivityLogger(activityLogger);
    this.pipeline.setSkillHealthTracker(skillHealthTracker);

    // 7b. Wire multi-user support into pipeline
    {
      // Reuse the alfredUserRepo from User Management skill init (same db handle)
      const { AlfredUserRepository, UsageRepository: UsageRepoClass } = await import('@alfred/storage');
      const { ROLE_SKILL_ACCESS } = await import('@alfred/skills');
      const pipelineUserRepo = new AlfredUserRepository(db);
      const { UserServiceResolver } = await import('./user-service-resolver.js');
      const serviceResolver = new UserServiceResolver(pipelineUserRepo);
      this.pipeline.setAlfredUserRepo(pipelineUserRepo, ROLE_SKILL_ACCESS, this.usageRepo, serviceResolver);
    }

    // 7c2. Wire cluster cross-node messaging (needs adapters to be populated later)
    if (this.clusterManager) {
      this.clusterManager.subscribe('messages', (data) => {
        const { targetPlatform, chatId, text } = data as { targetPlatform: string; chatId: string; text: string };
        const adapter = this.adapters.get(targetPlatform as any);
        if (adapter) {
          adapter.sendMessage(chatId, text).catch(err => {
            this.logger.warn({ err, targetPlatform, chatId }, 'Cross-node message delivery failed');
          });
        }
      });

      // Start UDP discovery broadcast if primary
      if (this.config.cluster?.role === 'primary') {
        const { ClusterDiscovery } = await import('./cluster/discovery.js');
        const discovery = new ClusterDiscovery(this.logger.child({ component: 'cluster-discovery' }));
        discovery.startBroadcasting({
          nodeId: this.config.cluster.nodeId,
          host: '0.0.0.0',
          port: this.config.api?.port ?? 3420,
          role: 'primary',
        });
      }
    }

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
      if (config.api?.token) {
        this.logger.info('HTTP API authentication enabled');
      } else {
        this.logger.warn('HTTP API has no authentication token configured (api.token). API is open.');
      }
      this.adapters.set('api', new HttpAdapter(port, host, {
        apiToken: config.api?.token,
        corsOrigin: config.api?.corsOrigin,
        tls: config.api?.tls,
        authCallback: this.webAuthCallback,
        healthCheck: () => {
          let diskUsage: { path: string; sizeBytes: number } | undefined;
          try {
            const dbPath = this.config.storage.path;
            const stat = fs.statSync(dbPath);
            diskUsage = { path: dbPath, sizeBytes: stat.size };
          } catch { /* ignore */ }

          return {
            db: !!this.database,
            uptime: Math.floor(process.uptime()),
            startedAt: this.startedAt,
            adapters: Object.fromEntries([...this.adapters].map(([p, a]) => [p, a.getStatus()])),
            metrics: this.pipeline.getMetrics(),
            costs: this.llmProvider.getCostSummary(),
            todayUsage: this.usageRepo?.getDaily(new Date().toISOString().slice(0, 10)),
            watchesActive: this.watchRepo?.countEnabled() ?? 0,
            schedulersActive: this.scheduledActionRepo?.countEnabled() ?? 0,
            llmProviders: this.llmProvider.getProviderStatuses(),
            diskUsage,
          };
        },
        metricsCallback: () => this.buildPrometheusMetrics(),
        dashboardCallback: () => {
          const today = new Date().toISOString().slice(0, 10);
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
          return {
            watches: this.watchRepo?.getEnabled() ?? [],
            scheduled: this.scheduledActionRepo?.getAll() ?? [],
            skillHealth: this.skillHealthRepo?.getAll() ?? [],
            reminders: this.reminderRepo?.getAllPending() ?? [],
            usage: {
              today: this.usageRepo?.getDaily(today) ?? null,
              week: this.usageRepo?.getRange(weekAgo, today) ?? [],
              total: this.usageRepo?.getTotal() ?? [],
            },
            uptime: Math.floor(process.uptime()),
            startedAt: this.startedAt,
            adapters: Object.fromEntries(
              [...this.adapters.entries()].map(([p, a]) => [p, a.getStatus()]),
            ),
            llmProviders: this.llmProvider.getProviderStatuses(),
            userUsage: this.usageRepo?.getByUser(weekAgo, today) ?? [],
            userSkillUsage: this.activityRepo?.skillUsageByUser(weekAgo) ?? [],
          };
        },
        webUiPath: config.api?.webUi !== false ? this.resolveWebUiPath() : undefined,
      }));
      this.logger.info({ port, host, webUi: config.api?.webUi !== false }, 'HTTP API adapter registered');
    }
  }

  async start(): Promise<void> {
    this.logger.info('Starting Alfred...');

    for (const [platform, adapter] of this.adapters) {
      this.setupAdapterHandlers(platform, adapter);
      try {
        await adapter.connect();
        this.logger.info({ platform }, 'Adapter connected');
      } catch (err) {
        this.logger.error({ platform, err }, 'Adapter connection failed — skipping');
      }
    }

    // Start schedulers
    this.reminderScheduler?.start();
    this.backgroundTaskRunner?.start();
    this.proactiveScheduler?.start();
    this.watchEngine?.start();
    this.confirmationQueue?.start();
    this.calendarWatcher?.start();
    this.todoWatcher?.start();
    this.reasoningEngine?.start();

    // Wire inbound webhooks (if configured)
    if (this.config.webhooks?.length && this.watchEngine) {
      const apiAdapter = this.adapters.get('api');
      if (apiAdapter && 'addWebhook' in apiAdapter) {
        const httpAdapter = apiAdapter as import('@alfred/messaging').HttpAdapter;
        for (const wh of this.config.webhooks) {
          httpAdapter.addWebhook({
            name: wh.name,
            secret: wh.secret,
            callback: async (payload) => {
              if (wh.watchId && this.watchEngine) {
                await this.watchEngine.triggerWatch(wh.watchId);
              }
              // Optionally send payload info to chat
              if (wh.chatId && wh.platform) {
                const adapter = this.adapters.get(wh.platform as Platform);
                if (adapter) {
                  const summary = `🔔 Webhook "${wh.name}" triggered` + (payload.action ? `: ${payload.action}` : '');
                  await adapter.sendMessage(wh.chatId, summary);
                }
              }
            },
          });
          this.logger.info({ name: wh.name, watchId: wh.watchId }, 'Webhook registered');
        }
      }
    }

    // Startup cleanup — retain audit/summary/activity/usage data
    try {
      const cleaned = {
        audit: this.auditRepo?.cleanup(90) ?? 0,
        summaries: this.summaryRepo?.cleanup(180) ?? 0,
        activity: this.activityRepo?.cleanup(90) ?? 0,
        usage: this.usageRepo?.cleanup(365) ?? 0,
        expiredMemories: this.memoryRepo?.cleanupExpired() ?? 0,
      };
      if (cleaned.audit || cleaned.summaries || cleaned.activity || cleaned.usage) {
        this.logger.info(cleaned, 'Startup DB cleanup completed');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Startup DB cleanup failed');
    }

    // Skill health: periodic re-enable check (every 5 minutes)
    if (this.skillHealthTracker) {
      this.healthCheckTimer = setInterval(() => this.skillHealthTracker!.checkReEnables(), 5 * 60_000);
    }

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
    this.watchEngine?.stop();
    this.confirmationQueue?.stop();
    this.calendarWatcher?.stop();
    this.todoWatcher?.stop();
    this.reasoningEngine?.stop();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Shutdown MCP servers
    if (this.mcpManager) {
      await this.mcpManager.shutdown();
    }

    // Disconnect adapters with individual timeouts
    const adapterTimeout = 5_000;
    for (const [platform, adapter] of this.adapters) {
      try {
        await Promise.race([
          adapter.disconnect(),
          new Promise(resolve => setTimeout(resolve, adapterTimeout)),
        ]);
        this.logger.info({ platform }, 'Adapter disconnected');
      } catch (error) {
        this.logger.error({ platform, err: error }, 'Failed to disconnect adapter');
      }
    }

    // WAL checkpoint before close
    try {
      if (this.database) {
        this.database.getDb().pragma('wal_checkpoint(TRUNCATE)');
        this.database.close();
      }
    } catch {}
    this.logger.info('Alfred stopped');
  }

  async reloadService(service: 'proxmox' | 'unifi' | 'homeassistant' | 'contacts' | 'docker' | 'bmw' | 'routing' | 'todo'): Promise<{ success: boolean; error?: string }> {
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
      if (service === 'homeassistant' && freshConfig.homeassistant) {
        const { HomeAssistantSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new HomeAssistantSkill(freshConfig.homeassistant));
        this.config.homeassistant = freshConfig.homeassistant;
        this.logger.info({ baseUrl: freshConfig.homeassistant.baseUrl }, 'Home Assistant skill hot-reloaded');
      }
      if (service === 'contacts' && freshConfig.contacts) {
        const { ContactsSkill, createContactsProvider } = await import('@alfred/skills');
        const contactsProvider = await createContactsProvider(freshConfig.contacts);
        this.skillRegistry.register(new ContactsSkill(contactsProvider));
        this.config.contacts = freshConfig.contacts;
        this.logger.info({ provider: freshConfig.contacts.provider }, 'Contacts skill hot-reloaded');
      }
      if (service === 'docker' && freshConfig.docker) {
        const { DockerSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new DockerSkill(freshConfig.docker));
        this.config.docker = freshConfig.docker;
        this.logger.info('Docker skill hot-reloaded');
      }
      if (service === 'bmw' && freshConfig.bmw) {
        const { BMWSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new BMWSkill(freshConfig.bmw));
        this.config.bmw = freshConfig.bmw;
        this.logger.info('BMW CarData skill hot-reloaded');
      }
      if (service === 'routing' && freshConfig.routing) {
        const { RoutingSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new RoutingSkill(freshConfig.routing));
        this.config.routing = freshConfig.routing;
        this.logger.info('Routing skill hot-reloaded');
      }
      if (service === 'todo' && freshConfig.todo) {
        const { MicrosoftTodoSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new MicrosoftTodoSkill(freshConfig.todo));
        this.config.todo = freshConfig.todo;
        this.logger.info('Microsoft To Do skill hot-reloaded');
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, service }, 'Failed to hot-reload service');
      return { success: false, error: message };
    }
  }

  private resolveWebUiPath(): string | undefined {
    // ESM-safe: use import.meta.url instead of __dirname
    let selfDir: string;
    try {
      selfDir = path.dirname(new URL(import.meta.url).pathname);
      // Windows: remove leading slash from /C:/...
      if (process.platform === 'win32' && selfDir.startsWith('/')) selfDir = selfDir.slice(1);
    } catch {
      selfDir = process.cwd();
    }

    const candidates = [
      path.join(process.cwd(), 'web-ui'),                     // CWD/web-ui (manual deploy)
      path.join(selfDir, '..', 'web-ui'),                     // bundle/index.js → bundle/web-ui/
      path.join(selfDir, 'web-ui'),                            // same dir as bundle
      path.join(selfDir, '..', '..', 'web-ui'),               // global npm package
      path.join(selfDir, '..', '..', 'apps', 'web', 'out'),   // monorepo dev
    ];
    for (const candidate of candidates) {
      try {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(path.join(resolved, 'index.html'))) {
          this.logger.info({ path: resolved }, 'Web UI found');
          return resolved;
        }
      } catch { /* skip */ }
    }
    this.logger.debug('Web UI not found — serving API only');
    return undefined;
  }

  private buildPrometheusMetrics(): string {
    const lines: string[] = [];
    const uptime = Math.floor(process.uptime());

    // Process info
    lines.push('# HELP alfred_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE alfred_uptime_seconds gauge');
    lines.push(`alfred_uptime_seconds ${uptime}`);

    // Pipeline metrics (in-memory, current session)
    const m = this.pipeline.getMetrics();
    lines.push('# HELP alfred_requests_total Total messages processed');
    lines.push('# TYPE alfred_requests_total counter');
    lines.push(`alfred_requests_total ${m.requestsTotal}`);
    lines.push('# HELP alfred_requests_success_total Successful requests');
    lines.push('# TYPE alfred_requests_success_total counter');
    lines.push(`alfred_requests_success_total ${m.requestsSuccess}`);
    lines.push('# HELP alfred_requests_failed_total Failed requests');
    lines.push('# TYPE alfred_requests_failed_total counter');
    lines.push(`alfred_requests_failed_total ${m.requestsFailed}`);
    lines.push('# HELP alfred_request_duration_avg_ms Average request duration');
    lines.push('# TYPE alfred_request_duration_avg_ms gauge');
    lines.push(`alfred_request_duration_avg_ms ${m.avgDurationMs}`);

    // Session token/cost metrics
    const costs = this.llmProvider.getCostSummary();
    lines.push('# HELP alfred_llm_input_tokens_total Total LLM input tokens (session)');
    lines.push('# TYPE alfred_llm_input_tokens_total counter');
    lines.push(`alfred_llm_input_tokens_total ${costs.totalInputTokens}`);
    lines.push('# HELP alfred_llm_output_tokens_total Total LLM output tokens (session)');
    lines.push('# TYPE alfred_llm_output_tokens_total counter');
    lines.push(`alfred_llm_output_tokens_total ${costs.totalOutputTokens}`);
    lines.push('# HELP alfred_llm_cost_usd_total Total LLM cost in USD (session)');
    lines.push('# TYPE alfred_llm_cost_usd_total counter');
    lines.push(`alfred_llm_cost_usd_total ${costs.totalCostUsd}`);

    // Per-model breakdown
    lines.push('# HELP alfred_llm_calls_total LLM calls by model');
    lines.push('# TYPE alfred_llm_calls_total counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      const label = `model="${model}"`;
      lines.push(`alfred_llm_calls_total{${label}} ${entry.calls}`);
    }
    lines.push('# HELP alfred_llm_cost_usd LLM cost by model');
    lines.push('# TYPE alfred_llm_cost_usd counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_cost_usd{model="${model}"} ${entry.costUsd}`);
    }
    lines.push('# HELP alfred_llm_input_tokens LLM input tokens by model');
    lines.push('# TYPE alfred_llm_input_tokens counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_input_tokens{model="${model}"} ${entry.inputTokens}`);
    }
    lines.push('# HELP alfred_llm_output_tokens LLM output tokens by model');
    lines.push('# TYPE alfred_llm_output_tokens counter');
    for (const [model, entry] of Object.entries(costs.byModel)) {
      lines.push(`alfred_llm_output_tokens{model="${model}"} ${entry.outputTokens}`);
    }

    // Watches & scheduled actions
    if (this.watchRepo) {
      lines.push('# HELP alfred_watches_active Number of enabled watches');
      lines.push('# TYPE alfred_watches_active gauge');
      lines.push(`alfred_watches_active ${this.watchRepo.countEnabled()}`);
    }
    if (this.scheduledActionRepo) {
      lines.push('# HELP alfred_schedulers_active Number of enabled scheduled actions');
      lines.push('# TYPE alfred_schedulers_active gauge');
      lines.push(`alfred_schedulers_active ${this.scheduledActionRepo.countEnabled()}`);
    }

    // Persisted daily totals from SQLite
    if (this.usageRepo) {
      const today = new Date().toISOString().slice(0, 10);
      const daily = this.usageRepo.getDaily(today);
      lines.push('# HELP alfred_llm_today_cost_usd Total LLM cost today (persisted)');
      lines.push('# TYPE alfred_llm_today_cost_usd gauge');
      lines.push(`alfred_llm_today_cost_usd ${daily.totalCostUsd}`);
      lines.push('# HELP alfred_llm_today_calls Total LLM calls today (persisted)');
      lines.push('# TYPE alfred_llm_today_calls gauge');
      lines.push(`alfred_llm_today_calls ${daily.totalCalls}`);
    }

    lines.push('');
    return lines.join('\n');
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
            if (platform === 'api') {
              // API adapter: always use editMessage (sends 'status' SSE event, not 'response')
              await adapter.editMessage(message.chatId, statusMessageId ?? '', status);
            } else if (!statusMessageId) {
              statusMessageId = await adapter.sendMessage(message.chatId, status);
            } else {
              await adapter.editMessage(message.chatId, statusMessageId, status);
            }
          } catch (err) {
            this.logger.debug({ err, chatId: message.chatId }, 'Status message edit failed');
          }
        };

        const result = await this.pipeline.process(message, onProgress);

        // Group privacy: redirect sensitive skill responses to DM
        const PRIVATE_SKILLS = new Set([
          'email', 'calendar', 'contacts', 'bmw', 'todo', 'microsoft_todo',
          'database', 'memory', 'note', 'reminder', 'file', 'shell',
        ]);
        const isGroup = message.chatType === 'group';
        const usedPrivateSkill = isGroup && result.usedSkills?.some(s => PRIVATE_SKILLS.has(s));

        if (usedPrivateSkill && result.text) {
          // Send response as DM instead of in the group
          try {
            const formatted = this.formatter.format(result.text, message.platform);
            const sendOpts = formatted.parseMode !== 'text'
              ? { parseMode: formatted.parseMode as 'markdown' | 'html' }
              : undefined;
            await adapter.sendMessage(message.userId, formatted.text, sendOpts);
            // Notify the group
            await adapter.sendMessage(message.chatId, `@${message.userName ?? message.userId}, Antwort per DM gesendet (persönliche Daten).`);
          } catch (err) {
            this.logger.warn({ err, chatId: message.chatId }, 'Group privacy DM redirect failed, sending in group');
            // Fallback: send in group anyway
            const formatted = this.formatter.format(result.text, message.platform);
            await adapter.sendMessage(message.chatId, formatted.text);
          }
          // Send attachments via DM too
          if (result.attachments) {
            for (const att of result.attachments) {
              try {
                await adapter.sendFile(message.userId, att.data, att.fileName);
              } catch { /* skip */ }
            }
          }
          adapter.endStream(message.chatId);
          return;
        }

        // Empty text means the message was handled internally (e.g. confirmation response)
        // — skip sending to avoid empty Telegram messages
        if (result.text) {
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
        }

        // Send file attachments (e.g. from code_sandbox) after the text reply
        if (result.attachments) {
          for (const att of result.attachments) {
            try {
              const isImage = att.mimeType?.startsWith('image/') ?? false;
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

  private detectImageGenProvider(): { provider: 'openai' | 'google'; apiKey: string; baseUrl?: string } | undefined {
    const tiers = ['default', 'strong', 'fast', 'embeddings', 'local'] as const;
    // Prefer OpenAI (better image quality), then Google
    for (const preferred of ['openai', 'google'] as const) {
      for (const tier of tiers) {
        const tierConfig = this.config.llm[tier];
        if (tierConfig?.provider === preferred && tierConfig.apiKey) {
          return { provider: preferred, apiKey: tierConfig.apiKey, baseUrl: tierConfig.baseUrl };
        }
      }
    }
    return undefined;
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
        const parsed = yaml.load(content) as { rules?: unknown[] };
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          const ruleLoader = new RuleLoader();
          const validated = ruleLoader.loadFromObject({ rules: parsed.rules });
          rules.push(...validated);
          this.logger.info({ file, count: validated.length }, 'Loaded security rules');
        }
      } catch (err) {
        this.logger.error({ err, file }, 'Failed to load security rules file');
      }
    }

    return rules;
  }
}
