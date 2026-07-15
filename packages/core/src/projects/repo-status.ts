import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT = 15_000;

/**
 * v872 — Strukturierter Repo-Status eines Projekt-CWDs.
 *
 * Gemeinsamer Collector für git-probe (Health-Historie) und den
 * On-Demand-Endpoint GET /api/projects/:id/repo-status (Repo-Status-Karte).
 * Eine Implementierung, zwei Konsumenten — damit Probe-Details und
 * UI-Karte nie auseinanderlaufen.
 */
export interface RepoStatus {
  branch: string;
  sha: string;
  /** Alter des letzten Commits in Tagen (ganzzahlig, abgerundet). */
  commitAgeDays: number;
  lastCommitAt: string;
  /** Anzahl uncommitteter Dateien (staged + unstaged + untracked). */
  dirtyCount: number;
  /** Bis zu 8 Beispiel-Pfade aus `git status --porcelain`. */
  dirtyFiles: string[];
  /** Tracking-Remote-Branch (z.B. origin/master) — null wenn kein Upstream gesetzt. */
  upstream: string | null;
  /** Commits lokal voraus gegenüber Upstream — null wenn kein Upstream. */
  ahead: number | null;
  /** Commits hinter Upstream — null wenn kein Upstream. */
  behind: number | null;
  /** Konfigurierter Default-/Deploy-Branch des Projekts (falls bekannt). */
  defaultBranch?: string;
  /** true wenn der aktuelle Branch dem defaultBranch entspricht (undefined wenn unbekannt). */
  onDefaultBranch?: boolean;
  /**
   * v1119 — true wenn HEAD vollständig im Default-Branch enthalten ist (lokal
   * oder origin). Dann ist „nicht auf main" kein Warnfall: der Feature-Branch
   * ist gemergt, es fehlt nur der Checkout zurück (Realfall 15.07.: Warnung
   * stand dauerhaft, obwohl alle Refs auf demselben Commit standen).
   */
  mergedIntoDefault?: boolean;
}

export interface CollectRepoStatusOptions {
  defaultBranch?: string;
  timeoutMs?: number;
}

/** Wirft bei fehlendem cwd / fehlendem .git / unlesbarem HEAD — Caller mappt auf Probe-Error bzw. API-Fehler. */
export async function collectRepoStatus(cwd: string, opts?: CollectRepoStatusOptions): Promise<RepoStatus> {
  const timeout = opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT;
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!existsSync(path.join(cwd, '.git'))) throw new Error('not a git repository (no .git/)');

  const git = (args: string[]) => execFileAsync('git', args, { cwd, timeout });

  const [head, log, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-1', '--format=%H %ct']),
    git(['status', '--porcelain']),
  ]);

  const branch = head.stdout.trim();
  const [sha, ctRaw] = log.stdout.trim().split(/\s+/, 2);
  const commitTime = Number(ctRaw) * 1000;
  const commitAgeDays = Math.floor((Date.now() - commitTime) / (24 * 60 * 60 * 1000));

  const statusLines = status.stdout.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  const dirtyFiles = statusLines.slice(0, 8).map(l => l.slice(3).trim());

  // Upstream + ahead/behind — fehlt der Tracking-Branch (frisches Repo, lokaler
  // Branch ohne push -u), liefern wir null statt 0, damit die UI "kein Upstream"
  // von "synchron" unterscheiden kann.
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    upstream = up.stdout.trim() || null;
    if (upstream) {
      // left-right: "<behind>\t<ahead>" (links = nur Upstream, rechts = nur HEAD)
      const counts = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/, 2);
      behind = Number(behindRaw) || 0;
      ahead = Number(aheadRaw) || 0;
    }
  } catch {
    // kein Upstream konfiguriert — bewusst null lassen
  }

  const defaultBranch = opts?.defaultBranch;
  // v1119 — ist HEAD im Default-Branch enthalten? (lokal, sonst origin/…)
  let mergedIntoDefault: boolean | undefined;
  if (defaultBranch && branch !== defaultBranch) {
    mergedIntoDefault = false;
    for (const ref of [defaultBranch, `origin/${defaultBranch}`]) {
      try {
        await git(['merge-base', '--is-ancestor', 'HEAD', ref]);
        mergedIntoDefault = true;
        break;
      } catch { /* exit 1 = kein Ancestor bzw. Ref fehlt — nächsten Kandidaten prüfen */ }
    }
  }
  return {
    branch,
    sha: sha.slice(0, 8),
    commitAgeDays,
    lastCommitAt: new Date(commitTime).toISOString(),
    dirtyCount: statusLines.length,
    dirtyFiles,
    upstream,
    ahead,
    behind,
    defaultBranch,
    onDefaultBranch: defaultBranch ? branch === defaultBranch : undefined,
    ...(mergedIntoDefault !== undefined ? { mergedIntoDefault } : {}),
  };
}
