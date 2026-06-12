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
/**
 * v881 — externe Daten-Provider (von alfred.ts injiziert): liefern ECHTE
 * Zahlen/Listen aus DB und Forge, damit Templates wie Cost-Tracking oder
 * PR-Pflege nicht halluzinieren müssen.
 */
export interface AutomationDataProviders {
  /** Echte Kosten: cli_agent_runs pro Projekt + globale llm_usage (Monat vs. Vormonat). */
  costStats?: (projectId: string) => Promise<string>;
  /** Offene MRs/PRs via Forge-API (GitLab/GitHub — nicht nur gh). */
  forgePrs?: (cwd: string) => Promise<string>;
}

/**
 * v881 — Vergleichsbasis aus dem letzten Lauf: macht "Drift/Trend zur
 * Vorwoche" zu einer ECHTEN Aussage statt einer Halluzination. Beim ersten
 * Lauf gibt es bewusst keinen Block — der Prompt weist das LLM an, das
 * dann explizit zu sagen. Exportiert für Tests.
 */
export function buildPreviousRunBlock(lastRunAt?: string, lastRunStatus?: string, lastRunOutput?: string, maxChars = 2500): string {
  if (!lastRunOutput || lastRunStatus !== 'success') return '';
  const ts = lastRunAt ? lastRunAt.slice(0, 16).replace('T', ' ') : 'unbekannt';
  const body = lastRunOutput.length > maxChars ? lastRunOutput.slice(0, maxChars) + '\n[... gekürzt]' : lastRunOutput;
  return [
    `# Vorheriger Lauf (${ts}) — VERGLEICHSBASIS`,
    `Nutze diesen früheren Output für echte Vergleichs-/Trend-Aussagen. Erfinde KEINE Trends, die sich daraus nicht belegen lassen.`,
    body,
  ].join('\n');
}

export class AutomationEngine {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** v881 — optionale Daten-Provider (alfred.ts injiziert DB-/Forge-Zugriffe). */
  private dataProviders: AutomationDataProviders = {};

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

  setDataProviders(p: AutomationDataProviders): void {
    this.dataProviders = p;
  }

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
    // v881 — ALLE aktiven Items mit IDs (vorher 15 Titel — Triage über 100+
    // Items war strukturell unmöglich) + erledigte der letzten 14 Tage +
    // letzter Health/Build-Stand (= echter "Code-Stand" statt Vermutung).
    const [sessions, openItems, decisions, resolvedItems, health] = await Promise.all([
      this.projectRepo.listSessions(project.id, 10).catch(() => []),
      this.projectRepo.listOpenItemsForProject(project.id, ['open', 'in_progress']).catch(() => []),
      this.projectRepo.listDecisions(project.id, 10).catch(() => []),
      this.projectRepo.listOpenItemsForProject(project.id, ['done', 'cancelled']).catch(() => []),
      this.projectRepo.getCurrentHealthSummary(project.id).catch(() => ({} as Record<string, { status: string; details?: string; checkedAt: string }>)),
    ]);
    const cutoff14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recentDone = resolvedItems
      .filter(it => (it.resolvedAt ?? '') >= cutoff14d)
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
      .slice(0, 40);
    const healthLines = Object.entries(health as Record<string, { status: string; details?: string; checkedAt: string }>)
      .map(([probe, e]) => `- ${probe}: ${e.status}${e.details ? ` (${e.details.slice(0, 120)})` : ''} @ ${e.checkedAt.slice(0, 16)}`);
    const contextLines: string[] = [
      `# Projekt: ${project.name}`,
      project.cwd ? `cwd: ${project.cwd}` : '',
      project.repoUrl ? `repo: ${project.repoUrl}` : '',
      project.description ? `desc: ${project.description}` : '',
      '',
      `## Offene Items (${openItems.length} aktiv${openItems.length > 100 ? ', erste 100 gelistet' : ''})`,
      ...openItems.slice(0, 100).map(it => `- [${it.priority}] ${it.id.slice(0, 8)} ${it.title}${it.dueAt ? ` (due ${it.dueAt.slice(0, 10)})` : ''}${it.status === 'in_progress' ? ' (in Arbeit)' : ''}`),
      '',
      `## Erledigt in den letzten 14 Tagen (${recentDone.length})`,
      ...recentDone.map(it => `- [${it.status}] ${it.title} @ ${(it.resolvedAt ?? '').slice(0, 10)}`),
      '',
      `## Letzter Health-/Build-Stand`,
      ...(healthLines.length > 0 ? healthLines : ['(keine Health-Daten)']),
      '',
      `## Letzte Sessions`,
      ...sessions.slice(0, 5).map(s => `- ${s.sessionType} (${s.endedAt ? 'fertig' : 'laufend'}) @ ${s.startedAt.slice(0, 16)}`),
    ];
    if (decisions.length > 0) {
      contextLines.push('', `## Letzte Decisions`, ...decisions.slice(0, 5).map(d => `- ${d.title}: ${d.choice.slice(0, 100)}`));
    }

    // 2. Collectors (v881: cost_stats/forge_prs laufen über injizierte Provider — echte DB-/Forge-Daten)
    const collectorOutputs: string[] = [];
    for (const coll of tmpl.collectors ?? []) {
      try {
        let out: string;
        if (coll === 'cost_stats') {
          out = this.dataProviders.costStats ? await this.dataProviders.costStats(project.id) : '';
        } else if (coll === 'forge_prs') {
          out = this.dataProviders.forgePrs && project.cwd ? await this.dataProviders.forgePrs(project.cwd) : '';
        } else {
          out = await this.runCollector(coll, project.cwd);
        }
        if (out) collectorOutputs.push(`## ${coll}\n${out.slice(0, 9000)}`);
      } catch (err) {
        this.logger.debug({ err, coll, project: project.id }, 'Collector failed (non-fatal)');
      }
    }

    // 3. LLM-Call
    // v881 — Vorheriger-Lauf-Block: echte Drift-/Trend-Vergleiche
    const prevRunBlock = buildPreviousRunBlock(auto.lastRunAt, auto.lastRunStatus, auto.lastRunOutput);
    const finalPrompt = auto.promptOverride?.trim() || tmpl.defaultPrompt;
    const userMessage = [
      contextLines.filter(Boolean).join('\n'),
      collectorOutputs.length > 0 ? '\n# Collector-Output (ECHTE Daten — nutze NUR diese, erfinde keine Zahlen/Dateien)\n' + collectorOutputs.join('\n\n') : '',
      prevRunBlock,
      '',
      '# Aufgabe',
      finalPrompt,
      '',
      'WICHTIG: Stütze jede Aussage auf die oben gelieferten Daten. Fehlen Daten für einen Teil der Aufgabe, sage das EXPLIZIT ("keine Daten zu X") statt zu raten. Trend-/Vergleichsaussagen NUR wenn ein Vorheriger-Lauf-Block existiert.',
    ].filter(Boolean).join('\n\n');

    let output: string;
    try {
      const r = await this.llm.complete({
        system: `Du bist ein präziser, hilfreicher Projekt-Assistent. Antworte konkret, knapp, mit konkreten Datei-/Item-Referenzen wenn möglich. Erfinde NIEMALS Zahlen, Dateien oder Befunde — nur was die gelieferten Daten belegen. Deutsch.`,
        messages: [{ role: 'user', content: userMessage }],
        tier: 'fast',
        maxTokens: 2000,
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
        // ── v881 — neue Collectors: machen die Template-Versprechen wahr ──
        case 'changelog_head': {
          // Release-Pflege: "Lies CHANGELOG.md" — vorher gab es den Inhalt nie
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const head = await fs.readFile(path.join(cwd, 'CHANGELOG.md'), 'utf-8').then(c => c.slice(0, 4000)).catch(() => '(kein CHANGELOG.md)');
          const { stdout: tags } = await execFileAsync('git', ['tag', '--sort=-creatordate'], { cwd, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: '' }));
          return `### CHANGELOG.md (Anfang)\n${head}\n\n### Letzte Tags\n${tags.split('\n').slice(0, 10).join('\n') || '(keine Tags)'}`;
        }
        case 'readme_content': {
          // Documentation-Drift: README-Inhalt war nie im Kontext
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          return await fs.readFile(path.join(cwd, 'README.md'), 'utf-8').then(c => c.slice(0, 5000)).catch(() => '(kein README.md)');
        }
        case 'git_log_files': {
          // Recurring-Bug-Detector: Datei-Gruppierung braucht --name-only
          const { stdout } = await execFileAsync('git', ['log', '--since=30.days.ago', '--name-only', '--pretty=format:%h|%ad|%s', '--date=short'], { cwd, maxBuffer: 2 * 1024 * 1024 });
          return stdout.slice(0, 6000);
        }
        case 'git_diff_patch': {
          // Code-Review-Quick: der ECHTE Diff statt nur --stat
          const { stdout } = await execFileAsync('git', ['diff', 'HEAD~5..HEAD', '--unified=2'], { cwd, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
          return stdout.slice(0, 9000);
        }
        case 'git_shortlog': {
          // Activity-Digest: Commits pro Autor — echt statt geschätzt
          const { stdout } = await execFileAsync('git', ['shortlog', '-sn', '--since=7.days.ago', 'HEAD'], { cwd, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: '' }));
          return stdout.slice(0, 1500);
        }
        case 'branch_status': {
          // Auto-Rebase: echte Branch-Lage + Konflikt-Dry-Run via merge-tree
          const { stdout: defRaw } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: '' }));
          const defaultBranch = defRaw.trim().replace(/^origin\//, '') ||
            await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, maxBuffer: 64 * 1024 }).then(r => r.stdout.trim()).catch(() => 'main');
          const { stdout: branches } = await execFileAsync('git', ['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { cwd, maxBuffer: 256 * 1024 });
          const lines: string[] = [`default branch: ${defaultBranch}`];
          for (const b of branches.split('\n').map(s => s.trim()).filter(b => b && b !== defaultBranch).slice(0, 10)) {
            try {
              const { stdout: counts } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `${defaultBranch}...${b}`], { cwd, maxBuffer: 64 * 1024 });
              const [behind, ahead] = counts.trim().split(/\s+/, 2);
              // Konflikt-Dry-Run: merge-tree (Output mit Konfliktmarkern = Konflikt erwartet)
              let conflict = 'unbekannt';
              try {
                const { stdout: base } = await execFileAsync('git', ['merge-base', defaultBranch, b], { cwd, maxBuffer: 64 * 1024 });
                const { stdout: mt } = await execFileAsync('git', ['merge-tree', base.trim(), defaultBranch, b], { cwd, maxBuffer: 4 * 1024 * 1024 });
                conflict = mt.includes('<<<<<<<') ? 'KONFLIKT erwartet' : 'konfliktfrei';
              } catch { /* merge-tree-Variante nicht verfügbar */ }
              lines.push(`- ${b}: ${ahead} ahead / ${behind} behind ${defaultBranch} — Rebase: ${conflict}`);
            } catch { lines.push(`- ${b}: (Vergleich fehlgeschlagen)`); }
          }
          if (lines.length === 1) lines.push('(keine weiteren lokalen Branches)');
          return lines.join('\n');
        }
        case 'license_summary': {
          // License-Audit: echte Lizenzliste statt Vermutung
          if (!await this.exists(cwd, 'package.json')) return '';
          const { stdout } = await execFileAsync('npx', ['--yes', 'license-checker', '--summary', '--excludePrivatePackages'], { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
          return stdout ? stdout.slice(0, 3000) : '(license-checker nicht verfügbar — keine Lizenzdaten)';
        }
        case 'bench_run': {
          // Performance-Baseline: Bench wirklich ausführen (nur wenn Script existiert)
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          try {
            const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
            if (!pkg.scripts?.bench) return '(kein bench-Script in package.json — keine Performance-Daten)';
          } catch { return ''; }
          const { stdout, stderr } = await execFileAsync('npm', ['run', 'bench', '--silent'], { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
          return (stdout || stderr).slice(0, 4000);
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
