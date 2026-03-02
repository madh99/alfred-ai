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
