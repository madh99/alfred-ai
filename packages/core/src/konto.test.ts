import { describe, it, expect } from 'vitest';
import { zeitraeume, herkunftVon, agentVon, kontoKosten, type KontoQuelle } from './konto.js';
import { mitKostenZweck, mitKostenZweckWennLeer, aktuellerKostenZweck } from './kosten-zweck.js';

describe('v1506 D5 Konto', () => {
  it('Wochenbeginn Montag, Monatsbeginn', () => {
    expect(zeitraeume('2026-10-19')).toEqual({ wocheVon: '2026-10-19', monatVon: '2026-10-01' }); // Montag
    expect(zeitraeume('2026-10-25')).toEqual({ wocheVon: '2026-10-19', monatVon: '2026-10-01' }); // Sonntag
    expect(zeitraeume('2026-11-01')).toEqual({ wocheVon: '2026-10-26', monatVon: '2026-11-01' });
  });

  it('Herkunft und Agent aus dem Zweck (v1508: Agenten getrennt, alte claude-code-Zeilen zählen zu Claude Code)', () => {
    expect(herkunftVon('hintergrund:kg-maintenance')).toBe('hintergrund');
    expect(herkunftVon('chat')).toBe('chat');
    expect(herkunftVon('claude-code')).toBe('agent:claude-code');
    expect(herkunftVon('agent:codex')).toBe('agent:codex');
    expect(herkunftVon('irgendwas')).toBe('sonstiges');
    expect(agentVon('agent:mistral-vibe')).toBe('mistral-vibe');
    expect(agentVon('chat')).toBeUndefined();
  });

  it('Summen: LLM + Agenten, Agenten getrennt, Kosten je Gerät, Herkunft sortiert, Budget nur durchgereicht', async () => {
    const q: KontoQuelle = {
      tagesSchluessel: () => '2026-10-21',
      summeJeModell: async (von) => von === '2026-10-21'
        ? [{ model: 'gpt-6.1-sol', calls: 10, costUsd: 2 }, { model: 'haiku', calls: 5, costUsd: 0.1 }]
        : [{ model: 'gpt-6.1-sol', calls: 100, costUsd: 20 }, { model: 'opus-5-5', calls: 3, costUsd: 30 }],
      summeJeZweck: async (von) => von === '2026-10-21'
        ? [{ zweck: 'sonstiges', calls: 1, costUsd: 0 }, { zweck: 'agent:codex', calls: 1, costUsd: 0.5 }, { zweck: 'chat', calls: 8, costUsd: 1.5 }, { zweck: 'hintergrund:a', calls: 4, costUsd: 0.4 }, { zweck: 'hintergrund:b', calls: 2, costUsd: 0.2 }, { zweck: 'agent:claude-code', calls: 1, costUsd: 3 }]
        : [{ zweck: 'chat', calls: 50, costUsd: 30 }, { zweck: 'hintergrund:a', calls: 40, costUsd: 4 }, { zweck: 'hintergrund:b', calls: 9, costUsd: 9 }, { zweck: 'claude-code', calls: 1, costUsd: 1 }, { zweck: 'agent:claude-code', calls: 2, costUsd: 4 }, { zweck: 'agent:codex', calls: 1, costUsd: 0.5 }],
      summeJeZweckUndModell: async () => [
        { zweck: 'agent:claude-code', model: 'gerät:Ubuntu-VM', calls: 1, costUsd: 3 },
        { zweck: 'agent:claude-code', model: 'gerät:MacBook', calls: 1, costUsd: 1 },
        { zweck: 'agent:codex', model: 'gpt-5.5', calls: 1, costUsd: 0.5 },
        { zweck: 'chat', model: 'gerät:Fake', calls: 1, costUsd: 9 },
      ],
    };
    const k = await kontoKosten(q, { tagesbudgetUsd: 15 });
    expect(k.llm.heute).toBe(2.1);
    expect(k.agenten).toEqual([
      { agent: 'claude-code', heute: 3, woche: 5, monat: 5 }, // Woche = Monatsdaten der Attrappe; alte claude-code-Zeile zählt mit
      { agent: 'codex', heute: 0.5, woche: 0.5, monat: 0.5 },
      { agent: 'mistral-vibe', heute: 0, woche: 0, monat: 0 },
    ]);
    expect(k.heute).toBe(5.6);
    expect(k.monat).toBe(55.5);
    expect(k.tagesbudgetUsd).toBe(15);
    expect(k.herkunftHeute.map(h => h.herkunft)).toEqual(['chat', 'hintergrund', 'agent:claude-code', 'agent:codex', 'sonstiges']);
    expect(k.herkunftHeute.find(h => h.herkunft === 'hintergrund')).toEqual({ herkunft: 'hintergrund', kosten: 0.6, aufrufe: 6 });
    expect(k.hintergrundMonat).toEqual([{ job: 'b', kosten: 9 }, { job: 'a', kosten: 4 }]);
    expect(k.teuerstesModell).toEqual({ modell: 'opus-5-5', kosten: 30 });
    expect(k.geraeteMonat).toEqual({ 'Ubuntu-VM': 3, MacBook: 1 });
    expect(k.zeitraum).toEqual({ heute: '2026-10-21', wocheVon: '2026-10-19', monatVon: '2026-10-01' });
  });

  it('ohne Daten: bekannte Agenten mit 0, kein Budgetfeld', async () => {
    const leer: KontoQuelle = { tagesSchluessel: () => '2026-10-21', summeJeModell: async () => [], summeJeZweck: async () => [], summeJeZweckUndModell: async () => [] };
    const k = await kontoKosten(leer);
    expect(k.tagesbudgetUsd).toBeUndefined();
    expect(k.heute).toBe(0);
    expect(k.agenten.map(a => a.agent)).toEqual(['claude-code', 'codex', 'mistral-vibe']);
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
