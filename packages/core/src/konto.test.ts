import { describe, it, expect } from 'vitest';
import { zeitraeume, herkunftVon, kontoKosten, type KontoQuelle } from './konto.js';
import { mitKostenZweck, mitKostenZweckWennLeer, aktuellerKostenZweck } from './kosten-zweck.js';

describe('v1506 D5 Konto', () => {
  it('Wochenbeginn Montag, Monatsbeginn', () => {
    expect(zeitraeume('2026-10-19')).toEqual({ wocheVon: '2026-10-19', monatVon: '2026-10-01' }); // Montag
    expect(zeitraeume('2026-10-25')).toEqual({ wocheVon: '2026-10-19', monatVon: '2026-10-01' }); // Sonntag
    expect(zeitraeume('2026-11-01')).toEqual({ wocheVon: '2026-10-26', monatVon: '2026-11-01' });
  });

  it('Herkunft aus dem Zweck', () => {
    expect(herkunftVon('hintergrund:kg-maintenance')).toBe('hintergrund');
    expect(herkunftVon('chat')).toBe('chat');
    expect(herkunftVon('claude-code')).toBe('claude-code');
    expect(herkunftVon('irgendwas')).toBe('sonstiges');
  });

  it('Summen: LLM + Claude Code, Herkunft gruppiert, teuerstes Modell, Budget nur durchgereicht', async () => {
    const q: KontoQuelle = {
      tagesSchluessel: () => '2026-10-21',
      summeJeModell: async (von) => von === '2026-10-21'
        ? [{ model: 'gpt-6.1-sol', calls: 10, costUsd: 2 }, { model: 'haiku', calls: 5, costUsd: 0.1 }]
        : [{ model: 'gpt-6.1-sol', calls: 100, costUsd: 20 }, { model: 'opus-5-5', calls: 3, costUsd: 30 }],
      summeJeZweck: async (von) => von === '2026-10-21'
        ? [{ zweck: 'chat', calls: 8, costUsd: 1.5 }, { zweck: 'hintergrund:a', calls: 4, costUsd: 0.4 }, { zweck: 'hintergrund:b', calls: 2, costUsd: 0.2 }, { zweck: 'claude-code', calls: 1, costUsd: 3 }, { zweck: 'sonstiges', calls: 1, costUsd: 0 }]
        : [{ zweck: 'chat', calls: 50, costUsd: 30 }, { zweck: 'hintergrund:a', calls: 40, costUsd: 4 }, { zweck: 'hintergrund:b', calls: 9, costUsd: 9 }, { zweck: 'claude-code', calls: 2, costUsd: 5 }],
    };
    const k = await kontoKosten(q, { tagesbudgetUsd: 15 });
    expect(k.llm.heute).toBe(2.1);
    expect(k.claudeCode.heute).toBe(3);
    expect(k.heute).toBe(5.1);
    expect(k.monat).toBe(55);
    expect(k.tagesbudgetUsd).toBe(15);
    expect(k.herkunftHeute.map(h => h.herkunft)).toEqual(['chat', 'hintergrund', 'claude-code', 'sonstiges']);
    expect(k.herkunftHeute.find(h => h.herkunft === 'hintergrund')).toEqual({ herkunft: 'hintergrund', kosten: 0.6, aufrufe: 6 });
    expect(k.hintergrundMonat).toEqual([{ job: 'b', kosten: 9 }, { job: 'a', kosten: 4 }]);
    expect(k.teuerstesModell).toEqual({ modell: 'opus-5-5', kosten: 30 });
    expect(k.zeitraum).toEqual({ heute: '2026-10-21', wocheVon: '2026-10-19', monatVon: '2026-10-01' });
  });

  it('ohne Budget kein Budgetfeld', async () => {
    const leer: KontoQuelle = { tagesSchluessel: () => '2026-10-21', summeJeModell: async () => [], summeJeZweck: async () => [] };
    const k = await kontoKosten(leer);
    expect(k.tagesbudgetUsd).toBeUndefined();
    expect(k.heute).toBe(0);
    expect(k.teuerstesModell).toBeUndefined();
  });

  it('Zweck-Kontext: innen gewinnt, WennLeer überschreibt nicht, ohne Kontext „sonstiges“, über await hinweg', async () => {
    expect(aktuellerKostenZweck()).toBe('sonstiges');
    await mitKostenZweck('aufgabe', async () => {
      await new Promise(r => setTimeout(r, 1));
      await mitKostenZweckWennLeer('chat', async () => { expect(aktuellerKostenZweck()).toBe('aufgabe'); });
      await mitKostenZweck('hintergrund:x', async () => { expect(aktuellerKostenZweck()).toBe('hintergrund:x'); });
      expect(aktuellerKostenZweck()).toBe('aufgabe');
    });
    await mitKostenZweckWennLeer('chat', async () => { await Promise.resolve(); expect(aktuellerKostenZweck()).toBe('chat'); });
  });
});
