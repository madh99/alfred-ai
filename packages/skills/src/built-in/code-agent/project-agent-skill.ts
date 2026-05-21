import type { SkillMetadata, SkillContext, SkillResult, CodeAgentDefinitionConfig, ProjectAgentsConfig } from '@alfred/types';
import { Skill } from '../../skill.js';
import type { ProjectAgentSessionRepository, ProjectAgentInterjectionRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

/**
 * v607 D5 — strip LLM-introduced boilerplate prefixes from the goal-text.
 *
 * The v605 PromptBuilder tells the LLM "always use action='start' with a fresh
 * goal", which the LLM tends to take literally and prepend phrases like
 * "Starte einen NEUEN Projekt-Agent-Lauf für ..." to the actual project
 * description. This pollutes project-names and runbook-titles downstream.
 *
 * Strips repeatedly to handle layered prefixes. Returns the cleaned goal.
 */
export function stripGoalPrefix(goal: string): string {
  const prefixes = [
    /^Starte\s+(einen\s+)?(NEUE[NRS]?\s+)?Projekt-Agent-Lauf\s+(für|fuer)\s+/i,
    /^Bitte\s+(starte|erstelle|baue)\s+/i,
    /^Starte\s+(einen\s+)?(neuen\s+)?Project[-\s]Agent[-\s]Lauf\s+/i,
    /^Erstelle\s+(ein\s+)?(neues\s+)?Projekt\s+(für|für\s+|fuer\s+)?/i,
    /^Bitte\s+/i,
  ];
  let result = goal.trim();
  let changed = true;
  let iters = 0;
  while (changed && iters++ < 4) {
    changed = false;
    for (const re of prefixes) {
      if (re.test(result)) {
        result = result.replace(re, '').trim();
        // Strip leading quotes around the project name if any
        result = result.replace(/^["'"„"](.+?)["'"""]/, '$1').trim();
        changed = true;
      }
    }
  }
  return result.length > 0 ? result : goal.trim();
}

/** Fallback in-memory inbox (used when no DB repository is available). */
const interjectionInboxFallback = new Map<string, string[]>();

/** DB-backed interjection repository — set via setInterjectionRepo(). */
let interjectionRepo: ProjectAgentInterjectionRepository | undefined;

export function setInterjectionRepo(repo: ProjectAgentInterjectionRepository): void {
  interjectionRepo = repo;
}

/** Active runner abort controllers keyed by session ID. */
const activeAbortControllers = new Map<string, AbortController>();

/**
 * v651 — Per-Session Output-Ring-Buffer für Live-Streaming. Hält die letzten ~500
 * Output-Lines pro aktiver Session + Liste der SSE-Subscriber. Wird bei Session-Ende
 * 5min lang behalten damit Spät-Connector noch das Ende sieht, dann gelöscht.
 */
interface OutputBuffer {
  lines: Array<{ ts: number; source: 'stdout' | 'stderr' | 'system'; text: string }>;
  subscribers: Set<(line: { ts: number; source: string; text: string }) => void>;
  endedAt?: number;
}
const outputBuffers = new Map<string, OutputBuffer>();
const OUTPUT_BUFFER_MAX_LINES = 500;
const OUTPUT_BUFFER_RETAIN_MS = 5 * 60_000;

export function appendOutputLine(taskId: string, source: 'stdout' | 'stderr' | 'system', text: string): void {
  let buf = outputBuffers.get(taskId);
  if (!buf) { buf = { lines: [], subscribers: new Set() }; outputBuffers.set(taskId, buf); }
  const entry = { ts: Date.now(), source, text: text.slice(0, 4000) };
  buf.lines.push(entry);
  if (buf.lines.length > OUTPUT_BUFFER_MAX_LINES) buf.lines.splice(0, buf.lines.length - OUTPUT_BUFFER_MAX_LINES);
  for (const sub of buf.subscribers) {
    try { sub(entry); } catch { /* dropped */ }
  }
}

export function subscribeOutput(taskId: string, cb: (line: { ts: number; source: string; text: string }) => void): { history: Array<{ ts: number; source: string; text: string }>; unsubscribe: () => void } {
  let buf = outputBuffers.get(taskId);
  if (!buf) { buf = { lines: [], subscribers: new Set() }; outputBuffers.set(taskId, buf); }
  buf.subscribers.add(cb);
  return {
    history: [...buf.lines],
    unsubscribe: () => { buf!.subscribers.delete(cb); },
  };
}

export function markOutputEnded(taskId: string): void {
  const buf = outputBuffers.get(taskId);
  if (!buf) return;
  buf.endedAt = Date.now();
  setTimeout(() => {
    const b = outputBuffers.get(taskId);
    if (b && b.endedAt && Date.now() - b.endedAt > OUTPUT_BUFFER_RETAIN_MS - 100) {
      outputBuffers.delete(taskId);
    }
  }, OUTPUT_BUFFER_RETAIN_MS);
}

export async function pushInterjection(taskId: string, message: string): Promise<void> {
  if (interjectionRepo) {
    await interjectionRepo.push(taskId, message);
  } else {
    const inbox = interjectionInboxFallback.get(taskId) ?? [];
    inbox.push(message);
    interjectionInboxFallback.set(taskId, inbox);
  }
}

export async function drainInterjections(taskId: string): Promise<string[]> {
  if (interjectionRepo) {
    return interjectionRepo.drain(taskId);
  }
  const messages = interjectionInboxFallback.get(taskId) ?? [];
  interjectionInboxFallback.delete(taskId);
  return messages;
}

export function registerAbortController(sessionId: string, controller: AbortController): void {
  activeAbortControllers.set(sessionId, controller);
}

export function removeAbortController(sessionId: string): void {
  activeAbortControllers.delete(sessionId);
}

/**
 * v649 — Auto-Detect für Build/Test-Commands aus dem cwd.
 * Liest package.json/Cargo.toml/pyproject.toml und mappt sinnvolle Scripts.
 * Gracefully degrades wenn nichts erkennbar.
 */
async function autoDetectBuildCommands(cwd: string): Promise<{ build: string[]; test: string[] } | null> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts ?? {};
      const build: string[] = [];
      const test: string[] = [];
      // Install first
      if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) build.push('pnpm install');
      else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) build.push('yarn install');
      else build.push('npm install');
      // Build/typecheck/lint
      if (scripts.build) build.push('npm run build');
      if (scripts.typecheck) build.push('npm run typecheck');
      else if (scripts['type-check']) build.push('npm run type-check');
      if (scripts.lint) build.push('npm run lint');
      // Test commands
      if (scripts.test && !/^echo\s/.test(scripts.test)) test.push('npm test');
      return { build, test };
    }
    const cargoPath = path.join(cwd, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      return { build: ['cargo build'], test: ['cargo test'] };
    }
    const pyprojectPath = path.join(cwd, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      const raw = fs.readFileSync(pyprojectPath, 'utf8');
      const build: string[] = ['pip install -e .'];
      const test: string[] = [];
      if (/pytest/.test(raw)) test.push('pytest');
      return { build, test };
    }
    const gomod = path.join(cwd, 'go.mod');
    if (fs.existsSync(gomod)) {
      return { build: ['go build ./...'], test: ['go test ./...'] };
    }
    return null;
  } catch { return null; }
}

/**
 * v649 — Erweiterter Pre-Flight-Check: prüft Agent-Binary, Git-Identity, Disk-Space,
 * Build-Tools (npm/cargo/python). Liefert eine Liste klarer Diagnose-Strings.
 * Empty array = alles ok.
 */
export async function extendedPreflight(cwd: string, agentCommand: string): Promise<string[]> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const issues: string[] = [];

  // Agent-Binary
  try {
    const probe = spawnSync(agentCommand, ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (probe.status !== 0 && !probe.stdout?.trim()) {
      issues.push(`Agent-Binary "${agentCommand}" antwortet nicht auf --version (status=${probe.status}). Vermutlich nicht installiert oder nicht im PATH.`);
    }
  } catch { issues.push(`Agent-Binary "${agentCommand}" konnte nicht ausgeführt werden.`); }

  // Git-Identity (wird vom Runner injected, hier nur Hinweis falls fehlt)
  try {
    const userName = spawnSync('git', ['-C', cwd, 'config', 'user.name'], { timeout: 2000, encoding: 'utf8' });
    if (!userName.stdout?.trim()) issues.push('Git-Identity (user.name) fehlt — Runner setzt Default "Alfred", aber globale Identity wäre besser.');
  } catch { /* skip */ }

  // Disk-Space (best effort: nur Warnung)
  try {
    const stat = fs.statfsSync(cwd);
    const freeGB = (stat.bavail * stat.bsize) / (1024 ** 3);
    if (freeGB < 0.5) issues.push(`Wenig Disk-Space im cwd: ${freeGB.toFixed(2)} GB frei. Build kann scheitern.`);
  } catch { /* statfs not always available */ }

  // Build-Tools je nach erkanntem Projekt-Typ
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const probe = spawnSync('npm', ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (probe.status !== 0) issues.push('npm nicht im PATH — kann package.json nicht installieren.');
    } catch { issues.push('npm nicht ausführbar.'); }
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    try {
      const probe = spawnSync('cargo', ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (probe.status !== 0) issues.push('cargo nicht im PATH — Rust-Project kann nicht gebaut werden.');
    } catch { issues.push('cargo nicht ausführbar.'); }
  }

  return issues;
}

export class ProjectAgentSkill extends Skill {
  readonly metadata: SkillMetadata;

  private readonly agents: Map<string, CodeAgentDefinitionConfig>;
  private readonly config: ProjectAgentsConfig;
  /** Set by alfred.ts after construction — the runner that executes the loop. */
  private runner?: { run(sessionId: string, config: Record<string, unknown>, platform: string, chatId: string): Promise<void> };
  /** v615 M1 — set via alfred.ts after construction to enable project-name lookups */
  private projectRepo?: {
    findByCwd?(userId: string, cwd: string): Promise<{ id: string; name: string; cwd?: string } | null>;
    list(userId: string, opts?: { status?: string; limit?: number }): Promise<Array<{ id: string; name: string; slug: string; cwd?: string }>>;
  };
  private ownerUserId?: string;

  /** v615 M1 — wire from alfred.ts after Skill construction. */
  setProjectLookup(repo: typeof this.projectRepo, ownerUserId: string | undefined): void {
    this.projectRepo = repo;
    this.ownerUserId = ownerUserId;
  }

  constructor(
    config: ProjectAgentsConfig & { agents: CodeAgentDefinitionConfig[] },
    private readonly llm: LLMProvider,
    private readonly sessionRepo: ProjectAgentSessionRepository,
  ) {
    super();
    this.config = config;
    this.agents = new Map(config.agents.map(a => [a.name, a]));

    // v611 — Build metadata at construction so the agent-enum reflects the actually
    // configured code agents instead of hardcoded "claude-code". Before this fix the
    // LLM had no way to know other agents existed and the input-schema rejected nothing,
    // so a typoed name only failed deep in the runner with 'Unknown agent'.
    const agentNames = [...this.agents.keys()];
    const defaultAgent = agentNames[0] ?? '';
    const agentList = agentNames.length > 0 ? agentNames.join(', ') : '(none configured)';
    this.metadata = {
      name: 'project_agent',
      category: 'automation',
      description: `Autonomous coding agent that creates and develops software projects end-to-end. Runs indefinitely until the goal is reached.
Actions:
- start: Start a NEW project agent session. Use this whenever the user requests a new project or wants to retry after a previous session ended. Params: goal (what to build), cwd (directory), agent (which code agent to use — available: ${agentList}; default: ${defaultAgent}), buildCommands (optional, e.g. ["npm install", "npm run build"]), testCommands (optional), template (optional, e.g. "nextjs"). WICHTIG zur cwd: das ist der LOKALE Entwicklungs-Pfad auf der Alfred-Node (z.B. /home/madh/projects/<projektname>), NICHT der Deploy-Target-Pfad auf einem Remote-Host. Wenn die Deploy-Memory sagt "Projekt X läuft auf 192.168.1.96 als ubuntu" ist das der Deploy-Target, NICHT der Workspace. Für Continue-Sessions desselben Projekts: gleichen cwd wie der letzte erfolgreiche Lauf benutzen (siehe project_workspace_<projektname> Memory falls vorhanden).
- status: Check current status of a project agent session. Params: task_id. Returns currentPhase — if 'done' or 'failed', the session has ENDED and interject will not work; start a fresh one instead.
- interject: Send a message to a CURRENTLY RUNNING project agent (e.g. "add feature X"). Params: task_id, message. DO NOT use interject if the session is already finished/done/failed — start a new session with action='start' instead. The skill will reject interject on terminated sessions with a clear error.
- stop: Stop a running project agent. Params: task_id`,
      riskLevel: 'admin',
      version: '1.0.0',
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'status', 'interject', 'stop', 'resume'],
            description: 'Project agent action',
          },
          goal: { type: 'string', description: 'What to build (for start)' },
          cwd: { type: 'string', description: 'Working directory for the project (for start)' },
          agent: agentNames.length > 0 ? {
            type: 'string',
            enum: agentNames,
            description: `Code agent to use (for start). Available: ${agentList}. Default: ${defaultAgent}. Omit to use default.`,
          } : {
            type: 'string',
            description: 'Code agent to use (for start). No agents configured.',
          },
          buildCommands: {
            type: 'array', items: { type: 'string' },
            description: 'Commands to validate build (for start). Default: ["npm install", "npm run build"]',
          },
          testCommands: {
            type: 'array', items: { type: 'string' },
            description: 'Commands to run tests (for start). Default: ["npm test"]',
          },
          template: { type: 'string', description: 'Project template name (for start, optional)' },
          task_id: { type: 'string', description: 'Task ID (for status/interject/stop)' },
          message: { type: 'string', description: 'Message to inject (for interject)' },
        },
        required: ['action'],
      },
    };
  }

  setRunner(runner: { run(sessionId: string, config: Record<string, unknown>, platform: string, chatId: string): Promise<void> }): void {
    this.runner = runner;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'start':
        return this.startProject(input, context);
      case 'status':
        return this.getStatus(input, context);
      case 'interject':
        return this.interject(input, context);
      case 'stop':
        return this.stopProject(input, context);
      case 'resume':
        return this.resumeProject(input, context);
      default:
        return { success: false, error: `Unknown action "${action}". Use start, status, interject, stop, or resume.` };
    }
  }

  /**
   * v648 — Resume eines fehlgeschlagenen Project-Agent-Laufs.
   * Liest persisted Plan + Commits + Milestones, baut Continuation-Goal, startet neu.
   */
  private async resumeProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const failedTaskId = input.failed_task_id as string | undefined;
    if (!failedTaskId) return { success: false, error: 'Missing required field "failed_task_id"' };
    if (!this.runner) return { success: false, error: 'Project agent runner not configured' };

    const failed = await this.sessionRepo.getByTaskId(failedTaskId);
    if (!failed) return { success: false, error: `Session ${failedTaskId} not found` };

    // Erlaube Resume bei failed/awaiting_user/done (für "more work please")
    if (failed.currentPhase !== 'failed' && failed.currentPhase !== 'awaiting_user' && failed.currentPhase !== 'done') {
      return { success: false, error: `Session ${failedTaskId} ist in Phase '${failed.currentPhase}' — Resume nur bei failed/awaiting_user/done.` };
    }

    // Diagnose-Hint aus dem letzten Build-Output (Auth/Inactivity/etc.)
    let diagHint = '';
    if (typeof (this.sessionRepo as any).getByTaskIdWithOutput === 'function') {
      // not implemented today; leave for future
    }

    // Load persisted plan if available
    const plansRepo = (this as { plansRepoRef?: any }).plansRepoRef;
    let planSummary = '';
    if (plansRepo) {
      try {
        const phases = await plansRepo.listBySession(failed.id);
        if (phases.length > 0) {
          const done = phases.filter((p: any) => p.status === 'done').length;
          const lines = phases.map((p: any) => {
            const icon = p.status === 'done' ? '✓' : p.status === 'failed' ? '✗' : p.status === 'running' ? '◐' : '○';
            return `  ${icon} P${p.phaseIdx}: ${p.description.slice(0, 100)}`;
          }).join('\n');
          planSummary = `\n**Ursprünglicher Plan (${done}/${phases.length} erledigt)**:\n${lines}\n`;
        }
      } catch { /* skip */ }
    }

    const commits = failed.milestones.length > 0
      ? `\n**Erreichte Milestones**:\n${failed.milestones.slice(-10).map(m => `  ✓ ${m}`).join('\n')}\n`
      : '';

    const lastCommit = failed.lastCommitSha
      ? `\n**Letzter Commit**: ${failed.lastCommitSha.slice(0, 12)}`
      : '';

    const userNotes = input.notes ? `\n**User-Hinweis**: ${String(input.notes).slice(0, 800)}\n` : '';

    const continuationGoal = `FORTSETZUNG der abgebrochenen Session ${failedTaskId.slice(0, 8)}.

**Original-Ziel**:
${failed.goal.slice(0, 3000)}

**Status zum Abbruch**:
- Phase ${failed.currentIteration} (von vermutlich mehr)
- ${failed.totalFilesChanged} Dateien geändert
- Build-Status: ${failed.lastBuildPassed ? 'zuletzt grün' : 'zuletzt rot'}${lastCommit}
${planSummary}${commits}${userNotes}

**ERSTE PHASE deines neuen Plans**:
1. Untersuche den aktuellen Repo-Stand (\`git log --oneline -20\`, \`ls\`, relevante Source-Files)
2. Matched gegen das ursprüngliche Ziel: was ist bereits umgesetzt, was fehlt?
3. Wenn unklar: kurzes Audit als Markdown.

**Danach**: nur die fehlenden Teile umsetzen. Bestehende Arbeit NICHT überschreiben, KEIN Force-Push, KEIN revert von Commits. Build grün bekommen, normal committen+pushen.
`;

    // Start fresh with same cwd + agent
    const startInput = {
      cwd: failed.cwd,
      goal: continuationGoal,
      agent: failed.agentName,
      _resumedFromTaskId: failedTaskId, // internal marker
    };
    const result = await this.startProject(startInput, context);
    if (result.success && result.data) {
      (result.data as Record<string, unknown>).resumedFromTaskId = failedTaskId;
      result.display = `▶ Resume gestartet: neue Session ${(result.data as any).taskId?.slice(0, 8)} fortsetzend von ${failedTaskId.slice(0, 8)}.\n\n` + (result.display ?? '');
    }
    return result;
  }

  private async startProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const rawGoal = input.goal as string | undefined;
    let cwd = input.cwd as string | undefined;
    const agentName = (input.agent as string) ?? [...this.agents.keys()][0];

    if (!rawGoal) return { success: false, error: 'Missing required field "goal"' };
    if (!cwd) return { success: false, error: 'Missing required field "cwd"' };
    if (!this.runner) return { success: false, error: 'Project agent runner not configured' };

    // v607 D5 — strip boilerplate prefixes the LLM tends to prepend (driven by
    // the v605 PromptBuilder rule "use action='start' with fresh goal"). Without
    // this, project-names + runbook-titles look like
    // "Starte einen NEUEN Projekt-Agent-Lauf für 'X' unter ..."
    // instead of just the project description.
    const goal = stripGoalPrefix(rawGoal);

    const agentDef = this.agents.get(agentName);
    if (!agentDef) {
      return { success: false, error: `Unknown agent "${agentName}". Available: ${[...this.agents.keys()].join(', ')}` };
    }

    // L4 (v604) — Smart cwd-Default: when the chosen agent runs as a different
    // (non-root) user via `sudo -u X`, a cwd under /root/ creates an unreachable
    // path (parent /root is drwx------ → traversal blocked → constant EACCES).
    // We auto-rewrite to /home/X/projects/<last-segment> and surface a hint.
    const runAsUser = (agentDef.command === 'sudo' && agentDef.argsTemplate[0] === '-u' && agentDef.argsTemplate[1])
      ? agentDef.argsTemplate[1]
      : undefined;
    let cwdRewriteHint: string | undefined;
    if (runAsUser && runAsUser !== 'root' && /^\/root(\/|$)/.test(cwd)) {
      const lastSegment = cwd.replace(/\/+$/, '').split('/').pop() || 'project';
      const newCwd = `/home/${runAsUser}/projects/${lastSegment}`;
      cwdRewriteHint = `Hinweis: cwd \`${cwd}\` wurde automatisch auf \`${newCwd}\` umgeleitet, weil Agent "${agentName}" als User "${runAsUser}" läuft und /root nicht traversierbar ist.`;
      cwd = newCwd;
    }

    // v617 — Wenn ein Projekt mit GENAU diesem cwd schon existiert, ist auto-bind
    // explizit gewollt. M1 + M2 dürfen dann NICHT blocken (sonst wird der korrekte
    // Continue-Pfad blockiert nur weil irgendwo ein anderes Projekt mit ähnlichem
    // Namen existiert). Genau dieser Bug wäre bei dir aufgetreten weil 3a407ced
    // (cwd=/home/madh/projects/alpbyte-games) UND ef6f549a (cwd=/home/ubuntu/...)
    // beide existieren — ein Start mit dem korrekten /home/madh/...-cwd hätte
    // M1 fälschlich getriggert weil basename gleich.
    let exactProjectMatch: { id: string; name: string; cwd?: string } | null = null;
    if (this.projectRepo && this.ownerUserId) {
      try {
        const list = await this.projectRepo.list(this.ownerUserId, { limit: 200 });
        exactProjectMatch = list.find(p => p.cwd === cwd) ?? null;
      } catch { /* fall through */ }
    }

    // v615 M2 — Workspace-Sanity-Check: lehne cwd ab das auf ein /home/<X>/ verweist
    // wo X nicht der runAsUser ist (außer 'projects'-Subpath). Verhindert dass das LLM
    // einen Deploy-Target-Pfad wie /home/ubuntu/<project> als Workspace ansetzt
    // und der Agent damit ein paralleles, isoliertes Verzeichnis auf der Alfred-Node
    // anlegt (so passiert am 2026-05-20 mit alpbyte-games auf /home/ubuntu/...).
    // v617: skip wenn ein bestehendes Projekt diesen cwd schon registriert hat
    // (= war offensichtlich gewollt, blockieren wäre Regression).
    if (!exactProjectMatch && runAsUser && /^\/home\/([^/]+)\//.test(cwd)) {
      const m = cwd.match(/^\/home\/([^/]+)\//);
      const cwdHomeUser = m?.[1];
      if (cwdHomeUser && cwdHomeUser !== runAsUser) {
        return {
          success: false,
          error: `cwd "${cwd}" verweist auf das Home-Verzeichnis von User "${cwdHomeUser}", aber Agent "${agentName}" läuft als "${runAsUser}". ` +
            `Das ist meistens eine Verwechslung von Deploy-Target-Pfad mit lokalem Dev-Workspace. ` +
            `Wahrscheinlich gemeint: /home/${runAsUser}/projects/${cwd.split('/').pop() || 'project'} ` +
            `(oder explizit bestätigen falls wirklich gewollt).`,
        };
      }
    }

    // v615 M1 — Project-Name-Lookup BEFORE accepting the supplied cwd: if a Project
    // with a similar name already exists at a DIFFERENT cwd, reject this start.
    // v617: skip wenn ein Projekt mit EXAKT diesem cwd existiert (auto-bind nimmt es)
    // Catches the alpbyte-games / /home/ubuntu/ vs /home/madh/projects/ confusion
    // from 2026-05-20 where the LLM picked the deploy-target path as workspace.
    if (!exactProjectMatch && this.projectRepo && this.ownerUserId) {
      try {
        const lastSegment = cwd.replace(/\/+$/, '').split('/').pop() ?? '';
        const lastSegmentNorm = lastSegment.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (lastSegmentNorm.length >= 3) {
          const allProjects = await this.projectRepo.list(this.ownerUserId, { status: 'active', limit: 100 });
          const conflict = allProjects.find(p => {
            if (!p.cwd) return false;
            if (p.cwd === cwd) return false; // exact match → not a conflict (defensive double-check)
            const projLast = p.cwd.replace(/\/+$/, '').split('/').pop() ?? '';
            return projLast.toLowerCase().replace(/[^a-z0-9-]/g, '') === lastSegmentNorm
              || p.name.toLowerCase().replace(/[^a-z0-9-]/g, '').includes(lastSegmentNorm)
              || p.slug.toLowerCase().includes(lastSegmentNorm);
          });
          if (conflict && conflict.cwd) {
            return {
              success: false,
              error: `Es gibt bereits ein Projekt "${conflict.name.slice(0, 80)}" mit cwd \`${conflict.cwd}\`. ` +
                `Du hast cwd \`${cwd}\` angegeben — meintest du den bestehenden Pfad? ` +
                `Falls ja: action=start nochmal mit cwd=\`${conflict.cwd}\`. ` +
                `Falls wirklich neuer Workspace gewünscht: rename des cwd-Basenames (z.B. ${lastSegment}-v2) und erneut versuchen.`,
              data: { existing_project_cwd: conflict.cwd, supplied_cwd: cwd, existing_project_name: conflict.name },
            };
          }
        }
      } catch { /* non-critical — fall through to existing checks */ }
    }

    // Check if a session is already running for this cwd
    const existing = await this.sessionRepo.findActiveByCwd(cwd);
    if (existing) {
      return {
        success: false,
        error: `In "${cwd}" läuft bereits ein Project Agent (Task: ${existing.taskId}, Phase: ${existing.currentPhase}). ` +
          `Stoppe ihn zuerst mit action=stop, task_id=${existing.taskId}.`,
      };
    }

    // v605 M6 / v608 F7 — surface any previous (completed/failed) sessions for
    // the same cwd as informational hint. Not a blocker — but the new attempt
    // SHOULD know whether the last build passed, what milestones were reached
    // and which commit was the last good state.
    let previousAttemptHint: string | undefined;
    try {
      const history = await this.sessionRepo.getHistoryByCwd(cwd);
      if (history.length > 0) {
        const lines = history.slice(0, 3).map((h, i) => {
          const buildIcon = h.lastBuildPassed ? '✅ build ok' : '🔴 build broken';
          const phaseIcon = h.phase === 'done' ? '✓ done' : '✗ failed';
          const sha = h.lastCommitSha ? ` @ ${h.lastCommitSha.slice(0, 8)}` : '';
          const ms = h.milestones.length > 0 ? ` — ${h.milestones.slice(-2).join(' · ')}` : '';
          return `  ${i + 1}. [${phaseIcon}, ${buildIcon}${sha}] ${h.goal.slice(0, 80)}${ms}`;
        });
        previousAttemptHint = `Vorherige Versuche in diesem Verzeichnis:\n${lines.join('\n')}\n\nDie neue Session läuft frisch. Build-Status der letzten Sessions bitte beachten.`;
      }
    } catch { /* non-critical */ }

    // v649 — Extended Pre-Flight (Agent-Binary, Git-Identity, Disk-Space, Build-Tools)
    let preflightWarnings: string[] = [];
    try {
      // Resolve binary from agentDef (sudo wrapper aside)
      let probeCmd = agentDef.command;
      if (agentDef.command === 'sudo' && Array.isArray(agentDef.argsTemplate)) {
        const sudoArgs = [...agentDef.argsTemplate];
        let i = 0;
        while (i < sudoArgs.length && sudoArgs[i].startsWith('-')) {
          if (sudoArgs[i] === '-u' || sudoArgs[i] === '--user') { i += 2; continue; }
          i += 1;
        }
        if (i < sudoArgs.length) probeCmd = sudoArgs[i];
      }
      preflightWarnings = await extendedPreflight(cwd, probeCmd);
    } catch { /* non-critical */ }

    // Resolve build/test commands from input, template, or defaults
    const template = this.config.templates?.find(t => t.name === input.template);
    // v649 — Auto-Test-Discovery aus package.json/Cargo.toml/pyproject.toml
    const autoDetected = await autoDetectBuildCommands(cwd).catch(() => null);
    const buildCommands = (input.buildCommands as string[])
      ?? template?.buildCommands
      ?? autoDetected?.build
      ?? ['npm install', 'npm run build'];
    const testCommands = (input.testCommands as string[])
      ?? template?.testCommands
      ?? autoDetected?.test
      ?? [];

    // Create session tracking
    const session = await this.sessionRepo.create({
      taskId: crypto.randomUUID(),
      goal,
      cwd,
      agentName,
      resumedFromTaskId: input._resumedFromTaskId as string | undefined,
    });

    const config = {
      goal, cwd, agentName, buildCommands, testCommands,
      maxDurationHours: this.config.defaultMaxDurationHours ?? 8,
      maxFixAttempts: this.config.maxFixAttemptsPerIteration ?? 3,
      buildTimeoutMs: this.config.buildCommandTimeoutMs ?? 300_000,
      // v650 — opt-in flags
      branchPerSession: input.branchPerSession === true || input.branch_per_session === true,
      confirmPlan: input.confirmPlan === true || input.confirm_plan === true,
      // v652 — Auto-Resume opt-in
      autoResume: input.autoResume === true || input.auto_resume === true,
    };

    // Fire-and-forget: start the runner loop asynchronously
    this.runner.run(session.taskId, config, context.platform, context.chatId).catch((err) => {
      console.error('[project-agent] Runner failed:', err);
    });

    return {
      success: true,
      data: { taskId: session.taskId, goal, cwd, agentName, buildCommands, testCommands, cwdRewriteHint, previousAttemptHint, preflightWarnings },
      display: `🚀 Project Agent gestartet (${session.taskId})\n` +
        `Ziel: ${goal}\n` +
        `Verzeichnis: ${cwd}\n` +
        `Agent: ${agentName}\n` +
        `Build: ${buildCommands.join(' && ')}\n` +
        (autoDetected ? `🔎 Auto-Detect: ${autoDetected.build.length} Build- + ${autoDetected.test.length} Test-Commands erkannt.\n` : '') +
        (cwdRewriteHint ? `\n⚠️ ${cwdRewriteHint}\n` : '') +
        (previousAttemptHint ? `\nℹ️ ${previousAttemptHint}\n` : '') +
        (preflightWarnings.length > 0 ? `\n⚠️ Pre-Flight-Warnungen:\n${preflightWarnings.map(w => `  - ${w}`).join('\n')}\n` : '') +
        `Fortschritt wird via Chat gemeldet.`,
    };
  }

  /** Verify the caller owns or is admin for this task. */
  private async verifyTaskAccess(taskId: string, context: SkillContext): Promise<import('@alfred/storage').ProjectAgentSession | null> {
    const session = await this.sessionRepo.getByTaskId(taskId);
    if (!session) return null;
    // Task was started from the same chat, or user is admin
    if (context.chatId === (session as any).chatId) return session;
    if (context.userRole === 'admin') return session;
    return null;
  }

  private async getStatus(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // v605 M4 — explicit "session ended" hint when phase is terminal
    const isTerminal = session.currentPhase === 'done' || session.currentPhase === 'failed';
    const terminalHint = isTerminal
      ? `\n\n⚠️ **Diese Session ist ABGESCHLOSSEN** (phase: ${session.currentPhase}). ` +
        `Interject hat hier keine Wirkung. Für neue Arbeit: \`project_agent action='start'\` mit neuem Goal.`
      : '';
    return {
      success: true,
      data: { ...session, terminated: isTerminal },
      display: `📊 Project Agent Status (${taskId})\n` +
        `Phase: ${session.currentPhase}${isTerminal ? ' (TERMINATED)' : ''}\n` +
        `Iteration: ${session.currentIteration}\n` +
        `Dateien geändert: ${session.totalFilesChanged}\n` +
        `Letzter Build: ${session.lastBuildPassed ? '✅ passed' : '❌ failed'}\n` +
        `Letzter Commit: ${session.lastCommitSha ?? '—'}\n` +
        (session.milestones.length > 0 ? `Milestones: ${session.milestones.join(', ')}` : '') +
        terminalHint,
    };
  }

  private async interject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    const message = input.message as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };
    if (!message) return { success: false, error: 'Missing "message"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // v605 M1 — reject interjections to terminated sessions. Previously the
    // alfred-hallucination "ich habe nachgereicht" happened because interject
    // returned success on completed sessions, leaving messages in an
    // orphan-inbox that no runner ever drained.
    const terminal = session.currentPhase === 'done' || session.currentPhase === 'failed';
    if (terminal) {
      return {
        success: false,
        error: `Project-Agent-Session ${taskId} ist bereits beendet (phase: ${session.currentPhase}). ` +
          `Interject geht nur an LAUFENDE Sessions. Starte eine NEUE Session mit action='start' und neuem Goal.`,
        data: { taskId, sessionPhase: session.currentPhase, terminated: true },
      };
    }

    await pushInterjection(taskId, message);
    return {
      success: true,
      data: { taskId, message },
      display: `📝 Nachricht eingereiht für Project Agent (${taskId}). Wird in der nächsten Iteration berücksichtigt.`,
    };
  }

  private async stopProject(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const taskId = input.task_id as string | undefined;
    if (!taskId) return { success: false, error: 'Missing "task_id"' };

    const session = await this.verifyTaskAccess(taskId, context);
    if (!session) return { success: false, error: `Task "${taskId}" nicht gefunden oder keine Berechtigung.` };

    // Push stop signal to inbox
    await pushInterjection(taskId, '__STOP__');
    // Also abort via controller if available
    const controller = activeAbortControllers.get(taskId);
    if (controller) controller.abort();

    return {
      success: true,
      data: { taskId, stopped: true },
      display: `⏹ Stop-Signal gesendet an Project Agent (${taskId}). Agent wird nach dem aktuellen Schritt sauber beendet.`,
    };
  }
}
