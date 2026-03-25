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
import { PromptBuilder, estimateTokens, estimateMessageTokens, trimOldToolResults, calculateCost } from '@alfred/llm';
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

/** Skills whose output is specific to the executing node (filesystem, OS, local processes). */
const NODE_LOCAL_SKILLS = new Set([
  'shell', 'file', 'system_info', 'screenshot', 'clipboard',
  'docker', 'code_sandbox', 'code_agent', 'project_agent', 'browser',
]);

const MAX_TOOL_DURATION_MS = 15 * 60 * 1000; // 15 minutes timeout for tool loop
const MAX_TOOL_ITERATIONS = 50; // Abort tool loop after N iterations
const MAX_REPEATED_ERRORS = 2; // Abort tool loop after N identical consecutive errors
const MAX_TOOL_RESULT_CHARS = 12_000; // Truncate tool results exceeding this length

/**
 * Detect if a user message contains "reasoning signals" — mentions of places, times,
 * travel, purchases, or plans that could benefit from proactive cross-context analysis.
 */
function hasReasoningSignal(text: string): boolean {
  if (!text || text.length < 10) return false;
  return /\b(fahr\w*|reis\w*|flieg\w*|flug\w*|morgen|übermorgen|nächst\w*\s+(woche|monat|sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)|am\s+(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)|nach\s+\w{3,}|kauf\w*|bestell\w*|brauch\w*|termin|treffen|abhol\w*|besuch\w*|urlaub|wien|graz|linz|salzburg|innsbruck|münchen|berlin|budapest|prag)\b/i.test(text);
}

/** Sensitive field names to redact from tool results before sending to LLM. */
const SECRET_PATTERNS = [
  /("(?:refreshToken|refresh_token|accessToken|access_token|clientSecret|client_secret|apiKey|api_key|password|idToken|id_token|secret|token_secret|app_key|appKey)"\s*:\s*")([^"]{8,})(")/gi,
  // Also catch long Bearer/JWT tokens that might appear inline
  /\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,
];

/**
 * Redact sensitive secrets from tool result content.
 * Replaces token values with [REDACTED] while preserving the key name
 * so the LLM knows a value EXISTS but cannot see or leak it.
 */
function redactSecrets(content: string): string {
  let result = content;
  // Redact JSON key-value patterns
  result = result.replace(SECRET_PATTERNS[0], '$1[REDACTED]$3');
  // Redact inline JWT tokens
  result = result.replace(SECRET_PATTERNS[1], '[REDACTED_TOKEN]');
  return result;
}
const MAX_CONTINUATION_ROUNDS = 3; // Max continuation rounds when LLM hits max_tokens
const TOKEN_BUDGET_RATIO = 0.85; // Use at most 85% of input window for context

/**
 * Truncate large tool results to keep LLM input manageable.
 * Preserves the beginning and end of the content so the LLM sees the structure
 * and knows how many entries were omitted.
 */
function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split('\n');
  if (lines.length <= 10) {
    // Few lines but very long — just hard-truncate
    return content.slice(0, maxChars) + '\n\n[... truncated, total ' + content.length + ' chars]';
  }
  // Keep ~70% head, ~20% tail, omit middle
  const headCount = Math.floor(lines.length * 0.7);
  const tailCount = Math.max(Math.floor(lines.length * 0.2), 5);
  const omitted = lines.length - headCount - tailCount;
  // Check if head+tail already fits
  const headLines = lines.slice(0, headCount);
  const tailLines = lines.slice(lines.length - tailCount);
  const marker = `\n[... ${omitted} Zeilen ausgelassen, insgesamt ${lines.length} Zeilen ...]\n`;
  const result = headLines.join('\n') + marker + tailLines.join('\n');
  // If still too long, reduce head
  if (result.length > maxChars) {
    const halfMax = Math.floor(maxChars * 0.7);
    return content.slice(0, halfMax) + '\n\n[... truncated, total ' + content.length + ' chars]\n\n' + content.slice(content.length - Math.floor(maxChars * 0.2));
  }
  return result;
}
const MAX_INLINE_FILE_SIZE = 100_000; // Include text file content inline up to 100KB
const MEMORY_TOKEN_BUDGET = 2000; // Max tokens for all memories in system prompt
const MIN_MEMORY_SCORE = 0.1; // Minimum relevance score for memory inclusion
const TOOL_LOOP_KEEP_RECENT = 3; // Keep last N tool pairs uncompressed during re-trimming
const HISTORY_WITH_SUMMARY = 10; // When summary exists, load 10 recent messages (tool pairs consume 2 slots each)

export type ProgressCallback = (status: string) => void;

export interface PipelineResult {
  text: string;
  attachments?: SkillResultAttachment[];
  /** Names of skills that were executed during this pipeline run. */
  usedSkills?: string[];
}

export interface PipelineMetrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsFailed: number;
  avgDurationMs: number;
  lastRequestAt?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
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
  fileStore?: import('@alfred/storage').FileStore;
  processedMessageRepo?: import('@alfred/storage').ProcessedMessageRepository;
  nodeId?: string;
  embeddingService?: EmbeddingService;
  activeLearning?: ActiveLearningService;
  memoryRetriever?: MemoryRetriever;
  maxHistoryMessages?: number;
  documentProcessor?: import('./document-processor.js').DocumentProcessor;
  conversationSummarizer?: import('./conversation-summarizer.js').ConversationSummarizer;
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
  private readonly fileStore?: import('@alfred/storage').FileStore;
  private readonly processedMessageRepo?: import('@alfred/storage').ProcessedMessageRepository;
  private readonly nodeId: string;
  private readonly embeddingService?: EmbeddingService;
  private readonly activeLearning?: ActiveLearningService;
  private readonly memoryRetriever?: MemoryRetriever;
  private readonly maxHistoryMessages: number;
  private readonly documentProcessor?: import('./document-processor.js').DocumentProcessor;
  private readonly conversationSummarizer?: import('./conversation-summarizer.js').ConversationSummarizer;

  private confirmationQueue?: import('./confirmation-queue.js').ConfirmationQueue;
  private activityLogger?: import('./activity-logger.js').ActivityLogger;
  private skillHealthTracker?: import('./skill-health-tracker.js').SkillHealthTracker;
  private alfredUserRepo?: import('@alfred/storage').AlfredUserRepository;
  private roleSkillAccess?: Record<string, string[] | '*'>;
  private usageRepo?: import('@alfred/storage').UsageRepository;
  private userServiceResolver?: { getServiceConfig: Function; getUserServices: Function; saveServiceConfig: Function; removeServiceConfig: Function };

  /** Registry of currently running delegate agents, keyed by a unique agent ID. */
  private readonly activeAgents = new Map<string, ActiveAgent>();
  private agentIdCounter = 0;

  /** Active request AbortControllers, keyed by chatId:userId */
  private readonly activeRequests = new Map<string, AbortController>();

  /** Cancel the active request for a specific chat+user. Returns true if something was cancelled. */
  cancelRequest(chatId: string, userId: string): boolean {
    const key = `${chatId}:${userId}`;
    const controller = this.activeRequests.get(key);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(key);
      return true;
    }
    return false;
  }

  private readonly metrics: PipelineMetrics = {
    requestsTotal: 0,
    requestsSuccess: 0,
    requestsFailed: 0,
    avgDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };

  getMetrics(): PipelineMetrics { return { ...this.metrics }; }

  setConfirmationQueue(queue: import('./confirmation-queue.js').ConfirmationQueue): void {
    this.confirmationQueue = queue;
  }

  setActivityLogger(logger: import('./activity-logger.js').ActivityLogger): void {
    this.activityLogger = logger;
  }

  setSkillHealthTracker(tracker: import('./skill-health-tracker.js').SkillHealthTracker): void {
    this.skillHealthTracker = tracker;
  }

  setAlfredUserRepo(
    repo: import('@alfred/storage').AlfredUserRepository,
    roleAccess: Record<string, string[] | '*'>,
    usageRepo?: import('@alfred/storage').UsageRepository,
    serviceResolver?: { getServiceConfig: Function; getUserServices: Function; saveServiceConfig: Function; removeServiceConfig: Function },
  ): void {
    this.alfredUserRepo = repo;
    this.roleSkillAccess = roleAccess;
    this.usageRepo = usageRepo;
    this.userServiceResolver = serviceResolver;
  }

  private recordMetric(success: boolean, durationMs: number, tokenData?: { input: number; output: number; costUsd: number }): void {
    this.metrics.requestsTotal++;
    if (success) {
      this.metrics.requestsSuccess++;
    } else {
      this.metrics.requestsFailed++;
    }
    // Running average
    this.metrics.avgDurationMs = Math.round(
      this.metrics.avgDurationMs + (durationMs - this.metrics.avgDurationMs) / this.metrics.requestsTotal,
    );
    this.metrics.lastRequestAt = new Date().toISOString();
    if (tokenData) {
      this.metrics.totalInputTokens += tokenData.input;
      this.metrics.totalOutputTokens += tokenData.output;
      this.metrics.totalCostUsd += tokenData.costUsd;
    }
  }

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
    this.fileStore = options.fileStore;
    this.processedMessageRepo = options.processedMessageRepo;
    this.nodeId = options.nodeId ?? 'single';
    this.embeddingService = options.embeddingService;
    this.activeLearning = options.activeLearning;
    this.memoryRetriever = options.memoryRetriever;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 30;
    this.documentProcessor = options.documentProcessor;
    this.conversationSummarizer = options.conversationSummarizer;
    this.promptBuilder = new PromptBuilder();
  }

  async process(message: NormalizedMessage, onProgress?: ProgressCallback): Promise<PipelineResult> {
    const startTime = Date.now();
    this.logger.info({ platform: message.platform, userId: message.userId, chatId: message.chatId }, 'Processing message');

    // Register AbortController for this request (keyed by chatId:userId)
    const requestKey = `${message.chatId}:${message.userId}`;
    const abortController = new AbortController();
    this.activeRequests.set(requestKey, abortController);

    // Show status immediately so user knows Alfred is working
    onProgress?.('Thinking...');

    // Check for pending confirmation response
    if (this.confirmationQueue && message.text) {
      const { context: confContext } = await buildSkillContext(this.users, {
        platformUserId: message.userId,
        platform: message.platform,
        chatId: message.chatId,
        chatType: message.chatType,
        userName: message.userName,
        displayName: message.displayName,
      });
      const handled = await this.confirmationQueue.checkForConfirmation(
        message.chatId, message.platform, message.text, confContext,
      );
      if (handled) return { text: '' }; // confirmation queue already sent its response via adapter
    }

    try {
      // 0b. HA Message dedup — ensure each message is processed by exactly one node
      if (this.processedMessageRepo) {
        const msgId = message.id ?? `${message.chatId}:${message.userId}:${Date.now()}`;
        const messageKey = `${message.platform}:${msgId}`;
        const claimed = await this.processedMessageRepo.markProcessed(messageKey, this.nodeId);
        if (!claimed) {
          this.logger.debug({ messageKey }, 'Message already processed by another node, skipping');
          return { text: '' };
        }
      }

      // 1. Resolve user, master ID, and linked platform IDs via central factory
      // For scheduled tasks, use the real user chatId for skill context (reminders, etc.)
      // but keep the isolated chatId for conversation management.
      const skillChatId = (message.metadata?.originalChatId as string) ?? message.chatId;

      const { user, masterUserId, linkedPlatformUserIds, context: baseContext } = await buildSkillContext(
        this.users,
        {
          platformUserId: message.userId,
          platform: message.platform,
          chatId: skillChatId,
          chatType: message.chatType,
          userName: message.userName,
          displayName: message.displayName,
        },
      );

      // 1b. Resolve Alfred user + role for multi-user support
      let alfredUser: { id: string; role: string; active: boolean; username: string } | undefined;
      try {
        alfredUser = await this.alfredUserRepo?.getUserByPlatform(message.platform, message.userId) as typeof alfredUser;
      } catch (err) {
        this.logger.debug({ err }, 'Alfred user lookup failed (table may not exist yet)');
      }
      if (alfredUser) {
        if (!alfredUser.active) {
          return { text: 'Dein Account ist deaktiviert. Bitte kontaktiere den Admin.' };
        }
        baseContext.userRole = alfredUser.role;
        baseContext.alfredUserId = alfredUser.id;
        if (this.userServiceResolver) {
          baseContext.userServiceResolver = this.userServiceResolver as SkillContext['userServiceResolver'];
        }
      }

      // HA context
      if (this.nodeId !== 'single') {
        baseContext.nodeId = this.nodeId;
        baseContext.clusterEnabled = true;
      }

      // FileStore context — enables skills to access S3/NFS stored files
      if (this.fileStore) {
        baseContext.fileStore = this.fileStore as SkillContext['fileStore'];
      }

      // 1c. Group conversation isolation: use chatId:userId as conversation key in groups
      const conversationChatId = message.chatType === 'group'
        ? `${message.chatId}:${message.userId}`
        : message.chatId;

      // 2. Find or create conversation
      const conversation = await this.conversationManager.getOrCreateConversation(
        message.platform,
        conversationChatId,
        user.id,
      );

      // 3. Load conversation summary & history
      const summary = (!message.metadata?.skipHistory && this.conversationSummarizer)
        ? await this.conversationSummarizer.getSummary(conversation.id)
        : undefined;
      const historyLimit = summary ? HISTORY_WITH_SUMMARY : this.maxHistoryMessages;
      const history = message.metadata?.skipHistory
        ? []
        : await this.conversationManager.getHistory(conversation.id, historyLimit);

      // 4. Save user message
      await this.conversationManager.addMessage(conversation.id, 'user', message.text);

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
              for (const m of await this.memoryRepo.getRecentForPrompt(uid, 5)) {
                if (!seen.has(m.key)) { seen.add(m.key); memories.push(m); }
              }
            }
          } else {
            const seen = new Set<string>();
            memories = [];
            for (const uid of memUserIds) {
              for (const m of await this.memoryRepo.getRecentForPrompt(uid, 20)) {
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
          userProfile = await (this.users as { getProfile(id: string): Promise<import('@alfred/llm').UserProfile | undefined> }).getProfile(masterUserId);
          if (userProfile && !userProfile.displayName) {
            userProfile.displayName = user.displayName ?? user.username;
          }
          if (userProfile && alfredUser?.username) {
            userProfile.alfredUsername = alfredUser.username;
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
        // Include recent user messages from conversation history so follow-up
        // questions retain the skill category context of earlier messages.
        const recentUserTexts = history
          .filter(m => m.role === 'user')
          .slice(-3)
          .map(m => m.content)
          .join(' ');
        const categoryInput = recentUserTexts ? `${message.text} ${recentUserTexts}` : message.text;
        const selectedCategories = selectCategories(categoryInput, availableCategories);
        skillMetas = filterSkills(allSkillMetas, selectedCategories);
      }

      // 6b. Role-based skill filtering (multi-user)
      if (skillMetas && this.roleSkillAccess) {
        const role = alfredUser?.role ?? (this.alfredUserRepo ? 'guest' : undefined);
        if (role) {
          const allowed = this.roleSkillAccess[role];
          if (allowed && allowed !== '*') {
            const allowedSet = new Set(allowed);
            skillMetas = skillMetas.filter(s => allowedSet.has(s.name));
          }
        }
      }

      const tools = skillMetas
        ? this.promptBuilder.buildTools(skillMetas)
        : undefined;
      let system = this.promptBuilder.buildSystemPrompt({
        memories,
        skills: skillMetas,
        userProfile,
        conversationSummary: summary?.summary,
      });

      // Inject active agent status so the LLM can answer "what is the agent doing?"
      const agentStatusBlock = this.buildActiveAgentStatus();
      if (agentStatusBlock) {
        system += '\n\n' + agentStatusBlock;
      }
      const rawMessages: LLMMessage[] = this.promptBuilder.buildMessages(history);

      // Collapse repeated tool-error loops (e.g. 68x the same file.write failure)
      // into a single representative pair + a note, to avoid wasting the context window.
      const collapsed = this.collapseRepeatedToolErrors(rawMessages);

      // Trim old, large tool results to short summaries (keeps last 3 pairs full)
      const allMessages = trimOldToolResults(collapsed);
      const savedTokens = collapsed.reduce((s, m) => s + estimateMessageTokens(m), 0)
        - allMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
      if (savedTokens > 100) {
        this.logger.debug(`Tool result trimming saved ~${savedTokens} tokens`);
      }

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
      let lastModel: string | undefined;
      const pendingAttachments: SkillResultAttachment[] = [];
      const usedSkillNames = new Set<string>();
      const accumulatedToolCalls: ToolCall[] = [];
      const accumulatedToolResults: LLMContentBlock[] = [];
      onProgress?.('Thinking...');

      while (true) {
        // Check for abort before each LLM call
        if (abortController.signal.aborted) {
          // Save dummy assistant response to prevent orphaned user message
          await this.conversationManager.addMessage(conversation.id, 'assistant', '⏹ Abgebrochen.');
          this.activeRequests.delete(requestKey);
          return { text: '⏹ Anfrage abgebrochen.' };
        }

        // Re-trim if tool loop has grown beyond the context budget
        if (iteration > 0) {
          this.compressToolLoop(messages, system, toolTokens);
        }

        try {
          response = await this.llm.complete({
            messages,
            system,
            tools: tools && tools.length > 0 ? tools : undefined,
            tier: message.metadata?.tier,
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

        // Discard potentially truncated tool calls when output hit max_tokens
        if (response.stopReason === 'max_tokens' && response.toolCalls?.length) {
          this.logger.warn({ toolCallCount: response.toolCalls.length },
            'Discarding truncated tool calls due to max_tokens');
          response = { ...response, toolCalls: [] };
        }

        // If no tool calls, check if output was truncated by max_tokens
        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (response.stopReason === 'max_tokens') {
            // Output was truncated — ask LLM to continue
            let continuationRounds = 0;
            let fullText = response.content ?? '';
            while (response.stopReason === 'max_tokens' && continuationRounds < MAX_CONTINUATION_ROUNDS) {
              continuationRounds++;
              this.logger.info({ continuationRounds, textLength: fullText.length }, 'Output truncated, requesting continuation');
              if (fullText) {
                messages.push({ role: 'assistant', content: fullText });
                messages.push({ role: 'user', content: 'Fahre exakt dort fort wo du aufgehört hast. Keine Wiederholung, nur der Rest.' });
              } else {
                // Content was empty despite max_tokens — ask for a shorter answer
                messages.push({ role: 'user', content: 'Deine Antwort war zu lang und wurde abgeschnitten. Bitte antworte kürzer und kompakter. Fasse zusammen statt alles aufzulisten.' });
              }
              try {
                response = await this.llm.complete({
                  messages,
                  system,
                  tools: tools && tools.length > 0 ? tools : undefined,
                  tier: message.metadata?.tier,
                });
                totalInputTokens += response.usage?.inputTokens ?? 0;
                totalOutputTokens += response.usage?.outputTokens ?? 0;
                if (response.content) {
                  fullText += response.content;
                }
              } catch {
                break;
              }
            }
            response = { ...response, content: fullText, stopReason: 'end_turn' };
          }
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
            false, message.metadata?.tier,
          );
          break;
        }

        // Iteration cap check
        if (iteration >= MAX_TOOL_ITERATIONS) {
          this.logger.warn({ iteration, pendingToolCalls: response.toolCalls.length }, 'Tool loop iteration cap reached');
          response = await this.abortToolLoop(
            messages, response, conversation.id, system,
            `Das Iterationslimit von ${MAX_TOOL_ITERATIONS} Tool-Aufrufen wurde erreicht.`,
            false, message.metadata?.tier,
          );
          break;
        }

        iteration++;
        this.logger.info({ iteration, toolCalls: response.toolCalls.length }, 'Processing tool calls');

        // Check for abort before tool execution
        if (abortController.signal.aborted) {
          await this.conversationManager.addMessage(conversation.id, 'assistant', '⏹ Abgebrochen.');
          this.activeRequests.delete(requestKey);
          return { text: '⏹ Anfrage abgebrochen.' };
        }

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
        // Track which skills were used
        for (const tc of response.toolCalls) {
          usedSkillNames.add(tc.name);
        }

        // Accumulate tool interactions — saved as a single consolidated pair after the loop
        // to avoid bloating the DB with 2 messages per iteration (which quickly exhausts
        // the history window, especially with HISTORY_WITH_SUMMARY = 6).
        accumulatedToolCalls.push(...response.toolCalls);
        accumulatedToolResults.push(...toolResultBlocks);

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
              true, message.metadata?.tier,
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

      // 8. Save accumulated tool interactions as a single consolidated pair
      //    (instead of 2 messages per iteration, this stores at most 2 total)
      if (accumulatedToolCalls.length > 0) {
        await this.conversationManager.addMessage(
          conversation.id, 'assistant', '', JSON.stringify(accumulatedToolCalls),
        );
        await this.conversationManager.addMessage(
          conversation.id, 'user', '', JSON.stringify(accumulatedToolResults),
        );
      }

      // 9. Save final assistant response (redact any secrets that may have leaked into the response)
      await this.conversationManager.addMessage(
        conversation.id,
        'assistant',
        redactSecrets(responseText),
      );

      // 9. Active learning: extract memories from conversation (fire-and-forget)
      if (this.activeLearning) {
        this.activeLearning.onMessageProcessed(masterUserId, message.text, responseText);
      }

      // 10. Update conversation summary (fire-and-forget)
      if (this.conversationSummarizer && !message.metadata?.skipHistory) {
        const summaryHistory = history.slice(-8).map(m => ({
          role: m.role,
          content: m.content,
        }));
        this.conversationSummarizer.onMessageProcessed(
          conversation.id,
          history.length + 2,
          message.text,
          responseText,
          summaryHistory,
        );
      }

      const duration = Date.now() - startTime;
      const model = response.model ?? lastModel ?? 'unknown';
      lastModel = model;
      const requestCostUsd = calculateCost(model, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
      this.logger.info(
        {
          duration, model,
          tokens: response.usage,
          totalTokens: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          costUsd: Math.round(requestCostUsd * 1_000_000) / 1_000_000,
          stopReason: response.stopReason,
          toolIterations: iteration,
        },
        'Message processed',
      );

      this.recordMetric(true, Date.now() - startTime, {
        input: totalInputTokens, output: totalOutputTokens, costUsd: requestCostUsd,
      });

      // Record per-user LLM usage (separate from global tracking)
      if (alfredUser && this.usageRepo && requestCostUsd > 0) {
        try {
          await this.usageRepo.record(lastModel ?? 'unknown', totalInputTokens, totalOutputTokens, 0, 0, requestCostUsd, alfredUser.id);
        } catch { /* non-critical */ }
      }
      // 11. Conversation-Reasoning: proactive insights for signal messages
      let proactiveInsight: string | undefined;
      const isSignal = hasReasoningSignal(message.text);
      if (this.memoryRepo && isSignal) {
        this.logger.info({ signal: true, text: message.text.slice(0, 50) }, 'Conversation-Reasoning triggered');
        try {
          proactiveInsight = await this.generateProactiveInsight(
            masterUserId, message.text, responseText, resolvedTimezone,
          );
          this.logger.info({ hasInsight: !!proactiveInsight }, 'Conversation-Reasoning complete');
        } catch { /* non-critical — don't block response */ }
      }

      this.activeRequests.delete(requestKey);
      return {
        text: proactiveInsight ? `${responseText}\n\n${proactiveInsight}` : responseText,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
        usedSkills: usedSkillNames.size > 0 ? [...usedSkillNames] : undefined,
      };
    } catch (error) {
      this.activeRequests.delete(requestKey);
      this.recordMetric(false, Date.now() - startTime);
      this.logger.error({ err: error }, 'Failed to process message');

      // Save error response to prevent orphaned user messages in history
      // (an orphaned user message without an assistant reply corrupts the
      // conversation for ALL subsequent requests in this chat)
      try {
        const convChatId = message.chatType === 'group'
          ? `${message.chatId}:${message.userId}`
          : message.chatId;
        const conv = await this.conversationManager.getOrCreateConversation(
          message.platform, convChatId, message.userId,
        );
        await this.conversationManager.addMessage(
          conv.id, 'assistant',
          'Sorry, I encountered an error processing your message. Please try again.',
        );
      } catch { /* best effort — don't mask the original error */ }

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
    tier?: import('@alfred/types').ModelTier,
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
      await this.conversationManager.addMessage(
        conversationId, 'assistant', response.content ?? '', JSON.stringify(response.toolCalls),
      );
    }
    await this.conversationManager.addMessage(
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
    return await this.llm.complete({ messages, system, tier });
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

  /**
   * Generate a proactive insight by cross-referencing the user's message with
   * their memories, calendar, and todos. Only called for "signal" messages
   * (mentions of places, times, travel, purchases).
   * Returns a short insight string or undefined if nothing relevant.
   */
  private async generateProactiveInsight(
    userId: string,
    userMessage: string,
    assistantResponse: string,
    timezone?: string,
  ): Promise<string | undefined> {
    if (!this.memoryRepo) return undefined;

    // Load context: memories + calendar events + todos (lightweight)
    let memoriesText = '';
    let calendarText = '';
    let todosText = '';

    try {
      const memories = await this.memoryRepo.getRecentForPrompt(userId, 15);
      if (memories.length > 0) {
        memoriesText = memories.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
      }
    } catch { /* skip */ }

    // Try to get calendar data via skill execution
    if (this.skillRegistry && this.skillSandbox) {
      try {
        const calSkill = this.skillRegistry.get('calendar');
        if (calSkill) {
          const now = new Date();
          const tomorrow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
          const result = await this.skillSandbox.execute(calSkill, {
            action: 'list_events',
            start: now.toISOString(),
            end: tomorrow.toISOString(),
          }, { userId, chatId: userId, platform: 'cli', chatType: 'dm' as const, timezone: timezone ?? 'Europe/Vienna', conversationId: '' });
          if (result.success && result.display) calendarText = result.display;
        }
      } catch { /* skip */ }

      try {
        const todoSkill = this.skillRegistry.get('todo');
        if (todoSkill) {
          const result = await this.skillSandbox.execute(todoSkill, {
            action: 'list',
          }, { userId, chatId: userId, platform: 'cli', chatType: 'dm' as const, timezone: timezone ?? 'Europe/Vienna', conversationId: '' });
          if (result.success && result.display) todosText = result.display;
        }
      } catch { /* skip */ }
    }

    // Skip if no context available
    if (!memoriesText && !calendarText && !todosText) return undefined;

    const prompt = `Du bist Alfreds proaktives Cross-Context Modul. Der User hat gerade geschrieben:
"${userMessage.slice(0, 300)}"

Alfred hat bereits geantwortet:
"${assistantResponse.slice(0, 300)}"

Dein Job: Prüfe ob es ZUSÄTZLICHE, NICHT-OFFENSICHTLICHE Hinweise gibt die Alfred NOCH NICHT erwähnt hat.
Verbinde die Nachricht mit den bestehenden Daten des Users:

=== Erinnerungen ===
${memoriesText || '(keine)'}

=== Kalender (nächste 48h) ===
${calendarText || '(kein Kalender)'}

=== Offene Todos ===
${todosText || '(keine Todos)'}

REGELN:
- NUR antworten wenn du etwas findest was Alfred NOCH NICHT gesagt hat
- Zeitkonflikte, Gelegenheiten (Shop in der Nähe), vergessene Verpflichtungen
- Max 2 kurze Sätze, konkret
- Wenn nichts Relevantes: antworte exakt "SKIP"
- Kein Smalltalk, keine Wiederholung von Alfreds Antwort`;

    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 256,
        tier: 'fast',
      });

      const text = response.content.trim();
      if (!text || text === 'SKIP' || text.length < 10) return undefined;
      if (text.toLowerCase().includes('skip') || text.toLowerCase().includes('nichts relevant')) return undefined;

      return `💡 ${text}`;
    } catch {
      return undefined;
    }
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
      // Redact sensitive secrets from tool results before sending to LLM
      content = redactSecrets(content);
      content = truncateToolResult(content, MAX_TOOL_RESULT_CHARS);
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

    // Multiple tool calls: execute with per-skill concurrency limit
    // This prevents rate-limiting (429) when the LLM fires many calls to the same API
    const MAX_CONCURRENT_PER_SKILL = 3;
    onProgress?.(`Running ${toolCalls.length} tools...`);

    // Group by skill name to detect skills that need throttling
    const skillGroups = new Map<string, number[]>();
    for (let i = 0; i < toolCalls.length; i++) {
      const name = toolCalls[i].name;
      let group = skillGroups.get(name);
      if (!group) {
        group = [];
        skillGroups.set(name, group);
      }
      group.push(i);
    }

    // Check if any skill exceeds the concurrency limit
    const needsThrottling = [...skillGroups.values()].some(g => g.length > MAX_CONCURRENT_PER_SKILL);

    let resultMap: Map<number, PromiseSettledResult<{ content: string; isError?: boolean; attachments?: SkillResultAttachment[] }>>;

    if (!needsThrottling) {
      // All skills within limit — run everything in parallel
      const settled = await Promise.allSettled(
        toolCalls.map(tc => this.executeToolCall(tc, context, onProgress))
      );
      resultMap = new Map(settled.map((r, i) => [i, r]));
    } else {
      // Throttle: run each skill's calls in batches of MAX_CONCURRENT_PER_SKILL
      // Different skills still run in parallel with each other
      resultMap = new Map();
      const skillPromises = [...skillGroups.entries()].map(async ([_name, indices]) => {
        for (let batch = 0; batch < indices.length; batch += MAX_CONCURRENT_PER_SKILL) {
          const batchIndices = indices.slice(batch, batch + MAX_CONCURRENT_PER_SKILL);
          const settled = await Promise.allSettled(
            batchIndices.map(idx => this.executeToolCall(toolCalls[idx], context, onProgress))
          );
          for (let j = 0; j < batchIndices.length; j++) {
            resultMap.set(batchIndices[j], settled[j]);
          }
        }
      });
      await Promise.all(skillPromises);
    }

    const blocks = toolCalls.map((tc, i) => {
      const settled = resultMap.get(i)!;
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

    // Skill health check — auto-disabled skills are blocked
    if (this.skillHealthTracker) {
      const disabled = await this.skillHealthTracker.isDisabled(toolCall.name);
      if (disabled) {
        const until = disabled.disabledUntil ? new Date(disabled.disabledUntil).toISOString() : 'unknown';
        this.logger.warn(
          { tool: toolCall.name, disabledUntil: until, consecutiveFails: disabled.consecutiveFails },
          'Skill is auto-disabled due to repeated failures',
        );
        return {
          content: `Skill "${toolCall.name}" is temporarily disabled due to repeated failures (${disabled.consecutiveFails} consecutive). Re-enabled at ${until}.`,
          isError: true,
        };
      }
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
        this.activityLogger?.logSkillExec({
          userId: context.userId, platform: context.platform, chatId: context.chatId,
          skillName: toolCall.name, outcome: 'denied', error: evaluation.reason,
        });
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

      const execStart = Date.now();
      try {
        const result = await this.skillSandbox.execute(skill, toolCall.input, execContext, undefined, tracker);
        this.activityLogger?.logSkillExec({
          userId: context.userId, platform: context.platform, chatId: context.chatId,
          skillName: toolCall.name, outcome: result.success ? 'success' : 'error',
          durationMs: Date.now() - execStart, error: result.error,
        });
        // Record skill health
        if (this.skillHealthTracker) {
          if (result.success) {
            await this.skillHealthTracker.recordSuccess(toolCall.name);
          } else {
            await this.skillHealthTracker.recordFailure(toolCall.name, result.error ?? 'Unknown error');
          }
        }
        let content = result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error');
        // HA: annotate node-local skill results with nodeId
        if (this.nodeId !== 'single' && NODE_LOCAL_SKILLS.has(toolCall.name) && result.success) {
          content = `[${this.nodeId}] ${content}`;
        }
        return {
          content,
          isError: !result.success,
          attachments: result.attachments,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.activityLogger?.logSkillExec({
          userId: context.userId, platform: context.platform, chatId: context.chatId,
          skillName: toolCall.name, outcome: 'error',
          durationMs: Date.now() - execStart, error: errorMsg,
        });
        this.skillHealthTracker?.recordFailure(toolCall.name, errorMsg);
        throw err;
      } finally {
        if (agentId) {
          this.activeAgents.delete(agentId);
        }
      }
    }

    // Fallback: direct execution without sandbox
    try {
      const result = await skill.execute(toolCall.input, context);
      if (result.success) {
        this.skillHealthTracker?.recordSuccess(toolCall.name);
      } else {
        this.skillHealthTracker?.recordFailure(toolCall.name, result.error ?? 'Unknown error');
      }
      return {
        content: result.display ?? (result.success ? JSON.stringify(result.data) : result.error ?? 'Unknown error'),
        isError: !result.success,
        attachments: result.attachments,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.skillHealthTracker?.recordFailure(toolCall.name, msg);
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
        const savedPath = await this.saveToInbox(attachment, message.userId);
        if (savedPath) {
          const isTextFile = this.isTextMimeType(attachment.mimeType);
          const storageBackend = this.fileStore?.backend ?? 'local';
          const isCloudStore = storageBackend === 's3' || storageBackend === 'nfs';
          const savedToLabel = isCloudStore
            ? `[Saved to FileStore (${storageBackend}): key="${savedPath}". Use file skill with action "read_store" or "send" to access it. Do NOT use local file paths.]`
            : `[Saved to: ${savedPath}]`;
          let fileNote = `[File received: "${attachment.fileName ?? 'unknown'}" (${this.formatBytes(attachment.data.length)}, ${attachment.mimeType ?? 'unknown type'})]\n${savedToLabel}`;

          // For text-based files, include the content inline
          if (isTextFile && attachment.data.length <= MAX_INLINE_FILE_SIZE) {
            const textContent = attachment.data.toString('utf-8');
            fileNote += `\n[File content]:\n${textContent}`;
          }

          // Auto-ingest documents for RAG search
          if (this.documentProcessor && this.isIngestable(attachment.mimeType)) {
            try {
              const result = await this.documentProcessor.ingest(
                message.userId,
                savedPath,
                attachment.fileName ?? 'unknown',
                attachment.mimeType ?? 'application/octet-stream',
                attachment.data, // Pass raw data so DocumentProcessor doesn't need local fs access
              );
              if (result.existing) {
                // Remove duplicate file from inbox
                if (this.fileStore) {
                  this.fileStore.delete(savedPath).catch(() => {});
                } else {
                  try { fs.unlinkSync(savedPath); } catch { /* ignore */ }
                }
                fileNote = `[File received: "${attachment.fileName ?? 'unknown'}" (duplicate, not saved again)]\n[IMPORTANT: This document is already indexed (${result.chunkCount} chunks). To read or answer questions about it, use the "document" skill with action "search" and a relevant query. Do NOT use shell/file tools to read the PDF.]`;
              } else {
                fileNote += `\n[IMPORTANT: Document has been indexed (${result.chunkCount} chunks). To read or answer questions about it, use the "document" skill with action "search" and a relevant query. Do NOT use shell/file tools to read the PDF.]`;
              }
            } catch (err) {
              this.logger.warn({ err, fileName: attachment.fileName }, 'Auto-ingest failed');
            }
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
      // File sent without any accompanying text.
      const hasIndexedDoc = blocks.some(b => b.type === 'text' && (b as { text: string }).text.includes('document is already indexed'));
      const hasNewDoc = blocks.some(b => b.type === 'text' && (b as { text: string }).text.includes('Document has been indexed'));
      if (hasIndexedDoc || hasNewDoc) {
        // Document was auto-ingested — tell the LLM it's ready for search
        blocks.push({ type: 'text', text: 'The user sent this document. It has been automatically indexed. Acknowledge receipt and tell the user the document is ready — they can ask questions about its content anytime.' });
      } else {
        // Non-ingestable file — ask the user what they want.
        blocks.push({ type: 'text', text: 'The user sent this file without any instructions. Ask them what they would like you to do with it. Do NOT take any other actions, do NOT use any tools, and do NOT act on conversation history or memories. ONLY ask what the user wants.' });
      }
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
  private async saveToInbox(attachment: Attachment, userId?: string): Promise<string | undefined> {
    if (!attachment.data) return undefined;

    const safeUserId = (userId ?? 'default').replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
    const originalName = attachment.fileName ?? `file_${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Use FileStore if available (supports S3/NFS for HA)
    if (this.fileStore) {
      try {
        const stored = await this.fileStore.save(safeUserId, originalName, attachment.data);
        return stored.key;
      } catch (err) {
        this.logger.error({ err }, 'Failed to save file via FileStore');
        return undefined;
      }
    }

    // Fallback: local filesystem (single-instance)
    const baseInbox = this.inboxPath ?? path.resolve('./data/inbox');
    const inboxDir = path.join(baseInbox, safeUserId);
    try {
      fs.mkdirSync(inboxDir, { recursive: true });
    } catch {
      this.logger.error({ inboxDir }, 'Cannot create inbox directory');
      return undefined;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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

  private isIngestable(mimeType?: string): boolean {
    if (!mimeType) return false;
    const ingestable = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain', 'text/csv', 'text/markdown', 'text/html',
      'application/json', 'application/xml',
    ];
    return ingestable.includes(mimeType) || mimeType.startsWith('text/');
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
