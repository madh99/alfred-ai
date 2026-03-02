import { execFile } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GitCmdOptions {
  cwd: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  dirty: boolean;
}

export interface GitCommitResult {
  sha: string;
  message: string;
  filesChanged: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string[], opts: GitCmdOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`git ${args[0]} failed: ${msg}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function gitStatus(opts: GitCmdOptions): Promise<GitStatus> {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
    const status = await git(['status', '--porcelain'], opts);
    return { isRepo: true, branch, dirty: status.length > 0 };
  } catch {
    return { isRepo: false, branch: '', dirty: false };
  }
}

export async function gitCreateBranch(name: string, opts: GitCmdOptions): Promise<void> {
  await git(['checkout', '-b', name], opts);
}

export async function gitStageAll(opts: GitCmdOptions): Promise<void> {
  await git(['add', '-A'], opts);
}

export async function gitCommit(message: string, opts: GitCmdOptions): Promise<GitCommitResult> {
  await git(['commit', '-m', message], opts);
  const sha = await git(['rev-parse', '--short', 'HEAD'], opts);
  const diffStat = await git(['diff', '--stat', 'HEAD~1', 'HEAD'], opts);
  const filesChanged = diffStat.split('\n').length - 1; // last line is summary
  return { sha, message, filesChanged: Math.max(filesChanged, 0) };
}

export async function gitPush(remote: string, branch: string, opts: GitCmdOptions): Promise<void> {
  await git(['push', '-u', remote, branch], opts);
}

export function slugifyBranch(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `alfred/${slug}`;
}

// ── Remote-Info ──────────────────────────────────────────────────────────

export interface RemoteInfo {
  owner: string;
  repo: string;
  baseUrl: string;
}

/**
 * Read the URL of a named git remote (e.g. "origin").
 * Returns `null` when the remote does not exist.
 */
export async function gitGetRemoteUrl(
  remote: string,
  opts: GitCmdOptions,
): Promise<string | null> {
  try {
    return await git(['remote', 'get-url', remote], opts);
  } catch {
    return null;
  }
}

/**
 * Parse an HTTPS or SSH remote URL into owner, repo and baseUrl.
 *
 * Supported formats:
 *  - https://github.com/owner/repo.git
 *  - git@github.com:owner/repo.git
 *  - http://git.lokalkraft.at/madh/alfred-ai.git
 *  - All variants with or without .git suffix
 */
export function parseRemoteUrl(url: string): RemoteInfo | null {
  // SSH  — git@host:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const ownerRepo = sshMatch[2];
    const parts = ownerRepo.split('/');
    if (parts.length < 2) return null;
    const repo = parts.pop()!;
    const owner = parts.join('/');
    return { owner, repo, baseUrl: `https://${host}` };
  }

  // HTTPS / HTTP — https://host/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const ownerRepo = httpsMatch[2];
    const parts = ownerRepo.split('/');
    if (parts.length < 2) return null;
    const repo = parts.pop()!;
    const owner = parts.join('/');
    return { owner, repo, baseUrl: `https://${host}` };
  }

  return null;
}

/** Initialise a new git repository. */
export async function gitInitRepo(opts: GitCmdOptions): Promise<void> {
  await git(['init'], opts);
}

/** Add a named remote. */
export async function gitAddRemote(
  name: string,
  url: string,
  opts: GitCmdOptions,
): Promise<void> {
  await git(['remote', 'add', name, url], opts);
}
