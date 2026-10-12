import { describe, it, expect } from 'vitest';
import { GeraetSkill } from '../geraete/geraet-skill.js';

// v1383 — Array-Parameter der Geräteaktionen (pruefen) brauchen items, sonst lehnt OpenAI das ganze Werkzeug ab
describe('Geräte-Skill Schema', () => {
  it('Arrays tragen items, andere Typen nicht', () => {
    const s = new GeraetSkill({
      geraetId: 'g', name: 'VM', skillName: 'geraet_vm',
      manifest: { plattform: 'linux', aktionen: [
        { name: 'pruefen', beschreibung: 'x', autonomie: 'auto', parameter: { pruefungen: { type: 'array', description: 'Liste' }, liste2: { type: 'array', items: { type: 'string' } }, pfad: { type: 'string' } } },
      ] },
      pruefeFreigabe: () => false,
      vorhaben: { anlegen: () => undefined, aktiviere: () => undefined, deckt: () => undefined },
    } as never);
    const p = (s.metadata.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(p.pruefungen).toMatchObject({ type: 'array', items: { type: 'object' } });
    expect(p.liste2).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(p.pfad!.items).toBeUndefined();
  });
});
