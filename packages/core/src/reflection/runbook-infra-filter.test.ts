import { describe, it, expect } from 'vitest';
import { nutztInfraChanges } from './chat-session-runbook-reflector.js';

// v1697 — kein Runbook-Vorschlag aus Gesprächen mit Change-Aktionen, egal in welchem Faden (Owner 27.10.)
describe('v1697 nutztInfraChanges', () => {
  const tc = (action: string, name = 'infrastruktur') => JSON.stringify([{ id: 'c1', name, input: { action } }]);
  it('erkennt planen, ändern, freigeben, steuern; nicht lesen oder andere Skills', () => {
    expect(nutztInfraChanges(tc('changes_planen'))).toBe(true);
    expect(nutztInfraChanges(tc('change_aendern'))).toBe(true);
    expect(nutztInfraChanges(tc('freigabe_anfragen'))).toBe(true);
    expect(nutztInfraChanges(tc('change_zeigen'))).toBe(false);
    expect(nutztInfraChanges(tc('changes_planen', 'itsm'))).toBe(false);
    expect(nutztInfraChanges(JSON.stringify([{ type: 'tool_result', content: 'infrastruktur changes_planen' }]))).toBe(false);
    expect(nutztInfraChanges(undefined)).toBe(false);
    expect(nutztInfraChanges('kaputt infrastruktur')).toBe(false);
  });
});
