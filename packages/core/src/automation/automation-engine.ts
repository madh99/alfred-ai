import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { ProjectAutomation, ProjectAutomationsRepository, ProjectRepository, AutomationTemplateKind, ConversationRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform } from '@alfred/types';
import { AUTOMATION_TEMPLATES } from './automation-templates.js';

const execFileAsync = promisify(execFile);

/**
 * v663b — AutomationEngine: führt project_automations aus.
 *
 * Pro Lauf:
 *  1) Projekt-Kontext laden (cwd, repoUrl, sessions, openItems, conventions, decisions)
 *  2) Optionale Daten-Collectors ausführen (git log, npm outdated, …)
 *  3) LLM-Call mit Template-Prompt + Kontext + Collector-Output
 *  4) Output an Destination (telegram/project_chat/email/web_notification)
 *  5) Result persistieren + nextRunAt nach Cron neu berechnen
 */
export class AutomationEngine {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly repo: ProjectAutomationsRepository,
    private readonly projectRepo: ProjectRepository,
    private readonly conversationRepo: ConversationRepository | undefined,
    private readonly llm: LLMProvider,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly logger: Logger,
    private readonly ownerChatId: string,
    private readonly ownerPlatform: Platform,
  ) {}

  /** Periodischer Sweep: prüft alle 60s ob Automations fällig sind. */
  start(): void {
    this.timer = setInterval(() => this.tick().catch(err => this.logger.warn({ err }, 'AutomationEngine tick failed')), 60_000);
    // Initial-Tick gleich nach Start
    setTimeout(() => this.tick().catch(() => {}), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const due = await this.repo.listDue().catch(() => []);
    for (const auto of due) {
      try {
        await this.runAutomation(auto);
      } catch (err) {
        this.logger.warn({ err, id: auto.id }, 'Automation run failed');
        const next = this.computeNextRun(auto.schedule);
        await this.repo.recordRun(auto.id, 'failed', `Error: ${(err as Error).message}`, next);
      }
    }
  }

  /** Manuell oder zeitgesteuert auslösen. Liefert das LLM-Output zurück. */
  async runAutomation(auto: ProjectAutomation): Promise<string> {
    this.logger.info({ id: auto.id, kind: auto.templateKind, project: auto.projectId }, 'Automation run start');
    const tmpl = AUTOMATION_TEMPLATES[auto.templateKind];
    if (!tmpl) {
      await this.repo.recordRun(auto.id, 'failed', `Unknown template kind: ${auto.templateKind}`);
      return '';
    }

    const project = await this.projectRepo.getById(auto.userId, auto.projectId);
    if (!project) {
      await this.repo.recordRun(auto.id, 'failed', 'Project nicht gefunden');
      return '';
    }

    // 1. Projekt-Kontext
    const [sessions, openItems, decisions] = await Promise.all([
      this.projectRepo.listSessions(project.id, 10).catch(() => []),
      this.projectRepo.listOpenItemsForProject(project.id, ['open', 'in_progress']).catch(() => []),
      this.projectRepo.listDecisions(project.id, 10).catch(() => []),
    ]);
    const contextLines: string[] = [
      `# Projekt: ${project.name}`,
      project.cwd ? `cwd: ${project.cwd}` : '',
      project.repoUrl ? `repo: ${project.repoUrl}` : '',
      project.description ? `desc: ${project.description}` : '',
      '',
      `## Offene Items (${openItems.length})`,
      ...openItems.slice(0, 15).map(it => `- [${it.priority}] ${it.title}${it.dueAt ? ` (due ${it.dueAt.slice(0, 10)})` : ''}`),
      '',
      `## Letzte Sessions`,
      ...sessions.slice(0, 5).map(s => `- ${s.sessionType} (${s.endedAt ? 'fertig' : 'laufend'}) @ ${s.startedAt.slice(0, 16)}`),
    ];
    if (decisions.length > 0) {
      contextLines.push('', `## Letzte Decisions`, ...decisions.slice(0, 5).map(d => `- ${d.title}: ${d.choice.slice(0, 100)}`));
    }

    // 2. Collectors
    const collectorOutputs: string[] = [];
    for (const coll of tmpl.collectors ?? []) {
      try {
        const out = await this.runCollector(coll, project.cwd);
        if (out) collectorOutputs.push(`## ${coll}\n${out.slice(0, 3000)}`);
      } catch (err) {
        this.logger.debug({ err, coll, project: project.id }, 'Collector failed (non-fatal)');
      }
    }

    // 3. LLM-Call
    const finalPrompt = auto.promptOverride?.trim() || tmpl.defaultPrompt;
    const userMessage = [
      contextLines.filter(Boolean).join('\n'),
      collectorOutputs.length > 0 ? '\n# Collector-Output\n' + collectorOutputs.join('\n\n') : '',
      '',
      '# Aufgabe',
      finalPrompt,
    ].filter(Boolean).join('\n\n');

    let output: string;
    try {
      const r = await this.llm.complete({
        system: `Du bist ein präziser, hilfreicher Projekt-Assistent. Antworte konkret, knapp, mit konkreten Datei-/Item-Referenzen wenn möglich. Deutsch.`,
        messages: [{ role: 'user', content: userMessage }],
        tier: 'fast',
        maxTokens: 1500,
        temperature: 0.3,
      });
      output = (r.content ?? '').trim();
    } catch (err) {
      const next = this.computeNextRun(auto.schedule);
      await this.repo.recordRun(auto.id, 'failed', `LLM-Error: ${(err as Error).message}`, next);
      throw err;
    }

    // 4. Output an Destination
    const header = `${tmpl.icon} **${tmpl.label}** — ${project.name}\n`;
    const fullMessage = header + '\n' + output;
    await this.deliverOutput(auto, fullMessage, project.id);

    // 5. Result + nextRun
    const next = this.computeNextRun(auto.schedule);
    await this.repo.recordRun(auto.id, 'success', output, next);
    this.logger.info({ id: auto.id, kind: auto.templateKind, outputChars: output.length, next }, 'Automation run success');
    return output;
  }

  private async runCollector(kind: string, cwd?: string): Promise<string> {
    if (!cwd) return '';
    try {
      switch (kind) {
        case 'git_log_recent': {
          const { stdout } = await execFileAsync('git', ['log', '--since=7.days.ago', '--pretty=format:%h %ad %s', '--date=short'], { cwd, maxBuffer: 2 * 1024 * 1024 });
          return stdout.slice(0, 3000);
        }
        case 'git_diff_summary': {
          const { stdout } = await execFileAsync('git', ['diff', 'HEAD~5..HEAD', '--stat'], { cwd, maxBuffer: 2 * 1024 * 1024 });
          return stdout.slice(0, 3000);
        }
        case 'npm_outdated': {
          if (!await this.exists(cwd, 'package.json')) return '';
          const { stdout } = await execFileAsync('npm', ['outdated', '--json'], { cwd, maxBuffer: 2 * 1024 * 1024 }).catch(e => ({ stdout: (e as { stdout?: string }).stdout ?? '' }));
          return stdout.slice(0, 3000);
        }
        case 'pip_outdated': {
          if (!await this.exists(cwd, 'requirements.txt') && !await this.exists(cwd, 'pyproject.toml')) return '';
          const { stdout } = await execFileAsync('pip', ['list', '--outdated', '--format=json'], { cwd, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
          return stdout.slice(0, 3000);
        }
        case 'npm_audit': {
          if (!await this.exists(cwd, 'package.json')) return '';
          const { stdout } = await execFileAsync('npm', ['audit', '--json'], { cwd, maxBuffer: 4 * 1024 * 1024 }).catch(e => ({ stdout: (e as { stdout?: string }).stdout ?? '' }));
          return stdout.slice(0, 4000);
        }
        case 'test_coverage': {
          // Best-effort: existiert coverage/coverage-summary.json?
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          try {
            const data = await fs.readFile(path.join(cwd, 'coverage/coverage-summary.json'), 'utf-8');
            return data.slice(0, 3000);
          } catch { return ''; }
        }
        case 'tree_overview': {
          // Top-Level Files/Dirs + 1 Ebene tief
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          try {
            const entries = await fs.readdir(cwd, { withFileTypes: true });
            const lines = entries
              .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'build')
              .slice(0, 30)
              .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);
            return lines.join('\n');
          } catch { return ''; }
        }
        case 'pr_open': {
          const { stdout } = await execFileAsync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,author,updatedAt'], { cwd, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
          return stdout.slice(0, 3000);
        }
        default: return '';
      }
    } catch (err) {
      this.logger.debug({ err, kind }, 'Collector exec failed (non-fatal)');
      return '';
    }
  }

  private async exists(cwd: string, file: string): Promise<boolean> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try { await fs.access(path.join(cwd, file)); return true; } catch { return false; }
  }

  private async deliverOutput(auto: ProjectAutomation, message: string, projectId: string): Promise<void> {
    const dest = auto.outputDestination;
    if (dest === 'telegram' || dest === 'web_notification' || dest === 'email') {
      // Telegram als primärer Outgoing-Channel (web_notification + email later)
      const adapter = this.adapters.get(this.ownerPlatform) ?? this.adapters.get('telegram' as Platform);
      if (adapter) {
        try { await adapter.sendMessage(this.ownerChatId, message); }
        catch (err) { this.logger.warn({ err }, 'Automation: deliver via adapter failed'); }
      }
    } else if (dest === 'project_chat') {
      // In die Projekt-Conversation als assistant-message anhängen
      if (this.conversationRepo) {
        try {
          const conv = await this.conversationRepo.findOrCreateForProject(auto.userId, projectId);
          await this.conversationRepo.addMessage(conv.id, 'assistant', message);
        } catch (err) { this.logger.warn({ err }, 'Automation: deliver via project_chat failed'); }
      }
    }
  }

  /**
   * Cron-Berechnung: für `manual` → undefined, sonst nimmt einen einfachen Cron-Parser
   * für die häufigsten Patterns (Daily/Weekly/Monthly).
   */
  computeNextRun(cron?: string): string | undefined {
    if (!cron || cron === 'manual') return undefined;
    try {
      const next = nextCronExecution(cron, new Date());
      return next?.toISOString();
    } catch { return undefined; }
  }
}

/**
 * Minimaler Cron-Parser (5 Felder: min hour dom mon dow).
 * Unterstützt: Zahlen, '*', Listen (1,2,3), Ranges (1-5), Steps (Slash-N wie Standard-Cron).
 * Findet das nächste Match in den nächsten 366 Tagen.
 */
export function nextCronExecution(cron: string, from: Date): Date | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [min, hour, dom, mon, dow] = parts;
  // Try max 366 days
  let d = new Date(from.getTime() + 60_000); // start at next minute
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(d.getMinutes(), min)
      && matches(d.getHours(), hour)
      && matches(d.getDate(), dom)
      && matches(d.getMonth() + 1, mon)
      && matches(d.getDay(), dow)) {
      return d;
    }
    d = new Date(d.getTime() + 60_000);
  }
  return undefined;
}

function matches(value: number, expr: string): boolean {
  if (expr === '*') return true;
  for (const part of expr.split(',')) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = Number(stepStr);
      if (base === '*') { if (value % step === 0) return true; continue; }
      if (base.includes('-')) {
        const [s, e] = base.split('-').map(Number);
        if (value >= s && value <= e && (value - s) % step === 0) return true;
        continue;
      }
      const baseN = Number(base);
      if (value >= baseN && (value - baseN) % step === 0) return true;
      continue;
    }
    if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      if (value >= s && value <= e) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}
