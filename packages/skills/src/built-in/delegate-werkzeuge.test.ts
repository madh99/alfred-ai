import { describe, it, expect } from 'vitest';
import { DelegateSkill } from './delegate.js';
import type { SkillResult, SkillMetadata } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import { Skill } from '../skill.js';
import { SkillRegistry } from '../skill-registry.js';

// v1356 — Analyse 11.10.: der Stichwortfilter des Unteragenten behielt bei deutschen Aufgaben praktisch alle Werkzeuge
// („und", „die", „mit" stehen in fast jeder Beschreibung) → 74–89k Tokens je Lauf.
class Fake extends Skill {
  readonly metadata: SkillMetadata;
  constructor(name: string, description: string, category = 'core') {
    super();
    this.metadata = { name, description, version: '1', category, riskLevel: 'read', inputSchema: { type: 'object', properties: {} } } as unknown as SkillMetadata;
  }
  async execute(): Promise<SkillResult> { return { success: true, display: 'ok' }; }
}

function registry(): SkillRegistry {
  const r = new SkillRegistry();
  r.register(new Fake('homeassistant', 'Steuert und liest Home Assistant: Lichter, Schalter, Sensoren, Verlauf', 'infrastructure'));
  const fremd = ['bmw', 'social', 'crypto', 'marketplace', 'itsm', 'cmdb', 'spotify', 'sonos', 'proxmox', 'unifi', 'cloudflare', 'docker', 'feed', 'goe', 'energy', 'travel'];
  for (const n of fremd) r.register(new Fake(n, `Verwaltet ${n} und die zugehörigen Daten mit allen Aktionen für den Nutzer`, 'infrastructure'));
  for (const n of ['calculator', 'memory', 'note', 'shell', 'file', 'reminder', 'web_search']) r.register(new Fake(n, `${n} Werkzeug`));
  return r;
}
const aufgabe = 'Untersuche ausschließlich lesend Home Assistant: Welche Lichtschalter waren in den letzten Tagen länger als sonst an und welche Bewegungsmelder sind ausgefallen?';
const werkzeuge = (d: DelegateSkill, task: string) => (d as unknown as { buildSubAgentTools: (t: string) => Array<{ name: string }> }).buildSubAgentTools(task).map(t => t.name);

describe('DelegateSkill — Werkzeugauswahl des Unteragenten', () => {
  it('Stichwortfilter: Füllwörter („und", „die", „mit") halten keine fremden Werkzeuge mehr im Satz', () => {
    const d = new DelegateSkill({} as LLMProvider, registry());
    const w = werkzeuge(d, aufgabe);
    expect(w).toContain('homeassistant');
    expect(w).not.toContain('bmw');
    expect(w).not.toContain('social');
    expect(w.length).toBeLessThan(10); // Home Assistant + 7 Kernwerkzeuge statt alle 24
  });

  it('mit gesetzter Werkzeugwahl gilt deren Auswahl; leere Auswahl fällt auf den Stichwortfilter zurück', () => {
    const d = new DelegateSkill({} as LLMProvider, registry());
    d.setWerkzeugwahl((_t, kandidaten) => kandidaten.filter(k => k.name === 'homeassistant' || k.name === 'memory'));
    expect(werkzeuge(d, aufgabe).sort()).toEqual(['homeassistant', 'memory']);
    d.setWerkzeugwahl(() => []);
    expect(werkzeuge(d, aufgabe)).toContain('homeassistant');
    d.setWerkzeugwahl(() => { throw new Error('kaputt'); });
    expect(werkzeuge(d, aufgabe)).toContain('homeassistant');
  });

  it('delegate selbst ist nie dabei (keine Rekursion)', () => {
    const r = registry();
    const d = new DelegateSkill({} as LLMProvider, r);
    r.register(d);
    d.setWerkzeugwahl((_t, k) => k);
    expect(werkzeuge(d, aufgabe)).not.toContain('delegate');
  });
});
