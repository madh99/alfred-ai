import { describe, it, expect } from 'vitest';
import { parseMailRegel, neueMails, begrenzeGesehen, ausloeserText, passtZuRegel } from '../ereignisse/mail-ereignisse.js';

// v1211 — Jarvis Schicht 2: Mail-Ereignisquelle (Realfall aWATTar-Rechnung, 4 Chat-Aufgaben/Tag).
describe('parseMailRegel', () => {
  it('akzeptiert JSON mit from oder subject, lehnt Leeres und Cron-Strings ab', () => {
    expect(parseMailRegel('{"account":"outlook","from":"awattar.com"}')).toEqual({ account: 'outlook', from: 'awattar.com', subject: undefined });
    expect(parseMailRegel('{"subject":"Rechnung","skills":["email","memory"]}')).toEqual({ account: undefined, from: undefined, subject: 'Rechnung', skills: ['email', 'memory'] });
    expect(parseMailRegel('{"account":"outlook"}')).toBeNull();
    expect(parseMailRegel('0 7 * * *')).toBeNull();
    expect(parseMailRegel('[]')).toBeNull();
  });
});

describe('neueMails', () => {
  const regel = { account: 'outlook', from: 'service@awattar.com', subject: 'Rechnung' };
  const mails = [
    { id: 'c', from: 'aWATTar Service <service@awattar.com>', subject: 'aWATTar - Rechnung Strom 06/2026 - 123', date: '2026-07-10T09:50:00Z' },
    { id: 'a', from: 'aWATTar Service <service@awattar.com>', subject: 'aWATTar - Rechnung Strom 05/2026 - 122', date: '2026-06-10T09:50:00Z' },
    { id: 'n', from: 'news@awattar.com', subject: 'Newsletter', date: '2026-07-11T08:00:00Z' },
    { id: 'x', from: 'someone@example.com', subject: 'Rechnung', date: '2026-07-12T08:00:00Z' },
  ];
  it('filtert nach Absender UND Betreff, ignoriert Gesehenes, älteste zuerst', () => {
    expect(neueMails(mails, regel, new Set()).map(m => m.id)).toEqual(['a', 'c']);
    expect(neueMails(mails, regel, new Set(['a'])).map(m => m.id)).toEqual(['c']);
    expect(passtZuRegel(mails[2], regel)).toBe(false);
    expect(passtZuRegel(mails[3], regel)).toBe(false);
  });
  it('begrenzeGesehen behält die jüngsten Einträge', () => {
    expect(begrenzeGesehen(['1', '2', '3', '4'], 3)).toEqual(['2', '3', '4']);
    expect(begrenzeGesehen(['1', '2'], 3)).toEqual(['1', '2']);
  });
  it('ausloeserText nennt Konto, Betreff, Absender, messageId und verbietet die erneute Suche', () => {
    const t = ausloeserText(mails[1], 'outlook');
    expect(t).toContain('im Konto "outlook"');
    expect(t).toContain('messageId a');
    expect(t).toContain('account="outlook"');
    expect(t).toContain('nicht erneut suchen');
  });
});
