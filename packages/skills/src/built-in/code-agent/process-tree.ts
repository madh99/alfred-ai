import { readdirSync, readlinkSync, readFileSync } from 'node:fs';

/**
 * v810 — Robustes Killen von Agent-Subprozess-Bäumen.
 *
 * Hintergrund: Der Coding-Agent (claude-code) läuft als detached Host-Prozess.
 * Er spawnt seine Bash-Tool-Kommandos (z.B. `npx vitest run`) in EIGENEN
 * Sessions. Beim Abort killt `process.kill(-pid)` nur die Prozess-Gruppe von
 * claude-code — die in separaten Sessions gestarteten Grand-Children überleben,
 * werden an init (PPID 1) reparented und laufen als Waisen weiter (halten u.a.
 * den Worktree offen → "Directory not empty" beim Cleanup).
 *
 * Lösung: über das cwd killen. JEDER vom Agent gestartete Prozess erbt den
 * Worktree als cwd; cwd ist immutable (dev-tools chdir'en nicht). Das überlebt
 * reparenting + neue Sessions. Linux-only (liest /proc); no-op sonst.
 *
 * WICHTIG: Container-Prozesse (der dev-server!) werden ausgeschlossen — sie
 * können denselben Worktree als cwd haben (bind-mount), laufen aber im Container
 * und dürfen vom Agent-Abort NICHT getroffen werden. Erkennung via cgroup.
 */
export function killProcessesByCwd(
  targetCwd: string,
  signal: NodeJS.Signals = 'SIGTERM',
  opts?: { includeContainer?: boolean },
): number {
  if (process.platform !== 'linux') return 0;
  if (!targetCwd) return 0;

  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return 0;
  }

  const selfPid = process.pid;
  const target = targetCwd.replace(/\/+$/, '');
  let killed = 0;

  for (const pid of pids) {
    const numPid = Number(pid);
    if (numPid === selfPid) continue;

    // cwd des Prozesses auflösen — schlägt fehl wenn Prozess weg oder keine Rechte
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    const norm = cwd.replace(/\/+$/, '');
    if (norm !== target && !norm.startsWith(target + '/')) continue;

    // Container-Prozesse (dev-server etc.) ausschließen — sie dürfen vom
    // Agent-Abort nicht getroffen werden. Bei A2-Destroy ist der Container eh
    // schon gestoppt; dort kann includeContainer=true gesetzt werden.
    if (!opts?.includeContainer) {
      try {
        const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
        if (/docker|containerd|libpod|\/docker[-/]/.test(cgroup)) continue;
      } catch {
        /* kein cgroup lesbar — als Host-Prozess behandeln */
      }
    }

    try {
      process.kill(numPid, signal);
      killed++;
    } catch {
      /* schon weg */
    }
  }

  return killed;
}

/**
 * v810 — Vollständiger Kill eines Agent-Laufs: erst Prozess-Gruppe (falls
 * detached gespawnt), dann SIGTERM auf alle cwd-Matches, nach `graceMs` SIGKILL
 * als Backstop für reparentete Waisen.
 */
export function killAgentTree(
  childPid: number | undefined,
  cwd: string,
  opts?: { graceMs?: number; detached?: boolean },
): void {
  const graceMs = opts?.graceMs ?? 3000;
  const detached = opts?.detached ?? true;

  // 1) Prozess-Gruppe (erfasst same-group Children sofort)
  try {
    if (detached && childPid && process.platform !== 'win32') {
      process.kill(-childPid, 'SIGTERM');
    } else if (childPid) {
      process.kill(childPid, 'SIGTERM');
    }
  } catch {
    /* gone */
  }

  // 2) Sofort SIGTERM auf alle cwd-Matches (erfasst Sub-Sessions vor reparenting)
  try {
    killProcessesByCwd(cwd, 'SIGTERM');
  } catch {
    /* best-effort */
  }

  // 3) Nach Gnadenfrist SIGKILL auf Gruppe + verbliebene cwd-Matches (Waisen)
  setTimeout(() => {
    try {
      if (detached && childPid && process.platform !== 'win32') {
        process.kill(-childPid, 'SIGKILL');
      } else if (childPid) {
        process.kill(childPid, 'SIGKILL');
      }
    } catch {
      /* gone */
    }
    try {
      killProcessesByCwd(cwd, 'SIGKILL');
    } catch {
      /* best-effort */
    }
  }, graceMs).unref?.();
}
