import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * v775 — Auflösen der UID zu einem Username via `id -nu`. Wird gebraucht
 * damit `git worktree add` direkt als der projectCwd-Owner laufen kann,
 * statt als root und dann mit chown nachzubessern.
 * Returnt null wenn UID nicht zu einem Username aufgelöst werden kann
 * (z.B. UID ist im Container nicht bekannt).
 */
async function uidToUsername(uid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('id', ['-nu', String(uid)], { timeout: 3_000 });
    const name = stdout.trim();
    return name || null;
  } catch {
    return null;
  }
}

/** Prüft ob ein Pfad ein gültiges git-Repo enthält. */
export async function validateGitRepo(cwd: string): Promise<{ ok: boolean; reason?: string }> {
  if (!existsSync(cwd)) return { ok: false, reason: `path does not exist: ${cwd}` };
  try {
    const top = await git(['rev-parse', '--show-toplevel'], cwd, 5_000);
    if (!top) return { ok: false, reason: 'git rev-parse returned empty' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `not a git repo: ${(err as Error).message.slice(0, 100)}` };
  }
}

export async function getCurrentCommitSha(cwd: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], cwd, 5_000);
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 5_000);
}

export interface CreateWorktreeInput {
  projectCwd: string;       // Main-Repo-Checkout
  branchName: string;       // z.B. agent-{sid8}-{slug}
  worktreePath: string;     // Ziel-Pfad — sollte unter sandboxConfig.worktreeBasePath liegen
  fromBranch?: string;      // optional: Branch von dem aus erstellt wird, default HEAD
  logger: Logger;
}

export interface CreateWorktreeResult {
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
}

/**
 * v697 — Erstellt einen git-worktree auf neuem Branch. Atomar: bei Fehler wird
 * der Worktree-Pfad NICHT angelegt (oder bereinigt).
 *
 * Wichtig: das main-Repo (projectCwd) wird NICHT verändert — Worktrees sind
 * git-native isolierte Checkouts mit eigener .git-Datei (verweist auf main .git).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const validate = await validateGitRepo(input.projectCwd);
  if (!validate.ok) throw new Error(`Worktree base invalid: ${validate.reason}`);

  // Sicherheit: branchName + worktreePath strict prüfen
  if (!/^[a-zA-Z0-9._/-]+$/.test(input.branchName)) {
    throw new Error(`Invalid branch name (chars not allowed): ${input.branchName}`);
  }
  if (existsSync(input.worktreePath)) {
    throw new Error(`Worktree path already exists: ${input.worktreePath}`);
  }

  // Parent-Dir anlegen falls nötig
  const parent = path.dirname(input.worktreePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const baseCommit = input.fromBranch
    ? await git(['rev-parse', input.fromBranch], input.projectCwd, 5_000)
    : await getCurrentCommitSha(input.projectCwd);

  // Prüfen ob Branch schon existiert — wenn ja, einen Suffix anhängen
  let finalBranch = input.branchName;
  try {
    await git(['rev-parse', '--verify', `refs/heads/${input.branchName}`], input.projectCwd, 5_000);
    // Branch existiert → suffix anhängen
    finalBranch = `${input.branchName}-${Date.now().toString(36)}`;
    input.logger.warn({ original: input.branchName, used: finalBranch }, 'Branch existed, using suffixed name');
  } catch { /* doesn't exist → ok */ }

  // v775 — `git worktree add` AS projectCwd-Owner ausführen. Hintergrund:
  // v774 hatte nur `.git/worktrees/<name>/` gechownt. Aber `git worktree add -b NEW_BRANCH`
  // erstellt drei root-owned Dinge in der MAIN .git (wenn alfred als root läuft):
  //   1. .git/worktrees/<name>/  (v774 hat das gefixt)
  //   2. .git/refs/heads/<branch>  (v774 hatte das NICHT gefixt)
  //   3. .git/logs/refs/heads/<branch>  (v774 hatte das NICHT gefixt)
  // → spätere `sudo -u <user> git commit` failt mit "Permission denied" auf den ref-log.
  // Fix: gleich von Anfang an als der projectCwd-Owner ausführen.
  let workTreeAddRunAsUser: string | null = null;
  try {
    const projStat = statSync(input.projectCwd);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (projStat.uid !== currentUid && currentUid === 0) {
      // Wir sind root, projectCwd gehört anderem User → als der laufen
      workTreeAddRunAsUser = await uidToUsername(projStat.uid);
      if (!workTreeAddRunAsUser) {
        input.logger.warn({ uid: projStat.uid }, 'v775 uidToUsername failed — fallback auf root + chown');
      }
    }
  } catch (err) {
    input.logger.warn({ err }, 'v775 ownership-detection failed — fallback auf root + chown');
  }

  try {
    if (workTreeAddRunAsUser) {
      // Als projectCwd-Owner: `sudo -u <user> git worktree add ...`
      await execFileAsync('sudo', ['-u', workTreeAddRunAsUser, 'git', 'worktree', 'add', '-b', finalBranch, input.worktreePath, baseCommit], {
        cwd: input.projectCwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      input.logger.info({ runAsUser: workTreeAddRunAsUser, worktreePath: input.worktreePath }, 'v775 worktree created as projectCwd-owner');
    } else {
      // Fallback: als root (v774 chown-Pfad räumt nachher auf)
      await git(['worktree', 'add', '-b', finalBranch, input.worktreePath, baseCommit], input.projectCwd, 120_000);
    }
  } catch (err) {
    // Cleanup attempt bei partial create
    if (existsSync(input.worktreePath)) {
      try { rmSync(input.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    throw new Error(`git worktree add failed: ${(err as Error).message.slice(0, 200)}`);
  }

  // v707 — Worktree-Permissions: alfred läuft typisch als root, der Container-User ist
  // node (UID 1000). Damit `npm install` im Container ins worktree-bind-mount schreiben
  // kann, brauchen wir group-write (das parent-Dir hat schon setgid auf madh-Gruppe).
  // chmod -R g+rwX setzt group-write rekursiv ohne execute-bits auf Files zu setzen.
  try {
    await execFileAsync('chmod', ['-R', 'g+rwX', input.worktreePath], { timeout: 30_000 });
  } catch (err) {
    input.logger.warn({ err, worktreePath: input.worktreePath }, 'chmod g+rwX on worktree failed — container may have permission issues');
  }

  // v774 — Worktree-Metadata-Permissions: `git worktree add` schreibt Metadaten nach
  // `<projectCwd>/.git/worktrees/<name>/` als der Prozess-User (root). Wenn der Code-Agent
  // später als anderer User läuft (z.B. `sudo -u madh git commit`), kann er `index.lock`
  // dort nicht schreiben → fatal: Permission denied auf jedem git-Schreibvorgang.
  // Fix: chown auf den Owner von projectCwd, plus group-write.
  try {
    const worktreeName = path.basename(input.worktreePath);
    const worktreeMetaDir = path.join(input.projectCwd, '.git', 'worktrees', worktreeName);
    if (existsSync(worktreeMetaDir)) {
      const projStat = statSync(input.projectCwd);
      await execFileAsync('chown', ['-R', `${projStat.uid}:${projStat.gid}`, worktreeMetaDir], { timeout: 10_000 });
      await execFileAsync('chmod', ['-R', 'g+rwX', worktreeMetaDir], { timeout: 10_000 });
      input.logger.info({ worktreeMetaDir, uid: projStat.uid, gid: projStat.gid }, 'v774 worktree-metadata chowned to projectCwd-owner');
    }
  } catch (err) {
    input.logger.warn({ err, worktreePath: input.worktreePath }, 'v774 chown on .git/worktrees/<name> failed — git ops may fail with index.lock permission denied');
  }

  input.logger.info({ worktreePath: input.worktreePath, branch: finalBranch, baseCommit }, 'Worktree created');
  return { worktreePath: input.worktreePath, branchName: finalBranch, baseCommitSha: baseCommit };
}

export interface DestroyWorktreeInput {
  projectCwd: string;
  worktreePath: string;
  branchName: string;
  /** auch den Branch löschen (für discard). False für merge (Branch bleibt für Push). */
  deleteBranch: boolean;
  /** force entfernt auch bei uncommitted changes. */
  force?: boolean;
  logger: Logger;
}

/** v697 — Entfernt Worktree + optional den Branch. Idempotent (kein Fehler wenn schon weg). */
export async function destroyWorktree(input: DestroyWorktreeInput): Promise<void> {
  // git worktree remove zuerst (entfernt auch den Pfad)
  if (existsSync(input.worktreePath)) {
    try {
      await git(['worktree', 'remove', input.worktreePath, ...(input.force ? ['--force'] : [])], input.projectCwd, 30_000);
    } catch (err) {
      input.logger.warn({ err, worktreePath: input.worktreePath }, 'git worktree remove failed, fallback to manual rmSync');
      try { rmSync(input.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  // git worktree prune um zombie-records zu entfernen
  try { await git(['worktree', 'prune'], input.projectCwd, 10_000); } catch { /* ignore */ }

  if (input.deleteBranch) {
    try {
      await git(['branch', '-D', input.branchName], input.projectCwd, 10_000);
    } catch (err) {
      // Branch evtl. nicht da, oder gepusht und gemerged
      input.logger.debug({ err, branchName: input.branchName }, 'git branch -D failed (may be already gone)');
    }
  }
  input.logger.info({ worktreePath: input.worktreePath, branch: input.branchName, deletedBranch: input.deleteBranch }, 'Worktree destroyed');
}

/** Liste aller worktrees (für Debugging/Cleanup-Worker). */
export async function listWorktrees(projectCwd: string): Promise<Array<{ path: string; branch: string; commit: string }>> {
  try {
    const out = await git(['worktree', 'list', '--porcelain'], projectCwd, 10_000);
    const result: Array<{ path: string; branch: string; commit: string }> = [];
    let current: Partial<{ path: string; branch: string; commit: string }> = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) current.path = line.slice(9);
      else if (line.startsWith('HEAD ')) current.commit = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === '') {
        if (current.path && current.commit) result.push({ path: current.path, branch: current.branch ?? '', commit: current.commit });
        current = {};
      }
    }
    if (current.path && current.commit) result.push({ path: current.path, branch: current.branch ?? '', commit: current.commit });
    return result;
  } catch {
    return [];
  }
}
