import { describe, expect, it } from 'vitest';
import { leseLadung, schaetze, warnen, warnText, anbieterVonModell } from './guthaben-schaetzung.js';

const openaiMail = { id: 'm1', from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your OpenAI API account has been funded', body: 'Hi, We charged $24.00 to your credit card ending in 1234 to fund your OpenAI API credit balance.', date: '2026-10-31T08:20:10Z' };
const anthropicMail = { id: 'm2', from: 'invoice+statements+acct_1REyrSBNUnCSzfs9@stripe.com', subject: 'Your receipt from Anthropic Ireland, Limited #2795-4841-5882', body: 'One-time credit purchase\n Qty 1\n $20.00\nVAT - Austria (20%) $4.00\nAmount paid $24.00', date: '2026-10-30T10:44:27Z' };
const maxAbo = { id: 'm3', from: 'invoice+statements@mail.anthropic.com', subject: 'Your receipt from Anthropic, PBC #2552-0722-0291', body: 'Max plan - 20x Qty 1 €180.00 VAT - Austria (20%) €36.00 Amount paid €216.00', date: '2026-10-28T00:48:54Z' };

describe('v1726 — Guthaben-Schätzung', () => {
  it('erkennt Ladungen (OpenAI ohne MwSt., Anthropic Einmal-Guthaben), nicht das Max-Abo', () => {
    expect(leseLadung(openaiMail)).toMatchObject({ anbieter: 'openai', guthaben: 20 });
    expect(leseLadung(anthropicMail)).toMatchObject({ anbieter: 'anthropic', guthaben: 20 });
    expect(leseLadung(maxAbo)).toBeUndefined();
    expect(leseLadung({ ...openaiMail, from: 'phish@example.com' })).toBeUndefined();
  });
  it('schätzt ab dem leeren Stand bzw. vorsichtig ab der letzten Ladung', () => {
    const l = [leseLadung(openaiMail)!, { anbieter: 'openai' as const, guthaben: 10, zeit: '2026-10-29T17:17:46Z', mailId: 'x' }];
    const kosten = (iso: string) => (Date.parse(iso) < Date.parse('2026-10-30T00:00:00Z') ? 25 : 12);
    const mitLeer = schaetze('openai', l, '2026-10-29T17:00:00Z', kosten, 1);
    expect(mitLeer).toMatchObject({ geladen: 30, verbraucht: 25, rest: 5, grundlage: 'leer-ereignis' });
    const ohne = schaetze('openai', l, undefined, kosten, 1);
    expect(ohne).toMatchObject({ geladen: 20, verbraucht: 12, rest: 8, grundlage: 'letzte-ladung' });
    expect(schaetze('openai', l, '2026-11-01T00:00:00Z', kosten, 1)).toBeUndefined(); // leer, noch nicht aufgeladen
  });
  it('warnt bei weniger als 12 h Reichweite oder unter 3 $', () => {
    expect(warnen({ anbieter: 'openai', rest: 10, geladen: 20, verbraucht: 10, seit: 'x', grundlage: 'leer-ereignis', stundenRest: 6 })).toBe(true);
    expect(warnen({ anbieter: 'openai', rest: 10, geladen: 20, verbraucht: 10, seit: 'x', grundlage: 'leer-ereignis', stundenRest: 20 })).toBe(false);
    expect(warnen({ anbieter: 'anthropic', rest: 2, geladen: 20, verbraucht: 18, seit: 'x', grundlage: 'letzte-ladung' })).toBe(true);
    expect(warnText({ anbieter: 'openai', rest: 4.5, geladen: 20, verbraucht: 15.5, seit: 'x', grundlage: 'leer-ereignis', stundenRest: 3 })).toContain('OpenAI-Guthaben geschätzt noch 4.50 $');
  });
  it('ordnet Modelle Anbietern zu', () => {
    expect(anbieterVonModell('gpt-6.1-sol')).toBe('openai');
    expect(anbieterVonModell('claude-opus-5-5')).toBe('anthropic');
    expect(anbieterVonModell('mistral-large-latest')).toBeUndefined();
  });
});
