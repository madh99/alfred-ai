import { describe, it, expect } from 'vitest';
import { weltmodellKurzAus, WELTMODELL_CHAT_SEKTIONEN } from '../reasoning-context-collector.js';

// v1206 — Jarvis Schleife 1: Alfred kennt im Gespräch das Haus (Weltmodell aus dem letzten Sammeln).
describe('weltmodellKurzAus', () => {
  it('baut Abschnitte je Sektion mit Zeichenbudget und Stand, Fehlertexte bleiben draußen', () => {
    const inhalte = new Map<string, string>([
      ['bmw', '**Fahrzeug:** steht seit 05.10. 18:28, SoC 30 %'],
      ['smarthome', '**Anwesenheit:** madh: zuhause · Türen geschlossen'],
      ['energy', '(Energie-Abfrage fehlgeschlagen)'],
      ['infra', 'x'.repeat(1000)],
      ['calendar', 'Termin heute 14:00'],
    ]);
    const t = weltmodellKurzAus(inhalte, '2026-10-06T00:30:00.000Z')!;
    expect(t.startsWith('## Weltmodell (automatisch erhoben, Stand ')).toBe(true);
    expect(t).toContain('### Auto (BMW)\n**Fahrzeug:** steht seit 05.10. 18:28, SoC 30 %');
    expect(t).toContain('### Haus (Home Assistant)');
    expect(t).not.toContain('Energie-Abfrage fehlgeschlagen');
    expect(t).not.toContain('Termin heute'); // Kalender steht bereits im Prompt
    const infra = t.split('### Infrastruktur\n')[1];
    expect(infra.length).toBeLessThanOrEqual(401 + 2);
    expect(infra.endsWith('…')).toBe(true);
  });
  it('ohne Inhalte undefined; Reihenfolge der Sektionen wie definiert', () => {
    expect(weltmodellKurzAus(new Map())).toBeUndefined();
    const keys = WELTMODELL_CHAT_SEKTIONEN.map(s => s[0]);
    expect(keys).toEqual(['bmw', 'smarthome', 'energy', 'infra', 'vorgaenge']);
  });
});
