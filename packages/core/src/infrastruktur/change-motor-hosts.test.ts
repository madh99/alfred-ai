import { describe, it, expect } from 'vitest';
import { beruehrteHosts } from './change-motor.js';

// Realfall 19.11.2026 — nach einem Change nur die berührten Fernzugriff-Zugänge neu erfassen
describe('beruehrteHosts', () => {
  it('sammelt name der fernzugriff-Schritte (ohne Verweise, ohne Doppelte), andere Skills zählen nicht', () => {
    const s = [
      { nr: 1, skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'pve3', befehl: 'x' } },
      { nr: 2, skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'pve3', befehl: 'y' } },
      { nr: 3, skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: '{{schritt1.name}}', befehl: 'z' } },
      { nr: 4, skill: 'linux_sql', aktion: 'reste_entfernen', parameter: { zugang: 'sqllnx02' } },
      { nr: 5, skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: ' alfred1 ', befehl: 'z' } },
    ];
    expect(beruehrteHosts(s as never)).toEqual({ fernzugriff: ['alfred1', 'pve3'] });
    expect(beruehrteHosts([] as never)).toEqual({ fernzugriff: [] });
  });
});
