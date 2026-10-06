import { describe, it, expect, vi } from 'vitest';
import { DelegateSkill } from './delegate.js';
import type { SkillContext, SkillResult, SkillMetadata } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import { Skill } from '../skill.js';
import { SkillRegistry } from '../skill-registry.js';

// v1234 — Owner-Beobachtung 06.10.: Sprachnachricht aus einem delegierten Lauf kam nie an,
// weil delegate die Anhänge seiner Unter-Skills verwarf. Jetzt gehen sie mit nach oben.

class SprachSkill extends Skill {
  readonly metadata: SkillMetadata = { name: 'sprache_fake', description: 'erzeugt eine Sprachnachricht', version: '1', category: 'media', riskLevel: 'read', parameters: { type: 'object', properties: {} } } as unknown as SkillMetadata;
  async execute(): Promise<SkillResult> {
    return { success: true, display: 'Sprache generiert.', attachments: [{ fileName: 'speech.opus', mimeType: 'audio/opus', data: Buffer.from('opus-bytes') }] };
  }
}

describe('DelegateSkill — Anhänge der Unter-Skills', () => {
  it('gibt die Sprachnachricht des Unter-Skills im eigenen Ergebnis zurück', async () => {
    const registry = new SkillRegistry();
    registry.register(new SprachSkill());
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'sprache_fake', input: { text: 'Hallo' } }], usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: 'Sprachnachricht erstellt.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    const llm = { complete } as unknown as LLMProvider;
    const skill = new DelegateSkill(llm, registry);
    const r = await skill.execute({ task: 'Sprachnachricht senden' }, { userId: 'u1', chatId: 'c1', platform: 'telegram' } as unknown as SkillContext);
    expect(r.success).toBe(true);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments?.[0].mimeType).toBe('audio/opus');
    // das Werkzeug-Ergebnis nennt den Anhang, damit das Modell nicht „keine Datei" schließt
    const zweiterAufruf = complete.mock.calls[1][0] as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(zweiterAufruf.messages)).toContain('Anhang');
  });
});
