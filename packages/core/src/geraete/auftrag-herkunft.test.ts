import { describe, it, expect } from 'vitest';
import { AuftragHerkunft } from './auftrag-herkunft.js';

describe('v1509 AuftragHerkunft.laufend', () => {
  it('nur Aufträge des Geräts, jüngster zuerst, beendete und zu alte fallen weg, Frage mit Projektname', () => {
    let jetzt = 1_000_000_000;
    const a = new AuftragHerkunft(undefined, () => jetzt);
    a.merke('g1', 'alt', { chatId: 'c', platform: 'api', userId: 'u' });
    jetzt += 13 * 3_600_000; // 13 h später: „alt“ ist über der 12-h-Grenze
    a.merke('g1', 'a1', { chatId: 'c', platform: 'api', userId: 'u' });
    jetzt += 60_000;
    a.merke('g1', 'f1', { chatId: 'c', platform: 'api', userId: 'u', frage: { akteId: 'x', name: 'Finanz-Backend', geraet: 'VM', frage: '?' } });
    a.merke('g2', 'b1', { chatId: 'c', platform: 'api', userId: 'u' });
    a.merke('g1', 'weg', { chatId: 'c', platform: 'api', userId: 'u' });
    a.nimm('g1', 'weg');
    expect(a.laufend('g1').map(x => x.auftragId)).toEqual(['f1', 'a1']);
    expect(a.laufend('g1')[0]!.frage).toBe('Finanz-Backend');
    expect(a.laufend('g2').map(x => x.auftragId)).toEqual(['b1']);
  });
});
