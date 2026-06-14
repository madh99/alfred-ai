import { describe, it, expect } from 'vitest';
import { upgradeAgentDef } from './agent-executor.js';
import type { CodeAgentDefinitionConfig } from '@alfred/types';

/**
 * v893 — Agent-Typ-Erkennung in upgradeAgentDef.
 *
 * Bug: die alte Regex `/^|\/claude($|\s)/` war durch die `^`-Alternative für
 * JEDEN String wahr → isClaude IMMER true → da `isClaude` zuerst greift, bekamen
 * vibe UND codex den claude-Zweig, also `--verbose --output-format stream-json`
 * injiziert → vibes/codex' CLI kennt diese Flags nicht → argparse-Fehler
 * (exitCode 2). Das war die reale Ursache der mistral-vibe-Abbrüche.
 *
 * Fix: Erkennung per Basename (bare Binary ODER voller Pfad, auch hinter sudo).
 * claude-code MUSS unverändert bleiben.
 */

const def = (command: string, argsTemplate: string[]): CodeAgentDefinitionConfig =>
  ({ name: 'x', command, argsTemplate } as CodeAgentDefinitionConfig);

describe('v893 upgradeAgentDef agent detection', () => {
  it('claude-code (sudo -u madh claude) bleibt UNVERÄNDERT: claude-stream-json + stream-flags', () => {
    const r = upgradeAgentDef(def('sudo', ['-u', 'madh', 'claude', '--print', '{{prompt}}']));
    expect(r.outputFormat).toBe('claude-stream-json');
    expect(r.argsTemplate).toContain('--output-format');
    expect(r.argsTemplate).toContain('stream-json');
    expect(r.argsTemplate).toContain('--verbose');
  });

  it('vibe (bare) → vibe-streaming, KEINE claude-Flags', () => {
    const r = upgradeAgentDef(def('vibe', ['-p', '{{prompt}}', '--output', 'text']));
    expect(r.outputFormat).toBe('vibe-streaming');
    expect(r.argsTemplate).toContain('streaming');
    expect(r.argsTemplate).not.toContain('--verbose');
    expect(r.argsTemplate).not.toContain('--output-format');
    // --output text → streaming (kein doppeltes text)
    expect(r.argsTemplate.join(' ')).toContain('--output streaming');
  });

  it('vibe (voller Pfad hinter sudo -u madh) → vibe-streaming, KEINE claude-Flags', () => {
    const r = upgradeAgentDef(def('sudo', ['-u', 'madh', '/home/madh/.local/bin/vibe', '-p', '{{prompt}}', '--output', 'text']));
    expect(r.outputFormat).toBe('vibe-streaming');
    expect(r.argsTemplate).toContain('streaming');
    expect(r.argsTemplate).not.toContain('--verbose');
    expect(r.argsTemplate).not.toContain('--output-format');
  });

  it('vibe-Heartbeat zeigt auf den echten Session-Log-Pfad (~/.vibe/logs/session)', () => {
    const r = upgradeAgentDef(def('vibe', ['-p', '{{prompt}}', '--output', 'text']));
    expect(r.additionalHeartbeatPaths).toContain('~/.vibe/logs/session');
    expect(r.additionalHeartbeatPaths).not.toContain('~/.vibe/sessions');
  });

  it('codex → codex-jsonl + --json, KEINE claude-Flags (vorher fälschlich claude)', () => {
    const r = upgradeAgentDef(def('codex', ['exec', '--skip-git-repo-check', '{{prompt}}']));
    expect(r.outputFormat).toBe('codex-jsonl');
    expect(r.argsTemplate).toContain('--json');
    expect(r.argsTemplate).not.toContain('--verbose');
    expect(r.argsTemplate).not.toContain('--output-format');
  });

  it('expliziter outputFormat in der config wird respektiert (keine Detection)', () => {
    const r = upgradeAgentDef({ ...def('vibe', ['-p', '{{prompt}}']), outputFormat: 'text' } as CodeAgentDefinitionConfig);
    expect(r.outputFormat).toBe('text');
    expect(r.argsTemplate).not.toContain('streaming');
  });

  it('unbekannter Agent bleibt unangetastet', () => {
    const original = def('mytool', ['run', '{{prompt}}']);
    const r = upgradeAgentDef(original);
    expect(r.outputFormat).toBeUndefined();
    expect(r.argsTemplate).toEqual(['run', '{{prompt}}']);
  });
});
