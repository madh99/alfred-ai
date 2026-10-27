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

// v1695 (K5) — Realfall 27.10. (I9): 2 von 5 Changes gespeichert, delegate meldete trotzdem Erfolg ohne Hinweis
class SpeicherSkill extends Skill {
  readonly metadata: SkillMetadata = { name: 'speicher_fake', description: 'speichert', version: '1', category: 'core', riskLevel: 'read', parameters: { type: 'object', properties: {} } } as unknown as SkillMetadata;
  kontexte: SkillContext[] = [];
  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    this.kontexte.push(context);
    return input.nr === 3 ? { success: false, error: 'Zeitlimit des Werkzeugs überschritten' } : { success: true, display: `gespeichert ${String(input.nr)}` };
  }
}

describe('DelegateSkill — ehrlicher Status (K5)', () => {
  const ctx = { userId: 'u1', chatId: 'c1', platform: 'api' } as unknown as SkillContext;
  it('fehlgeschlagener Werkzeugaufruf ohne späteren Erfolg → TEILERGEBNIS; Unter-Skills sehen unteragent', async () => {
    const registry = new SkillRegistry(); const sp = new SpeicherSkill(); registry.register(sp);
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'a', name: 'speicher_fake', input: { action: 'x', nr: 1 } }, { id: 'b', name: 'speicher_fake', input: { action: 'y', nr: 3 } }], usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: 'Alles gespeichert.\nERGEBNIS: erledigt 1, 3', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    const r = await new DelegateSkill({ complete } as unknown as LLMProvider, registry).execute({ task: 'speichern' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toMatch(/^⚠️ TEILERGEBNIS/);
    expect(r.display).toContain('speicher_fake.y (Zeitlimit');
    expect((r.data as { status: string }).status).toBe('teilweise');
    expect(sp.kontexte.every(c => c.unteragent === true)).toBe(true);
    const system = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain('ERGEBNIS:');
  });
  it('späterer Erfolg derselben Aktion hebt den Fehler auf; Iterationsgrenze → teilweise', async () => {
    const registry = new SkillRegistry(); registry.register(new SpeicherSkill());
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'a', name: 'speicher_fake', input: { action: 'y', nr: 3 } }], usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'b', name: 'speicher_fake', input: { action: 'y', nr: 4 } }], usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: 'fertig', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    const r = await new DelegateSkill({ complete } as unknown as LLMProvider, registry).execute({ task: 'speichern' }, ctx);
    expect((r.data as { status: string }).status).toBe('vollstaendig');
    expect(r.display).toBe('fertig');
    const grenze = vi.fn().mockResolvedValue({ content: 'zwischendurch', toolCalls: [{ id: 'c', name: 'speicher_fake', input: { nr: 1 } }], usage: { inputTokens: 1, outputTokens: 1 } });
    const g = await new DelegateSkill({ complete: grenze } as unknown as LLMProvider, registry).execute({ task: 'x', max_iterations: 1 }, ctx);
    expect((g.data as { status: string }).status).toBe('teilweise');
    expect(g.display).toContain('Iterationsgrenze (1)');
  });
});
