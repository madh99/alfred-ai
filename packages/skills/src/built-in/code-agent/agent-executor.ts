import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeAgentDefinitionConfig } from '@alfred/types';
import { appendOutputLine } from './project-agent-skill.js';
import { killAgentTree } from './process-tree.js';
import { createParserState, parseLine, type AgentOutputFormat, type ParsedUsage } from './agent-output-parser.js';

// v635 — Default auf 12min angehoben (war 10min v625). Praxisbefund Phase 24
// (Datenmodell/Migration): claude-code ging 600s lang stdout-stumm obwohl
// Dateien geschrieben wurden — stdout-Buffering oder lange interne Tool-Calls.
// Wichtiger als Default-Bump ist der File-mtime-Heartbeat unten.
const DEFAULT_TIMEOUT_MS = 720_000; // 12 minutes — used as inactivity threshold by default
// v626 — Ceiling 15→30min. v624 D wollte 20min für Long-Phases (npm install +
// build + lint + typecheck + test als ein Block); die alte 15min-Decke clampte
// den Wert intern auf 15min, wodurch das v624-Versprechen nicht eingelöst wurde.
// Mit 30min Ceiling wirkt das 20min-Long-Phase-Setting wirklich, plus Buffer.
const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes — used as inactivity threshold ceiling
const MAX_OUTPUT_CHARS = 100_000;
/** v619 D0 — Absolute safety cap. Sliding inactivity timer can extend indefinitely
 *  if the subprocess keeps producing output, but we never want a single agent
 *  invocation to run longer than this regardless of activity.
 *
 *  v853 — von 60min auf 4h erhöht. Realistische Multi-Phase-Refactors mit
 *  Build/Test-Cycles laufen oft 1-3h legitim. Inaktivitäts-Timer (default
 *  10min für code/project agents) bleibt die primäre Schutzlinie — der
 *  ABSOLUTE_CAP fängt nur den seltenen "active-but-wedged" Fall ab.
 *  Override via ENV `ALFRED_AGENT_EXECUTOR_ABSOLUTE_CAP_MS`. */
const ABSOLUTE_CAP_MS = (() => {
  const envVal = process.env['ALFRED_AGENT_EXECUTOR_ABSOLUTE_CAP_MS'];
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 4 * 60 * 60 * 1000; // 4 hours
})();

/**
 * v608 F5 — Preflight: check the agent's binary is callable before spawning.
 * If it's missing we want a clear actionable error, not a 10-minute idle hang
 * (claude-code sometimes exits silently with no output when the binary is unreachable).
 */
function preflightAgent(agentDef: CodeAgentDefinitionConfig): string | null {
  // For `sudo -u <user> <real-command> ...` we want to check the real binary,
  // not `sudo` itself.
  let probeCommand = agentDef.command;
  let probeArgs: string[] = [];
  if (agentDef.command === 'sudo' && Array.isArray(agentDef.argsTemplate)) {
    const sudoArgs = [...agentDef.argsTemplate];
    let i = 0;
    while (i < sudoArgs.length && sudoArgs[i].startsWith('-')) {
      if (sudoArgs[i] === '-u' || sudoArgs[i] === '--user') { i += 2; continue; }
      i += 1;
    }
    if (i < sudoArgs.length) probeCommand = sudoArgs[i];
  }
  if (process.platform === 'win32') return null; // skip on Windows — shell:true handles wrappers
  if (path.isAbsolute(probeCommand)) {
    return fs.existsSync(probeCommand) ? null : `Agent binary nicht gefunden: ${probeCommand}`;
  }
  try {
    const result = spawnSync('which', [probeCommand], { timeout: 3000, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout?.trim()) {
      return `Agent binary "${probeCommand}" nicht im PATH (\`which ${probeCommand}\` exit=${result.status}). ` +
        `Prüfe Installation oder agents.command in Config.`;
    }
    return null;
  } catch {
    return null; // best-effort — don't block on the preflight itself
  }
}

/**
 * v866 — Binary-Version eines CLI-Agents (`claude --version`, `codex --version`).
 * Pro command gecached (1 Spawn pro Prozess-Lifetime, nicht pro Run). Bei
 * sudo-Wrappern wird das echte Binary aufgelöst (gleiche Logik wie preflight).
 * Best-effort: bei Fehler/Timeout → undefined, blockiert nie.
 */
const agentVersionCache = new Map<string, string | undefined>();
export function getAgentVersion(agentDef: CodeAgentDefinitionConfig): string | undefined {
  let probeCommand = agentDef.command;
  if (agentDef.command === 'sudo' && Array.isArray(agentDef.argsTemplate)) {
    const sudoArgs = [...agentDef.argsTemplate];
    let i = 0;
    while (i < sudoArgs.length && sudoArgs[i].startsWith('-')) {
      if (sudoArgs[i] === '-u' || sudoArgs[i] === '--user') { i += 2; continue; }
      i += 1;
    }
    if (i < sudoArgs.length) probeCommand = sudoArgs[i];
  }
  if (agentVersionCache.has(probeCommand)) return agentVersionCache.get(probeCommand);
  let version: string | undefined;
  try {
    const result = spawnSync(probeCommand, ['--version'], { timeout: 5000, encoding: 'utf8', shell: process.platform === 'win32' });
    if (result.status === 0 && result.stdout?.trim()) {
      // erste Zeile, ohne Binary-Namen-Präfix ("2.1.39 (Claude Code)" / "codex-cli 0.x.y")
      version = result.stdout.trim().split('\n')[0].slice(0, 100);
    }
  } catch { /* best-effort */ }
  agentVersionCache.set(probeCommand, version);
  return version;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', '.cache']);

/**
 * v844 — Expandiert `~` und `$HOME` zu absolutem Pfad. Wird für
 * `additionalHeartbeatPaths` benötigt damit configs Pfade wie
 * `~/.claude/projects` schreiben können.
 */
function expandHome(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p.replace(/\$HOME/g, home);
}

/**
 * v844 — Backwards-compat upgrade für agent-defs aus pre-v844 configs.
 *
 * Bestehende Installations (z.B. /root/alfred/config/default.yml auf .92)
 * haben claude/codex/vibe mit Default-Output-Mode (text). Bei langen Phasen
 * → 600s stdout-Stille → unfairer kill (siehe v844 changelog).
 *
 * Statt user-configs zu mutieren, detecten wir den Agent-Typ am `command`
 * und injecten Stream-Flags + outputFormat IN-MEMORY. User-config bleibt
 * unverändert; expliziter outputFormat in config überschreibt die Detection.
 */
export function upgradeAgentDef(def: CodeAgentDefinitionConfig): CodeAgentDefinitionConfig {
  if (def.outputFormat) return def; // user has explicit setting — respect it
  const tpl = Array.isArray(def.argsTemplate) ? def.argsTemplate : [];

  // v893 — Agent-Erkennung per Basename. Trifft das bare Binary ("vibe") UND
  // einen vollen Pfad ("/home/madh/.local/bin/vibe"), egal ob als `command`
  // oder als Element der argsTemplate (z.B. hinter `sudo -u madh`).
  // FIX: die alte Regex `/^|\/claude($|\s)/` war durch die `^`-Alternative für
  // JEDEN String wahr → isClaude/isCodex/isVibe IMMER alle true → da `isClaude`
  // zuerst greift, bekamen vibe UND codex fälschlich den claude-Zweig, also die
  // claude-only-Flags `--verbose --output-format stream-json` injiziert, die
  // ihre CLIs nicht kennen → argparse-Fehler (exitCode 2). claude-code bleibt
  // unverändert (es enthält weiterhin das Element "claude" → isClaude true).
  const cmdBase = (def.command || '').split('/').pop() ?? '';
  const has = (name: string): boolean =>
    cmdBase === name || tpl.some((a) => a === name || a.endsWith('/' + name));
  const isClaude = has('claude');
  const isCodex  = has('codex');
  const isVibe   = has('vibe');

  if (!isClaude && !isCodex && !isVibe) return def;

  const updated: CodeAgentDefinitionConfig = { ...def, argsTemplate: [...tpl] };
  const hasFlag = (flag: string) => updated.argsTemplate.includes(flag);

  if (isClaude) {
    updated.outputFormat = 'claude-stream-json';
    // Required combo: --output-format stream-json + --verbose
    if (!hasFlag('--output-format')) injectAfterClaudePrintFlag(updated.argsTemplate, ['--output-format', 'stream-json']);
    if (!hasFlag('--verbose'))       injectAfterClaudePrintFlag(updated.argsTemplate, ['--verbose']);
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.claude/projects')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.claude/projects'];
    }
  } else if (isCodex) {
    updated.outputFormat = 'codex-jsonl';
    if (!hasFlag('--json')) injectAfterCodexExec(updated.argsTemplate, ['--json']);
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.codex/sessions')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.codex/sessions'];
    }
  } else if (isVibe) {
    updated.outputFormat = 'vibe-streaming';
    // vibe nutzt `--output text` als Default — auf streaming wechseln
    const outputIdx = updated.argsTemplate.indexOf('--output');
    if (outputIdx >= 0 && outputIdx + 1 < updated.argsTemplate.length) {
      updated.argsTemplate[outputIdx + 1] = 'streaming';
    } else {
      updated.argsTemplate.push('--output', 'streaming');
    }
    // v893 — Heartbeat am tatsächlichen vibe-Session-Log-Pfad. vibe schreibt
    // nach VIBE_HOME/logs/session (SESSION_LOG_DIR in vibe), NICHT ~/.vibe/sessions
    // — der alte Pfad existierte nie → Heartbeat lief ins Leere.
    const existing = updated.additionalHeartbeatPaths ?? [];
    if (!existing.includes('~/.vibe/logs/session')) {
      updated.additionalHeartbeatPaths = [...existing, '~/.vibe/logs/session'];
    }
  }
  return updated;
}

/** Insert flags right after `--print` (claude) or at end if --print missing. */
function injectAfterClaudePrintFlag(args: string[], flags: string[]): void {
  const printIdx = args.findIndex(a => a === '--print' || a === '-p');
  if (printIdx >= 0) args.splice(printIdx + 1, 0, ...flags);
  else args.push(...flags);
}

/** Insert flags right after `exec` (codex subcommand). */
function injectAfterCodexExec(args: string[], flags: string[]): void {
  const idx = args.indexOf('exec');
  if (idx >= 0) args.splice(idx + 1, 0, ...flags);
  else args.unshift(...flags);
}

/**
 * v896 — vibe braucht das Projekt als VERTRAUENSWÜRDIGES Workspace, sonst lehnt
 * seine Sandbox schreibende Ops im Headless-Modus ab ("Tool execution not
 * permitted" — z.B. mkdir/write_file für Next.js-`[param]`-Routes). Anders als
 * claude/codex kennt vibe kein implizites Trust übers Spawn-cwd. Wir setzen den
 * Lauf-cwd explizit als `--workdir` (chdir + trust) und `--add-dir` (trusted root).
 * Idempotent; nur für vibe (outputFormat 'vibe-streaming'); claude/codex unberührt.
 */
export function injectVibeWorkspaceFlags(args: string[], outputFormat: string | undefined, cwd: string): string[] {
  if (outputFormat !== 'vibe-streaming' || !cwd) return args;
  const out = [...args];
  if (!out.includes('--workdir')) out.push('--workdir', cwd);
  if (!out.includes('--add-dir')) out.push('--add-dir', cwd);
  return out;
}

/**
 * v895 — vibe liefert Tokens/Kosten/Modell NICHT im Stream (StreamingJsonOutput-
 * Formatter gibt nur LLMMessages aus), sondern in der Session-`meta.json`
 * (`stats` + `config`). Reine, testbare Extraktion aus dem geparsten meta-Objekt.
 *   stats.session_prompt_tokens / session_completion_tokens / session_cost,
 *   config.active_model.
 */
export function parseVibeMetaStats(meta: Record<string, unknown>): { model?: string; usage?: ParsedUsage } {
  const stats = (meta.stats ?? {}) as Record<string, unknown>;
  const cfg = (meta.config ?? {}) as Record<string, unknown>;
  const model = typeof cfg.active_model === 'string' && cfg.active_model.length > 0 ? cfg.active_model : undefined;
  const inTok = Number(stats.session_prompt_tokens ?? 0);
  const outTok = Number(stats.session_completion_tokens ?? 0);
  const cost = Number(stats.session_cost ?? 0);
  const hasUsage = inTok > 0 || outTok > 0 || cost > 0;
  return {
    model,
    usage: hasUsage ? { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, costUsd: cost } : undefined,
  };
}

/**
 * v903 — codex liefert das Modell NICHT im `--json`-Stream (nur `usage` im
 * `turn.completed`). Es steht in der Rollout-Session
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) im `turn_context`-Event als
 * `payload.model`. Reine, testbare Extraktion: erste Zeile mit `payload.model`.
 */
export function parseCodexRolloutModel(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.model === 'string' && payload.model.length > 0) return payload.model;
  }
  return undefined;
}

/**
 * v903 — Lokalisiert die zu DIESEM codex-Lauf gehörende Rollout-Session
 * (neueste `rollout-*.jsonl`, deren mtime um/nach dem Run-Start liegt) und liest
 * das Modell. Best-effort: fehlt die Datei (oder anderes OS) → undefined. Alfred
 * läuft als root und darf die Session-Files lesen. CODEX_HOME-Auflösung wie codex:
 * env > ~/.codex des Run-Users (sudo -u <user> → /home/<user>, sonst Prozess-Home).
 */
function readCodexSessionModel(def: CodeAgentDefinitionConfig, startTimeMs: number): string | undefined {
  try {
    const runAsUser = (def.command === 'sudo' && Array.isArray(def.argsTemplate) && def.argsTemplate[0] === '-u')
      ? def.argsTemplate[1] : undefined;
    const envHome = def.env && typeof def.env.CODEX_HOME === 'string' ? def.env.CODEX_HOME : undefined;
    const codexHome = envHome ? expandHome(envHome) : path.join(runAsUser ? `/home/${runAsUser}` : os.homedir(), '.codex');
    const sessRoot = path.join(codexHome, 'sessions');
    if (!fs.existsSync(sessRoot)) return undefined;
    // codex legt rollout-Files in einem YYYY/MM/DD-Baum ab → rekursiv sammeln.
    const files = (fs.readdirSync(sessRoot, { recursive: true }) as string[])
      .map(String)
      .filter((p) => p.endsWith('.jsonl') && path.basename(p).startsWith('rollout-'))
      .map((rel) => { const full = path.join(sessRoot, rel); try { return { full, mt: fs.statSync(full).mtimeMs }; } catch { return null; } })
      .filter((x): x is { full: string; mt: number } => x !== null)
      .sort((a, b) => b.mt - a.mt);
    for (const { full, mt } of files.slice(0, 8)) {
      // Session muss um/nach dem Run-Start geschrieben sein (10s Slack für Uhren-Skew).
      if (mt < startTimeMs - 10_000) break;
      let content: string;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const model = parseCodexRolloutModel(content);
      if (model) return model;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * v895 — Lokalisiert die zu DIESEM vibe-Lauf gehörende Session-`meta.json`
 * (neueste Session, deren `start_time` um/nach dem Run-Start liegt) und
 * extrahiert usage/model. Best-effort: fehlt die Datei (oder anderes OS) → null.
 * Alfred läuft als root und darf die madh-eigenen Logs lesen (/home/<user> ist
 * für root traversierbar). VIBE_HOME-Auflösung wie vibe: env > ~/.vibe des
 * Run-Users (sudo -u <user> → /home/<user>, sonst Prozess-Home).
 */
function readVibeSessionStats(def: CodeAgentDefinitionConfig, startTimeMs: number): { model?: string; usage?: ParsedUsage } | null {
  try {
    const runAsUser = (def.command === 'sudo' && Array.isArray(def.argsTemplate) && def.argsTemplate[0] === '-u')
      ? def.argsTemplate[1] : undefined;
    const envHome = def.env && typeof def.env.VIBE_HOME === 'string' ? def.env.VIBE_HOME : undefined;
    const vibeHome = envHome ? expandHome(envHome) : path.join(runAsUser ? `/home/${runAsUser}` : os.homedir(), '.vibe');
    const sessRoot = path.join(vibeHome, 'logs', 'session');
    if (!fs.existsSync(sessRoot)) return null;
    const dirs = fs.readdirSync(sessRoot)
      .map((name) => { try { return { name, mt: fs.statSync(path.join(sessRoot, name)).mtimeMs }; } catch { return null; } })
      .filter((x): x is { name: string; mt: number } => x !== null)
      .sort((a, b) => b.mt - a.mt);
    for (const { name } of dirs.slice(0, 5)) {
      const metaPath = path.join(sessRoot, name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>; } catch { continue; }
      const sessStart = typeof meta.start_time === 'string' ? Date.parse(meta.start_time) : NaN;
      // Session muss um/nach dem Run-Start begonnen haben (10s Slack für Uhren-Skew).
      if (!Number.isNaN(sessStart) && sessStart >= startTimeMs - 10_000) {
        return parseVibeMetaStats(meta);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface AgentExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  modifiedFiles: string[];
  /** v866 — Token-Usage aus den Stream-Events (claude result / codex turn.completed).
   *  Läuft auf der EIGENEN Subscription/API-Key des CLI-Agents — wird bewusst
   *  NICHT in Alfreds llm_usage/service_usage gezählt, sondern separat in
   *  cli_agent_runs persistiert. */
  usage?: ParsedUsage;
  /** v866 — Modell aus dem init-Event (z.B. claude-fable-5). */
  model?: string;
  /** v906 — codex Session-/Thread-ID (aus `thread.started`), für Resume-Retry. */
  sessionId?: string;
}

/**
 * v906 — codex „Selected model is at capacity. Please try a different model."
 * (auch generisch „… at capacity"). Bewusst GETRENNT von isTransientApiFailure:
 * dieser Fall braucht eine andere Strategie (langer Backoff + Session-Resume statt
 * 90s/180s-Frisch-Re-Run), weil das Modell-Kapazitätsfenster Minuten dauern kann.
 * `\bat capacity\b` matcht NICHT das Wort „capacity" in Prompt-/Ziel-Texten.
 */
export function isCodexAtCapacity(result: Pick<AgentExecutionResult, 'stdout' | 'stderr' | 'exitCode'>): boolean {
  if (result.exitCode === 0) return false;
  const tail = `${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`;
  return /\bat capacity\b/i.test(tail);
}

/**
 * v906 — Wandelt eine aufgewertete codex-argsTemplate in die Resume-Form:
 * `exec <flags> {{prompt}}` → `exec resume <flags> <sessionId> {{prompt}}`.
 * Damit setzt der Retry die unterbrochene codex-Session fort (erhält die bereits
 * geleistete Arbeit) statt von vorn zu starten. Idempotent (kein doppeltes resume).
 */
export function toCodexResumeArgsTemplate(argsTemplate: string[], sessionId: string): string[] {
  const args = [...argsTemplate];
  const execIdx = args.indexOf('exec');
  if (execIdx < 0 || args[execIdx + 1] === 'resume') return args;
  args.splice(execIdx + 1, 0, 'resume');
  // sessionId als Positional unmittelbar vor den Prompt-Platzhalter (resume [OPTIONS] [SESSION_ID] [PROMPT]).
  const promptIdx = args.indexOf('{{prompt}}');
  if (promptIdx >= 0) args.splice(promptIdx, 0, sessionId);
  else args.push(sessionId);
  return args;
}

/**
 * v864 — Erkennt ob ein non-zero Agent-Exit ein TRANSIENTER LLM-API-Fehler war
 * (Provider überlastet, Rate-Limit, Netzwerk) statt eines echten Crashes.
 *
 * Hintergrund (Vorfall 494ae636, 11.06.): Phase 4 starb nach 38s an einem
 * Anthropic `529 Overloaded` — der claude CLI retried intern, gibt dann auf
 * und exitet 1. Der Runner behandelte das wie einen Auth-/Binary-Fehler und
 * brach die ganze Session ab; 3 grüne Phasen + 5485 grüne Tests blieben
 * ungepusht liegen. Alfreds EIGENE LLM-Calls haben Retry/Fallback
 * (anthropic.ts maxRetries=5, model-router isRetryableError) — der externe
 * CLI-Agent-Pfad hatte bis v864 keinerlei Klassifikation.
 *
 * Geprüft wird nur das ENDE von stdout+stderr (je 2000 Zeichen): beim
 * stream-json-Format ist stdout der extrahierte finale Assistant-Text, dort
 * landet der Fehler („API Error: 529 …"). Bewusst NICHT matchen: 401/403
 * (Auth — permanent), "command not found" (Binary — permanent).
 *
 * v905 — codex „Selected model is at capacity. Please try a different model."
 * wird bewusst NICHT als transient behandelt (v904 zurückgenommen): das ist ein
 * Modell-wechseln-Signal, kein warten-und-wiederholen. Ein Retry träfe dasselbe
 * dauerhaft volle Modell erneut → 2 zusätzliche, ebenso scheiternde Läufe +
 * 90s/180s Wartezeit ohne Erfolgschance. Echte transiente Überlast (Anthropic
 * 529/overloaded, 429, Netz) bleibt abgedeckt.
 */
export function isTransientApiFailure(result: Pick<AgentExecutionResult, 'stdout' | 'stderr' | 'exitCode'>): boolean {
  if (result.exitCode === 0) return false;
  const tail = `${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`;
  return (
    /API Error:?\s*5\d\d/i.test(tail) ||
    /API Error:?\s*429/i.test(tail) ||
    /overloaded_error|"overloaded"|\bOverloaded\b/i.test(tail) ||
    /rate.?limit(ed|s)?\b|too many requests/i.test(tail) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error/i.test(tail)
  );
}

/**
 * v1047 — Kumulierte CPU-Ticks (utime+stime) des Prozesses `rootPid` und ALLER
 * Nachfahren, gelesen aus /proc (Linux). Grundlage des Prozessbaum-CPU-
 * Heartbeats: still laufende Builds/Tests produzieren keinen stdout, aber CPU.
 * `procDir` ist nur für Tests injizierbar.
 * @returns Ticks-Summe oder undefined, wenn /proc bzw. der Prozess nicht lesbar
 *          ist (z.B. Windows, Prozess bereits beendet).
 */
export function sumProcessTreeCpuTicks(rootPid: number, procDir = '/proc'): number | undefined {
  try {
    const entries = fs.readdirSync(procDir).filter(n => /^\d+$/.test(n));
    const byPpid = new Map<number, number[]>();
    const cpu = new Map<number, number>();
    for (const name of entries) {
      let stat: string;
      try {
        stat = fs.readFileSync(path.join(procDir, name, 'stat'), 'utf8');
      } catch {
        continue; // Prozess zwischen readdir und read verschwunden
      }
      // Format: `pid (comm) state ppid …` — comm kann Leerzeichen/Klammern
      // enthalten, deshalb hinter der LETZTEN schließenden Klammer parsen.
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const rest = stat.slice(close + 2).split(' ');
      const ppid = Number(rest[1]);
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      if (!Number.isFinite(ppid)) continue;
      const pid = Number(name);
      const list = byPpid.get(ppid) ?? [];
      list.push(pid);
      byPpid.set(ppid, list);
      cpu.set(pid, (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0));
    }
    if (!cpu.has(rootPid)) return undefined;
    let sum = 0;
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      sum += cpu.get(pid) ?? 0;
      for (const c of byPpid.get(pid) ?? []) queue.push(c);
    }
    return sum;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `${VAR_NAME}` placeholders in env values against process.env.
 */
function resolveEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    });
  }
  return resolved;
}

/**
 * Replace `{{prompt}}` placeholders in args template.
 */
function buildArgs(template: string[], prompt: string): string[] {
  return template.map((arg) => arg.replace(/\{\{prompt\}\}/g, prompt));
}

/**
 * Truncate output keeping the tail (most recent output is most useful).
 */
function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return '[...truncated...]\n' + text.slice(-MAX_OUTPUT_CHARS);
}

/**
 * Snapshot file mtimes in a directory, skipping ignored dirs.
 * v844 — accepts multiple roots so the heartbeat can also watch agent-side
 * session paths (claude `~/.claude/projects/...`) where the agent writes
 * even when it stays silent on stdout.
 */
function snapshotMtimes(dirOrDirs: string | string[]): Map<string, number> {
  const roots = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const result = new Map<string, number>();

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          result.set(fullPath, stat.mtimeMs);
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  for (const root of roots) {
    if (root && fs.existsSync(root)) walk(root);
  }
  return result;
}

/**
 * Detect files that were created or modified between two snapshots.
 */
function detectModifiedFiles(
  before: Map<string, number>,
  after: Map<string, number>,
  baseDir: string,
): string[] {
  const modified: string[] = [];
  for (const [filePath, mtime] of after) {
    const prevMtime = before.get(filePath);
    if (prevMtime === undefined || mtime > prevMtime) {
      modified.push(path.relative(baseDir, filePath));
    }
  }
  return modified.sort();
}

/**
 * v850 — Optional MCP-Token-Provider. Wenn gesetzt: jeder agent-Spawn
 * bekommt ein frisches One-Time-Token via env-var ALFRED_MCP_TOKEN damit
 * der CLI-Agent über MCP-stdio auf Alfreds Knowledge-Stores zugreifen kann.
 *
 * Alfred setzt den Provider in alfred.ts beim Start wenn `codeAgents.mcp.enabled`.
 */
let mcpTokenProvider: ((opts: { agentName: string; cwd?: string }) => string | null) | null = null;

export function setMcpTokenProvider(p: ((opts: { agentName: string; cwd?: string }) => string | null) | null): void {
  mcpTokenProvider = p;
}

export async function executeAgent(
  agentDefRaw: CodeAgentDefinitionConfig,
  prompt: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    onProgress?: (status: string) => void;
    /** v608 F4 — callback fired on every stdout/stderr chunk so the SkillSandbox
     *  ActivityTracker stays alive while the subprocess produces output.
     *  Without this, long-running claude-code runs get killed by the 120s
     *  inactivity watchdog even though they're working. */
    onActivity?: () => void;
    /** v650 — AbortSignal vom Runner. Wenn signal aborted: child-process tree
     *  wird sauber gekillt (SIGTERM, dann SIGKILL nach 3s). */
    signal?: AbortSignal;
    /** v651 — taskId/sessionId für Live-Output-Buffer (siehe project-agent-skill
     *  outputBuffers). Wenn gesetzt: jede stdout/stderr-Zeile wird in den
     *  Ring-Buffer geschoben damit SSE-Subscriber live mitlesen können. */
    taskId?: string;
    /** v906 — codex: bestehende Session per `exec resume <id>` fortsetzen statt
     *  neu starten (nur beim at-capacity-Retry gesetzt). */
    resumeSessionId?: string;
  } = {},
): Promise<AgentExecutionResult> {
  // v844 — auto-upgrade legacy agent defs to stream-mode (claude/codex/vibe).
  // No-op if user explicitly set outputFormat in config.
  let agentDef = upgradeAgentDef(agentDefRaw);
  // v906 — Resume-Form NUR wenn explizit angefordert (at-capacity-Retry) und codex.
  // Der normale Lauf bleibt unverändert (resumeSessionId ist dann undefined).
  if (options.resumeSessionId && agentDef.outputFormat === 'codex-jsonl') {
    agentDef = { ...agentDef, argsTemplate: toCodexResumeArgsTemplate(agentDef.argsTemplate, options.resumeSessionId) };
  }
  const cwd = options.cwd ?? agentDef.cwd ?? process.cwd();

  // v862 — Hard-Guard (letzte Verteidigung): Code-Agents dürfen NIE direkt in
  // Alfreds eigener Installation arbeiten. Der reguläre Pfad ist der Self-
  // Healing-Redirect im project_agent (Repo-Checkout + MR/PR). Dieser Guard
  // fängt Umgehungen (z.B. delegate→code_agent.run mit Installations-cwd —
  // exakt der Vorfall vom 10.06.2026, claude-code patchte bundle/index.js).
  {
    const { isSelfInstallPath } = await import('./self-healing.js');
    if (isSelfInstallPath(cwd)) {
      return {
        stdout: '',
        stderr: `cwd "${cwd}" ist Alfreds eigene Installation — Code-Agents dürfen dort nicht arbeiten ` +
          `(Patches sind flüchtig, unreviewt und werden beim nächsten npm install überschrieben). ` +
          `Nutze stattdessen project_agent mit demselben cwd: der Self-Healing-Redirect arbeitet ` +
          `automatisch im Repo-Checkout und erstellt einen MR/PR zur Review.`,
        exitCode: 126,
        durationMs: 0,
        modifiedFiles: [],
      };
    }
  }

  // v608 F5 — preflight: catch missing binary BEFORE spawning, so we don't
  // burn the 10-minute initial-timeout on a process that silently dies.
  const preflightError = preflightAgent(agentDef);
  if (preflightError) {
    return {
      stdout: '',
      stderr: preflightError,
      exitCode: 127,
      durationMs: 0,
      modifiedFiles: [],
    };
  }

  // Auto-create working directory if it doesn't exist
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }
  // If command runs as a different user (sudo -u <user>), ensure cwd is owned by that user
  // Safety: only chown if cwd is not a system directory (/root, /home, /, /etc etc.)
  if (agentDef.command === 'sudo' && agentDef.argsTemplate[0] === '-u' && agentDef.argsTemplate[1]) {
    const runAsUser = agentDef.argsTemplate[1];
    const cwdDepth = cwd.split('/').filter(Boolean).length;
    if (cwdDepth >= 2) { // Only chown paths like /root/project, /home/user/project — never /root or /home
      try { execFileSync('chown', ['-R', `${runAsUser}:${runAsUser}`, cwd], { timeout: 5000 }); } catch { /* best effort */ }
    }
  }
  const rawTimeout = options.timeoutMs ?? agentDef.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

  const args = injectVibeWorkspaceFlags(buildArgs(agentDef.argsTemplate, prompt), agentDef.outputFormat, cwd);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(agentDef.env ? resolveEnv(agentDef.env) : {}),
  };
  // v850 — Per-spawn MCP-Token: wenn provider verdrahtet ist, ein frisches
  // Token issuen und in env passieren. CLI-Agent gibt es transparent an
  // sein MCP-stdio-process weiter (via spawn-env-Vererbung). Alfred-MCP-
  // Server validiert das Token vor jedem tool-call.
  if (mcpTokenProvider) {
    try {
      const token = mcpTokenProvider({ agentName: agentDef.name, cwd });
      if (token) env.ALFRED_MCP_TOKEN = token;
    } catch { /* token issue non-critical */ }
  }

  // Use shell on Windows for .cmd/.bat wrappers
  const isWindows = process.platform === 'win32';

  // v844 — Heartbeat-Roots: cwd + optional agent-spezifische Session-Pfade
  // (~/.claude/projects/..., ~/.codex/sessions/..., etc.). Erkennt aktivität
  // wenn der Agent dort schreibt obwohl im cwd nichts passiert (typisch für
  // Audit/Read-only Phasen).
  const heartbeatRoots: string[] = [cwd];
  if (Array.isArray(agentDef.additionalHeartbeatPaths)) {
    for (const p of agentDef.additionalHeartbeatPaths) {
      if (typeof p === 'string' && p.length > 0) heartbeatRoots.push(expandHome(p));
    }
  }

  // v844 — Output-Parser: bei stream-formats werden JSON-events in human-
  // readable progress-zeilen umgewandelt und der finale text-content separat
  // akkumuliert (wird als stdout returned). Default 'text' = passthrough.
  const outputFormat: AgentOutputFormat = (agentDef.outputFormat as AgentOutputFormat) ?? 'text';
  const parserState = createParserState(outputFormat);

  // Snapshot before execution
  const beforeSnapshot = snapshotMtimes(heartbeatRoots);
  const startTime = Date.now();

  return new Promise<AgentExecutionResult>((resolve) => {
    const child = spawn(agentDef.command, args, {
      cwd,
      env,
      shell: isWindows,
      stdio: agentDef.promptVia === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // v650 — detached so we can SIGTERM the whole process group (kill -PGID)
      detached: !isWindows,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let killReason: 'inactivity' | 'absolute' | 'aborted' | undefined;

    // v650/v810 — Stop-Cleanup: wenn Caller via AbortSignal aborted, kompletten
    // Agent-Baum killen. v810: killAgentTree erfasst auch reparentete Sub-Sessions
    // (claude-code spawnt Bash-Tools in eigenen Sessions → Group-Kill verfehlt sie
    // → Waisen halten den Worktree offen). Kill via cwd-Match als Backstop.
    const onAbort = () => {
      killed = true;
      killReason = 'aborted';
      killAgentTree(child.pid, cwd, { detached: !isWindows });
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // v619 D0 — Sliding inactivity timer statt absolutem Timer.
    // Vorher (Bug): const timer = setTimeout(kill, timeoutMs) — egal wie aktiv
    // der Subprocess war, nach timeoutMs (5min default) wurde SIGTERM gesendet.
    // Phasen die länger als 5min dauern aber kontinuierlich Output produzieren
    // (typisch für codex bei Multi-Datei-Edits) wurden mitten in der Arbeit gekillt.
    //
    // Neu: bei jedem stdout/stderr-Chunk wird der Timer zurückgesetzt. Der Agent
    // darf beliebig lange laufen, solange er innerhalb des timeoutMs-Fensters
    // Output produziert. Zusätzlich absolute Sicherung (ABSOLUTE_CAP_MS) damit
    // nichts ewig läuft (z.B. forever-loop in eskaliertem child-process).
    // v624 B — Mid-Progress-Warning: bei timeoutMs/2 Stille ein einmaliger Hinweis
    // an onProgress (geht via project-agent-runner an Telegram). Lässt den User
    // sehen "Agent ist still aber lebt noch — kill in N min". Wird beim nächsten
    // Chunk zurückgesetzt damit man bei zwischenzeitlicher Aktivität nicht
    // gespamt wird. Pro inactivity-window genau eine Warning.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let halfwayTimer: ReturnType<typeof setTimeout> | undefined;
    let resetSource: 'stdout' | 'stderr' | 'fs-heartbeat' | 'proc-heartbeat' | 'initial' = 'initial';
    const resetInactivity = (source: typeof resetSource = 'initial') => {
      resetSource = source;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      halfwayTimer = setTimeout(() => {
        const halfSec = Math.round(timeoutMs / 2 / 1000);
        const remainingMin = Math.round((timeoutMs - timeoutMs / 2) / 60_000);
        options.onProgress?.(`⏳ Stille seit ${halfSec}s — wird in ~${remainingMin}min gekillt sofern keine Aktivität`);
      }, timeoutMs / 2);
      inactivityTimer = setTimeout(() => {
        killed = true;
        killReason = 'inactivity';
        // v810 — kompletter Baum statt nur child.kill (erfasst Sub-Sessions)
        killAgentTree(child.pid, cwd, { detached: !isWindows, graceMs: 5_000 });
      }, timeoutMs);
    };
    resetInactivity();

    // v635 — File-mtime-Heartbeat alle 30s. Wenn der Agent neue Dateien schreibt
    // (typisch für Multi-File-Edits / Migrationen / Code-Generation) aber stdout/stderr
    // gepuffert oder still ist, bleibt der Subprocess als aktiv erkannt und der
    // Inactivity-Timer wird zurückgesetzt. Verhindert das v625-Symptom: Agent
    // schreibt 77 Dateien aber wird mid-phase wegen stdout-Stille gekillt.
    let lastHeartbeatSnapshot = beforeSnapshot;
    const heartbeatInterval = setInterval(() => {
      try {
        const nowSnapshot = snapshotMtimes(heartbeatRoots);
        // Compare against last heartbeat snapshot — count files that changed since
        let changed = 0;
        for (const [fp, mtime] of nowSnapshot) {
          const prev = lastHeartbeatSnapshot.get(fp);
          if (prev === undefined || mtime > prev) { changed++; if (changed >= 1) break; }
        }
        if (changed > 0) {
          lastHeartbeatSnapshot = nowSnapshot;
          resetInactivity('fs-heartbeat');
        }
      } catch { /* fs scan errors are non-fatal */ }
    }, 30_000);
    (heartbeatInterval as { unref?: () => void }).unref?.();

    // v1047 — Prozessbaum-CPU-Heartbeat (der STRUKTURELLE Fix für die
    // v844/v1046-Fehlerklasse): still laufende Builds/Tests (npm, next build,
    // vitest) schreiben weder stdout noch src-Dateien — aber sie verbrennen
    // CPU. Steigt die kumulierte utime+stime des gesamten Prozessbaums
    // zwischen zwei Heartbeats messbar, gilt der Agent als aktiv — die
    // Phase-Keyword-Wortliste (project-agent-runner) ist damit nur noch
    // Feintuning, kein Single Point of Failure mehr. Ein wirklich hängender
    // Agent (wartet auf Netz/Auth/stdin) verbraucht ~0 CPU und wird weiterhin
    // vom Inactivity-Timeout eingesammelt. Linux-only (/proc); auf anderen
    // Plattformen still inaktiv.
    let lastTreeCpuTicks = child.pid !== undefined ? sumProcessTreeCpuTicks(child.pid) : undefined;
    const procHeartbeatInterval = setInterval(() => {
      if (child.pid === undefined) return;
      const ticks = sumProcessTreeCpuTicks(child.pid);
      if (ticks === undefined) return; // Prozess weg oder kein /proc
      // ≥25 Ticks (~0,25s CPU bei 100Hz) in 30s = echte Arbeit; exitende
      // Kinder lassen die Summe sinken — dann nur die Basis nachziehen.
      if (lastTreeCpuTicks !== undefined && ticks > lastTreeCpuTicks + 25) {
        resetInactivity('proc-heartbeat');
      }
      if (lastTreeCpuTicks === undefined || ticks !== lastTreeCpuTicks) lastTreeCpuTicks = ticks;
    }, 30_000);
    (procHeartbeatInterval as { unref?: () => void }).unref?.();

    const absoluteTimer = setTimeout(() => {
      killed = true;
      killReason = 'absolute';
      // v810 — kompletter Baum statt nur child.kill (erfasst Sub-Sessions)
      killAgentTree(child.pid, cwd, { detached: !isWindows, graceMs: 5_000 });
    }, ABSOLUTE_CAP_MS);

    // v844 — Bei stream-formats akkumulieren wir den finalen text-content
    // separat, damit codeResult.stdout für Caller (project-agent-runner,
    // code-agent-skill) genauso aussieht wie bei text-Mode (human-readable).
    // rawStdout bleibt für Debug verfügbar (wird nicht returned aber im
    // stderr-Fall via fallback genutzt).
    let extractedText = '';
    let stdoutBuffer = ''; // partial line buffer (chunks können mid-line geteilt sein)
    const isStreaming = outputFormat !== 'text';
    // v866 — Usage + Modell aus den Stream-Events akkumulieren (mehrere
    // result-Events möglich, z.B. bei Sub-Sessions → summieren).
    let usageAcc: ParsedUsage | undefined;
    let modelSeen: string | undefined;
    let sessionSeen: string | undefined; // v906 — codex thread.started thread_id (für Resume)
    const accumulate = (parsed: { usage?: ParsedUsage; model?: string; sessionId?: string }): void => {
      if (parsed.model) modelSeen = parsed.model;
      if (parsed.sessionId) sessionSeen = parsed.sessionId;
      if (parsed.usage) {
        if (!usageAcc) {
          usageAcc = { ...parsed.usage };
        } else {
          usageAcc.inputTokens += parsed.usage.inputTokens;
          usageAcc.outputTokens += parsed.usage.outputTokens;
          usageAcc.cacheReadTokens += parsed.usage.cacheReadTokens;
          if (parsed.usage.costUsd !== undefined) {
            usageAcc.costUsd = (usageAcc.costUsd ?? 0) + parsed.usage.costUsd;
          }
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity('stdout'); // v619 D0 — extend inactivity timer on every chunk

      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? ''; // keep incomplete last line for next chunk
      for (const rawLine of lines) {
        const trimmed = rawLine.replace(/\r$/, '');
        if (trimmed.length === 0) continue;
        if (isStreaming) {
          const parsed = parseLine(parserState, trimmed);
          accumulate(parsed); // v866 — usage/model einsammeln
          for (const p of parsed.progress) {
            if (options.taskId) {
              try { appendOutputLine(options.taskId, 'stdout', p); } catch { /* */ }
            }
            options.onProgress?.(`[${agentDef.name}] ${p}`);
          }
          for (const f of parsed.finalTextChunks) extractedText += (extractedText ? '\n' : '') + f;
        } else {
          // text-mode: passthrough wie bisher
          if (options.taskId) {
            try { appendOutputLine(options.taskId, 'stdout', trimmed); } catch { /* */ }
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onActivity?.(); // v608 F4 — keep sandbox watchdog alive
      resetInactivity('stderr'); // v619 D0 — extend inactivity timer on every chunk
      // v651 — Live-Output-Buffer pro Zeile
      if (options.taskId) {
        for (const line of text.split('\n')) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed.length === 0) continue;
          try { appendOutputLine(options.taskId, 'stderr', trimmed); } catch { /* best-effort */ }
        }
      }
      // Forward stderr lines as progress updates
      if (options.onProgress) {
        const lastLine = text.trim().split('\n').pop();
        if (lastLine) {
          options.onProgress(`[${agentDef.name}] ${lastLine}`);
        }
      }
    });

    // Send prompt via stdin if configured
    if (agentDef.promptVia === 'stdin' && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      clearTimeout(absoluteTimer);
      clearInterval(heartbeatInterval);
      clearInterval(procHeartbeatInterval);
      // v844 — flush trailing partial line through parser
      if (stdoutBuffer.length > 0) {
        const trimmed = stdoutBuffer.replace(/\r$/, '');
        if (trimmed.length > 0 && isStreaming) {
          const parsed = parseLine(parserState, trimmed);
          accumulate(parsed); // v866 — usage/model auch aus der trailing line
          for (const p of parsed.progress) {
            if (options.taskId) { try { appendOutputLine(options.taskId, 'stdout', p); } catch { /* */ } }
          }
          for (const f of parsed.finalTextChunks) extractedText += (extractedText ? '\n' : '') + f;
        } else if (trimmed.length > 0 && options.taskId) {
          try { appendOutputLine(options.taskId, 'stdout', trimmed); } catch { /* */ }
        }
        stdoutBuffer = '';
      }
      const durationMs = Date.now() - startTime;
      // v844 — afterSnapshot nur über cwd (für modifiedFiles), nicht über
      // additionalHeartbeatPaths — der Caller will Files-im-Projekt zurück.
      const afterSnapshot = snapshotMtimes(cwd);
      const modifiedFiles = detectModifiedFiles(beforeSnapshot, afterSnapshot, cwd);

      // v619 D0 — annotate stderr with kill-reason so downstream diagnostics
      // (project-agent-runner) can distinguish inactivity-kill from absolute-cap-kill
      // v635 — include last-activity-source so we can see whether the agent
      // was silent both in stdout AND in file-writes (truly idle) vs only stdout
      let finalStderr = stderr;
      if (killReason === 'inactivity') {
        finalStderr = stderr + `\n[agent-executor] killed: no output for ${Math.round(timeoutMs / 1000)}s (inactivity timeout, last-activity=${resetSource})`;
      } else if (killReason === 'absolute') {
        finalStderr = stderr + `\n[agent-executor] killed: ${Math.round(ABSOLUTE_CAP_MS / 60_000)}min absolute cap reached (was active but ran too long)`;
      } else if (killReason === 'aborted') {
        finalStderr = stderr + `\n[agent-executor] killed: caller aborted (Stop-Signal)`;
      }

      // v844 — bei stream-mode geben wir den extrahierten human-readable text
      // zurück (statt raw JSON-lines). Fallback auf raw stdout falls der parser
      // nichts extrahiert hat (z.B. Agent crashte vor erstem assistant_message).
      const stdoutForCaller = isStreaming
        ? (extractedText.length > 0 ? extractedText : stdout)
        : stdout;

      // v895 — vibe gibt usage/model nicht im Stream aus → aus der Session-meta.json
      // nachtragen (nur wenn der Parser nichts hatte; claude/codex bleiben unberührt).
      let finalUsage = usageAcc;
      let finalModel = modelSeen;
      if (outputFormat === 'vibe-streaming' && (!finalModel || !finalUsage)) {
        const m = readVibeSessionStats(agentDef, startTime);
        if (m) {
          if (!finalModel && m.model) finalModel = m.model;
          if (!finalUsage && m.usage) finalUsage = m.usage;
        }
      }
      // v903 — codex liefert das Modell nicht im --json-Stream → aus der Rollout-
      // Session nachtragen (Usage kommt aus turn.completed, bleibt unberührt).
      if (outputFormat === 'codex-jsonl' && !finalModel) {
        const m = readCodexSessionModel(agentDef, startTime);
        if (m) finalModel = m;
      }

      resolve({
        stdout: truncateOutput(stdoutForCaller),
        stderr: truncateOutput(finalStderr),
        exitCode: killed ? 124 : (code ?? 1),
        durationMs,
        modifiedFiles,
        usage: finalUsage,   // v866 + v895 (vibe via meta.json)
        model: finalModel,   // v866 + v895
        sessionId: sessionSeen, // v906 — codex thread.started thread_id (für Resume)
      });
    });

    child.on('error', (err) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (halfwayTimer) clearTimeout(halfwayTimer);
      clearTimeout(absoluteTimer);
      clearInterval(heartbeatInterval);
      clearInterval(procHeartbeatInterval);
      const durationMs = Date.now() - startTime;
      resolve({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr + '\n' + err.message),
        exitCode: 127,
        durationMs,
        modifiedFiles: [],
      });
    });
  });
}
