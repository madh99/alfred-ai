import { describe, it, expect } from 'vitest';
import { injectVibeWorkspaceFlags } from './agent-executor.js';

/**
 * v896 — vibe braucht --workdir + --add-dir mit dem Lauf-cwd, damit seine Sandbox
 * das Projekt als vertrauenswürdiges Workspace akzeptiert (sonst "Tool execution
 * not permitted" bei mkdir/write_file, z.B. Next.js-[param]-Routes).
 */
describe('v896 injectVibeWorkspaceFlags', () => {
  const cwd = '/home/madh/projects/fussball-cc';

  it('vibe → hängt --workdir + --add-dir mit dem cwd an', () => {
    const r = injectVibeWorkspaceFlags(['-p', 'do x', '--output', 'streaming'], 'vibe-streaming', cwd);
    expect(r).toEqual(['-p', 'do x', '--output', 'streaming', '--workdir', cwd, '--add-dir', cwd]);
  });

  it('claude → unverändert (kein Trust-Flag injiziert)', () => {
    const args = ['--print', 'do x', '--output-format', 'stream-json', '--verbose'];
    expect(injectVibeWorkspaceFlags(args, 'claude-stream-json', cwd)).toEqual(args);
  });

  it('codex → unverändert', () => {
    const args = ['exec', '--json', 'do x'];
    expect(injectVibeWorkspaceFlags(args, 'codex-jsonl', cwd)).toEqual(args);
  });

  it('idempotent: vorhandenes --workdir/--add-dir wird nicht dupliziert', () => {
    const args = ['-p', 'x', '--workdir', '/foo', '--add-dir', '/bar'];
    expect(injectVibeWorkspaceFlags(args, 'vibe-streaming', cwd)).toEqual(args);
  });

  it('leeres cwd → keine Injektion (defensiv)', () => {
    const args = ['-p', 'x'];
    expect(injectVibeWorkspaceFlags(args, 'vibe-streaming', '')).toEqual(args);
  });
});
