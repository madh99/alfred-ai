/**
 * v839 — Zentralisierter Env-Augmentor für alle Agent-Adapter (claude-code/vibe/
 * codex/generic-plain).
 *
 * Setzt NODE_OPTIONS=--max-old-space-size=<N> falls noch nicht vorhanden, damit
 * Subprocesses die der Agent selbst spawnt (z.B. `npm test`, `tsc --noEmit`)
 * mehr Heap haben als Node-Default (~1.4 GB).
 *
 * Warum nötig: Agent-CLI (claude/vibe/...) erbt Alfreds process.env. Wenn da
 * kein NODE_OPTIONS drin ist, hat auch der Agent-spawn-tsc-grandchild nichts
 * → V8 SIGABRT (exit 134) bei großen Monorepos wie alpbyte-games.
 *
 * Vererbung: existierendes NODE_OPTIONS aus parent (Alfred selbst) bleibt
 * erhalten und wird gemerged. Doppel-Setting wird vermieden.
 */

const DEFAULT_NODE_HEAP_MB = 4096;

export function augmentSpawnEnv(
  parentEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  opts?: { nodeMaxOldSpaceSizeMb?: number },
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v === 'string') merged[k] = v;
  }
  const mb = opts?.nodeMaxOldSpaceSizeMb ?? DEFAULT_NODE_HEAP_MB;
  const existing = merged.NODE_OPTIONS ?? '';
  if (/max-old-space-size/.test(existing)) {
    // Parent hat schon ein Override (z.B. aus Alfred-Startup) — nicht doppelt setzen
    return merged;
  }
  merged.NODE_OPTIONS = `${existing} --max-old-space-size=${mb}`.trim();
  return merged;
}
