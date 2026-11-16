import { describe, it, expect } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { BauplanSkill, BAUPLAN_SCHREIBEND } from './bauplan-skill.js';
import { BauplanDienst } from './bauplan-dienst.js';
import { EINGEBAUTE_VORLAGEN } from './vorlagen/index.js';

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
    ableitenVorschlag: merke('ableitenVorschlag', { ok: true, text: 'Vorschlag-Tabelle', kandidaten: [], verweise: [], hinweise: [] }),
    ableitenErzeugen: merke('ableitenErzeugen', { ok: true, text: 'Entwurf gespeichert' }),
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
  it('Final-Welle I2: eingebaut statt vorlage — genau eines; unbekannter Schlüssel abgewiesen; Inhalt = Register (Kopie)', async () => {
    const { skill, aufrufe } = neu();
    expect((await skill.execute({ action: 'bauplan_speichern', eingebaut: 'pki_lab' }, owner)).success).toBe(true);
    const gespeichert = aufrufe.at(-1)![1][1] as Record<string, unknown>;
    expect(gespeichert).toEqual(EINGEBAUTE_VORLAGEN.pki_lab);
    expect(gespeichert).not.toBe(EINGEBAUTE_VORLAGEN.pki_lab);
    const n = aufrufe.length;
    const r1 = await skill.execute({ action: 'bauplan_speichern', eingebaut: 'gibtsnicht' }, owner);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('pki_lab');
    const r2 = await skill.execute({ action: 'bauplan_speichern', eingebaut: 'pki_lab', vorlage: { key: 'x' } }, owner);
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/genau eines/);
    expect(aufrufe).toHaveLength(n);
    expect(JSON.stringify(skill.metadata.inputSchema)).toContain('eingebaut');
    expect(skill.metadata.description).toContain('eingebaut');
  });
  it('Final-Welle I2: eingebaute pki_lab besteht die echte Speicher-Validierung des Dienstes', async () => {
    const zeilen: unknown[] = [];
    const echt = new BauplanDienst({
      repo: { speichere: async (_u, d) => { const z = { id: 'z1', key: d.key, version: 1, json: d.json, abdruck: d.abdruck, status: 'entwurf', createdAt: 'x', updatedAt: 'x' }; zeilen.push(z); return z as never; }, finde: async () => undefined, liste: async () => [], setze: async () => undefined },
      instanzen: { anlegen: async () => { throw new Error('nie'); }, finde: async () => undefined },
      pruefeNur: async () => [], planen: async () => ({ ok: false, fehler: ['nie'] }), freigabeAnfragen: async () => ({ ok: false, fehler: ['nie'] }),
      pruefe: async () => ({ ok: true, text: '' }), frage: async () => true, melde: async () => undefined, verwerfen: async () => undefined,
    });
    const skill = new BauplanSkill(echt, { istOwner: () => true, owner: () => 'o' });
    const r = await skill.execute({ action: 'bauplan_speichern', eingebaut: 'pki_lab' }, owner);
    expect(r.success, r.error).toBe(true);
    expect(zeilen).toHaveLength(1);
    expect((zeilen[0] as { key: string }).key).toBe('pki_lab');
  });
  it('V4 bauplan_ableiten: vorschlag und erzeugen gehen mit den Eingaben an den Dienst; Modus und Felder geprüft', async () => {
    const { skill, aufrufe } = neu();
    const v = await skill.execute({ action: 'bauplan_ableiten', modus: 'vorschlag', changes: ['2cfde1a2', '7335dfeb'] }, owner);
    expect(v.success).toBe(true);
    expect(v.display).toBe('Vorschlag-Tabelle');
    expect(aufrufe.at(-1)).toEqual(['ableitenVorschlag', ['o', ['2cfde1a2', '7335dfeb']]]);
    const e = await skill.execute({ action: 'bauplan_ableiten', modus: 'erzeugen', changes: ['2cfde1a2'], auswahl: { 5: 'vlan' }, teil: { 'x:1:p:0': 'fest' }, key: 'lab', titel: 'Lab', zweck: 'Test', dokumentart: 'testprotokoll' }, owner);
    expect(e.success).toBe(true);
    expect(aufrufe.at(-1)).toEqual(['ableitenErzeugen', ['o', ['2cfde1a2'], { 5: 'vlan' }, { key: 'lab', titel: 'Lab', zweck: 'Test', dokumentart: 'testprotokoll' }, { 'x:1:p:0': 'fest' }]]);
    const n = aufrufe.length;
    expect((await skill.execute({ action: 'bauplan_ableiten', changes: ['a'] }, owner)).success).toBe(false);
    expect((await skill.execute({ action: 'bauplan_ableiten', modus: 'vorschlag' }, owner)).success).toBe(false);
    expect((await skill.execute({ action: 'bauplan_ableiten', modus: 'erzeugen', changes: ['a'], key: 'lab', titel: 'Lab', zweck: 'Test', dokumentart: 'testprotokoll' }, owner)).success).toBe(false);
    expect((await skill.execute({ action: 'bauplan_ableiten', modus: 'erzeugen', changes: ['a'], auswahl: { 1: 'x' }, key: 'lab', titel: 'Lab', zweck: 'Test', dokumentart: 'anderes' }, owner)).success).toBe(false);
    expect(aufrufe).toHaveLength(n);
    expect(skill.metadata.description).toContain('bauplan_ableiten');
    expect(JSON.stringify(skill.metadata.inputSchema)).toContain('auswahl');
  });
  it('V4 bauplan_ableiten (auch vorschlag) aus Unteragent oder Change-Schritt abgewiesen; nur Owner', async () => {
    const { skill, aufrufe } = neu();
    for (const modus of ['vorschlag', 'erzeugen']) {
      expect((await skill.execute({ action: 'bauplan_ableiten', modus, changes: ['a'] }, { ...owner, unteragent: true } as SkillContext)).success).toBe(false);
      expect((await skill.execute({ action: 'bauplan_ableiten', modus, changes: ['a'] }, { ...owner, ausChange: true } as SkillContext)).success).toBe(false);
      expect((await skill.execute({ action: 'bauplan_ableiten', modus, changes: ['a'] }, fremd)).success).toBe(false);
    }
    expect(aufrufe).toHaveLength(0);
    expect(BAUPLAN_SCHREIBEND).toContain('bauplan_ableiten');
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
