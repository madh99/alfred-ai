import type { Logger } from 'pino';
import type { AsyncDbAdapter } from '@alfred/storage';
import type { ReflectorDeps } from './reflection/types.js';
import { WatchReflector } from './reflection/watch-reflector.js';
import { WorkflowReflector } from './reflection/workflow-reflector.js';
import { ReminderReflector } from './reflection/reminder-reflector.js';
import { ConversationReflector } from './reflection/conversation-reflector.js';
import { DocReflector } from './reflection/doc-reflector.js';
import { ActionExecutor } from './reflection/action-executor.js';
import type { ReflectionResult } from './reflection/types.js';

export class ReflectionEngine {
  private readonly logger: Logger;
  private readonly watchReflector: WatchReflector;
  private readonly workflowReflector: WorkflowReflector;
  private readonly reminderReflector: ReminderReflector;
  private readonly conversationReflector: ConversationReflector;
  private readonly docReflector: DocReflector;
  private readonly actionExecutor: ActionExecutor;
  private readonly config: ReflectorDeps['config'];
  private readonly nodeId: string;
  private readonly dbAdapter: AsyncDbAdapter | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastRunDay = '';

  constructor(deps: ReflectorDeps, dbAdapter?: AsyncDbAdapter) {
    this.logger = deps.logger.child({ component: 'reflection-engine' });
    this.config = deps.config;
    this.nodeId = deps.nodeId;
    this.dbAdapter = dbAdapter;

    const defaultAdapter = deps.adapters.get(deps.defaultPlatform);

    this.watchReflector = new WatchReflector(
      deps.watchRepo,
      deps.activityRepo,
      deps.logger.child({ component: 'watch-reflector' }),
      deps.config.watches as Required<typeof deps.config.watches>,
    );

    this.workflowReflector = new WorkflowReflector(
      deps.workflowRepo,
      deps.activityRepo,
      deps.logger.child({ component: 'workflow-reflector' }),
      deps.config.workflows as Required<typeof deps.config.workflows>,
    );

    this.reminderReflector = new ReminderReflector(
      dbAdapter,
      deps.memoryRepo,
      deps.logger.child({ component: 'reminder-reflector' }),
      deps.config.reminders as Required<typeof deps.config.reminders>,
    );

    this.conversationReflector = new ConversationReflector(
      deps.llm,
      deps.activityRepo,
      deps.memoryRepo,
      dbAdapter,
      deps.logger.child({ component: 'conversation-reflector' }),
      deps.config.conversation as Required<typeof deps.config.conversation>,
    );

    this.docReflector = new DocReflector(
      deps.cmdbRepo,
      deps.logger.child({ component: 'doc-reflector' }),
      deps.config.docs as Required<typeof deps.config.docs>,
    );

    this.actionExecutor = new ActionExecutor(
      deps.watchRepo,
      deps.workflowRepo,
      dbAdapter,
      deps.adapters,
      deps.defaultChatId,
      deps.defaultPlatform,
      deps.logger.child({ component: 'action-executor' }),
    );
  }

  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Reflection engine disabled');
      return;
    }

    this.logger.info({ schedule: this.config.schedule }, 'Reflection engine started');

    // Check every hour, only act at configured hour
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err }, 'Reflection tick error'));
    }, 60 * 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.info('Reflection engine stopped');
    }
  }

  async tick(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Parse target hour from cron-style schedule (e.g. "0 4 * * *" -> hour 4)
    const hourMatch = this.config.schedule.match(/^\d+\s+(\d+)/);
    const targetHour = hourMatch ? parseInt(hourMatch[1], 10) : 4;

    if (now.getHours() !== targetHour || this.lastRunDay === today) return;
    this.lastRunDay = today;

    // HA distributed dedup: only one node runs reflection per day
    if (this.dbAdapter && this.dbAdapter.type === 'postgres') {
      const slotKey = `reflection:${today}`;
      const result = await this.dbAdapter.execute(
        'INSERT INTO reasoning_slots (slot_key, node_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [slotKey, this.nodeId, now.toISOString()],
      );
      if (result.changes === 0) {
        this.logger.debug('Reflection slot already claimed by another node');
        return;
      }
    }

    this.logger.info('Reflection cycle starting');
    const start = Date.now();

    // Run all reflectors in parallel
    const userId = 'master'; // reflection runs for the master user
    const settled = await Promise.allSettled([
      this.watchReflector.reflect(userId),
      this.workflowReflector.reflect(userId),
      this.reminderReflector.reflect(userId),
      this.conversationReflector.reflect(userId),
      this.docReflector.reflect(userId),
    ]);

    const results: ReflectionResult[] = [];
    const reflectorNames = ['watch', 'workflow', 'reminder', 'conversation', 'docs'];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        this.logger.warn({ err: outcome.reason, reflector: reflectorNames[i] }, 'Reflector failed');
      }
    }

    // Execute actions for collected results
    if (results.length > 0) {
      await this.actionExecutor.execute(results);
    }

    const durationMs = Date.now() - start;
    const auto = results.filter(r => r.risk === 'auto').length;
    const proactive = results.filter(r => r.risk === 'proactive').length;
    const confirm = results.filter(r => r.risk === 'confirm').length;

    this.logger.info(
      { total: results.length, auto, proactive, confirm, durationMs },
      'Reflection cycle complete',
    );
  }
}
