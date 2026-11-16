import { describe, it, expect } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { BauplanSkill, BAUPLAN_SCHREIBEND } from './bauplan-skill.js';
import type { BauplanDienst } from './bauplan-dienst.js';

function dienst() {
  const aufrufe: Array<[string, unknown[]]> = [];
  const merke = (n: string, r: unknown) => async (...a: unknown[]) => { aufrufe.push([n, a]); return r; };
  const d = {
    speichern: merke('speichern', { ok: true, zeile: { key: 'test_lab', version: 2, abdruck: 'a'.repeat(64), status: 'entwurf' }, hinweise: [] }),
    freigabeAnfragen: merke('freigabeAnfragen', { ok: true, text: 'Freigabe-Frage gestellt' }),
    freigebenNachJa: merke('freigebenNachJa', { ok: false, text: 'Keine gültige Freigabe' }),
    widerrufen: merke('widerrufen', { ok: true, text: 'widerrufen' }),
    anwenden: merke('anwenden', { ok: true, text: 'angewendet', ids: ['c1'] }),
    liste: merke('liste', [{ key: 'test_lab', titel: 'Test-Lab', version: 2, status: 'entwurf', freigegebeneVersion: 1 }]),
    zeigen: merke('zeigen', { key: 'test_lab', version: 1, status: 'freigegeben', abdruck: 'b'.repeat(64), json: '{"titel":"Test-Lab"}' }),
  };
  return { d: d as unknown as BauplanDienst, aufrufe };
}
const owner = { userId: 'owner' } as SkillContext;
const fremd = { userId: 'fremd' } as SkillContext;
const neu = () => { const x = dienst(); return { ...x, skill: new BauplanSkill(x.d, { istOwner: c => c.userId === 'owner', owner: () => 'o' }) }; };

describe('BauplanSkill', () => {
  it('nur Owner; riskLevel write; Beschreibung verbietet bauplan_freigeben durch das Modell', async () => {
    const { skill, aufrufe } = neu();
    expect(skill.metadata.name).toBe('bauplan');
    expect(skill.metadata.riskLevel).toBe('write');
    expect(skill.metadata.description).toMatch(/bauplan_freigeben.*nie selbst/i);
    expect((await skill.execute({ action: 'bauplan_liste' }, fremd)).success).toBe(false);
    expect(aufrufe).toHaveLength(0);
  });
  it('schreibende Aktionen aus Unteragent oder Change-Schritt abgewiesen', async () => {
    const { skill, aufrufe } = neu();
    for (const action of BAUPLAN_SCHREIBEND) {
      expect((await skill.execute({ action, key: 'test_lab', vorlage: {}, parameter: {}, instanz: 'x', version: 1, freigabe: 'n' }, { ...owner, unteragent: true } as SkillContext)).success, action).toBe(false);
      expect((await skill.execute({ action, key: 'test_lab', vorlage: {}, parameter: {}, instanz: 'x', version: 1, freigabe: 'n' }, { ...owner, ausChange: true } as SkillContext)).success, action).toBe(false);
    }
    expect(aufrufe).toHaveLength(0);
    expect(BAUPLAN_SCHREIBEND).toEqual(expect.arrayContaining(['bauplan_speichern', 'bauplan_freigabe_anfragen', 'bauplan_freigeben', 'bauplan_widerrufen', 'bauplan_anwenden']));
  });
  it('bauplan_freigeben direkt vom Modell (ohne gültige Einmal-Freigabe) → abgewiesen; Werte gehen unverändert an den Dienst', async () => {
    const { skill, aufrufe } = neu();
    const r = await skill.execute({ action: 'bauplan_freigeben', key: 'test_lab', version: 1 }, owner);
    expect(r.success).toBe(false);
    expect(aufrufe).toEqual([['freigebenNachJa', ['o', 'test_lab', 1, undefined]]]);
  });
  it('speichern: Vorlage als Objekt oder JSON-Text; anwenden: key, parameter, instanz', async () => {
    const { skill, aufrufe } = neu();
    expect((await skill.execute({ action: 'bauplan_speichern', vorlage: { key: 'test_lab' } }, owner)).success).toBe(true);
    expect((await skill.execute({ action: 'bauplan_speichern', vorlage: '{"key":"test_lab"}' }, owner)).success).toBe(true);
    expect((await skill.execute({ action: 'bauplan_speichern' }, owner)).success).toBe(false);
    expect(aufrufe.filter(a => a[0] === 'speichern').map(a => a[1][1])).toEqual([{ key: 'test_lab' }, { key: 'test_lab' }]);
    const r = await skill.execute({ action: 'bauplan_anwenden', key: 'test_lab', parameter: { vlan: 832 }, instanz: 'lab-1' }, owner);
    expect(r.success).toBe(true);
    expect(aufrufe.at(-1)).toEqual(['anwenden', ['o', 'test_lab', { vlan: 832 }, 'lab-1']]);
    expect((await skill.execute({ action: 'bauplan_anwenden', key: 'test_lab', parameter: {} }, owner)).success).toBe(false);
  });
  it('liste und zeigen lesen nur', async () => {
    const { skill } = neu();
    const l = await skill.execute({ action: 'bauplan_liste' }, { ...owner, unteragent: true } as SkillContext);
    expect(l.success).toBe(true);
    expect(l.display).toContain('test_lab');
    expect(l.display).toContain('v1 freigegeben');
    const z = await skill.execute({ action: 'bauplan_zeigen', key: 'test_lab', version: 1 }, owner);
    expect(z.success).toBe(true);
    expect(z.display).toContain('bbbbbbbbbbbb');
  });
});
