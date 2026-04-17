import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AlfredConfig, NormalizedMessage, Platform, SecurityRule } from '@alfred/types';
import type { Logger } from 'pino';
import type { MessagingAdapter } from '@alfred/messaging';
import { createLogger } from '@alfred/logger';
import { Database, ConversationRepository, UserRepository, AuditRepository, MemoryRepository, ReminderRepository, NoteRepository, EmbeddingRepository, LinkTokenRepository, BackgroundTaskRepository, ScheduledActionRepository, DocumentRepository, TodoRepository, WatchRepository, SummaryRepository, UsageRepository, CalendarNotificationRepository, ConfirmationRepository, ActivityRepository, SkillHealthRepository, WorkflowRepository, FeedbackRepository, SkillStateRepository, KnowledgeGraphRepository, BmwTelematicRepository, ServiceUsageRepository, CmdbRepository, ItsmRepository, type AsyncDbAdapter } from '@alfred/storage';
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
  VoiceSkill,
  ImageGenerateSkill,
  TransitSkill,
  ConfigureSkill,
  TodoSkill,
  FeedReaderSkill,
  HelpSkill,
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
import { MemoryConsolidator } from './active-learning/memory-consolidator.js';
import { PatternAnalyzer } from './active-learning/pattern-analyzer.js';
import { TemporalAnalyzer } from './active-learning/temporal-analyzer.js';
import { KnowledgeGraphService } from './knowledge-graph.js';
import { ActionFeedbackTracker } from './action-feedback-tracker.js';
import { ConversationSummarizer } from './conversation-summarizer.js';
import { CalendarWatcher } from './calendar-watcher.js';
import { TodoWatcher } from './todo-watcher.js';
import { ActivityLogger } from './activity-logger.js';
import { SkillHealthTracker } from './skill-health-tracker.js';
import { WorkflowRunner } from './workflow-runner.js';
import { ScriptExecutor } from './workflow/script-executor.js';
import { DbQueryExecutor } from './workflow/db-query-executor.js';
import { PromptParser } from './workflow/prompt-parser.js';
import { TriggerManager } from './workflow/trigger-manager.js';
import { GuardEvaluator } from './workflow/guard-evaluator.js';
import { ReasoningEngine } from './reasoning-engine.js';
import { InsightTracker } from './insight-tracker.js';
import { ReflectionEngine } from './reflection-engine.js';
import { resolveReflectionConfig } from './reflection/index.js';

/** Get ISO week number for a date. */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export class Alfred {
  private readonly logger: Logger;
  private database!: Database;
  private pipeline!: MessagePipeline;
  private llmProvider!: import('@alfred/llm').ModelRouter;
  private reminderScheduler?: ReminderScheduler;
  private backgroundTaskRunner?: BackgroundTaskRunner;
  private proactiveScheduler?: ProactiveScheduler;
  private watchEngine?: WatchEngine;
  private triggerManager?: TriggerManager;
  private confirmationQueue?: ConfirmationQueue;
  private readonly adapters: Map<Platform, MessagingAdapter> = new Map();
  private readonly formatter = new ResponseFormatter();
  private userRepo!: UserRepository;
  private skillRegistry!: SkillRegistry;
  private skillSandbox?: SkillSandbox;
  private mcpManager?: import('@alfred/skills').MCPManager;
  private calendarSkill?: CalendarSkill;
  private calendarWatcher?: CalendarWatcher;
  private todoWatcher?: TodoWatcher;
  private reasoningEngine?: ReasoningEngine;
  private reflectionEngine?: ReflectionEngine;
  private usageRepo?: UsageRepository;
  private serviceUsageRepo?: ServiceUsageRepository;
  private auditRepo?: AuditRepository;
  private summaryRepo?: SummaryRepository;
  private activityRepo?: ActivityRepository;
  private memoryRepo?: MemoryRepository;
  private watchRepo?: WatchRepository;
  private scheduledActionRepo?: ScheduledActionRepository;
  private skillHealthRepo?: SkillHealthRepository;
  private clusterManager?: import('./cluster/cluster-manager.js').ClusterManager;
  private adapterClaimManager?: import('./adapter-claim-manager.js').AdapterClaimManager;
  private webAuthCallback?: {
    loginWithCode: (code: string) => Promise<{ success: boolean; userId?: string; username?: string; role?: string; token?: string; error?: string }>;
    getUserByToken: (token: string) => Promise<{ userId: string; username: string; role: string } | null>;
  };
  private reminderRepo?: ReminderRepository;
  private spotifySkill?: import('@alfred/skills').SpotifySkill;
  private bmwSkill?: import('@alfred/skills').BMWSkill;
  private bmwTelematicRepo?: BmwTelematicRepository;
  private memorySkillRef?: MemorySkill;
  private kgServiceRef?: import('./knowledge-graph.js').KnowledgeGraphService;
  private sonosSkill?: import('@alfred/skills').SonosSkill;
  private skillHealthTracker?: SkillHealthTracker;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private memoryConsolidatorTimer?: ReturnType<typeof setInterval>;
  private patternAnalyzerTimer?: ReturnType<typeof setInterval>;
  private temporalAnalyzerTimer?: ReturnType<typeof setInterval>;
  private insightExpiryTimer?: ReturnType<typeof setInterval>;
  private clusterMonitorTimer?: ReturnType<typeof setInterval>;
  private cmdbDiscoveryTimer?: ReturnType<typeof setInterval>;
  private cmdbHealthCheckTimer?: ReturnType<typeof setInterval>;
  private insightTracker?: InsightTracker;
  private ownerMasterUserId?: string;
  private userServiceResolverRef?: { getServiceConfig: Function; getUserServices: Function; saveServiceConfig: Function; removeServiceConfig: Function };
  private readonly startedAt = new Date().toISOString();

  constructor(private config: AlfredConfig) {
    this.logger = createLogger('alfred', config.logger.level);
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Alfred...');

    // 1. Initialize storage
    this.database = await Database.create({
      backend: this.config.storage.backend ?? 'sqlite',
      path: this.config.storage.path,
      connectionString: this.config.storage.connectionString,
    });
    const adapter = this.database.getAdapter();
    const conversationRepo = new ConversationRepository(adapter);
    const userRepo = new UserRepository(adapter);
    this.userRepo = userRepo;
    const auditRepo = new AuditRepository(adapter);
    this.auditRepo = auditRepo;
    const memoryRepo = new MemoryRepository(adapter);
    this.memoryRepo = memoryRepo;
    const skillStateRepo = new SkillStateRepository(adapter);
    const reminderRepo = new ReminderRepository(adapter);
    this.reminderRepo = reminderRepo;
    const noteRepo = new NoteRepository(adapter);
    const embeddingRepo = new EmbeddingRepository(adapter);
    const linkTokenRepo = new LinkTokenRepository(adapter);
    const backgroundTaskRepo = new BackgroundTaskRepository(adapter);
    const scheduledActionRepo = new ScheduledActionRepository(adapter);
    this.scheduledActionRepo = scheduledActionRepo;
    const activityRepo = new ActivityRepository(adapter);
    this.activityRepo = activityRepo;
    const activityLogger = new ActivityLogger(activityRepo, this.logger.child({ component: 'activity' }));
    const skillHealthRepo = new SkillHealthRepository(adapter);
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
    const usageRepo = new UsageRepository(adapter);
    this.usageRepo = usageRepo;
    llmProvider.setPersist((model, inp, out, cacheR, cacheW, cost) => {
      usageRepo.record(model, inp, out, cacheR, cacheW, cost).catch(() => {});
    });

    // Service usage tracking (STT, TTS, OCR, Moderation)
    const serviceUsageRepo = new ServiceUsageRepository(adapter);
    this.serviceUsageRepo = serviceUsageRepo;

    // Create embedding service
    const embeddingService = new EmbeddingService(
      llmProvider,
      embeddingRepo,
      this.logger.child({ component: 'embeddings' }),
    );

    // Validate embedding model consistency — invalidate + re-embed if model changed
    const embeddingModelName = this.config.llm.embeddings?.model
      ?? this.config.llm.default?.model
      ?? 'unknown';
    if (llmProvider.supportsEmbeddings()) {
      try {
        const deleted = await embeddingService.validateModelConsistency(embeddingModelName);
        if (deleted > 0) {
          // Re-embed all memories in the background (non-blocking)
          setTimeout(async () => {
            try {
              const users = await userRepo.listAll();
              let total = 0;
              for (const user of users) {
                const memories = await memoryRepo.listAll(user.id);
                for (const mem of memories) {
                  await embeddingService.embedAndStore(
                    user.id,
                    `${mem.key}: ${mem.value}`,
                    'memory',
                    mem.id,
                  );
                  total++;
                }
              }
              this.logger.info(
                { count: total, model: embeddingModelName },
                'Re-embedded all memories with new model',
              );
            } catch (err) {
              this.logger.error({ err }, 'Background re-embedding failed');
            }
          }, 5000);
        }
      } catch (err) {
        this.logger.error({ err }, 'Embedding model consistency check failed');
      }
    }

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
    const summaryRepo = new SummaryRepository(adapter);
    this.summaryRepo = summaryRepo;
    const conversationSummarizer = new ConversationSummarizer(
      llmProvider,
      summaryRepo,
      this.logger.child({ component: 'summarizer' }),
    );
    this.logger.info('Conversation summarizer initialized');

    // 4. Initialize skills
    const skillSandbox = this.skillSandbox = new SkillSandbox(
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
    const noteSkill = new NoteSkill(noteRepo);
    skillRegistry.register(noteSkill);
    const todoRepo = new TodoRepository(adapter);
    const todoSkill = new TodoSkill(todoRepo);
    skillRegistry.register(todoSkill);
    skillRegistry.register(new WeatherSkill());
    skillRegistry.register(new ShellSkill());
    const memorySkill = new MemorySkill(memoryRepo, embeddingService);
    skillRegistry.register(memorySkill);
    this.memorySkillRef = memorySkill;
    skillRegistry.register(new DelegateSkill(llmProvider, skillRegistry, skillSandbox, securityManager));

    // 3b. Brainstorming skill
    {
      const { BrainstormingSkill } = await import('@alfred/skills');
      const { BrainstormingRepository } = await import('@alfred/storage');
      const brainstormRepo = new BrainstormingRepository(adapter);
      const brainstormSkill = new BrainstormingSkill(brainstormRepo);
      // Wire KG context fetcher
      brainstormSkill.setKgContextFn(async (_userId: string, topic: string) => {
        if (!this.kgServiceRef) return '';
        // Always use ownerMasterUserId — alfredUserId is different from KG user_id
        const resolvedUid = this.ownerMasterUserId ?? _userId;
        const graph = await new KnowledgeGraphRepository(adapter).getFullGraph(resolvedUid);
        const topicLower = topic.toLowerCase();
        const relevant = graph.entities.filter(e =>
          e.name.toLowerCase().includes(topicLower) ||
          e.normalizedName.includes(topicLower) ||
          (e.attributes?.value && String(e.attributes.value).toLowerCase().includes(topicLower)),
        );
        // Also get entities connected to relevant ones
        const relevantIds = new Set(relevant.map(e => e.id));
        const connectedRelations = graph.relations.filter(r => relevantIds.has(r.sourceEntityId) || relevantIds.has(r.targetEntityId));
        const connectedIds = new Set<string>();
        for (const r of connectedRelations) { connectedIds.add(r.sourceEntityId); connectedIds.add(r.targetEntityId); }
        const allRelevant = graph.entities.filter(e => relevantIds.has(e.id) || connectedIds.has(e.id));

        const lines = allRelevant.slice(0, 20).map(e => {
          const attrs = Object.entries(e.attributes ?? {}).filter(([k]) => !['skillName', 'type', 'memoryKey', 'memoryConfidence'].includes(k)).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
          return `- [${e.entityType}] ${e.name}${attrs ? ` (${attrs})` : ''}`;
        });
        const relLines = connectedRelations.slice(0, 15).map(r => {
          const src = allRelevant.find(e => e.id === r.sourceEntityId)?.name ?? '?';
          const tgt = allRelevant.find(e => e.id === r.targetEntityId)?.name ?? '?';
          return `- ${src} → ${r.relationType} → ${tgt}`;
        });
        // Also fetch relevant memories
        let memContext = '';
        try {
          const mems = await memoryRepo.search(resolvedUid, topic);
          memContext = mems.slice(0, 5).map(m => `- [memory] ${m.key}: ${m.value.slice(0, 100)}`).join('\n');
        } catch { /* skip */ }

        return `Entities:\n${lines.join('\n')}\n\nRelationen:\n${relLines.join('\n')}${memContext ? `\n\nMemories:\n${memContext}` : ''}`;
      });
      // Wire LLM call
      brainstormSkill.setLlmCallFn(async (prompt: string, tier: 'default' | 'strong') => {
        const response = await llmProvider.complete({
          messages: [{ role: 'user', content: prompt }],
          tier,
          maxTokens: 2000,
        });
        return response.content;
      });
      skillRegistry.register(brainstormSkill);
      this.logger.info('Brainstorming skill registered');
    }

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
    configureSkill.setHealthAdapter(skillHealthTracker);
    skillRegistry.register(configureSkill);
    skillRegistry.register(new ClipboardSkill());
    skillRegistry.register(new ScreenshotSkill());
    skillRegistry.register(new BrowserSkill());
    skillRegistry.register(new ProfileSkill(userRepo));
    const crossPlatformSkill = new CrossPlatformSkill(userRepo, linkTokenRepo, this.adapters, (platform, userId) => conversationRepo.findByPlatformAndUser(platform, userId));
    skillRegistry.register(crossPlatformSkill);
    const backgroundTaskSkill = new BackgroundTaskSkill(backgroundTaskRepo);
    skillRegistry.register(backgroundTaskSkill);
    skillRegistry.register(new ScheduledTaskSkill(scheduledActionRepo));

    // 4a. Document intelligence
    const documentRepo = new DocumentRepository(adapter);
    const documentProcessor = new DocumentProcessor(documentRepo, embeddingService, this.logger.child({ component: 'documents' }));

    // 4a-ocr. Wire up Mistral OCR if a Mistral LLM provider is configured
    const mistralApiKey = this.detectMistralApiKey();
    if (mistralApiKey) {
      const { OcrService } = await import('@alfred/skills');
      const ocrService = new OcrService(mistralApiKey);
      ocrService.setUsageCallback((model, units) => {
        serviceUsageRepo.record('ocr', model, units).catch(() => {});
      });
      documentProcessor.setOcrService(ocrService);
      this.logger.info('Mistral OCR enabled for document processing');
    }

    // SharedResourceRepo for document sharing — created later, set after user management init
    const documentSkill = new DocumentSkill(documentRepo, documentProcessor, embeddingService);
    skillRegistry.register(documentSkill);

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

    // Determine the default platform for proactive notifications (watchers, reasoning)
    const defaultProactivePlatform = ([...this.adapters.keys()][0] ?? 'telegram') as Platform;

    // 4b2. Initialize calendar vorlauf watcher (optional)
    if (calendarProvider && this.config.calendar?.vorlauf?.enabled) {
      const calNotifRepo = new CalendarNotificationRepository(adapter);
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId) {
        this.calendarWatcher = new CalendarWatcher(
          calendarProvider,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          defaultProactivePlatform,
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
        const calNotifRepo = new CalendarNotificationRepository(adapter);
        this.todoWatcher = new TodoWatcher(
          todoRepo,
          calNotifRepo,
          this.adapters,
          ownerUserId,
          defaultProactivePlatform,
          { minutesBefore: 30 },
          this.logger.child({ component: 'todo-watcher' }),
          activityLogger,
          ownerUserId,
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
      const { ProjectAgentSkill, setInterjectionRepo } = await import('@alfred/skills');
      const { ProjectAgentSessionRepository, ProjectAgentInterjectionRepository } = await import('@alfred/storage');
      const projectSessionRepo = new ProjectAgentSessionRepository(adapter);
      setInterjectionRepo(new ProjectAgentInterjectionRepository(adapter));
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
        this.config.codeAgents.forge,
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
      this.bmwSkill = new BMWSkill(this.config.bmw);
      skillRegistry.register(this.bmwSkill);
      this.logger.info('BMW CarData skill enabled');
    }

    // 4l. go-e Charger (optional)
    if (this.config.goeCharger?.host) {
      const { GoeChargerSkill } = await import('@alfred/skills');
      skillRegistry.register(new GoeChargerSkill(this.config.goeCharger, this.config.energy));
      this.logger.info({ host: this.config.goeCharger.host }, 'go-e Charger skill registered');
    }

    // 4m. Routing (optional)
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

    // OneDrive (uses same MS Graph token as Microsoft Todo)
    if (this.config.todo) {
      const { OneDriveSkill } = await import('@alfred/skills');
      skillRegistry.register(new OneDriveSkill(this.config.todo));
      this.logger.info('OneDrive skill registered');
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

    // 4p2. Crypto price (CoinGecko — always available, no API key needed)
    {
      const { CryptoPriceSkill } = await import('@alfred/skills');
      skillRegistry.register(new CryptoPriceSkill());
      this.logger.info('Crypto price skill registered');
    }

    // 4p3. Bitpanda (portfolio — always registered, API key optional for ticker)
    {
      const { BitpandaSkill } = await import('@alfred/skills');
      skillRegistry.register(new BitpandaSkill(this.config.bitpanda));
      this.logger.info({ hasApiKey: !!this.config.bitpanda?.apiKey }, 'Bitpanda skill registered');
    }

    // 4p4. Trading / CCXT (exchange trading — registered if exchanges configured)
    if (this.config.trading?.exchanges && Object.keys(this.config.trading.exchanges).length > 0) {
      const { TradingSkill } = await import('@alfred/skills');
      skillRegistry.register(new TradingSkill(this.config.trading));
      this.logger.info({ exchanges: Object.keys(this.config.trading.exchanges) }, 'Trading skill registered');
    }

    // Recipe
    {
      const { RecipeSkill } = await import('@alfred/skills');
      const { RecipeFavoriteRepository, MealPlanRepository, AlfredUserRepository } = await import('@alfred/storage');
      const recipeFavRepo = new RecipeFavoriteRepository(adapter);
      const mealPlanRepo = new MealPlanRepository(adapter);
      const recipeUserRepo = new AlfredUserRepository(adapter);
      skillRegistry.register(new RecipeSkill(this.config.recipe, {
        favorites: recipeFavRepo,
        mealPlans: mealPlanRepo,
        userRepo: recipeUserRepo,
      }));
      this.logger.info({
        hasSpoonacular: !!this.config.recipe?.spoonacular?.apiKey,
        hasEdamam: !!this.config.recipe?.edamam?.appId,
      }, 'Recipe skill registered');
    }

    // 4p5. Spotify (playback, search, playlists — needs client ID, OAuth PKCE)
    if (this.config.spotify?.clientId) {
      const { SpotifySkill } = await import('@alfred/skills');
      const apiPublicUrl = this.config.api?.publicUrl ?? `http://${this.config.api?.host ?? 'localhost'}:${this.config.api?.port ?? 3420}`;
      this.spotifySkill = new SpotifySkill(this.config.spotify, apiPublicUrl);
      skillRegistry.register(this.spotifySkill);
      this.logger.info('Spotify skill registered');
    }

    // Sonos (always registered — local discovery needs no config)
    {
      const { SonosSkill } = await import('@alfred/skills');
      const sonosApiUrl = this.config.api?.publicUrl ?? `http://${this.config.api?.host ?? 'localhost'}:${this.config.api?.port ?? 3420}`;
      this.sonosSkill = new SonosSkill(this.config.sonos, sonosApiUrl, memoryRepo, skillStateRepo);
      skillRegistry.register(this.sonosSkill);
      this.logger.info({ hasCloud: !!this.config.sonos?.cloud }, 'Sonos skill registered');
    }

    // Travel (requires at least one search API)
    if (this.config.travel?.booking?.rapidApiKey) {
      const { TravelSkill } = await import('@alfred/skills');
      const { TravelPlanRepository } = await import('@alfred/storage');
      const travelPlanRepo = new TravelPlanRepository(adapter);
      skillRegistry.register(new TravelSkill(this.config.travel, { plans: travelPlanRepo }));
      this.logger.info({
        hasFlights: true,
        hasHotels: true,
      }, 'Travel skill registered');
    }

    // MQTT (requires broker URL)
    if (this.config.mqtt?.brokerUrl) {
      const { MqttSkill } = await import('@alfred/skills');
      skillRegistry.register(new MqttSkill(this.config.mqtt));
      this.logger.info({ broker: this.config.mqtt.brokerUrl }, 'MQTT skill registered');
    }

    // 4o2. Cloudflare DNS (optional)
    if (this.config.cloudflare?.apiToken) {
      const { CloudflareDnsSkill } = await import('@alfred/skills');
      skillRegistry.register(new CloudflareDnsSkill(this.config.cloudflare));
      this.logger.info('Cloudflare DNS skill registered');
    }

    // 4o3. Nginx Proxy Manager (optional)
    if (this.config.nginxProxyManager?.baseUrl) {
      const { NginxProxyManagerSkill } = await import('@alfred/skills');
      skillRegistry.register(new NginxProxyManagerSkill(this.config.nginxProxyManager));
      this.logger.info({ baseUrl: this.config.nginxProxyManager.baseUrl }, 'Nginx Proxy Manager skill registered');
    }

    // 4o4. pfSense Firewall (optional)
    if (this.config.pfsense?.baseUrl) {
      const { PfSenseSkill } = await import('@alfred/skills');
      skillRegistry.register(new PfSenseSkill(this.config.pfsense));
      this.logger.info({ baseUrl: this.config.pfsense.baseUrl, auth: this.config.pfsense.authMethod ?? 'apikey' }, 'pfSense Firewall skill registered');
    }

    // 4o5. Deploy Skill (always available — uses SSH + orchestration)
    {
      const { DeploySkill } = await import('@alfred/skills');
      const deploySkill = new DeploySkill(this.config.infra);
      // Wire orchestration callbacks for full_deploy
      const orchCallbacks: Record<string, ((input: Record<string, unknown>) => Promise<any>) | undefined> = {};
      if (skillRegistry.has('proxmox')) orchCallbacks.proxmox = (i) => skillSandbox.execute(skillRegistry.get('proxmox')!, i, {} as any);
      if (skillRegistry.has('cloudflare_dns')) orchCallbacks.cloudflare = (i) => skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, i, {} as any);
      if (skillRegistry.has('nginx_proxy_manager')) orchCallbacks.npm = (i) => skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, i, {} as any);
      if (skillRegistry.has('pfsense')) orchCallbacks.firewall = (i) => skillSandbox.execute(skillRegistry.get('pfsense')!, i, {} as any);
      if (skillRegistry.has('unifi')) orchCallbacks.unifi = (i) => skillSandbox.execute(skillRegistry.get('unifi')!, i, {} as any);
      deploySkill.setOrchestrationCallbacks(orchCallbacks);
      skillRegistry.register(deploySkill);
      this.logger.info('Deploy skill registered (with orchestration)');

      // 4o5-mikrotik. MikroTik RouterOS (optional — before CMDB so discovery source is available)
      if (this.config.mikrotik?.enabled) {
        const { MikroTikSkill } = await import('@alfred/skills');
        const mtSkill = new MikroTikSkill(this.config.mikrotik);
        skillRegistry.register(mtSkill);
        this.logger.info('MikroTik skill registered');
      }

      // 4o6. CMDB + ITSM + InfraDocs (auto-enabled when any infra skill is configured)
      if (this.config.cmdb?.enabled !== false && (this.config.proxmox || this.config.unifi || this.config.docker || this.config.cloudflare || this.config.nginxProxyManager || this.config.pfsense || this.config.homeassistant || this.config.mikrotik)) {
        const cmdbRepo = new CmdbRepository(adapter);
        const itsmRepo = new ItsmRepository(adapter);
        itsmRepo.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const { ProblemRepository } = await import('@alfred/storage');
        const problemRepo = new ProblemRepository(adapter);

        const { CmdbSkill, ItsmSkill, InfraDocsSkill } = await import('@alfred/skills');
        const cmdbSkill = new CmdbSkill(cmdbRepo, this.config.cmdb?.staleThresholdDays ?? 7);
        const itsmSkill = new ItsmSkill(itsmRepo, cmdbRepo, problemRepo);
        const infraDocsSkill = new InfraDocsSkill(cmdbRepo, itsmRepo);

        // Wire LLM callback for ITSM service description parsing + doc generation
        itsmSkill.setLlmCallback(async (prompt: string, tier?: string) => {
          if (!this.llmProvider) throw new Error('LLM nicht verfügbar');
          const res = await this.llmProvider.complete({ messages: [{ role: 'user', content: prompt }], tier: (tier as any) ?? 'default', maxTokens: 3000 });
          return res.content;
        });

        // Wire LLM callback for runbook generation
        infraDocsSkill.setLlmCallback(async (prompt: string, tier?: string) => {
          if (!this.llmProvider) throw new Error('LLM nicht verfügbar');
          const res = await this.llmProvider.complete({ messages: [{ role: 'user', content: prompt }], tier: (tier as any) ?? 'default', maxTokens: 3000 });
          return res.content;
        });

        // Wire SSH callback for deep system scans
        if (skillRegistry.has('shell')) {
          infraDocsSkill.setSshCallback(async (host: string, command: string) => {
            const shellSkill = skillRegistry.get('shell')!;
            const sshCmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${this.config.infra?.sshUser ? this.config.infra.sshUser + '@' : ''}${host} '${command.replace(/'/g, "'\\''")}'`;
            const result = await skillSandbox.execute(shellSkill, { command: sshCmd }, { userId: '', platform: 'api', chatId: '', conversationId: '' } as any);
            const data = result.data as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
            console.log(`[ssh-cb] success=${result.success} exit=${data?.exitCode} stdout=${(data?.stdout ?? '').length}b stderr=${(data?.stderr ?? '').slice(0, 80)} cmd=${command.slice(0, 60)}`);
            if (!result.success) return '';
            return data?.stdout ?? result.display ?? '';
          });
        }

        // Wire discovery sources from registered infra skills
        const wrapSkillAsSource = (skillName: string, discoverFn: () => Promise<{ assets: any[]; relations: any[] }>) => {
          if (skillRegistry.has(skillName)) cmdbSkill.registerDiscoverySource(skillName, discoverFn);
        };

        wrapSkillAsSource('proxmox', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const pxSkill = skillRegistry.get('proxmox')!;
          const nodeIpMap = new Map<string, string>(); // node name → IP from cluster/status
          let clusterSourceId: string | undefined;
          try {
            // 1. Cluster status (optional — fails gracefully on single-node)
            try {
              const clusterResult = await skillSandbox.execute(pxSkill, { action: 'cluster_status' }, {} as any);
              if (clusterResult.success && Array.isArray(clusterResult.data)) {
                const clusterEntry = (clusterResult.data as any[]).find((e: any) => e.type === 'cluster');
                if (clusterEntry) {
                  clusterSourceId = `cluster:${clusterEntry.name}`;
                  assets.push({
                    name: clusterEntry.name, assetType: 'cluster', sourceSkill: 'proxmox', sourceId: clusterSourceId,
                    status: clusterEntry.quorate ? 'active' : 'degraded',
                    attributes: { nodes: clusterEntry.nodes, version: clusterEntry.version, quorate: clusterEntry.quorate },
                  });
                }
                // Extract node IPs from cluster/status node entries
                for (const entry of clusterResult.data as any[]) {
                  if (entry.type === 'node' && entry.name && entry.ip) {
                    nodeIpMap.set(entry.name, entry.ip);
                  }
                }
              }
            } catch { /* single-node or cluster API not available */ }

            // 2. Nodes
            const nodesResult = await skillSandbox.execute(pxSkill, { action: 'list_nodes' }, {} as any);
            if (nodesResult.success && Array.isArray(nodesResult.data)) {
              for (const n of nodesResult.data) {
                assets.push({ name: n.node, assetType: 'server', sourceSkill: 'proxmox', sourceId: `node:${n.node}`, ipAddress: nodeIpMap.get(n.node), status: n.status === 'online' ? 'active' : 'inactive', attributes: { cpu: n.cpu, maxcpu: n.maxcpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime } });
                if (clusterSourceId) {
                  relations.push({ sourceKey: `proxmox:node:${n.node}`, targetKey: `proxmox:${clusterSourceId}`, relationType: 'part_of' as const });
                }
              }
            }

            // 3. Storage (cluster-wide)
            try {
              const storageResult = await skillSandbox.execute(pxSkill, { action: 'list_storage', node: '' }, {} as any);
              if (storageResult.success && Array.isArray(storageResult.data)) {
                for (const s of storageResult.data as any[]) {
                  if (s.enabled === false || s.enabled === 0) continue;
                  assets.push({
                    name: s.storage, assetType: 'storage', sourceSkill: 'proxmox', sourceId: `storage:${s.storage}`,
                    status: s.active ? 'active' : 'inactive',
                    attributes: { storageType: s.type, content: s.content, used: s.used, total: s.total },
                  });
                  // Shared storage → connects_to each node (cluster-wide storage has no node restriction)
                  // Node-specific storage from /nodes/{n}/storage would need per-node calls — skip for now
                  if (clusterSourceId) {
                    relations.push({ sourceKey: `proxmox:${clusterSourceId}`, targetKey: `proxmox:storage:${s.storage}`, relationType: 'connects_to' as const });
                  }
                }
              }
            } catch { /* storage listing failed */ }

            // 4. VMs/LXCs
            const vmsResult = await skillSandbox.execute(pxSkill, { action: 'list_vms' }, {} as any);
            if (vmsResult.success && Array.isArray(vmsResult.data)) {
              for (const v of vmsResult.data) {
                const type = v.type === 'lxc' ? 'lxc' : 'vm';
                let vmIp: string | undefined;
                let vmMac: string | undefined;
                // Try to get IP from VM config (LXC: net0 has ip=..., QEMU: net0 has MAC)
                try {
                  const configPath = type === 'lxc'
                    ? `/nodes/${v.node}/lxc/${v.vmid}/config`
                    : `/nodes/${v.node}/qemu/${v.vmid}/config`;
                  const cfgResult = await skillSandbox.execute(skillRegistry.get('proxmox')!, { action: 'api_raw', path: configPath }, {} as any);
                  const cfg = cfgResult.success ? cfgResult.data as Record<string, unknown> : null;
                  if (cfg) {
                    const net0 = String(cfg.net0 ?? '');
                    // LXC: ip=192.168.1.92/24
                    const ipMatch = net0.match(/ip=([0-9.]+)/);
                    if (ipMatch) vmIp = ipMatch[1];
                    // MAC: virtio=BC:24:11:...,bridge=... or hwaddr=BC:24:11:...
                    const macMatch = net0.match(/(?:virtio|hwaddr)=([0-9A-Fa-f:]+)/);
                    if (macMatch) vmMac = macMatch[1].toLowerCase();
                  }
                } catch { /* skip — config not accessible */ }
                // Try QEMU guest agent for running VMs without static IP
                if (!vmIp && type === 'vm' && v.status === 'running') {
                  try {
                    const agentResult = await skillSandbox.execute(skillRegistry.get('proxmox')!, { action: 'api_raw', path: `/nodes/${v.node}/qemu/${v.vmid}/agent/network-get-interfaces` }, {} as any);
                    if (agentResult.success && agentResult.data) {
                      const ifaces = (agentResult.data as any).result ?? agentResult.data;
                      if (Array.isArray(ifaces)) {
                        for (const iface of ifaces) {
                          const addrs = iface['ip-addresses'] ?? [];
                          for (const addr of addrs) {
                            if (addr['ip-address-type'] === 'ipv4' && !String(addr['ip-address']).startsWith('127.')) {
                              vmIp = addr['ip-address'];
                              break;
                            }
                          }
                          if (vmIp) break;
                        }
                      }
                    }
                  } catch { /* guest agent not available */ }
                }
                assets.push({ name: v.name || `${type}-${v.vmid}`, assetType: type, sourceSkill: 'proxmox', sourceId: `${v.node}:${v.vmid}`, identifier: `vmid:${v.vmid}`, ipAddress: vmIp, status: v.status === 'running' ? 'active' : 'inactive', attributes: { vmid: v.vmid, node: v.node, cpus: v.cpus, maxmem: v.maxmem, maxdisk: v.maxdisk, mac: vmMac } });
                relations.push({ sourceKey: `proxmox:${v.node}:${v.vmid}`, targetKey: `proxmox:node:${v.node}`, relationType: 'hosted_on' as const });
              }
            }
          } catch { /* skip source on error */ }
          return { assets, relations };
        });

        wrapSkillAsSource('docker', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const hostIp = this.config.docker?.host?.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
          try {
            const result = await skillSandbox.execute(skillRegistry.get('docker')!, { action: 'containers' }, {} as any);
            if (result.success && Array.isArray(result.data)) {
              for (const c of result.data) {
                const name = (c.Names?.[0] ?? c.Id ?? '').replace(/^\//, '');
                const sourceId = (c.Id ?? '').slice(0, 12);
                assets.push({ name, assetType: 'container', sourceSkill: 'docker', sourceId, status: c.State === 'running' ? 'active' : 'inactive', ipAddress: hostIp, attributes: { image: c.Image, status: c.Status, ports: c.Ports, host_ip: hostIp } });
                // Link container → host VM by IP match (resolved during CMDB upsert)
                if (hostIp) {
                  relations.push({ sourceKey: `docker:${sourceId}`, targetKey: `ip:${hostIp}`, relationType: 'runs_on' as const });
                }
              }
            }
          } catch { /* skip */ }
          return { assets, relations };
        });

        wrapSkillAsSource('unifi', async () => {
          const assets: any[] = [];
          try {
            const devResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_devices' }, {} as any);
            if (devResult.success && Array.isArray(devResult.data)) {
              for (const d of devResult.data) {
                assets.push({ name: d.name || d.mac, assetType: 'network_device', sourceSkill: 'unifi', sourceId: `device:${d.mac ?? d._id}`, ipAddress: d.ip, status: d.state === 1 ? 'active' : 'inactive', attributes: { mac: d.mac, model: d.model, type: d.type, version: d.version } });
              }
            }
            const netResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_networks' }, {} as any);
            if (netResult.success && Array.isArray(netResult.data)) {
              for (const n of netResult.data) {
                assets.push({ name: n.name || n._id, assetType: 'network', sourceSkill: 'unifi', sourceId: `net:${n._id}`, attributes: { vlan: n.vlan_enabled ? n.vlan : undefined, subnet: n.ip_subnet } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('cloudflare_dns', async () => {
          const assets: any[] = [];
          try {
            const zonesResult = await skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, { action: 'list_zones' }, {} as any);
            if (zonesResult.success && Array.isArray(zonesResult.data)) {
              for (const z of zonesResult.data) {
                const recsResult = await skillSandbox.execute(skillRegistry.get('cloudflare_dns')!, { action: 'list_records', domain: z.name }, {} as any);
                if (recsResult.success && Array.isArray(recsResult.data)) {
                  for (const r of recsResult.data) {
                    assets.push({ name: `${r.name} (${r.type})`, assetType: 'dns_record', sourceSkill: 'cloudflare_dns', sourceId: `${z.id}:${r.id}`, fqdn: r.name, attributes: { type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl, zone: z.name } });
                  }
                }
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('nginx_proxy_manager', async () => {
          const assets: any[] = [];
          try {
            const hostsResult = await skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, { action: 'list_hosts' }, {} as any);
            if (hostsResult.success && Array.isArray(hostsResult.data)) {
              for (const h of hostsResult.data) {
                assets.push({ name: h.domain_names?.[0] ?? `host-${h.id}`, assetType: 'proxy_host', sourceSkill: 'nginx_proxy_manager', sourceId: `host:${h.id}`, attributes: { domain_names: h.domain_names, forward_host: h.forward_host, forward_port: h.forward_port, forward_scheme: h.forward_scheme, ssl_forced: h.ssl_forced } });
              }
            }
            const certsResult = await skillSandbox.execute(skillRegistry.get('nginx_proxy_manager')!, { action: 'list_certificates' }, {} as any);
            if (certsResult.success && Array.isArray(certsResult.data)) {
              for (const c of certsResult.data) {
                assets.push({ name: c.nice_name || c.domain_names?.[0] || `cert-${c.id}`, assetType: 'certificate', sourceSkill: 'nginx_proxy_manager', sourceId: `cert:${c.id}`, attributes: { domain_names: c.domain_names, expires_on: c.expires_on, provider: c.provider } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('pfsense', async () => {
          const assets: any[] = [];
          const pfSkill = skillRegistry.get('pfsense')!;
          // Firewall Rules
          try {
            const rulesResult = await skillSandbox.execute(pfSkill, { action: 'list_rules' }, {} as any);
            if (rulesResult.success && Array.isArray(rulesResult.data)) {
              for (const r of rulesResult.data) {
                assets.push({ name: r.descr || `rule-${r.id}`, assetType: 'firewall_rule', sourceSkill: 'pfsense', sourceId: `rule:${r.id}`, attributes: { type: r.type, interface: r.interface, protocol: r.protocol, source: r.source, destination: r.destination, destination_address: r.destination?.address } });
              }
            }
          } catch { /* skip */ }
          // Interfaces (network segments with IP/Subnet)
          try {
            const ifResult = await skillSandbox.execute(pfSkill, { action: 'list_interfaces' }, {} as any);
            if (ifResult.success && Array.isArray(ifResult.data)) {
              for (const i of ifResult.data) {
                const name = i.descr || i.name || i.if || 'unknown';
                const ip = i.ipaddr && i.ipaddr !== 'dhcp' ? i.ipaddr : undefined;
                const subnet = i.subnet ? `${ip ?? ''}/${i.subnet}` : undefined;
                assets.push({ name, assetType: 'network', sourceSkill: 'pfsense', sourceId: `if:${i.if ?? name}`, ipAddress: ip, attributes: { interface: i.if, subnet, vlan: i.tag, enable: i.enable, gateway: i.gateway } });
              }
            }
          } catch { /* skip */ }
          // VLANs
          try {
            const vlanResult = await skillSandbox.execute(pfSkill, { action: 'list_vlans' }, {} as any);
            if (vlanResult.success && Array.isArray(vlanResult.data)) {
              for (const v of vlanResult.data) {
                assets.push({ name: v.descr || `VLAN ${v.tag}`, assetType: 'network', sourceSkill: 'pfsense', sourceId: `vlan:${v.tag}`, attributes: { vlan_tag: v.tag, parent_if: v.parentif ?? v.if?.split('.')[0], vlanif: v.vlanif ?? v.if } });
              }
            }
          } catch { /* skip */ }
          // Gateways
          try {
            const gwResult = await skillSandbox.execute(pfSkill, { action: 'list_gateways' }, {} as any);
            if (gwResult.success && Array.isArray(gwResult.data)) {
              for (const g of gwResult.data) {
                assets.push({ name: g.name || `gw-${g.interface}`, assetType: 'network', sourceSkill: 'pfsense', sourceId: `gw:${g.name ?? g.interface}`, ipAddress: g.gateway as string, attributes: { interface: g.interface, monitor: g.monitor, status: g.status, default: g.defaultgw } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('homeassistant', async () => {
          const assets: any[] = [];
          try {
            const statesResult = await skillSandbox.execute(skillRegistry.get('homeassistant')!, { action: 'states' }, {} as any);
            if (statesResult.success && Array.isArray(statesResult.data)) {
              for (const s of statesResult.data) {
                const entityId = s.entity_id as string;
                if (!entityId) continue;
                const domain = entityId.split('.')[0];
                // Only discover physical devices and automations, skip transient states
                if (!['automation', 'switch', 'light', 'sensor', 'binary_sensor', 'climate', 'cover', 'fan', 'media_player', 'camera'].includes(domain)) continue;
                const type = domain === 'automation' ? 'automation' as const : 'iot_device' as const;
                assets.push({ name: s.attributes?.friendly_name || entityId, assetType: type, sourceSkill: 'homeassistant', sourceId: entityId, status: s.state === 'unavailable' ? 'inactive' : 'active', attributes: { entity_id: entityId, domain, state: s.state } });
              }
            }
          } catch { /* skip */ }
          return { assets, relations: [] };
        });

        wrapSkillAsSource('mikrotik', async () => {
          const assets: any[] = [];
          const relations: any[] = [];
          const mtSkill = skillRegistry.get('mikrotik')! as any;
          const routers = mtSkill.getRouters?.() ?? [];
          for (const cfg of routers) {
            const conn = { name: cfg.name, cfg };
            try {
              // Router as network_device asset
              const res = await mtSkill.api(conn, 'GET', '/system/resource');
              const identity = await mtSkill.api(conn, 'GET', '/system/identity');
              const routerName = identity?.name ?? cfg.name;
              const routerAsset = { name: routerName, assetType: 'network_device' as const, sourceSkill: 'mikrotik', sourceId: `router:${cfg.name}`, ipAddress: cfg.host, status: 'active' as const, attributes: { version: res.version, architecture: res['architecture-name'], board: res['board-name'], cpu_count: res['cpu-count'], total_memory: res['total-memory'], uptime: res.uptime } };
              assets.push(routerAsset);

              // Interfaces as network assets
              const ifaces = await mtSkill.api(conn, 'GET', '/interface');
              for (const i of (ifaces as any[])) {
                if (i.type === 'bridge' || i.type === 'loopback') continue;
                assets.push({ name: `${routerName}/${i.name}`, assetType: 'network' as const, sourceSkill: 'mikrotik', sourceId: `if:${cfg.name}:${i.name}`, attributes: { type: i.type, mac: i['mac-address'], running: i.running, mtu: i['actual-mtu'] } });
                relations.push({ sourceEntityName: `${routerName}/${i.name}`, targetEntityName: routerName, relationType: 'part_of' });
              }

              // Firewall rules
              const fwRules = await mtSkill.api(conn, 'GET', '/ip/firewall/filter');
              for (const r of (fwRules as any[]).slice(0, 50)) {
                const ruleName = r.comment || `${r.chain}-${r.action}-${r['.id']}`;
                assets.push({ name: `${routerName}/fw/${ruleName}`, assetType: 'firewall_rule' as const, sourceSkill: 'mikrotik', sourceId: `fw:${cfg.name}:${r['.id']}`, attributes: { chain: r.chain, action: r.action, src: r['src-address'], dst: r['dst-address'], protocol: r.protocol, port: r['dst-port'], disabled: r.disabled } });
              }

              // DHCP leases as discovered devices
              const leases = await mtSkill.api(conn, 'GET', '/ip/dhcp-server/lease');
              for (const l of (leases as any[])) {
                if (l.status !== 'bound') continue;
                const deviceName = l['host-name'] || l['mac-address'] || l.address;
                assets.push({ name: deviceName, assetType: 'network_device' as const, sourceSkill: 'mikrotik', sourceId: `dhcp:${cfg.name}:${l['mac-address'] ?? l.address}`, ipAddress: l.address, attributes: { mac: l['mac-address'], hostname: l['host-name'], server: l.server, dynamic: l.dynamic } });
              }
            } catch { /* router unreachable — skip */ }
          }
          return { assets, relations };
        });

        // Wire CMDB registration callback for full_deploy
        deploySkill.setCmdbCallback?.(async (result: Record<string, unknown>) => {
          try {
            const userId = this.config.security?.ownerUserId ?? '';
            const user = await this.userRepo?.findOrCreate('telegram' as any, userId);
            const uid = user?.masterUserId ?? user?.id ?? userId;
            // Register deployed assets
            if (result.host) {
              await cmdbRepo.upsertAsset(uid, { name: result.project as string ?? 'deployed-app', assetType: 'application', sourceSkill: 'deploy', sourceId: `deploy:${result.host}:${result.project}`, ipAddress: result.host as string, status: 'active', attributes: result });
            }
            await cmdbRepo.logChange(uid, null, 'created', 'deploy', undefined, undefined, undefined, `Full deploy: ${result.project ?? 'app'} auf ${result.host ?? '?'}`, 'deploy_skill');
          } catch { /* non-critical */ }
        });

        // Wire monitor alert → auto-incident creation with batch-aware dedup + linking
        if (this.config.cmdb?.autoIncidentFromMonitor !== false && skillRegistry.has('monitor')) {
          const origMonitor = skillRegistry.get('monitor')!;
          const origExecute = origMonitor.execute.bind(origMonitor);
          origMonitor.execute = async (input: Record<string, unknown>, ctx: any) => {
            const result = await origExecute(input, ctx);
            if (result.success) {
              const userId = this.ownerMasterUserId || ctx.masterUserId || ctx.userId;
              const alerts = Array.isArray(result.data)
                ? result.data as Array<{ source: string; message: string }>
                : [];

              // ── 1. Alert processing: create/append incidents ──
              if (alerts.length > 0) {
                // Track first incident per source within this batch for relatedIncidentId linking
                const batchFirstBySource = new Map<string, string>();

                for (const alert of alerts) {
                  try {
                    // Filter out generic alert words so device/entity names become the distinguishing keywords
                    const GENERIC_ALERT_WORDS = new Set(['device', 'connected', 'state', 'status', 'failed', 'error', 'warning', 'health', 'check', 'entities', 'unavailable', 'subsystem', 'battery', 'settings', 'offline', 'online']);
                    const keywords = alert.message.split(/[\s"()]+/).filter(w => w.length >= 4 && !GENERIC_ALERT_WORDS.has(w.toLowerCase())).map(w => w.toLowerCase());
                    const severity = alert.message.toLowerCase().includes('offline') || alert.message.toLowerCase().includes('critical') ? 'critical' as const : alert.message.toLowerCase().includes('high') || alert.message.toLowerCase().includes('cpu') ? 'high' as const : 'medium' as const;

                    // 1. Check keyword-match against existing open incidents → duplicate → append symptoms
                    const existingInc = await itsmRepo.findOpenIncidentForAsset(userId, alert.source, keywords);
                    if (existingInc) {
                      await itsmRepo.appendSymptoms(userId, existingInc.id, alert.message);
                      if (!batchFirstBySource.has(alert.source)) batchFirstBySource.set(alert.source, existingInc.id);
                      continue;
                    }

                    // 2. No keyword match → create new incident, link to batch-first or recent same-source
                    let relatedId = batchFirstBySource.get(alert.source);
                    if (!relatedId) {
                      const recent = await itsmRepo.findRecentIncidentForSource(userId, alert.source, 4);
                      if (recent) relatedId = recent.id;
                    }

                    const newInc = await itsmRepo.createIncident(userId, {
                      title: `${alert.source}: ${alert.message.slice(0, 100)}`,
                      severity,
                      symptoms: alert.message,
                      detectedBy: 'monitor',
                      relatedIncidentId: relatedId,
                    });

                    if (!batchFirstBySource.has(alert.source)) batchFirstBySource.set(alert.source, newInc.id);
                  } catch (err) { this.logger.warn({ err: (err as Error).message, source: alert.source }, 'Auto-incident creation failed'); }
                }
                // After all incidents processed, trigger service health re-evaluation
                try {
                  const itsmSkillRef = skillRegistry.get('itsm');
                  if (itsmSkillRef) {
                    await skillSandbox.execute(itsmSkillRef, { action: 'health_check' }, { userId, masterUserId: userId } as any);
                  }
                } catch { /* non-critical */ }
              }

              // ── 2. Auto-Recovery scan (runs on every successful monitor run) ──
              // Resolves monitor-created incidents whose underlying condition
              // is no longer present: clean source + no user interaction + 60min quiet.
              try {
                // Sources that were actually attempted in this run
                const requestedChecks = (input.checks as string[] | undefined) ?? [];
                const configuredSources: string[] = [];
                if (this.config.proxmox) configuredSources.push('proxmox');
                if (this.config.unifi) configuredSources.push('unifi');
                if (this.config.homeassistant) configuredSources.push('homeassistant');
                if (this.config.proxmoxBackup) configuredSources.push('proxmox_backup');
                const checkedSources = requestedChecks.length > 0 ? requestedChecks : configuredSources;

                // Sources whose check itself failed (e.g. API timeout) — skip recovery for those
                const failedSources = new Set<string>();
                for (const a of alerts) {
                  if (a.message.startsWith('Health check failed')) failedSources.add(a.source);
                }
                const cleanSources = checkedSources.filter(s => !failedSources.has(s));

                if (cleanSources.length > 0) {
                  const RECOVERY_MIN_AGE_MIN = 60;
                  const candidates = await itsmRepo.findRecoveryCandidates(userId, RECOVERY_MIN_AGE_MIN);

                  let resolvedCount = 0;
                  for (const inc of candidates) {
                    const titleLower = inc.title.toLowerCase();
                    const matchedSource = cleanSources.find(s => titleLower.startsWith(`${s}:`));
                    if (!matchedSource) continue;

                    const ageMinutes = Math.floor(
                      (Date.now() - new Date(inc.updatedAt).getTime()) / 60_000,
                    );

                    try {
                      await itsmRepo.updateIncident(userId, inc.id, {
                        status: 'resolved',
                        resolution: `🔄 Auto-resolved: Monitor-Bedingung für "${matchedSource}" ist seit ${ageMinutes}min nicht mehr aufgetreten. Finaler Close liegt beim User.`,
                      });
                      resolvedCount++;
                      this.logger.info(
                        { incidentId: inc.id, source: matchedSource, ageMinutes },
                        'ITSM auto-recovery: incident resolved',
                      );
                    } catch (err) {
                      this.logger.warn(
                        { err: (err as Error).message, incidentId: inc.id },
                        'ITSM auto-recovery: update failed',
                      );
                    }
                  }

                  if (resolvedCount > 0) {
                    this.logger.info(
                      { resolvedCount, cleanSources },
                      `ITSM auto-recovery: ${resolvedCount} incident(s) resolved`,
                    );
                  }
                }
              } catch (err) {
                this.logger.warn(
                  { err: (err as Error).message },
                  'ITSM auto-recovery scan failed',
                );
              }
            }
            return result;
          };
        }

        // Wire IP resolver callback (pfSense ARP/DHCP + UniFi clients → MAC-to-IP)
        cmdbSkill.setIpResolverCallback(async () => {
          const entries: Array<{ mac: string; ip: string; hostname?: string; source: string }> = [];
          // pfSense ARP table
          if (skillRegistry.has('pfsense')) {
            try {
              const arpResult = await skillSandbox.execute(skillRegistry.get('pfsense')!, { action: 'list_arp' }, {} as any);
              if (arpResult.success && Array.isArray(arpResult.data)) {
                for (const e of arpResult.data) {
                  if (e.mac && e.ip) entries.push({ mac: String(e.mac), ip: String(e.ip), hostname: e.hostname as string, source: 'pfsense_arp' });
                }
              }
            } catch { /* skip */ }
          }
          // pfSense DHCP leases
          if (skillRegistry.has('pfsense')) {
            try {
              const dhcpResult = await skillSandbox.execute(skillRegistry.get('pfsense')!, { action: 'list_dhcp_leases' }, {} as any);
              if (dhcpResult.success && Array.isArray(dhcpResult.data)) {
                for (const l of dhcpResult.data) {
                  if (l.mac && l.ip) entries.push({ mac: String(l.mac), ip: String(l.ip), hostname: l.hostname as string, source: 'pfsense_dhcp' });
                }
              }
            } catch { /* skip */ }
          }
          // UniFi clients (all known clients with MAC + IP)
          if (skillRegistry.has('unifi')) {
            try {
              const clientResult = await skillSandbox.execute(skillRegistry.get('unifi')!, { action: 'list_clients' }, {} as any);
              if (clientResult.success && Array.isArray(clientResult.data)) {
                for (const c of clientResult.data) {
                  if (c.mac && c.ip) entries.push({ mac: String(c.mac), ip: String(c.ip), hostname: (c.hostname ?? c.name) as string, source: 'unifi' });
                }
              }
            } catch { /* skip */ }
          }
          return entries;
        });

        // Wire KG sync callback (CMDB → KG)
        if (this.config.cmdb?.kgSync !== false) {
          cmdbSkill.setKgSyncCallback(async (uid: string) => {
            if (!this.kgServiceRef) return;
            const allAssets = await cmdbRepo.listAssets(uid);
            const allRels = await cmdbRepo.getAllRelations(uid);
            const relMapped = allRels.map(r => {
              const src = allAssets.find(a => a.id === r.sourceAssetId);
              const tgt = allAssets.find(a => a.id === r.targetAssetId);
              return { sourceEntityName: src?.name ?? '', targetEntityName: tgt?.name ?? '', relationType: r.relationType };
            }).filter(r => r.sourceEntityName && r.targetEntityName);
            await this.kgServiceRef.syncFromCmdb(uid, allAssets, relMapped);
          });
        }

        skillRegistry.register(cmdbSkill);
        skillRegistry.register(itsmSkill);
        skillRegistry.register(infraDocsSkill);

        // Schedule periodic auto-discovery
        const discoveryIntervalH = this.config.cmdb?.autoDiscoveryIntervalHours ?? 24;
        if (discoveryIntervalH > 0) {
          const discoveryMs = discoveryIntervalH * 3_600_000;
          setTimeout(() => {
            const uid = this.ownerMasterUserId || this.config.security?.ownerUserId || '';
            if (uid) cmdbSkill.execute({ action: 'discover' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            this.cmdbDiscoveryTimer = setInterval(() => {
              if (uid) cmdbSkill.execute({ action: 'discover' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            }, discoveryMs);
          }, 120_000);
          this.logger.info({ intervalHours: discoveryIntervalH }, 'CMDB auto-discovery scheduled');
        }

        // Schedule periodic health checks
        const healthCheckMin = this.config.cmdb?.healthCheckIntervalMinutes ?? 60;
        if (healthCheckMin > 0) {
          const healthMs = healthCheckMin * 60_000;
          setTimeout(() => {
            const uid = this.ownerMasterUserId || this.config.security?.ownerUserId || '';
            const runHealthCheck = () => {
              if (uid) itsmSkill.execute({ action: 'health_check' }, { userId: uid, masterUserId: uid } as any).catch(() => {});
            };
            runHealthCheck();
            this.cmdbHealthCheckTimer = setInterval(runHealthCheck, healthMs);
          }, 180_000); // 3 min after startup
        }

        this.logger.info('CMDB + ITSM + InfraDocs skills registered');
      }
    }

    // 4p. Marketplace (willhaben + eBay — willhaben always available, eBay needs credentials)
    {
      const { MarketplaceSkill } = await import('@alfred/skills');
      skillRegistry.register(new MarketplaceSkill(this.config.marketplace));
      this.logger.info('Marketplace skill registered');
    }

    // Shopping / Preisvergleich (immer registriert — Geizhals braucht keinen Key)
    {
      const { ShoppingSkill } = await import('@alfred/skills');
      skillRegistry.register(new ShoppingSkill());
      this.logger.info('Shopping skill registered');
    }

    // 4q. Briefing (always available — gathers data from registered skills, reads memories for addresses)
    {
      const { BriefingSkill } = await import('@alfred/skills');
      skillRegistry.register(new BriefingSkill(skillRegistry, this.config, memoryRepo));
      this.logger.info('Briefing skill registered');
    }

    // 4s. Feed reader (always available — stores subscriptions in skill_state)
    skillRegistry.register(new FeedReaderSkill(skillStateRepo));
    this.logger.info('Feed reader skill registered');

    // 4s2. Help skill (always available — shows available skills)
    // ROLE_SKILL_ACCESS is imported later; we set it after user management init
    const helpSkill = new HelpSkill(skillRegistry);
    skillRegistry.register(helpSkill);

    // 4s3. Onboarding (always available)
    {
      const { OnboardingSkill } = await import('@alfred/skills');
      const onboardingSkill = new OnboardingSkill();
      if (memoryRepo) {
        const uid = this.ownerMasterUserId || '';
        onboardingSkill.setMemoryCallback(async (key, value, type, category) => {
          await memoryRepo.saveWithMetadata(uid, key, value, category, type as any, 1.0, 'manual');
        });
      }
      skillRegistry.register(onboardingSkill);
    }

    // 4t. User Management (always available)
    {
      const { AlfredUserRepository } = await import('@alfred/storage');
      const { UserManagementSkill } = await import('@alfred/skills');
      const alfredUserRepo = new AlfredUserRepository(adapter);

      // Auto-create admin user from ownerUserId if not exists
      // Link to ALL enabled platforms (not just Telegram)
      if (this.config.security?.ownerUserId) {
        const ownerUid = this.config.security.ownerUserId;
        const allUsers = await alfredUserRepo.getAll();
        const admins = allUsers.filter(u => u.role === 'admin');
        let adminUser = admins[0];

        if (!adminUser) {
          adminUser = await alfredUserRepo.create({ username: 'admin', role: 'admin', displayName: 'Admin' });
          await alfredUserRepo.clearInviteCode(adminUser.id);
          this.logger.info({ userId: ownerUid }, 'Auto-created admin user from ownerUserId');
        }

        // Link to all configured platforms with the ownerUserId
        const platforms = ['telegram', 'discord', 'matrix', 'signal', 'api'] as const;
        for (const platform of platforms) {
          const existing = await alfredUserRepo.getUserByPlatform(platform, ownerUid);
          if (!existing) {
            try { await alfredUserRepo.linkPlatform(adminUser.id, platform, ownerUid); } catch { /* already linked */ }
          }
        }
        // Resolve the MASTER user ID (from `users` table, not `alfred_users` table)
        // adminUser.id is the alfred_users ID — we need the users.master_user_id instead
        try {
          const ownerUser = await userRepo.findOrCreate('telegram' as any, this.config.security.ownerUserId);
          this.ownerMasterUserId = ownerUser.masterUserId ?? ownerUser.id;
        } catch {
          this.ownerMasterUserId = adminUser.id; // fallback
        }
      }

      // Resolve Microsoft App credentials for Device Code Flow + shared resource setup
      const msAppCredentials = (() => {
        const ms = this.config.email?.accounts?.[0]?.microsoft
          ?? (this.config.email as any)?.microsoft
          ?? this.config.calendar?.microsoft
          ?? this.config.contacts?.microsoft
          ?? (this.config.todo as any);
        if (ms?.clientId && ms?.clientSecret) return { clientId: ms.clientId as string, clientSecret: ms.clientSecret as string, tenantId: ms.tenantId as string | undefined };
        return undefined;
      })();
      // Collect full MS configs per service type for add_shared_resource
      const msGlobalConfigs: Record<string, Record<string, unknown>> = {};
      if (this.config.calendar?.microsoft) msGlobalConfigs.calendar = { provider: 'microsoft', microsoft: this.config.calendar.microsoft };
      if (this.config.contacts?.microsoft) msGlobalConfigs.contacts = { provider: 'microsoft', microsoft: this.config.contacts.microsoft };
      const emailMs = this.config.email?.accounts?.[0]?.microsoft ?? (this.config.email as any)?.microsoft;
      if (emailMs) msGlobalConfigs.email = { provider: 'microsoft', microsoft: emailMs };
      if (this.config.todo?.clientId) msGlobalConfigs.todo = { ...(this.config.todo as unknown as Record<string, unknown>) };
      skillRegistry.register(new UserManagementSkill(alfredUserRepo, msAppCredentials, Object.keys(msGlobalConfigs).length > 0 ? msGlobalConfigs : undefined));
      this.logger.info('User management skill registered');

      // Wire Alfred user lookup into CrossPlatformSkill for send_to_user
      crossPlatformSkill.setAlfredUserLookup(alfredUserRepo);

      // Sharing skill
      const { SharingSkill } = await import('@alfred/skills');
      const { SharedResourceRepository } = await import('@alfred/storage');
      const sharedResourceRepo = new SharedResourceRepository(adapter);
      skillRegistry.register(new SharingSkill(sharedResourceRepo, alfredUserRepo));
      // Wire shared resources into skills for visibility checks
      (documentSkill as any).sharedResourceRepo = sharedResourceRepo;
      (noteSkill as any).sharedResourceRepo = sharedResourceRepo;
      (todoSkill as any).sharedResourceRepo = sharedResourceRepo;
      this.logger.info('Sharing skill registered');

      // Setup web auth callback for HTTP API login (persistent via link_tokens table)
      const webLinkTokenRepo = linkTokenRepo;
      this.webAuthCallback = {
        loginWithCode: async (code: string) => {
          const tempWebId = `web-pending-${Date.now()}`;
          const user = await alfredUserRepo.consumeInviteCode(code, 'api', tempWebId);
          if (!user) return { success: false, error: 'Ungültiger oder abgelaufener Code' };

          const token = `alf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          // Persist session token (expires in 30 days)
          const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
          await webLinkTokenRepo.createSession(token, user.id, 'web-session', expires);

          return { success: true, userId: user.id, username: user.username, role: user.role, token };
        },
        getUserByToken: async (token: string) => {
          const entry = await webLinkTokenRepo.findByToken(token);
          if (!entry) return null;
          // Check expiry
          if (new Date(entry.expiresAt) < new Date()) return null;
          const user = await alfredUserRepo.getById(entry.userId);
          if (!user) return null;
          return { userId: user.id, username: user.username, role: user.role };
        },
      };
    }

    // 4u. Database (optional)
    if (this.config.database?.enabled) {
      const { DatabaseSkill } = await import('@alfred/skills');
      const { DatabaseConnectionRepository } = await import('@alfred/storage');
      const dbConnRepo = new DatabaseConnectionRepository(adapter);
      const dbSkill = new DatabaseSkill(this.config.database, dbConnRepo);

      // Pre-load connections from config
      if (this.config.database.connections) {
        for (const conn of this.config.database.connections) {
          if (!(await dbConnRepo.getByName(conn.name))) {
            await dbConnRepo.create({
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

    // 4u-backup. System Backup (optional)
    if (this.config.backup?.enabled) {
      const { SystemBackupSkill } = await import('@alfred/skills');
      const pkg = await import('../../cli/package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: 'unknown' } }));
      const backupSkill = new SystemBackupSkill(
        this.config.backup,
        adapter,
        this.config.cluster?.nodeId ?? 'single',
        pkg.default.version ?? 'unknown',
        this.config.fileStore,
      );
      skillRegistry.register(backupSkill);
      this.logger.info('System Backup skill registered');
    }

    // 4u-commvault. Commvault Backup Management (optional)
    if (this.config.commvault?.enabled) {
      const { CommvaultSkill } = await import('@alfred/skills');
      const cvSkill = new CommvaultSkill(this.config.commvault);
      // Wire ITSM callback for auto-incident creation
      if (this.config.cmdb?.autoIncidentFromMonitor) {
        const itsmSkill = skillRegistry.get('itsm');
        if (itsmSkill) {
          cvSkill.setItsmCallback(async (input) => {
            return itsmSkill.execute(input, { alfredUserId: this.ownerMasterUserId } as any);
          });
        }
      }
      skillRegistry.register(cvSkill);
      this.logger.info('Commvault skill registered');
    }

    // MikroTik ITSM callback wiring (skill already registered before CMDB)
    if (this.config.mikrotik?.enabled && this.config.cmdb?.autoIncidentFromMonitor) {
      const mtSkill = skillRegistry.get('mikrotik') as any;
      const itsmSkill = skillRegistry.get('itsm');
      if (mtSkill && itsmSkill) {
        mtSkill.setItsmCallback(async (input: Record<string, unknown>) => {
          return itsmSkill.execute(input, { alfredUserId: this.ownerMasterUserId } as any);
        });
      }
    }

    // 4u. YouTube (optional, requires API key)
    if (this.config.youtube?.apiKey) {
      const { YouTubeSkill } = await import('@alfred/skills');
      skillRegistry.register(new YouTubeSkill(this.config.youtube));
      this.logger.info('YouTube skill registered');
    }

    this.logger.info({ skills: skillRegistry.getAll().map(s => s.metadata.name) }, 'Skills registered');

    // 5. Initialize speech-to-text (optional)
    // Auto-populate STT/TTS API keys from Mistral LLM provider when not explicitly set
    if (this.config.speech) {
      if (this.config.speech.sttProvider === 'mistral' && !this.config.speech.sttApiKey && mistralApiKey) {
        this.config.speech.sttApiKey = mistralApiKey;
      }
      if (this.config.speech.ttsProvider === 'mistral' && !this.config.speech.ttsApiKey && mistralApiKey) {
        this.config.speech.ttsApiKey = mistralApiKey;
      }
    }

    let speechTranscriber: SpeechTranscriber | undefined;
    if (this.config.speech?.apiKey) {
      speechTranscriber = new SpeechTranscriber(
        this.config.speech,
        this.logger.child({ component: 'speech' }),
      );
      speechTranscriber.setUsageCallback((model, units) => {
        serviceUsageRepo.record('stt', model, units).catch(() => {});
      });
      const effectiveSttProvider = this.config.speech.sttProvider ?? this.config.speech.provider;
      this.logger.info({ provider: effectiveSttProvider }, 'Speech-to-text initialized');
    }

    // 5b. Initialize text-to-speech (optional)
    if (this.config.speech?.ttsEnabled) {
      const synthesizer = new SpeechSynthesizer(
        this.config.speech,
        this.logger.child({ component: 'tts' }),
      );
      synthesizer.setSkillState(skillStateRepo);
      synthesizer.setUsageCallback((model, units) => {
        serviceUsageRepo.record('tts', model, units).catch(() => {});
      });
      skillRegistry.register(new TTSSkill(synthesizer));
      const effectiveTtsProvider = this.config.speech.ttsProvider ?? 'openai';
      this.logger.info({ provider: effectiveTtsProvider }, 'Text-to-speech skill registered');
    }

    // 5b2. Initialize voice management skill (optional — requires Mistral TTS + API key)
    {
      const speechCfg = this.config.speech;
      const voiceMgmtEnabled = speechCfg?.ttsProvider === 'mistral'
        && speechCfg.voiceManagement !== false;
      const voiceApiKey = speechCfg?.ttsApiKey ?? mistralApiKey;
      if (voiceMgmtEnabled && voiceApiKey && memoryRepo) {
        // Determine announce base URL for Sonos TTS integration
        // IMPORTANT: Sonos speakers cannot access HTTPS with self-signed certs.
        // Always use HTTP for announce URLs. Sonos and Alfred are on the same LAN.
        let announceBaseUrl: string;
        // Find first non-loopback IPv4 address for LAN accessibility
        let lanIp = 'localhost';
        const interfaces = os.networkInterfaces();
        for (const nets of Object.values(interfaces)) {
          if (!nets) continue;
          for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) {
              lanIp = net.address;
              break;
            }
          }
          if (lanIp !== 'localhost') break;
        }
        const port = this.config.api?.port ?? 3420;
        // When TLS is enabled, the HTTP fallback for Sonos runs on port+2 (e.g., 3422; port+1 is cluster discovery)
        const announcePort = this.config.api?.tls?.enabled ? port + 2 : port;
        announceBaseUrl = `http://${lanIp}:${announcePort}`;
        skillRegistry.register(new VoiceSkill(
          voiceApiKey, 'https://api.mistral.ai/v1', 'voxtral-mini-tts-2603',
          memoryRepo, skillRegistry, announceBaseUrl, skillStateRepo,
        ));
        this.logger.info({ announceBaseUrl }, 'Voice management skill registered');
      }
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

    // 5f. Initialize file store (optional — defaults to local fs)
    let fileStore: import('@alfred/storage').FileStore | undefined;
    if (this.config.fileStore) {
      const { createFileStore } = await import('@alfred/storage');
      fileStore = createFileStore(this.config.fileStore);
      this.logger.info({ backend: this.config.fileStore.backend }, 'File store initialized');
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
      fileStore,
      processedMessageRepo: this.config.cluster?.enabled
        ? new (await import('@alfred/storage')).ProcessedMessageRepository(adapter)
        : undefined,
      nodeId: this.config.cluster?.nodeId ?? 'single',
      embeddingService,
      activeLearning,
      memoryRetriever,
      maxHistoryMessages: this.config.conversation?.maxHistoryMessages ?? 100,
      documentProcessor,
      conversationSummarizer,
      personality: this.config.personality,
    });

    // 5e. Initialize cluster manager BEFORE schedulers
    if (this.config.cluster?.enabled) {
      // HA requires PostgreSQL
      if (adapter.type !== 'postgres') {
        throw new Error('HA Cluster erfordert storage.backend: "postgres". SQLite ist nicht für Multi-Node geeignet.');
      }
      if (!this.config.cluster.nodeId) {
        throw new Error('HA Cluster erfordert cluster.nodeId. Jeder Node braucht eine eindeutige ID.');
      }
      // FileStore warning
      if (!this.config.fileStore || this.config.fileStore.backend === 'local') {
        this.logger.warn('HA Cluster ohne S3/NFS FileStore — Datei-Uploads sind nur auf dem empfangenden Node sichtbar. Empfohlen: fileStore.backend: "s3" oder "nfs"');
      }

      const { ClusterManager } = await import('./cluster/cluster-manager.js');
      this.clusterManager = new ClusterManager(
        this.config.cluster,
        this.logger.child({ component: 'cluster' }),
      );
      await this.clusterManager.connect();
      if (!this.clusterManager.isConnected) {
        this.logger.warn('Redis nicht erreichbar — Cross-Node Pub/Sub und Echtzeit-Heartbeat deaktiviert. PG-Heartbeat als Fallback aktiv.');
      }
      // Run PG migrations BEFORE heartbeat (tables must exist first)
      const { PgMigrator, PG_MIGRATIONS } = await import('@alfred/storage');
      const pgMigrator = new PgMigrator(adapter);
      await pgMigrator.migrate(PG_MIGRATIONS);
      // Start PG heartbeat as fallback
      this.clusterManager.startPgHeartbeat(adapter);

      this.logger.info({ nodeId: this.config.cluster.nodeId }, 'Cluster manager initialized (Active-Active)');
    }

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
      this.config.cluster?.nodeId ?? 'single',
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
      this.config.cluster?.nodeId ?? 'single',
    );

    // 7d. Initialize watch engine (condition-based alerts)
    const watchRepo = new WatchRepository(adapter);
    this.watchRepo = watchRepo;
    skillRegistry.register(new WatchSkill(watchRepo, skillRegistry));

    // 7e. Initialize confirmation queue (human-in-the-loop for watch actions)
    const confirmRepo = new ConfirmationRepository(adapter);
    this.confirmationQueue = new ConfirmationQueue(
      confirmRepo,
      skillRegistry,
      skillSandbox,
      this.adapters,
      this.logger.child({ component: 'confirmation-queue' }),
      activityLogger,
    );

    // 7e2. Initialize feedback service (rejection/correction tracking)
    const feedbackRepo = new FeedbackRepository(adapter);
    const feedbackService = new FeedbackService(
      feedbackRepo,
      memoryRepo,
      this.logger.child({ component: 'feedback' }),
    );
    feedbackService.setLLM(llmProvider);
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
      this.config.cluster?.nodeId ?? 'single',
    );

    // 7f. Initialize workflow chains
    const workflowRepo = new WorkflowRepository(adapter);
    const workflowSkill = new WorkflowSkill(workflowRepo);
    skillRegistry.register(workflowSkill);

    const scriptExecutor = new ScriptExecutor(
      './data/scripts',
      this.logger.child({ component: 'script-executor' }),
    );
    const dbQueryExecutor = new DbQueryExecutor(
      adapter,
      this.logger.child({ component: 'db-query-executor' }),
    );
    const workflowRunner = new WorkflowRunner(
      workflowRepo,
      skillRegistry,
      skillSandbox,
      this.logger.child({ component: 'workflow-runner' }),
      activityLogger,
      skillHealthTracker,
      scriptExecutor,
      dbQueryExecutor,
    );
    workflowSkill.setRunner(workflowRunner);

    const promptParser = new PromptParser(
      llmProvider,
      skillRegistry,
      this.logger.child({ component: 'prompt-parser' }),
    );
    workflowSkill.setPromptParser(promptParser);

    // 7f-ii. TriggerManager — evaluates cron/watch triggers for workflows
    {
      const guardEvaluator = new GuardEvaluator(skillRegistry, skillSandbox);
      const triggerManager = new TriggerManager(
        workflowRepo,
        guardEvaluator,
        async (wfId, triggerData) => {
          const wf = await workflowRepo.getById(wfId);
          if (!wf) return;
          const { context } = await (await import('./context-factory.js')).buildSkillContext(
            userRepo,
            { userId: this.config.security?.ownerUserId ?? '', platform: 'api' as Platform, chatId: '' },
          );
          return workflowRunner.run(wf, context, triggerData);
        },
        this.logger.child({ component: 'trigger-manager' }),
      );
      triggerManager.start();
      this.triggerManager = triggerManager;
    }

    // 7g. Initialize reasoning engine — proactive cross-domain insights
    let insightTracker: InsightTracker | undefined;
    let kgServiceInstance: KnowledgeGraphService | undefined;
    {
      const ownerUserId = this.config.security?.ownerUserId;
      if (ownerUserId && this.config.reasoning?.enabled !== false) {
        insightTracker = new InsightTracker(
          memoryRepo,
          this.logger.child({ component: 'insight-tracker' }),
          skillStateRepo,
        );
        this.insightTracker = insightTracker;
        const reasoningNotifRepo = new CalendarNotificationRepository(adapter);
        kgServiceInstance = new KnowledgeGraphService(
          new KnowledgeGraphRepository(adapter),
          this.logger.child({ component: 'knowledge-graph' }),
          memoryRepo, skillRegistry, skillSandbox, userRepo,
          ownerUserId, defaultProactivePlatform,
        );
        // Optional LLM-based entity linker
        const llmLinkingCfg = this.config.reasoning?.llmLinking;
        if (llmLinkingCfg?.enabled) {
          const llmLinkProvider = llmLinkingCfg.provider ?? 'mistral';
          let llmLinkApiKey = this.config.mistralApiKey;
          if (!llmLinkApiKey) {
            for (const tier of ['fast', 'default', 'strong'] as const) {
              const t = this.config.llm[tier];
              if (t?.provider === llmLinkProvider && t.apiKey) { llmLinkApiKey = t.apiKey; break; }
            }
          }
          if (llmLinkApiKey) {
            const { LLMEntityLinker } = await import('./llm-entity-linker.js');
            const baseUrl = llmLinkProvider === 'openai' ? 'https://api.openai.com/v1'
              : llmLinkProvider === 'anthropic' ? 'https://api.anthropic.com/v1'
              : 'https://api.mistral.ai/v1';
            const llmLinker = new LLMEntityLinker(
              new KnowledgeGraphRepository(adapter), llmLinkingCfg,
              this.logger.child({ component: 'llm-entity-linker' }), llmLinkApiKey, baseUrl,
            );
            llmLinker.setUsageCallback((_service, model, inp, out) => {
              usageRepo.record(model, inp, out, 0, 0, 0).catch(() => {});
            });
            llmLinker.setDocumentRepo(documentRepo);
            kgServiceInstance.setLLMLinker(llmLinker);
            this.logger.info({ provider: llmLinkProvider, model: llmLinkingCfg.model ?? 'mistral-small-latest' }, 'LLM entity linker enabled');
          }
        }
        // Resolve user timezone for reasoning engine
        let userTimezone: string | undefined;
        try {
          const ownerProfile = await userRepo.getProfile?.(this.ownerMasterUserId || ownerUserId);
          userTimezone = ownerProfile?.timezone;
        } catch { /* fallback to server TZ */ }

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
          defaultProactivePlatform,
          this.config.reasoning,
          this.logger.child({ component: 'reasoning-engine' }),
          activityLogger,
          this.config.briefing?.location,
          feedbackRepo,
          this.confirmationQueue,
          this.config.cluster?.nodeId ?? 'single',
          adapter,
          insightTracker,
          undefined, // collector (auto-created internally)
          kgServiceInstance,
          workflowRepo,
          this.bmwTelematicRepo,
          noteRepo,
          this.reminderRepo,
          documentRepo,
          userTimezone,
        );
      }
    }

    // Wire PlanningAgent into ReasoningEngine
    if (this.reasoningEngine) {
      const { PlanRepository } = await import('@alfred/storage');
      const { PlanningAgent } = await import('./planning-agent.js');
      const planRepo = new PlanRepository(adapter);
      const planningAgent = new PlanningAgent(
        planRepo,
        llmProvider,
        {
          execute: async (skillName, params, userId) => {
            const skill = skillRegistry.get(skillName);
            if (!skill) return { success: false, error: `Skill "${skillName}" not found` };
            return skillSandbox.execute(skill, params, { userId, masterUserId: userId } as any);
          },
        },
        this.logger.child({ component: 'planning-agent' }),
      );
      this.reasoningEngine.setPlanningAgent(planningAgent);
      // Also wire into context collector for active plans display
      if ((this.reasoningEngine as any).collector?.setPlanningAgent) {
        (this.reasoningEngine as any).collector.setPlanningAgent(planningAgent);
      }
    }

    // Wire KG service into pipeline for dynamic device context in chat prompts
    if (kgServiceInstance) {
      this.pipeline.setKnowledgeGraphService(kgServiceInstance);
      this.kgServiceRef = kgServiceInstance;

      // Wire KG analyze callback into Memory skill
      if (this.memorySkillRef) {
        this.memorySkillRef.setKgAnalyzeCallback(async (_userId: string) => {
          // Always use the owner's masterUserId — not the alfredUserId from context
          // This prevents duplicate entities under different user IDs
          const resolvedUserId = this.ownerMasterUserId ?? _userId;

          const kgRepo = new KnowledgeGraphRepository(this.database.getAdapter());

          // 1. Memory-Sync + Cross-Extractor + Family Inference + Generic Links
          try { await (kgServiceInstance as any).syncMemoryEntities(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildCrossExtractorRelations(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildFamilyInference(resolvedUserId); } catch { /* continue */ }
          try { await (kgServiceInstance as any).buildGenericEntityLinks(resolvedUserId); } catch { /* continue */ }

          // 2. LLM linker (bypass daily schedule)
          const llmLinker = kgServiceInstance.getLLMLinker();
          let llmStats = { relations: 0, newEntities: 0, corrections: 0 };
          if (llmLinker) {
            try { llmStats = await llmLinker.run(resolvedUserId); } catch { /* continue */ }
          }

          // 3. Maintenance (dedup, prune)
          // 3. Maintenance (dedup, prune, phantom cleanup)
          try { await kgServiceInstance.maintenance(resolvedUserId); } catch (err) { this.logger.warn({ err: (err as Error).message }, 'KG maintenance in kg_analyze failed'); }

          // 4. Get totals
          const graph = await kgRepo.getFullGraph(resolvedUserId);
          return {
            entities: graph.entities.length,
            relations: graph.relations.length,
            newEntities: llmStats.newEntities,
            corrections: llmStats.corrections,
          };
        });
      }
    }

    // Wire watch events -> reasoning engine + trigger manager for event-triggered reasoning
    {
      const existingCallback = this.watchEngine.onWatchTriggered;
      this.watchEngine.onWatchTriggered = (name, value, data, skillName) => {
        existingCallback?.(name, value, data, skillName);

        // Forward to TriggerManager for watch-triggered workflows
        if (this.triggerManager) {
          this.triggerManager.onWatchTriggered(name, value).catch(() => {});
        }

        // Skip event-reasoning for feed_reader watches — RSS articles are evaluated
        // in the scheduled hourly reasoning pass via the feeds section instead.
        if (skillName === 'feed_reader') return;
        if (this.reasoningEngine) {
          this.reasoningEngine.triggerOnEvent('watch_alert', `Watch "${name}" ausgelöst: ${value}`, data)
            .catch(err => this.logger.warn({ err }, 'Event-triggered reasoning failed'));
        }
      };
    }

    // Wire calendar/todo watcher events → reasoning engine for holistic reasoning
    if (this.reasoningEngine && this.calendarWatcher) {
      this.calendarWatcher.onEventNotified = (event) => {
        this.reasoningEngine!.triggerOnEvent(
          'calendar_upcoming',
          `Termin in Kürze: ${event.title}${event.location ? ` (${event.location})` : ''}`,
          { eventId: event.id, title: event.title, location: event.location, start: event.start.toISOString() },
        ).catch(err => this.logger.warn({ err }, 'Calendar-triggered reasoning failed'));
      };
    }

    if (this.reasoningEngine && this.todoWatcher) {
      this.todoWatcher.onTodoNotified = (todoId, title, kind) => {
        this.reasoningEngine!.triggerOnEvent(
          `todo_${kind}`,
          `Todo ${kind === 'overdue' ? 'überfällig' : 'bald fällig'}: ${title}`,
          { todoId, title, kind },
        ).catch(err => this.logger.warn({ err }, 'Todo-triggered reasoning failed'));
      };
    }

    // Wire confirmation queue, activity logger, skill health tracker, and insight tracker into pipeline
    this.pipeline.setConfirmationQueue(this.confirmationQueue);
    this.pipeline.setActivityLogger(activityLogger);
    this.pipeline.setSkillHealthTracker(skillHealthTracker);
    if (insightTracker) this.pipeline.setInsightTracker(insightTracker);

    // Wire reasoning engine into pipeline for post-skill triggers
    if (this.reasoningEngine) {
      this.pipeline.setReasoningEngine(this.reasoningEngine);
    }

    // 7a2. Wire optional moderation service into pipeline
    if (this.config.security?.moderation?.enabled) {
      const modConfig = this.config.security.moderation;
      const provider = modConfig.provider ?? 'mistral';
      const baseUrl = provider === 'mistral'
        ? 'https://api.mistral.ai/v1'
        : 'https://api.openai.com/v1';
      const model = modConfig.model ?? (provider === 'mistral'
        ? 'mistral-moderation-latest'
        : 'omni-moderation-latest');

      // Derive API key: dedicated mistralApiKey → matching LLM tier → default tier
      let apiKey: string | undefined;
      if (provider === 'mistral' && this.config.mistralApiKey) {
        apiKey = this.config.mistralApiKey;
      }
      if (!apiKey) {
        for (const tier of ['default', 'strong', 'fast'] as const) {
          const tierConfig = this.config.llm[tier];
          if (tierConfig?.provider === provider && tierConfig.apiKey) {
            apiKey = tierConfig.apiKey;
            break;
          }
        }
      }
      // Fallback: use default provider's API key
      if (!apiKey) {
        apiKey = this.config.llm.default?.apiKey;
      }

      if (apiKey) {
        const { ModerationService } = await import('@alfred/security');
        const moderationService = new ModerationService(
          apiKey,
          baseUrl,
          model,
          this.logger.child({ component: 'moderation' }),
        );
        moderationService.setUsageCallback((m, units) => {
          this.serviceUsageRepo?.record('moderation', m, units).catch(() => {});
        });
        this.pipeline.setModerationService(moderationService);
        this.logger.info({ provider, model }, 'Moderation service enabled');
      } else {
        this.logger.warn('Moderation enabled but no API key found — skipping');
      }
    }

    // 7b. Wire multi-user support into pipeline
    {
      // Reuse the alfredUserRepo from User Management skill init (same db handle)
      const { AlfredUserRepository, UsageRepository: UsageRepoClass } = await import('@alfred/storage');
      const { ROLE_SKILL_ACCESS } = await import('@alfred/skills');
      const pipelineUserRepo = new AlfredUserRepository(adapter);
      const { UserServiceResolver } = await import('./user-service-resolver.js');
      const serviceResolver = new UserServiceResolver(pipelineUserRepo);
      this.userServiceResolverRef = serviceResolver;
      this.pipeline.setAlfredUserRepo(pipelineUserRepo, ROLE_SKILL_ACCESS, this.usageRepo, serviceResolver);
      // Wire role access into help skill
      (helpSkill as any).roleAccess = ROLE_SKILL_ACCESS;
      // Inject service resolver into Spotify skill for HA-safe token persistence
      if (this.spotifySkill && 'setServiceResolver' in this.spotifySkill) {
        (this.spotifySkill as any).setServiceResolver(serviceResolver);
      }
      // Inject service resolver + telematic repo into BMW skill
      if (this.bmwSkill && 'setServiceResolver' in this.bmwSkill) {
        (this.bmwSkill as any).setServiceResolver(serviceResolver, this.ownerMasterUserId);
        const bmwTelematicRepo = new BmwTelematicRepository(adapter);
        (this.bmwSkill as any).setTelematicRepo(bmwTelematicRepo);
        this.bmwTelematicRepo = bmwTelematicRepo;
      }
      // BMW MQTT streaming is started in start() after AdapterClaimManager is available
    }

    // 7c2. Wire cluster cross-node messaging (needs adapters to be populated later)
    if (this.clusterManager) {
      await this.clusterManager.subscribe('messages', (data) => {
        const { targetPlatform, chatId, text } = data as { targetPlatform: string; chatId: string; text: string };
        const adapter = this.adapters.get(targetPlatform as any);
        if (adapter) {
          adapter.sendMessage(chatId, text).catch(err => {
            this.logger.warn({ err, targetPlatform, chatId }, 'Cross-node message delivery failed');
          });
        }
      });

      // Start UDP discovery broadcast (any node can broadcast)
      if (this.config.cluster) {
        const { ClusterDiscovery } = await import('./cluster/discovery.js');
        const discovery = new ClusterDiscovery(this.logger.child({ component: 'cluster-discovery' }));
        discovery.startBroadcasting({
          nodeId: this.config.cluster.nodeId,
          host: '0.0.0.0',
          port: this.config.api?.port ?? 3420,
          role: this.config.cluster?.role ?? 'node',
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

    if (config.msteams?.enabled && config.msteams.appId) {
      const { MSTeamsAdapter } = await import('@alfred/messaging');
      const teamsAdapter = new MSTeamsAdapter(config.msteams);

      // Wire ConversationReference persistence via skill_state table (cluster-aware)
      const dbAdapter = this.database.getAdapter();
      const SKILL_KEY = 'msteams';
      const REF_PREFIX = 'conv_ref:';
      const systemUserId = '_system';
      teamsAdapter.setDbCallback({
        async saveConversationRef(chatId: string, ref: Record<string, unknown>): Promise<void> {
          const id = `msteams-ref-${chatId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;
          const now = new Date().toISOString();
          await dbAdapter.execute(
            `INSERT INTO skill_state (id, user_id, skill, key, value, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, skill, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [id, systemUserId, SKILL_KEY, `${REF_PREFIX}${chatId}`, JSON.stringify(ref), now],
          );
        },
        async loadAllConversationRefs(): Promise<Map<string, Record<string, unknown>>> {
          const rows = await dbAdapter.query(
            `SELECT key, value FROM skill_state WHERE user_id = ? AND skill = ? AND key LIKE ?`,
            [systemUserId, SKILL_KEY, `${REF_PREFIX}%`],
          );
          const map = new Map<string, Record<string, unknown>>();
          for (const row of rows) {
            const chatId = (row.key as string).slice(REF_PREFIX.length);
            try { map.set(chatId, JSON.parse(row.value as string)); } catch { /* skip malformed */ }
          }
          return map;
        },
      });

      this.adapters.set('msteams', teamsAdapter);
      this.logger.info({ port: config.msteams.webhookPort ?? 3978 }, 'MS Teams adapter registered (cluster-aware ConversationRef persistence)');
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
        publicUrl: config.api?.publicUrl,
        tls: config.api?.tls,
        authCallback: this.webAuthCallback,
        healthCheck: async () => {
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
            todayUsage: await this.usageRepo?.getDaily(new Date().toISOString().slice(0, 10)),
            watchesActive: await this.watchRepo?.countEnabled() ?? 0,
            schedulersActive: await this.scheduledActionRepo?.countEnabled() ?? 0,
            llmProviders: this.llmProvider.getProviderStatuses(),
            diskUsage,
          };
        },
        metricsCallback: () => this.buildPrometheusMetrics(),
        dashboardCallback: async () => {
          const today = new Date().toISOString().slice(0, 10);
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
          return {
            watches: await this.watchRepo?.getEnabled() ?? [],
            scheduled: await this.scheduledActionRepo?.getAll() ?? [],
            skillHealth: await this.skillHealthRepo?.getAll() ?? [],
            reminders: await this.reminderRepo?.getAllPending() ?? [],
            usage: {
              today: await this.usageRepo?.getDaily(today) ?? null,
              week: await this.usageRepo?.getRange(weekAgo, today) ?? [],
              total: await this.usageRepo?.getTotal() ?? [],
            },
            uptime: Math.floor(process.uptime()),
            startedAt: this.startedAt,
            adapters: Object.fromEntries(
              [...this.adapters.entries()].map(([p, a]) => [p, a.getStatus()]),
            ),
            llmProviders: this.llmProvider.getProviderStatuses(),
            services: this.getConfiguredServices(),
            serviceUsage: {
              today: await this.serviceUsageRepo?.getDaily(today) ?? [],
              week: await this.serviceUsageRepo?.getRange(weekAgo, today) ?? [],
              total: await this.serviceUsageRepo?.getTotal() ?? [],
            },
            userUsage: await this.usageRepo?.getByUser(weekAgo, today) ?? [],
            userSkillUsage: await this.activityRepo?.skillUsageByUser(weekAgo) ?? [],
          };
        },
        webUiPath: config.api?.webUi !== false ? this.resolveWebUiPath() : undefined,
      }));
      this.logger.info({ port, host, webUi: config.api?.webUi !== false }, 'HTTP API adapter registered');
    }
  }

  async start(): Promise<void> {
    this.logger.info('Starting Alfred...');

    // In HA mode: claim adapters via DB (only one node per adapter).
    // In single mode: connect all adapters directly.
    if (this.config.cluster?.enabled && this.database.getAdapter().type === 'postgres') {
      const { AdapterClaimManager } = await import('./adapter-claim-manager.js');
      this.adapterClaimManager = new AdapterClaimManager(
        this.database.getAdapter(),
        this.config.cluster.nodeId,
        this.logger.child({ component: 'adapter-claims' }),
      );

      // Try to claim each adapter, only connect if claimed
      for (const [platform, adapter] of this.adapters) {
        // HTTP API always connects (both nodes serve API behind load balancer)
        if (platform === 'api') {
          this.setupAdapterHandlers(platform, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (always-on)'); }
          catch (err) { this.logger.error({ platform, err }, 'Adapter connection failed'); }
          continue;
        }

        this.adapterClaimManager.registerPlatform(platform);
        const claimed = await this.adapterClaimManager.tryClaim(platform);
        if (claimed) {
          this.setupAdapterHandlers(platform, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (claimed)'); }
          catch (err) { this.logger.error({ platform, err }, 'Adapter connection failed'); }
        } else {
          this.logger.info({ platform }, 'Adapter claimed by another node, skipping');
        }
      }

      // When expired claims become available, connect the adapter (or start BMW streaming)
      this.adapterClaimManager.onAcquired(async (platform) => {
        if (platform === 'bmw-streaming') {
          if (this.bmwSkill) {
            this.logger.info('BMW MQTT streaming acquired from dead node, starting...');
            (this.bmwSkill as any).startStreaming()
              .then(() => this.logger.info('BMW MQTT streaming started (failover)'))
              .catch((err: unknown) => this.logger.warn({ err }, 'BMW MQTT streaming failover failed'));
          }
          return;
        }
        const adapter = this.adapters.get(platform as any);
        if (adapter && adapter.getStatus() === 'disconnected') {
          this.setupAdapterHandlers(platform as any, adapter);
          try { await adapter.connect(); this.logger.info({ platform }, 'Adapter connected (failover)'); }
          catch (err) { this.logger.error({ platform, err }, 'Failover adapter connection failed'); }
        }
      });

      this.adapterClaimManager.start();
    } else {
      // Single instance: connect all adapters
      for (const [platform, adapter] of this.adapters) {
        this.setupAdapterHandlers(platform, adapter);
        try {
          await adapter.connect();
          this.logger.info({ platform }, 'Adapter connected');
        } catch (err) {
          this.logger.error({ platform, err }, 'Adapter connection failed — skipping');
        }
      }
    }

    // Start BMW MQTT streaming — cluster-aware with failover
    if (this.bmwSkill && this.config.bmw?.streaming?.enabled) {
      if (this.adapterClaimManager) {
        this.adapterClaimManager.registerPlatform('bmw-streaming');
      }
      const canStream = !this.adapterClaimManager || await this.adapterClaimManager.tryClaim('bmw-streaming');
      if (canStream) {
        this.logger.info({ username: this.config.bmw.streaming.username, topic: this.config.bmw.streaming.topic }, 'Starting BMW MQTT streaming...');
        (this.bmwSkill as any).startStreaming()
          .then(() => this.logger.info('BMW MQTT streaming started'))
          .catch((err: unknown) => this.logger.warn({ err }, 'BMW MQTT streaming failed to start'));
      } else {
        this.logger.info('BMW MQTT streaming claimed by another node, skipping');
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

    // Scheduled system backups
    if (this.config.backup?.enabled && this.config.backup?.storage !== 'none') {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('system-backup');
      const backupSkill = this.skillRegistry.get('system_backup') as any;
      if (backupSkill) {
        let lastBackupMinute = -1;
        setInterval(async () => {
          const now = new Date();
          if (now.getMinutes() === lastBackupMinute) return;
          const schedule = this.config.backup?.schedule ?? '0 3 * * *';
          const [min, hour] = schedule.split(' ');
          const minMatch = min === '*' || (min.includes('/') ? now.getMinutes() % parseInt(min.split('/')[1]) === 0 : min.split(',').some(p => parseInt(p) === now.getMinutes()));
          const hourMatch = hour === '*' || (hour.includes('/') ? now.getHours() % parseInt(hour.split('/')[1]) === 0 : hour.split(',').some(p => parseInt(p) === now.getHours()));
          if (!minMatch || !hourMatch) return;
          lastBackupMinute = now.getMinutes();
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('system-backup');
            if (!claimed) return;
          }
          try {
            await backupSkill.createBackup({}, 'scheduled');
            this.logger.info('Scheduled system backup completed');
          } catch (err) {
            this.logger.warn({ err }, 'Scheduled system backup failed');
          }
        }, 60_000);
        this.logger.info({ schedule: this.config.backup.schedule ?? '0 3 * * *' }, 'System backup scheduler started');
      }
    }

    // Commvault proactive monitoring
    if (this.config.commvault?.enabled && (this.config.commvault.polling_interval ?? 30) > 0) {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('commvault-monitor');
      const cvSkill = this.skillRegistry.get('commvault') as any;
      if (cvSkill?.pollAndReport) {
        const intervalMs = (this.config.commvault.polling_interval ?? 30) * 60_000;
        setInterval(async () => {
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('commvault-monitor');
            if (!claimed) return;
          }
          try {
            const result = await cvSkill.pollAndReport();
            if (result.failed > 0 || result.storageWarnings.length > 0 || result.slaViolations.length > 0) {
              this.logger.info({ ...result }, 'Commvault monitoring alert');
            }
          } catch (err) {
            this.logger.debug({ err }, 'Commvault monitoring poll failed');
          }
        }, intervalMs);
        this.logger.info({ interval: `${this.config.commvault.polling_interval ?? 30}min` }, 'Commvault monitoring started');
      }
    }

    // MikroTik proactive monitoring
    if (this.config.mikrotik?.enabled && (this.config.mikrotik.polling_interval ?? 5) > 0) {
      if (this.adapterClaimManager) this.adapterClaimManager.registerPlatform('mikrotik-monitor');
      const mtSkill = this.skillRegistry.get('mikrotik') as any;
      if (mtSkill?.pollAndReport) {
        const intervalMs = (this.config.mikrotik.polling_interval ?? 5) * 60_000;
        setInterval(async () => {
          if (this.adapterClaimManager) {
            const claimed = await this.adapterClaimManager.tryClaim('mikrotik-monitor');
            if (!claimed) return;
          }
          try {
            const result = await mtSkill.pollAndReport();
            if (result.downInterfaces.length > 0 || result.cpuWarnings.length > 0) {
              this.logger.info({ ...result }, 'MikroTik monitoring alert');
            }
          } catch (err) {
            this.logger.debug({ err }, 'MikroTik monitoring poll failed');
          }
        }, intervalMs);
        this.logger.info({ interval: `${this.config.mikrotik.polling_interval ?? 5}min` }, 'MikroTik monitoring started');
      }
    }

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

    // Register OAuth callbacks on HTTP adapter
    {
      const apiAdapter = this.adapters.get('api');
      if (apiAdapter && 'registerOAuthCallback' in apiAdapter) {
        if (this.spotifySkill) {
          (apiAdapter as any).registerOAuthCallback('spotify', (code: string, state: Record<string, unknown>) =>
            this.spotifySkill!.handleOAuthCallback(code, state)
          );
          this.logger.info('Spotify OAuth callback registered');
        }
        if (this.sonosSkill && this.config.sonos?.cloud?.clientId) {
          (apiAdapter as any).registerOAuthCallback('sonos', (code: string, state: Record<string, unknown>) =>
            this.sonosSkill!.handleOAuthCallback(code, state)
          );
          this.logger.info('Sonos Cloud OAuth callback registered');
        }
      }
    }

    // Wire Knowledge Graph API on HTTP adapter
    {
      const apiAdapter = this.adapters.get('api');
      const dbAdapter = this.database.getAdapter();
      if (apiAdapter && 'setKnowledgeGraphCallbacks' in apiAdapter) {
        const kgRepoForApi = new KnowledgeGraphRepository(dbAdapter);
        (apiAdapter as any).setKnowledgeGraphCallbacks({
          getGraph: async (userId?: string) => {
            const uid = userId ?? this.config.security?.ownerUserId ?? '';
            try {
              const user = await this.userRepo!.findOrCreate('telegram' as any, uid);
              const resolvedId = user.masterUserId ?? user.id;
              return kgRepoForApi.getFullGraph(resolvedId);
            } catch {
              return kgRepoForApi.getFullGraph(uid);
            }
          },
          deleteEntity: async (entityId: string) => {
            const result = await dbAdapter.execute('DELETE FROM kg_entities WHERE id = ?', [entityId]);
            return result.changes > 0;
          },
          deleteRelation: async (relationId: string) => {
            const result = await dbAdapter.execute('DELETE FROM kg_relations WHERE id = ?', [relationId]);
            return result.changes > 0;
          },
          updateEntity: async (entityId: string, data: Record<string, unknown>) => {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); sets.push('normalized_name = ?'); params.push(String(data.name).trim().toLowerCase()); }
            if (data.entityType !== undefined) { sets.push('entity_type = ?'); params.push(data.entityType); }
            if (data.attributes !== undefined) { sets.push('attributes = ?'); params.push(JSON.stringify(data.attributes)); }
            if (sets.length === 0) return false;
            sets.push('last_seen_at = ?'); params.push(new Date().toISOString());
            params.push(entityId);
            try {
              const result = await dbAdapter.execute(`UPDATE kg_entities SET ${sets.join(', ')} WHERE id = ?`, params);
              return result.changes > 0;
            } catch { return false; }
          },
          updateRelation: async (relationId: string, data: Record<string, unknown>) => {
            const sets: string[] = [];
            const params: unknown[] = [];
            if (data.relationType !== undefined) { sets.push('relation_type = ?'); params.push(data.relationType); }
            if (data.strength !== undefined) { sets.push('strength = ?'); params.push(data.strength); }
            if (data.context !== undefined) { sets.push('context = ?'); params.push(data.context); }
            if (sets.length === 0) return false;
            sets.push('last_seen_at = ?'); params.push(new Date().toISOString());
            params.push(relationId);
            try {
              const result = await dbAdapter.execute(`UPDATE kg_relations SET ${sets.join(', ')} WHERE id = ?`, params);
              return result.changes > 0;
            } catch { return false; }
          },
        });
        this.logger.info('Knowledge Graph API registered');
      }
    }

    // Wire CMDB/ITSM/Docs API on HTTP adapter (only when CMDB skills are registered)
    if (this.config.cmdb?.enabled !== false && (this.config.proxmox || this.config.unifi || this.config.docker || this.config.cloudflare || this.config.nginxProxyManager || this.config.pfsense || this.config.homeassistant)) {
      const apiAdapter = this.adapters.get('api');
      const dbAdapter = this.database.getAdapter();
      if (apiAdapter && 'setCmdbCallbacks' in apiAdapter) {
        const cmdbRepo = new CmdbRepository(dbAdapter);
        const itsmRepo = new ItsmRepository(dbAdapter);
        itsmRepo.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const { ProblemRepository: ProblemRepo } = await import('@alfred/storage');
        const problemRepo = new ProblemRepo(dbAdapter);

        const resolveUser = async (userId: string) => {
          if (!userId && this.config.security?.ownerUserId && this.userRepo) {
            try {
              const user = await this.userRepo.findOrCreate('telegram' as any, this.config.security.ownerUserId);
              return user.masterUserId ?? user.id ?? this.config.security.ownerUserId;
            } catch { return this.config.security.ownerUserId; }
          }
          return userId || this.ownerMasterUserId || this.config.security?.ownerUserId || '';
        };

        (apiAdapter as any).setCmdbCallbacks({
          listAssets: async (uid: string, filters?: Record<string, unknown>) => cmdbRepo.listAssets(await resolveUser(uid), filters as any),
          getAsset: async (uid: string, id: string) => {
            const ruid = await resolveUser(uid);
            const asset = await cmdbRepo.getAssetById(ruid, id);
            const relations = asset ? await cmdbRepo.getRelationsForAsset(ruid, id) : [];
            const changes = asset ? await cmdbRepo.getChangesForAsset(ruid, id, 20) : [];
            return { asset, relations, changes };
          },
          createAsset: async (uid: string, data: Record<string, unknown>) => cmdbRepo.upsertAsset(await resolveUser(uid), data as any),
          updateAsset: async (uid: string, id: string, data: Record<string, unknown>) => cmdbRepo.updateAsset(await resolveUser(uid), id, data as any),
          deleteAsset: async (uid: string, id: string) => cmdbRepo.decommissionAsset(await resolveUser(uid), id),
          listRelations: async (uid: string) => cmdbRepo.getAllRelations(await resolveUser(uid)),
          createRelation: async (uid: string, data: Record<string, unknown>) => cmdbRepo.upsertRelation(await resolveUser(uid), data.source_asset_id as string, data.target_asset_id as string, data.relation_type as any),
          deleteRelation: async (uid: string, id: string) => cmdbRepo.removeRelation(await resolveUser(uid), id),
          discover: async (uid: string) => {
            // Trigger discovery via skill execution
            const cmdbSkill = this.skillRegistry?.get('cmdb');
            if (cmdbSkill) {
              return cmdbSkill.execute({ action: 'discover' }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            }
            return { success: false, error: 'CMDB skill not registered' };
          },
          getStats: async (uid: string) => cmdbRepo.getStats(await resolveUser(uid)),
          getChanges: async (uid: string, assetId: string) => cmdbRepo.getChangesForAsset(await resolveUser(uid), assetId),
          listDocuments: async (uid: string, filters?: Record<string, unknown>) => cmdbRepo.listDocuments(await resolveUser(uid), filters as any),
          getDocument: async (uid: string, id: string) => cmdbRepo.getDocumentById(await resolveUser(uid), id),
          getDocumentTree: async (uid: string) => cmdbRepo.getDocumentTree(await resolveUser(uid)),
          saveDocument: async (uid: string, data: Record<string, unknown>) => cmdbRepo.saveDocument(await resolveUser(uid), data as any),
          updateDocument: async (uid: string, id: string, data: Record<string, unknown>) => cmdbRepo.updateDocument(await resolveUser(uid), id, data as any),
          deleteDocument: async (uid: string, id: string) => cmdbRepo.deleteDocument(await resolveUser(uid), id),
          getDocumentVersions: async (uid: string, entityType: string, entityId: string, docType: string) =>
            cmdbRepo.getDocumentVersions(await resolveUser(uid), entityType, entityId, docType),
          searchDocuments: async (uid: string, query: string, filters?: Record<string, unknown>) =>
            cmdbRepo.searchDocuments(await resolveUser(uid), query, filters as any),
        });

        (apiAdapter as any).setItsmCallbacks({
          listIncidents: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listIncidents(await resolveUser(uid), filters as any),
          getIncident: async (uid: string, id: string) => itsmRepo.getIncidentById(await resolveUser(uid), id),
          createIncident: async (uid: string, data: Record<string, unknown>) => itsmRepo.createIncident(await resolveUser(uid), data as any),
          updateIncident: async (uid: string, id: string, data: Record<string, unknown>) => {
            // snake_case → camelCase for API/WebUI callers
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) {
              mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            }
            return itsmRepo.updateIncident(await resolveUser(uid), id, mapped as any);
          },
          listChanges: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listChangeRequests(await resolveUser(uid), filters as any),
          createChange: async (uid: string, data: Record<string, unknown>) => itsmRepo.createChangeRequest(await resolveUser(uid), data as any),
          updateChange: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return itsmRepo.updateChangeRequest(await resolveUser(uid), id, mapped as any);
          },
          listServices: async (uid: string, filters?: Record<string, unknown>) => itsmRepo.listServices(await resolveUser(uid), filters as any),
          createService: async (uid: string, data: Record<string, unknown>) => {
            const userId = await resolveUser(uid);
            const svc = await itsmRepo.createService(userId, data as any);
            // Persist JSON fields that createService doesn't handle (components, failureModes, sla)
            const jsonUpdates: Record<string, unknown> = {};
            if (data.components) jsonUpdates.components = data.components;
            if (data.failureModes) jsonUpdates.failureModes = data.failureModes;
            if (data.sla) jsonUpdates.sla = data.sla;
            if (Object.keys(jsonUpdates).length > 0) {
              return itsmRepo.updateService(userId, svc.id, jsonUpdates as any) ?? svc;
            }
            return svc;
          },
          updateService: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return itsmRepo.updateService(await resolveUser(uid), id, mapped as any);
          },
          healthCheck: async (uid: string) => {
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) return itsmSkill.execute({ action: 'health_check' }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'ITSM skill not registered' };
          },
          getDashboard: async (uid: string) => itsmRepo.getDashboard(await resolveUser(uid)),
          // Service Management
          getService: async (uid: string, id: string) => itsmRepo.getServiceById(await resolveUser(uid), id),
          deleteService: async (uid: string, id: string) => itsmRepo.deleteService(await resolveUser(uid), id),
          getServicesForAsset: async (uid: string, assetId: string) => itsmRepo.getServicesForAsset(await resolveUser(uid), assetId),
          generateDocs: async (uid: string, serviceId: string) => {
            const skill = this.skillRegistry?.get('infra_docs');
            if (skill) return skill.execute({ action: 'generate_service_doc', service_id: serviceId }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs not available' };
          },
          // Problem Management
          listProblems: async (uid: string, filters?: Record<string, unknown>) => problemRepo.listProblems(await resolveUser(uid), filters as any),
          getProblem: async (uid: string, id: string) => problemRepo.getProblemById(await resolveUser(uid), id),
          createProblem: async (uid: string, data: Record<string, unknown>) => problemRepo.createProblem(await resolveUser(uid), data as any),
          updateProblem: async (uid: string, id: string, data: Record<string, unknown>) => {
            const mapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) mapped[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
            return problemRepo.updateProblem(await resolveUser(uid), id, mapped as any);
          },
          linkIncidentToProblem: async (uid: string, problemId: string, incidentId: string) => problemRepo.linkIncident(await resolveUser(uid), problemId, incidentId),
          unlinkIncidentFromProblem: async (uid: string, problemId: string, incidentId: string) => problemRepo.unlinkIncident(await resolveUser(uid), problemId, incidentId),
          createFixChange: async (uid: string, problemId: string, data: Record<string, unknown>) => {
            const cr = await itsmRepo.createChangeRequest(await resolveUser(uid), { ...data, linkedProblemId: problemId } as any);
            await problemRepo.linkChangeRequest(await resolveUser(uid), problemId, cr.id);
            return { problem: await problemRepo.getProblemById(await resolveUser(uid), problemId), changeRequest: cr };
          },
          detectPatterns: async (uid: string, data: Record<string, unknown>) => problemRepo.detectPatterns(await resolveUser(uid), data as any),
          getProblemDashboard: async (uid: string) => problemRepo.getDashboard(await resolveUser(uid)),
          // SLA Management
          setSla: async (uid: string, targetType: string, targetId: string, sla: Record<string, unknown>) => {
            const userId = await resolveUser(uid);
            if (targetType === 'service') {
              return itsmRepo.updateService(userId, targetId, { sla } as any);
            } else {
              return cmdbRepo.updateAsset(userId, targetId, { sla } as any);
            }
          },
          getSlaReport: async (uid: string, targetType: string, targetId: string, period?: string) => {
            const userId = await resolveUser(uid);
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) {
              return itsmSkill.execute({ action: 'get_sla_report', sla_target_type: targetType, sla_target_id: targetId, sla_period: period }, { userId, masterUserId: userId } as any);
            }
            return { success: false, error: 'ITSM skill not registered' };
          },
          checkSlaCompliance: async (uid: string) => {
            const userId = await resolveUser(uid);
            const itsmSkill = this.skillRegistry?.get('itsm');
            if (itsmSkill) return itsmSkill.execute({ action: 'check_sla_compliance' }, { userId, masterUserId: userId } as any);
            return { success: false, error: 'ITSM skill not registered' };
          },
          getSlaBreaches: async (uid: string, period?: string) => {
            const userId = await resolveUser(uid);
            return itsmRepo.getSlaBreaches(userId, period ? new Date(period).toISOString() : undefined);
          },
        });

        (apiAdapter as any).setDocsCallbacks({
          generate: async (uid: string, type: string, params?: Record<string, unknown>) => {
            const docsSkill = this.skillRegistry?.get('infra_docs');
            if (docsSkill) return docsSkill.execute({ action: type, ...params }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs skill not registered' };
          },
          exportData: async (uid: string, format?: string) => {
            const docsSkill = this.skillRegistry?.get('infra_docs');
            if (docsSkill) return docsSkill.execute({ action: 'export', format }, { userId: await resolveUser(uid), masterUserId: await resolveUser(uid) } as any);
            return { success: false, error: 'InfraDocs skill not registered' };
          },
        });

        this.logger.info('CMDB/ITSM/Docs API registered');
      }
    }

    // ── Log Viewer + Cluster Operations API ──────────────────
    const logApiAdapter = this.adapters.get('api');
    if (logApiAdapter && 'setLogCallbacks' in logApiAdapter) {
      const logFilePath = this.config.logger.file?.path ?? process.env.ALFRED_LOG_FILE_PATH ?? './data/logs/alfred.log';
      const auditLogPath = this.config.logger.auditLogPath ?? './data/logs/audit.log';
      const fs = await import('node:fs');
      const readline = await import('node:readline');

      const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
      const LEVEL_NUMS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

      /** List all available log files for a base path, sorted newest first. */
      const listLogFiles = (filePath: string): Array<{ name: string; path: string; size: number; modified: string }> => {
        const files: Array<{ name: string; path: string; size: number; modified: string; mtime: number }> = [];
        // Scan directory for all log files matching the base name (numbered .1/.2 AND dated .2026-04-17)
        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath);
        try {
          for (const entry of fs.readdirSync(dir)) {
            if (entry === baseName || entry.startsWith(baseName + '.')) {
              const fullPath = path.join(dir, entry);
              try {
                const s = fs.statSync(fullPath);
                if (s.isFile()) {
                  files.push({ name: entry, path: fullPath, size: s.size, modified: new Date(s.mtimeMs).toISOString(), mtime: s.mtimeMs });
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* dir not found */ }
        files.sort((a, b) => b.mtime - a.mtime);
        return files.map(({ mtime: _, ...rest }) => rest);
      };

      const readLogFile = async (filePath: string, maxLines: number, levelFilter?: string, textFilter?: string, fileIndex?: number) => {
        const allFiles = listLogFiles(filePath);
        if (allFiles.length === 0) return { lines: [], total: 0, file: filePath, files: [] };
        // fileIndex 0 = newest (default), 1 = second newest, etc.
        const idx = Math.min(fileIndex ?? 0, allFiles.length - 1);
        const actualFile = allFiles[idx].path;

        const content = fs.readFileSync(actualFile, 'utf-8');
        const rawLines = content.split('\n').filter(Boolean);
        let parsed = rawLines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean) as Array<Record<string, unknown>>;

        if (levelFilter) {
          const minLevel = LEVEL_NUMS[levelFilter] ?? 30;
          parsed = parsed.filter(l => (l.level as number) >= minLevel);
        }
        if (textFilter) {
          const lower = textFilter.toLowerCase();
          parsed = parsed.filter(l => {
            const msg = ((l.msg as string) ?? '').toLowerCase();
            const comp = ((l.component as string) ?? '').toLowerCase();
            return msg.includes(lower) || comp.includes(lower) || JSON.stringify(l).toLowerCase().includes(lower);
          });
        }

        const total = parsed.length;
        const lines = parsed.slice(-maxLines);
        return { lines, total, file: actualFile, files: allFiles };
      };

      (logApiAdapter as any).setLogCallbacks({
        readAppLog: (lines: number, level?: string, filter?: string, fileIndex?: number) =>
          readLogFile(logFilePath, lines, level, filter, fileIndex),
        readAuditLog: (lines: number, _level?: string, _filter?: string, fileIndex?: number) =>
          readLogFile(auditLogPath, lines, undefined, undefined, fileIndex),
        streamAppLog: (res: import('http').ServerResponse, level?: string, filter?: string) => {
          // Find the current (newest) log file via listLogFiles
          const logFilesList = listLogFiles(logFilePath);
          const actualFile = logFilesList.length > 0 ? logFilesList[0].path : logFilePath;

          const minLevel = level ? (LEVEL_NUMS[level] ?? 30) : 0;
          const lowerFilter = filter?.toLowerCase();

          // Watch for changes and stream new lines
          let lastSize = 0;
          try { lastSize = fs.statSync(actualFile).size; } catch { /* new file */ }

          const watcher = fs.watch(actualFile, () => {
            try {
              const stat = fs.statSync(actualFile);
              if (stat.size <= lastSize) { lastSize = stat.size; return; }

              const stream = fs.createReadStream(actualFile, { start: lastSize, encoding: 'utf-8' });
              let buffer = '';
              stream.on('data', (chunk: string | Buffer) => { buffer += String(chunk); });
              stream.on('end', () => {
                for (const line of buffer.split('\n').filter(Boolean)) {
                  try {
                    const parsed = JSON.parse(line);
                    if (minLevel && (parsed.level as number) < minLevel) continue;
                    if (lowerFilter) {
                      const str = JSON.stringify(parsed).toLowerCase();
                      if (!str.includes(lowerFilter)) continue;
                    }
                    if (!res.writableEnded) {
                      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                    }
                  } catch { /* skip malformed */ }
                }
                lastSize = stat.size;
              });
            } catch { /* file may have rotated */ }
          });

          return () => { watcher.close(); };
        },
      });
    }

    if (logApiAdapter && 'setClusterCallbacks' in logApiAdapter) {
      const dbAdapter = this.database?.getAdapter();
      const nodeId = this.config.cluster?.nodeId ?? 'single';
      const clusterEnabled = this.config.cluster?.enabled === true;
      const reasoningSchedule = this.config.reasoning?.schedule ?? 'hourly';
      const startedAt = this.startedAt;

      (logApiAdapter as any).setClusterCallbacks({
        getHealth: async () => {
          const nodes: Array<Record<string, unknown>> = [];
          const claims: Array<Record<string, unknown>> = [];
          const reasoningSlots: Array<Record<string, unknown>> = [];

          if (dbAdapter) {
            try {
              const nodeRows = await dbAdapter.query('SELECT * FROM node_heartbeats ORDER BY last_seen_at DESC', []);
              const now = Date.now();
              for (const row of nodeRows as any[]) {
                nodes.push({
                  nodeId: row.node_id,
                  host: row.host ?? '',
                  lastSeenAt: row.last_seen_at,
                  startedAt: row.started_at,
                  uptimeS: row.uptime_s ?? 0,
                  adapters: JSON.parse(row.adapters ?? '[]'),
                  version: row.version ?? '',
                  alive: (now - new Date(row.last_seen_at).getTime()) < 60_000,
                });
              }
            } catch { /* table may not exist in SQLite mode */ }

            try {
              const claimRows = await dbAdapter.query('SELECT * FROM adapter_claims ORDER BY platform', []);
              const now = new Date().toISOString();
              for (const row of claimRows as any[]) {
                claims.push({
                  platform: row.platform,
                  nodeId: row.node_id,
                  claimedAt: row.claimed_at,
                  expiresAt: row.expires_at,
                  active: row.expires_at > now,
                });
              }
            } catch { /* table may not exist */ }

            try {
              const slotRows = await dbAdapter.query(
                'SELECT * FROM reasoning_slots ORDER BY claimed_at DESC LIMIT 20', [],
              );
              for (const row of slotRows as any[]) {
                reasoningSlots.push({
                  slotKey: row.slot_key,
                  nodeId: row.node_id,
                  claimedAt: row.claimed_at,
                });
              }
            } catch { /* table may not exist */ }
          }

          // If single mode, create a synthetic node entry
          if (!clusterEnabled && nodes.length === 0) {
            const uptimeS = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
            const adapterList = [...(this.adapters?.keys() ?? [])];
            nodes.push({
              nodeId, host: require('os').hostname(), lastSeenAt: new Date().toISOString(),
              startedAt, uptimeS, adapters: adapterList, version: '', alive: true,
            });
          }

          return {
            clusterEnabled,
            thisNodeId: nodeId,
            nodes,
            claims,
            recentReasoningSlots: reasoningSlots,
            operations: {
              reasoning: { schedule: reasoningSchedule },
              backup: this.config.backup?.schedule ? { schedule: this.config.backup.schedule } : undefined,
            },
          };
        },
      });
    }

    // Startup cleanup — retain audit/summary/activity/usage data
    try {
      const cleaned = {
        audit: await this.auditRepo?.cleanup(90) ?? 0,
        summaries: await this.summaryRepo?.cleanup(180) ?? 0,
        activity: await this.activityRepo?.cleanup(90) ?? 0,
        usage: await this.usageRepo?.cleanup(365) ?? 0,
        expiredMemories: await this.memoryRepo?.cleanupExpired() ?? 0,
        processedMessages: this.config.cluster?.enabled
          ? await new (await import('@alfred/storage')).ProcessedMessageRepository(this.database.getAdapter()).cleanup()
          : 0,
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

    // Memory consolidation: daily cleanup of stale + duplicate memories (runs at ~3:00 AM)
    if (this.config.activeLearning?.enabled !== false && this.memoryRepo) {
      const consolidator = new MemoryConsolidator(this.llmProvider, this.memoryRepo, this.logger.child({ component: 'memory-consolidator' }));
      if (this.database) {
        const { EmbeddingRepository } = await import('@alfred/storage');
        const embRepo = new EmbeddingRepository(this.database.getAdapter());
        consolidator.setEmbeddingRepo(embRepo);
      }
      const userRepoRef = this.userRepo;
      let lastConsolidationDay = '';
      this.memoryConsolidatorTimer = setInterval(async () => {
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (now.getHours() !== 3 || lastConsolidationDay === today) return;
        lastConsolidationDay = today;
        try {
          const users = await userRepoRef.listAll();
          for (const user of users) {
            const result = await consolidator.consolidate(user.id);
            if (result.deleted > 0 || result.merged > 0) {
              this.logger.info({ userId: user.id, ...result }, 'Memory consolidation completed');
            }
          }
        } catch (err) {
          this.logger.warn({ err }, 'Memory consolidation failed');
        }
      }, 60 * 60_000); // Check every hour, only acts once at 3 AM

      // Pattern analysis: daily extraction of behavioral patterns (runs at ~3:30 AM, after consolidation)
      if (this.activityRepo) {
        const patternAnalyzer = new PatternAnalyzer(this.llmProvider, this.memoryRepo, this.activityRepo, this.logger.child({ component: 'pattern-analyzer' }));
        let lastPatternDay = '';
        this.patternAnalyzerTimer = setInterval(async () => {
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          if (now.getHours() !== 3 || now.getMinutes() < 30 || lastPatternDay === today) return;
          lastPatternDay = today;
          try {
            const users = await userRepoRef.listAll();
            for (const user of users) {
              const count = await patternAnalyzer.analyze(user.id);
              if (count > 0) {
                this.logger.info({ userId: user.id, patterns: count }, 'Pattern analysis completed');
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'Pattern analysis failed');
          }
        }, 60 * 60_000); // Check every hour, only acts at 3:30 AM

        // Temporal analysis: weekly trends + anomalies (Sunday 4:00 AM)
        const temporalAnalyzer = new TemporalAnalyzer(this.activityRepo, this.memoryRepo, this.logger.child({ component: 'temporal-analyzer' }));
        let lastTemporalWeek = '';
        this.temporalAnalyzerTimer = setInterval(async () => {
          const now = new Date();
          const isoWeek = `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;
          // Only run on Sundays at 4:00 AM, once per week
          if (now.getDay() !== 0 || now.getHours() !== 4 || lastTemporalWeek === isoWeek) return;
          lastTemporalWeek = isoWeek;

          // HA distributed dedup: only one node runs weekly maintenance
          if (this.database.getAdapter().type === 'postgres') {
            try {
              const slotKey = `maintenance:${isoWeek}`;
              const slotResult = await this.database.getAdapter().execute(
                'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
                [slotKey, this.config.cluster?.nodeId ?? 'single', now.toISOString()],
              );
              if (slotResult.changes === 0) {
                this.logger.debug('Weekly maintenance slot already claimed by another node');
                return;
              }
            } catch { /* proceed on error (table might not exist yet) */ }
          }

          try {
            const users = await userRepoRef.listAll();
            const kgService = this.reasoningEngine
              ? new KnowledgeGraphService(new KnowledgeGraphRepository(this.database.getAdapter()), this.logger.child({ component: 'knowledge-graph' }), this.memoryRepo)
              : undefined;
            for (const user of users) {
              const report = await temporalAnalyzer.analyze(user.id);
              if (report.trends.length > 0 || report.anomalies.length > 0) {
                this.logger.info({ userId: user.id, trends: report.trends.length, anomalies: report.anomalies.length }, 'Temporal analysis completed');
              }
              // KG maintenance: decay old entities, prune weak ones
              if (kgService) await kgService.maintenance(user.id);
              // Action feedback: acceptance rates → memories
              if (this.activityRepo && this.memoryRepo) {
                const feedbackTracker = new ActionFeedbackTracker(this.activityRepo, this.memoryRepo, this.logger.child({ component: 'action-feedback' }));
                await feedbackTracker.analyze(user.id);
              }
              // Cleanup expired memories (connection_*, event-bound, TTL-based)
              if (this.memoryRepo) {
                try {
                  const cleaned = await this.memoryRepo.cleanupExpired();
                  if (cleaned > 0) this.logger.info({ cleaned }, 'Expired memories cleaned up');
                } catch (err) { this.logger.warn({ err: (err as Error).message }, 'Memory cleanup failed'); }
              }
              // Prune old BMW telematic history (keep 90 days)
              if (this.bmwTelematicRepo) {
                const pruned = await this.bmwTelematicRepo.prune(90);
                if (pruned > 0) this.logger.info({ pruned }, 'BMW telematic history pruned');
              }
              // Weekly chat LLM analysis: extract implicit knowledge from recent conversations
              if (kgService?.getLLMLinker()) {
                try {
                  const dbAdapter = this.database.getAdapter();
                  const recentMsgs = await dbAdapter.query(
                    `SELECT role, content FROM messages WHERE conversation_id IN (
                      SELECT id FROM conversations WHERE user_id = ?
                    ) ORDER BY created_at DESC LIMIT 100`,
                    [user.id],
                  ) as Array<{ role: string; content: string }>;
                  if (recentMsgs.length > 10) {
                    const chatStats = await kgService.getLLMLinker()!.analyzeRecentChats(user.id, recentMsgs.reverse());
                    if (chatStats.relations > 0 || chatStats.newEntities > 0) {
                      this.logger.info({ ...chatStats }, 'Weekly chat analysis completed');
                    }
                  }
                } catch (err) {
                  this.logger.debug({ err }, 'Weekly chat analysis failed');
                }
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'Temporal analysis failed');
          }
        }, 60 * 60_000); // Check every hour, only acts on Sunday 4 AM
      }
    }

    // ── Reflection Engine (self-optimization) ────────────────
    if (this.config.reflection?.enabled !== false && this.watchRepo && this.memoryRepo && this.activityRepo && this.skillRegistry && this.skillSandbox) {
      try {
        const reflectionConfig = resolveReflectionConfig(this.config.reflection);
        const ownerPlatform = (this.config.telegram?.enabled ? 'telegram'
          : this.config.discord?.enabled ? 'discord'
          : this.config.whatsapp?.enabled ? 'whatsapp'
          : 'api') as Platform;

        const reflectionAdapter = this.database?.getAdapter();
        const reflectionCmdbRepo = this.config.cmdb?.enabled !== false && reflectionAdapter
          ? new CmdbRepository(reflectionAdapter)
          : undefined;

        this.reflectionEngine = new ReflectionEngine({
          watchRepo: this.watchRepo,
          memoryRepo: this.memoryRepo,
          activityRepo: this.activityRepo,
          cmdbRepo: reflectionCmdbRepo,
          skillRegistry: this.skillRegistry,
          skillSandbox: this.skillSandbox,
          llm: this.llmProvider,
          adapters: this.adapters,
          logger: this.logger.child({ component: 'reflection-engine' }),
          defaultChatId: '',
          defaultPlatform: ownerPlatform,
          nodeId: this.config.cluster?.nodeId ?? 'single',
          config: reflectionConfig,
        }, this.database?.getAdapter());
        this.reflectionEngine.start();
        this.logger.info('Reflection engine initialized');
      } catch (err) {
        this.logger.warn({ err }, 'Reflection engine initialization failed');
      }
    }

    // Dead-node monitoring (observability only — adapter failover handled by AdapterClaimManager)
    if (this.clusterManager) {
      this.clusterMonitorTimer = setInterval(async () => {
        try {
          const nodes = await this.clusterManager!.getNodesAny();
          if (nodes.length > 0) {
            this.logger.debug({ liveNodes: nodes.map(n => n.id) }, 'Cluster node status');
          }
        } catch { /* ignore */ }
      }, 60_000);
    }

    // Insight expiry: process expired insights every 30 minutes for preference learning
    if (this.insightTracker && this.ownerMasterUserId) {
      const ownerMasterUserId = this.ownerMasterUserId;
      this.insightExpiryTimer = setInterval(() => {
        this.insightTracker!.processExpired(ownerMasterUserId).catch(err => {
          this.logger.warn({ err }, 'Insight expiry processing failed');
        });
      }, 30 * 60_000);
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

    // Stop BMW streaming
    if (this.bmwSkill && 'stopStreaming' in this.bmwSkill) {
      (this.bmwSkill as any).stopStreaming();
    }

    // Stop schedulers
    this.reminderScheduler?.stop();
    this.backgroundTaskRunner?.stop();
    this.proactiveScheduler?.stop();
    this.watchEngine?.stop();
    this.triggerManager?.stop();
    this.confirmationQueue?.stop();
    this.calendarWatcher?.stop();
    this.todoWatcher?.stop();
    this.reasoningEngine?.stop();
    this.adapterClaimManager?.stop();
    this.clusterManager?.stopPgHeartbeat();
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    if (this.memoryConsolidatorTimer) {
      clearInterval(this.memoryConsolidatorTimer);
      this.memoryConsolidatorTimer = undefined;
    }
    if (this.patternAnalyzerTimer) {
      clearInterval(this.patternAnalyzerTimer);
      this.patternAnalyzerTimer = undefined;
    }
    if (this.temporalAnalyzerTimer) {
      clearInterval(this.temporalAnalyzerTimer);
      this.temporalAnalyzerTimer = undefined;
    }
    if (this.insightExpiryTimer) {
      clearInterval(this.insightExpiryTimer);
      this.insightExpiryTimer = undefined;
    }
    if (this.clusterMonitorTimer) {
      clearInterval(this.clusterMonitorTimer);
      this.clusterMonitorTimer = undefined;
    }
    if (this.cmdbDiscoveryTimer) {
      clearInterval(this.cmdbDiscoveryTimer);
      this.cmdbDiscoveryTimer = undefined;
    }
    if (this.cmdbHealthCheckTimer) {
      clearInterval(this.cmdbHealthCheckTimer);
      this.cmdbHealthCheckTimer = undefined;
    }
    this.reflectionEngine?.stop();

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

  async reloadService(service: 'proxmox' | 'unifi' | 'homeassistant' | 'contacts' | 'docker' | 'bmw' | 'goe_charger' | 'routing' | 'todo'): Promise<{ success: boolean; error?: string }> {
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
        this.bmwSkill = new BMWSkill(freshConfig.bmw);
        this.skillRegistry.register(this.bmwSkill);
        // Re-inject service resolver + telematic repo for HA-safe persistence
        if (this.userServiceResolverRef && 'setServiceResolver' in this.bmwSkill) {
          (this.bmwSkill as any).setServiceResolver(this.userServiceResolverRef, this.ownerMasterUserId);
        }
        if (this.bmwTelematicRepo && 'setTelematicRepo' in this.bmwSkill) {
          (this.bmwSkill as any).setTelematicRepo(this.bmwTelematicRepo);
        }
        this.config.bmw = freshConfig.bmw;
        this.logger.info('BMW CarData skill hot-reloaded');
      }
      if (service === 'goe_charger' && freshConfig.goeCharger?.host) {
        const { GoeChargerSkill } = await import('@alfred/skills');
        this.skillRegistry.register(new GoeChargerSkill(freshConfig.goeCharger, freshConfig.energy));
        this.config.goeCharger = freshConfig.goeCharger;
        this.logger.info('go-e Charger skill hot-reloaded');
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

  private getConfiguredServices(): Array<{ name: string; provider: string; model: string; status: string }> {
    const services: Array<{ name: string; provider: string; model: string; status: string }> = [];
    const speech = this.config.speech;
    if (speech) {
      const sttProvider = speech.sttProvider ?? speech.provider;
      const ttsProvider = speech.ttsProvider ?? speech.provider;
      if (sttProvider) {
        const model = sttProvider === 'mistral' ? 'voxtral-mini-latest' : sttProvider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
        services.push({ name: 'Speech-to-Text', provider: sttProvider, model, status: 'active' });
      }
      if (speech.ttsEnabled !== false && ttsProvider) {
        const model = ttsProvider === 'mistral' ? 'voxtral-mini-tts-2603' : 'tts-1';
        services.push({ name: 'Text-to-Speech', provider: ttsProvider, model, status: 'active' });
      }
    }
    if (this.config.mistralApiKey) {
      services.push({ name: 'OCR', provider: 'mistral', model: 'mistral-ocr-latest', status: 'active' });
    }
    if (this.config.security?.moderation?.enabled) {
      const provider = this.config.security.moderation.provider ?? 'mistral';
      const model = this.config.security.moderation.model ?? (provider === 'mistral' ? 'mistral-moderation-latest' : 'omni-moderation-latest');
      services.push({ name: 'Moderation', provider, model, status: 'active' });
    }
    const embTier = (this.config.llm as Record<string, unknown>).embeddings as Record<string, unknown> | undefined;
    if (embTier?.provider) {
      services.push({ name: 'Embeddings', provider: embTier.provider as string, model: embTier.model as string ?? 'unknown', status: 'active' });
    }
    if (this.config.reasoning?.llmLinking?.enabled) {
      const llmLinkCfg = this.config.reasoning.llmLinking;
      services.push({ name: 'KG Entity-Linking', provider: llmLinkCfg.provider ?? 'mistral', model: llmLinkCfg.model ?? 'mistral-small-latest', status: 'active' });
    }
    return services;
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

  private async buildPrometheusMetrics(): Promise<string> {
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
      lines.push(`alfred_watches_active ${await this.watchRepo.countEnabled()}`);
    }
    if (this.scheduledActionRepo) {
      lines.push('# HELP alfred_schedulers_active Number of enabled scheduled actions');
      lines.push('# TYPE alfred_schedulers_active gauge');
      lines.push(`alfred_schedulers_active ${await this.scheduledActionRepo.countEnabled()}`);
    }

    // Persisted daily totals from DB
    if (this.usageRepo) {
      const today = new Date().toISOString().slice(0, 10);
      const daily = await this.usageRepo.getDaily(today);
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

  private async autoLinkApiUser(message: NormalizedMessage): Promise<void> {
    if (message.platform !== 'api') return;

    try {
      const apiUser = await this.userRepo.findOrCreate('api', message.userId, message.userName);
      const masterUserId = await this.userRepo.getMasterUserId(apiUser.id);

      // Already linked to another user
      if (masterUserId !== apiUser.id) return;

      // Find the first non-API/non-CLI user to link with
      const existingUser = await this.userRepo.findFirstByPlatformNotIn(['api', 'cli']);
      if (existingUser) {
        const targetMasterId = await this.userRepo.getMasterUserId(existingUser.id);
        await this.userRepo.setMasterUser(apiUser.id, targetMasterId);
        this.logger.info({ apiUserId: apiUser.id, masterUserId: targetMasterId }, 'Auto-linked API user');
      }
    } catch (err) {
      this.logger.debug({ err }, 'Auto-link API user failed');
    }
  }

  private setupAdapterHandlers(platform: Platform, adapter: MessagingAdapter): void {
    adapter.on('message', async (message: NormalizedMessage) => {
      try {
        // Handle /stop command — cancel active request for this user
        if (message.text?.trim().toLowerCase() === '/stop') {
          const cancelled = this.pipeline.cancelRequest(message.chatId, message.userId);
          const reply = cancelled ? '⏹ Anfrage abgebrochen.' : 'Keine laufende Anfrage zum Abbrechen.';
          try { await adapter.sendMessage(message.chatId, reply); } catch { /* ignore */ }
          return;
        }

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
          'email', 'calendar', 'contacts', 'bmw', 'todo', 'microsoft_todo', 'onedrive',
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
            const dmResult = await adapter.sendDirectMessage(message.userId, formatted.text, sendOpts);
            if (dmResult) {
              // Notify the group
              await adapter.sendMessage(message.chatId, `@${message.userName ?? message.userId}, Antwort per DM gesendet (persönliche Daten).`);
              // Send attachments via DM too
              if (result.attachments) {
                for (const att of result.attachments) {
                  try {
                    await adapter.sendDirectMessage(message.userId, att.fileName ?? 'file');
                  } catch { /* skip */ }
                }
              }
            } else {
              // DM failed — send in group as fallback
              await adapter.sendMessage(message.chatId, formatted.text, sendOpts);
            }
          } catch (err) {
            this.logger.warn({ err, chatId: message.chatId }, 'Group privacy DM redirect failed, sending in group');
            // Fallback: send in group anyway
            const formatted = this.formatter.format(result.text, message.platform);
            await adapter.sendMessage(message.chatId, formatted.text);
          }
          if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
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
              const isAudio = att.mimeType?.startsWith('audio/') ?? false;
              const isVoice = att.mimeType === 'audio/ogg' || att.mimeType === 'audio/opus';
              if (isImage) {
                await adapter.sendPhoto(message.chatId, att.data, att.fileName);
              } else if (isVoice) {
                await adapter.sendVoice(message.chatId, att.data);
              } else if (isAudio) {
                // Send as audio (playable in Telegram) — MP3, WAV, etc.
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
        if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
      } catch (error) {
        this.logger.error({ platform, err: error, chatId: message.chatId }, 'Failed to handle message');
        try {
          await adapter.sendMessage(message.chatId, 'Sorry, I encountered an error processing your message. Please try again.');
        } catch (sendError) {
          this.logger.error({ err: sendError }, 'Failed to send error message');
        }
        if ('endStream' in adapter) (adapter as any).endStream(message.chatId);
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

  /** Find a Mistral API key. Checks dedicated mistralApiKey first, then LLM tiers.
   *  This allows using Mistral services (OCR, moderation, STT, TTS, embeddings)
   *  independently of the main LLM provider. */
  private detectMistralApiKey(): string | undefined {
    // 1. Dedicated standalone key (ALFRED_MISTRAL_API_KEY → config.mistralApiKey)
    if (this.config.mistralApiKey) {
      return this.config.mistralApiKey;
    }
    // 2. Any LLM tier using Mistral as provider
    const tiers = ['default', 'strong', 'fast', 'embeddings', 'local'] as const;
    for (const tier of tiers) {
      const tierConfig = this.config.llm[tier];
      if (tierConfig?.provider === 'mistral' && tierConfig.apiKey) {
        return tierConfig.apiKey;
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
