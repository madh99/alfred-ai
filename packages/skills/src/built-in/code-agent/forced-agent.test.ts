import { describe, it, expect } from 'vitest';
import { CodeAgentSkill } from './code-agent-skill.js';
import type { SkillContext } from '@alfred/types';

/**
 * v890 — Projekt-Chat-CLI-Override (context.forcedCodeAgent).
 *
 * Der Picker im Projekt-Chat (bzw. 'auto' → Projekt-Strategie) bestimmt die CLI
 * deterministisch. Der Override MUSS über die LLM-Vermutung (input.agent) gewinnen
 * — sonst rät das LLM weiter claude-code (genau der Vorfall fussball-cc 13.06.).
 *
 * Getestet wird die CLI-Auswahl in runAgent VOR dem Subprozess-Start: ein
 * Override auf eine unbekannte CLI muss den "Unknown agent <override>"-Fehler
 * auslösen — das beweist, dass der Override den (gültigen) input.agent verdrängt.
 */

function makeSkill(): CodeAgentSkill {
  return new CodeAgentSkill({
    agents: [
      { name: 'claude-code', command: 'true', argsTemplate: [] },
      { name: 'mistral-vibe', command: 'true', argsTemplate: [] },
    ],
  });
}

const ctx = (forcedCodeAgent?: string): SkillContext => ({
  userId: 'u', chatId: 'c', platform: 'api', conversationId: '',
  ...(forcedCodeAgent ? { forcedCodeAgent } : {}),
} as SkillContext);

describe('v890 forcedCodeAgent override', () => {
  it('override gewinnt über input.agent (unbekannter Override → Fehler nennt den Override)', async () => {
    const skill = makeSkill();
    const r = await skill.execute(
      { action: 'run', agent: 'claude-code', prompt: 'x' },
      ctx('ghost-cli'),
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('ghost-cli'); // Override verdrängte das gültige claude-code
  });

  it('ohne Override bleibt input.agent maßgeblich (altes Verhalten, kein Projekt)', async () => {
    const skill = makeSkill();
    const r = await skill.execute(
      { action: 'run', agent: 'ghost-cli', prompt: 'x' },
      ctx(undefined),
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('ghost-cli'); // input.agent bleibt unverändert maßgeblich
  });

  it('gültiger Override (claude-code) verdrängt einen unbekannten input.agent → kein Unknown-agent-Fehler', async () => {
    const skill = makeSkill();
    const r = await skill.execute(
      { action: 'run', agent: 'ghost-cli', prompt: 'x', cwd: '/nonexistent-xyz', timeout: 50 },
      ctx('claude-code'),
    );
    // Der Lauf scheitert ggf. am Subprozess/cwd, aber NICHT mit "Unknown agent ghost-cli":
    // der gültige Override claude-code hat die Auswahl übernommen.
    expect(r.error ?? '').not.toContain('Unknown agent "ghost-cli"');
  });
});
