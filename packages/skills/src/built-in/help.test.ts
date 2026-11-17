import { describe, it, expect } from 'vitest';
import type { SkillContext } from '@alfred/types';
import { SkillRegistry } from '../skill-registry.js';
import { HelpSkill, hilfeRolle } from './help.js';
import { CalculatorSkill } from './calculator.js';
import { ROLE_SKILL_ACCESS } from './user-management.js';

const basis: SkillContext = { userId: 'u1', chatId: 'c1', platform: 'api', conversationId: 'k1' };

function hilfe(): HelpSkill {
  const reg = new SkillRegistry();
  reg.register(new CalculatorSkill());
  const h = new HelpSkill(reg, { ...ROLE_SKILL_ACCESS, guest: ['help'] });
  reg.register(h);
  return h;
}

describe('help — Rolle wie der Werkzeugfilter der Pipeline', () => {
  it('Owner ohne alfred_users-Eintrag (Pipeline-Fallback admin) sieht jeden Skill im Detail', async () => {
    const r = await hilfe().execute({ action: 'detail', skill_name: 'calculator' }, { ...basis, werkzeugRolle: 'admin' });
    expect(r.success).toBe(true);
  });

  it('ohne jede Rolle bleibt es bei guest — nicht freigegebene Skills werden abgewiesen', async () => {
    const reg = new SkillRegistry();
    const h = new HelpSkill(reg, { guest: ['help'] });
    reg.register(h);
    reg.register(new CalculatorSkill());
    const r = await h.execute({ action: 'detail', skill_name: 'calculator' }, basis);
    expect(r.success).toBe(false);
    expect(r.error).toContain('für deine Rolle nicht verfügbar');
  });

  it('werkzeugRolle hat Vorrang, userRole bleibt Rückfall', () => {
    expect(hilfeRolle({ ...basis, userRole: 'user', werkzeugRolle: 'admin' })).toBe('admin');
    expect(hilfeRolle({ ...basis, userRole: 'family' })).toBe('family');
    expect(hilfeRolle(basis)).toBe('guest');
  });
});
