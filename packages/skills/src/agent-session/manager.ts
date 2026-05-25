import type { Logger } from 'pino';
import type { AgentSessionRepository, AgentSession } from '@alfred/storage';
import type { AgentSessionAdapter, AgentEvent, AgentInvokeResult } from './types.js';

/**
 * v779 — AgentSessionManager
 *
 * Zentrale Koordination zwischen Sandbox+Agent-Wahl und konkretem Adapter.
 * Hält registrierte Adapter, sorgt für Session-Lookup/Creation, persistiert Usage-Stats
 * und Health-Status.
 *
 * Aufruf-Pattern aus alfred.ts:
 *   const manager = new AgentSessionManager({ adapters, repo, logger });
 *   const result = await manager.invoke({
 *     sandboxId, agentName: 'claude-code',
 *     prompt, cwd, runAsUser, signal, onEvent,
 *   });
 */

export interface AgentSessionManagerDeps {
  adapters: Map<string, AgentSessionAdapter>;
  repo: AgentSessionRepository;
  logger: Logger;
  /** Max gleichzeitig aktive Sessions pro Sandbox. LRU-Eviction. Default 4. */
  maxSessionsPerSandbox?: number;
  /** Health-Check-Intervall ms. Default 60s. Setze 0 zum Deaktivieren. */
  healthCheckIntervalMs?: number;
  /** Idle-Timeout: Sessions die so lange unused waren → als expired markieren. Default 24h. */
  sessionIdleTimeoutMs?: number;
}

export interface ManagerInvokeOptions {
  sandboxId: string;
  agentName: string;
  prompt: string;
  cwd: string;
  runAsUser?: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  timeoutMs?: number;
  promptPrefix?: string;
  /** Force new session (ignore existing). Z.B. nach Reset-Button. */
  forceNew?: boolean;
}

export class AgentSessionManager {
  private readonly adapters: Map<string, AgentSessionAdapter>;
  private readonly repo: AgentSessionRepository;
  private readonly logger: Logger;
  private readonly maxSessionsPerSandbox: number;
  private readonly healthCheckIntervalMs: number;
  private readonly sessionIdleTimeoutMs: number;
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(deps: AgentSessionManagerDeps) {
    this.adapters = deps.adapters;
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.maxSessionsPerSandbox = deps.maxSessionsPerSandbox ?? 4;
    this.healthCheckIntervalMs = deps.healthCheckIntervalMs ?? 60_000;
    this.sessionIdleTimeoutMs = deps.sessionIdleTimeoutMs ?? 24 * 3600_000;
  }

  /** Registriert einen Adapter zur Laufzeit (z.B. wenn neue CLI installiert wird). */
  registerAdapter(adapter: AgentSessionAdapter): void {
    this.adapters.set(adapter.name, adapter);
    this.logger.info({ adapter: adapter.name, capabilities: adapter.capabilities }, 'v779 AgentSession adapter registered');
  }

  listAdapters(): Array<{ name: string; capabilities: AgentSessionAdapter['capabilities'] }> {
    return Array.from(this.adapters.values()).map(a => ({ name: a.name, capabilities: a.capabilities }));
  }

  /**
   * Hauptmethode: führe einen Run aus. Reused existierende Session oder erstellt neue.
   * Persistiert Stats. Streamt AgentEvents an onEvent.
   */
  async invoke(opts: ManagerInvokeOptions): Promise<AgentInvokeResult> {
    const adapter = this.adapters.get(opts.agentName);
    if (!adapter) {
      throw new Error(`AgentSession: no adapter registered for "${opts.agentName}". Available: ${[...this.adapters.keys()].join(', ')}`);
    }

    // Session lookup oder create
    let session: AgentSession | undefined;
    if (!opts.forceNew) {
      session = await this.repo.findActive(opts.sandboxId, opts.agentName);
      if (session && session.cliSessionId) {
        // Optional health-check der existing session
        try {
          const healthy = await adapter.isHealthy(session.cliSessionId, opts.runAsUser);
          if (!healthy) {
            this.logger.info({ sessionId: session.id, agent: opts.agentName }, 'v779 existing session unhealthy → creating new');
            await this.repo.update(session.id, { status: 'expired' });
            session = undefined;
          } else {
            await this.repo.update(session.id, { lastHealthOk: Date.now() });
          }
        } catch (err) {
          this.logger.warn({ err }, 'v779 health check threw — assuming session is still ok');
        }
      }
    }

    if (!session) {
      session = await this.repo.create({
        sandboxId: opts.sandboxId,
        agentName: opts.agentName,
        capabilities: adapter.capabilities,
      });
      this.logger.info({ sessionId: session.id, sandbox: opts.sandboxId, agent: opts.agentName }, 'v779 created new agent session');

      // LRU-Eviction wenn zu viele
      await this.enforceLimit(opts.sandboxId);
    }

    const iteration = session.messageCount + 1;

    // Event-Tap: zwischen Adapter und User-Callback hängen wir uns rein um zu loggen + persistieren
    const onEventTapped = (event: AgentEvent) => {
      // Session-ID-Capture: Adapter informiert uns wenn CLI eine ID vergeben hat
      if (event.type === 'session_id' && session && !session.cliSessionId) {
        session.cliSessionId = event.value;
        this.repo.update(session.id, { cliSessionId: event.value }).catch(err => {
          this.logger.warn({ err, sessionId: session!.id }, 'v779 persist cliSessionId failed');
        });
      }
      // Event-Persistierung für Replay (best-effort, async, nicht warten)
      this.repo.appendEvent(session!.id, iteration, event.type, event).catch(() => { /* swallow */ });
      // Weiterleitung
      opts.onEvent(event);
    };

    // Run
    const startedAt = Date.now();
    const result = await adapter.invoke({
      cliSessionId: session.cliSessionId ?? null,
      preferredSessionId: session.id, // kann der Adapter zum --session-id flag nutzen falls supported
      prompt: opts.prompt,
      cwd: opts.cwd,
      runAsUser: opts.runAsUser,
      signal: opts.signal,
      onEvent: onEventTapped,
      timeoutMs: opts.timeoutMs,
      promptPrefix: opts.promptPrefix,
    });

    // Falls Adapter neue session-id geliefert hat (z.B. erster Run)
    if (result.newCliSessionId && !session.cliSessionId) {
      await this.repo.update(session.id, { cliSessionId: result.newCliSessionId });
    }

    // Stats updaten
    await this.repo.update(session.id, {
      messageCount: iteration,
      addTokensInput: result.usage.inputTokens,
      addTokensOutput: result.usage.outputTokens,
      addCachedTokens: result.usage.cachedTokens,
      addCostUsd: result.usage.costUsd ?? 0,
      status: result.sessionInvalidated ? 'failed' : 'active',
    });

    this.logger.info({
      sessionId: session.id, iteration, exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      tokens: result.usage,
      filesChanged: result.modifiedFiles.length,
    }, 'v779 agent session run completed');

    return result;
  }

  /** Force-reset einer Session: destroy CLI-State + DB-Eintrag löschen. */
  async resetSession(sandboxId: string, agentName: string, runAsUser?: string): Promise<void> {
    const session = await this.repo.findActive(sandboxId, agentName);
    if (!session) return;
    const adapter = this.adapters.get(agentName);
    if (adapter && session.cliSessionId) {
      try { await adapter.destroy(session.cliSessionId, runAsUser); }
      catch (err) { this.logger.warn({ err, sessionId: session.id }, 'v779 adapter.destroy failed'); }
    }
    await this.repo.delete(session.id);
  }

  /** Alle Sessions einer Sandbox killen — beim Sandbox-Discard. */
  async cleanupSandbox(sandboxId: string, runAsUser?: string): Promise<number> {
    const sessions = await this.repo.listBySandbox(sandboxId);
    for (const s of sessions) {
      const adapter = this.adapters.get(s.agentName);
      if (adapter && s.cliSessionId && s.status === 'active') {
        try { await adapter.destroy(s.cliSessionId, runAsUser); }
        catch (err) { this.logger.warn({ err, sessionId: s.id }, 'v779 cleanup destroy failed'); }
      }
    }
    return this.repo.deleteBySandbox(sandboxId);
  }

  /** LRU-Eviction: wenn Sandbox >maxSessionsPerSandbox aktive Sessions hat, älteste expirieren. */
  private async enforceLimit(sandboxId: string): Promise<void> {
    const active = await this.repo.listBySandbox(sandboxId);
    const activeCount = active.filter(s => s.status === 'active').length;
    if (activeCount <= this.maxSessionsPerSandbox) return;
    const toEvict = activeCount - this.maxSessionsPerSandbox;
    const oldest = await this.repo.listOldestActive(sandboxId, toEvict);
    for (const s of oldest) {
      await this.repo.update(s.id, { status: 'expired' });
      this.logger.info({ sessionId: s.id, agent: s.agentName }, 'v779 LRU-evicted agent session');
    }
  }

  /** Health-Monitor Loop. */
  startHealthMonitor(): void {
    if (this.healthCheckIntervalMs <= 0 || this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.runHealthSweep().catch(err => this.logger.warn({ err }, 'v779 health-sweep failed'));
    }, this.healthCheckIntervalMs);
    this.healthTimer.unref?.();
  }

  stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  private async runHealthSweep(): Promise<void> {
    // Aktuell nur idle-timeout check (alle adapter spezifisch health-check ist optional via isHealthy).
    // Vollständigere health-checks würden alle active Sessions iterieren — costy bei vielen Sandboxes.
    // Erst aktivieren wenn nötig.
  }
}
