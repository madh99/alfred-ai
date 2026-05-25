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

    let handoffBriefing: string | undefined;
    if (!session) {
      // v790 — Cross-Session-Context-Transfer: vor session.create() noch existing-sessions checken
      // damit wir uns selbst nicht ausschließen müssen.
      handoffBriefing = await this.buildHandoffBriefing(opts.sandboxId);

      session = await this.repo.create({
        sandboxId: opts.sandboxId,
        agentName: opts.agentName,
        capabilities: adapter.capabilities,
      });
      this.logger.info({ sessionId: session.id, sandbox: opts.sandboxId, agent: opts.agentName, hasBriefing: !!handoffBriefing }, 'v779/v790 created new agent session');

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
    // v790 — handoffBriefing wird vor opts.promptPrefix prepend'd (User-Prefix gewinnt am Ende)
    const promptPrefix = handoffBriefing
      ? (opts.promptPrefix ? `${handoffBriefing}\n\n${opts.promptPrefix}` : handoffBriefing)
      : opts.promptPrefix;
    if (handoffBriefing) {
      // Sichtbar machen im Event-stream — User sieht im UI dass Briefing aktiv war
      onEventTapped({ type: 'progress', phase: 'handoff-briefing', detail: `${handoffBriefing.length} chars from previous agent(s)` });
    }
    const result = await adapter.invoke({
      cliSessionId: session.cliSessionId ?? null,
      preferredSessionId: session.id, // kann der Adapter zum --session-id flag nutzen falls supported
      prompt: opts.prompt,
      cwd: opts.cwd,
      runAsUser: opts.runAsUser,
      signal: opts.signal,
      onEvent: onEventTapped,
      timeoutMs: opts.timeoutMs,
      promptPrefix,
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

  /**
   * v790 — Cross-Session-Context-Transfer.
   *
   * Wenn in dieser Sandbox bereits andere AgentSessions existieren, baue ein kompaktes
   * Briefing (~500-1000 chars) das den neuen Agent über den bisherigen Stand informiert.
   * Wird vor opts.promptPrefix prepend'd → Agent kann sofort beim "richtigen" Punkt
   * weiterarbeiten statt komplett bei null zu starten.
   *
   * Strategie:
   *  - Nimm die zuletzt-genutzte andere Session (sortiert nach lastUsedAt DESC)
   *  - Lese ihre letzten Events (alle Iterationen, neueste 50)
   *  - Extrahiere:
   *     - welcher Agent das war
   *     - welche files geändert wurden (aus edit-events)
   *     - welche shell-commands erfolgreich liefen
   *     - finale assistant-text (kurz gekürzt)
   *     - letzte Fehler falls Run failed
   *  - Format: kompakt, in Markdown, max ~1000 chars
   *
   * Wenn keine andere Session existiert → returns undefined (kein Briefing).
   */
  private async buildHandoffBriefing(sandboxId: string): Promise<string | undefined> {
    try {
      const allSessions = await this.repo.listBySandbox(sandboxId);
      if (allSessions.length === 0) return undefined;
      // Schon nach lastUsedAt DESC sortiert via repo.listBySandbox(). Erste = letzte aktivität.
      const lastOther = allSessions.find(s => s.messageCount > 0);
      if (!lastOther) return undefined;

      const events = await this.repo.listEvents(lastOther.id, undefined, 80);
      if (events.length === 0) return undefined;

      const editedFiles = new Set<string>();
      const shellCmds: Array<{ cmd: string; ok: boolean }> = [];
      const errors: string[] = [];
      let lastAssistantText: string | undefined;

      for (const e of events) {
        const data = e.eventData as any;
        if (!data || typeof data !== 'object') continue;
        switch (e.eventType) {
          case 'edit':
            if (typeof data.path === 'string') editedFiles.add(data.path);
            break;
          case 'shell':
            if (data.status === 'done' && typeof data.command === 'string' && data.command.trim()) {
              shellCmds.push({ cmd: String(data.command).slice(0, 120), ok: data.exitCode === 0 });
            }
            break;
          case 'text':
            if (typeof data.text === 'string') lastAssistantText = data.text;
            break;
          case 'error':
            if (typeof data.message === 'string') errors.push(data.message.slice(0, 200));
            break;
        }
      }

      const lines: string[] = [];
      lines.push(`[Handoff-Briefing aus vorherigem Agent in dieser Sandbox]`);
      lines.push(`Vorheriger Agent: "${lastOther.agentName}" · ${lastOther.messageCount} Iteration(en) · zuletzt aktiv ${lastOther.lastUsedAt}`);

      if (editedFiles.size > 0) {
        const files = Array.from(editedFiles).slice(0, 10);
        lines.push(`Geänderte Dateien (letzte): ${files.join(', ')}${editedFiles.size > 10 ? ` (+${editedFiles.size - 10})` : ''}`);
      }
      if (shellCmds.length > 0) {
        const recent = shellCmds.slice(-5);
        const okCount = recent.filter(c => c.ok).length;
        lines.push(`Letzte Shell-Commands (${okCount}/${recent.length} erfolgreich):`);
        for (const c of recent) {
          lines.push(`  ${c.ok ? '✓' : '✗'} ${c.cmd}`);
        }
      }
      if (errors.length > 0) {
        lines.push(`Letzter Fehler: ${errors[errors.length - 1].slice(0, 300)}`);
      }
      if (lastAssistantText) {
        const summary = lastAssistantText.slice(0, 400).replace(/\s+/g, ' ').trim();
        lines.push(`Letzte Aussage des vorherigen Agents: "${summary}${lastAssistantText.length > 400 ? '…' : ''}"`);
      }
      lines.push(`[Du startest jetzt frisch — keine direkten Tool-Results vorhanden. Verifiziere bei Bedarf den aktuellen Stand selbst per Read/Bash.]`);

      const briefing = lines.join('\n');
      // Cap auf 1500 chars um agent-context nicht zu fressen
      return briefing.length > 1500 ? briefing.slice(0, 1500) + '…' : briefing;
    } catch (err) {
      this.logger.warn({ err, sandboxId }, 'v790 buildHandoffBriefing failed (continuing without)');
      return undefined;
    }
  }
}
