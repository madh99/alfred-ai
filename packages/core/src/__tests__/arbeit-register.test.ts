import { describe, it, expect } from 'vitest';
import { ArbeitRegister, ARBEIT_VERWAIST_MS } from '../geraete/arbeit-register.js';
import type { ArbeitsEreignis } from '../geraete/arbeits-melder.js';

// v1975 — laufende Anfragen der Owner-Gespräche für App und Web abfragbar
const basis = { arbeit: 'a1', faden: 'infra-cf82f3f2', von: { platform: 'api', chatId: 'owner:faden:infra-cf82f3f2' }, seit: '2026-11-28T10:00:00.000Z' };
const ev = (e: Partial<ArbeitsEreignis>): ArbeitsEreignis => ({ ...basis, phase: 'status', ...e }) as ArbeitsEreignis;

describe('ArbeitRegister', () => {
  it('start → status mit Modell/Kosten → ende', () => {
    let t = Date.parse('2026-11-28T10:00:01Z');
    const r = new ArbeitRegister(() => t);
    r.anwenden(ev({ phase: 'start', frage: 'Synapse planen' }), 'API');
    t += 5000;
    r.anwenden(ev({ text: 'Infrastruktur: change_aendern', modell: 'gpt-6.2-sol', kostenUsd: 1.27, runde: 4 }), 'API');
    expect(r.liste()).toEqual([{ arbeit: 'a1', faden: 'infra-cf82f3f2', von: 'owner:faden:infra-cf82f3f2', kanal: 'API', frage: 'Synapse planen', seit: '2026-11-28T10:00:00.000Z', status: 'Infrastruktur: change_aendern', modell: 'gpt-6.2-sol', kostenUsd: 1.27, runde: 4, zuletzt: '2026-11-28T10:00:06.000Z' }]);
    r.anwenden(ev({ phase: 'ende' }), 'API');
    expect(r.liste()).toEqual([]);
  });

  it('Status ohne verpassten Start legt den Lauf trotzdem an; verwaiste Läufe fallen heraus', () => {
    let t = Date.parse('2026-11-28T10:00:00Z');
    const r = new ArbeitRegister(() => t);
    r.anwenden(ev({ arbeit: 'b', text: 'läuft' }), 'Telegram');
    expect(r.liste().map(a => [a.arbeit, a.status, a.seit])).toEqual([['b', 'läuft', '2026-11-28T10:00:00.000Z']]);
    t += ARBEIT_VERWAIST_MS + 1000;
    expect(r.liste()).toEqual([]);
  });
});
