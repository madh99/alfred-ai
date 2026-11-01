import { describe, expect, it } from 'vitest';
import { leseLadung, schaetze, warnen, warnText, anbieterVonModell, neuerFaktor, guthabenEingabe, leseEzbKurs, bruttoEur, type Schaetzung } from './guthaben-schaetzung.js';

const openaiMail = { id: 'm1', from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your OpenAI API account has been funded', body: 'Hi, We charged $24.00 to your credit card ending in 1234 to fund your OpenAI API credit balance.', date: '2026-10-31T08:20:10Z' };
const anthropicMail = { id: 'm2', from: 'invoice+statements+acct_1REyrSBNUnCSzfs9@stripe.com', subject: 'Your receipt from Anthropic Ireland, Limited #2795-4841-5882', body: 'One-time credit purchase\n Qty 1\n $20.00\nVAT - Austria (20%) $4.00\nAmount paid $24.00', date: '2026-10-30T10:44:27Z' };
const maxAbo = { id: 'm3', from: 'invoice+statements@mail.anthropic.com', subject: 'Your receipt from Anthropic, PBC #2552-0722-0291', body: 'Max plan - 20x Qty 1 €180.00 VAT - Austria (20%) €36.00 Amount paid €216.00', date: '2026-10-28T00:48:54Z' };
const s = (x: Partial<Schaetzung>): Schaetzung => ({ anbieter: 'openai', rest: 10, geladen: 20, verbraucht: 10, seit: 'x', grundlage: 'leer-ereignis', start: 0, faktor: 1, ...x });

describe('v1726/v1727 — Guthaben-Schätzung', () => {
  it('erkennt Ladungen (OpenAI ohne MwSt., Anthropic Einmal-Guthaben), nicht das Max-Abo', () => {
    expect(leseLadung(openaiMail)).toMatchObject({ anbieter: 'openai', guthaben: 20 });
    expect(leseLadung(anthropicMail)).toMatchObject({ anbieter: 'anthropic', guthaben: 20 });
    expect(leseLadung(maxAbo)).toBeUndefined();
    expect(leseLadung({ ...openaiMail, from: 'phish@example.com' })).toBeUndefined();
    const gratis = { id: 'm4', from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your API credits are ready', body: 'You’ve successfully linked your ChatGPT account to your API organization: “Mach Personal”.\nToday, you received $9 in API credits.', date: '2026-11-01T12:13:56Z' };
    expect(leseLadung(gratis)).toMatchObject({ anbieter: 'openai', guthaben: 9 });
    expect(leseLadung({ ...gratis, from: 'noreply@openai.example.com' })).toBeUndefined();
  });

  it('schätzt ab leerem Stand, genanntem Kontostand oder vorsichtig ab der letzten Ladung; Faktor wirkt auf den Verbrauch', () => {
    const l = [leseLadung(openaiMail)!, { anbieter: 'openai' as const, guthaben: 10, zeit: '2026-10-29T17:17:46Z', mailId: 'x' }];
    const kosten = (iso: string) => (Date.parse(iso) < Date.parse('2026-10-30T00:00:00Z') ? 25 : 12);
    expect(schaetze('openai', l, { art: 'leer', betrag: 0, zeit: '2026-10-29T17:00:00Z' }, kosten, 1)).toMatchObject({ geladen: 30, verbraucht: 25, rest: 5, grundlage: 'leer-ereignis' });
    expect(schaetze('openai', l, undefined, kosten, 1)).toMatchObject({ geladen: 20, verbraucht: 12, rest: 8, grundlage: 'letzte-ladung' });
    expect(schaetze('openai', l, { art: 'leer', betrag: 0, zeit: '2026-11-01T00:00:00Z' }, kosten, 1)).toBeUndefined();
    const stand = schaetze('openai', [...l, { anbieter: 'openai', guthaben: 33.33, zeit: '2026-11-01T12:30:00Z', mailId: 'y' }], { art: 'stand', betrag: 2.07, zeit: '2026-11-01T12:09:00Z' }, () => 1, 1, 1.15);
    expect(stand).toMatchObject({ start: 2.07, geladen: 33.33, verbraucht: 1.15, rest: 34.25, grundlage: 'kontostand', faktor: 1.15 });
  });

  it('Korrekturfaktor aus zwei bekannten Ständen (Realfall 01.11.: OpenAI 20 $ geladen, 15,61 $ gemessen, Stand 2,07 $)', () => {
    const l = [leseLadung(openaiMail)!];
    expect(neuerFaktor({ art: 'leer', betrag: 0, zeit: '2026-10-31T08:09:00Z' }, { betrag: 2.07, zeit: '2026-11-01T12:09:00Z' }, l, 'openai', 15.61)).toBeCloseTo(1.149, 2);
    expect(neuerFaktor({ art: 'leer', betrag: 0, zeit: '2026-10-31T08:09:00Z' }, { betrag: 2.07, zeit: '2026-11-01T12:09:00Z' }, l, 'openai', 1)).toBe(1); // zu wenig gemessen
    expect(neuerFaktor({ art: 'leer', betrag: 0, zeit: '2026-10-31T08:09:00Z' }, { betrag: 2.07, zeit: '2026-11-01T12:09:00Z' }, l, 'openai', 5)).toBe(2); // gedeckelt
  });

  it('warnt bei weniger als 12 h Reichweite oder unter 3 $; Text mit Euro und Eingabe-Hinweis', () => {
    expect(warnen(s({ stundenRest: 6 }))).toBe(true);
    expect(warnen(s({ stundenRest: 20 }))).toBe(false);
    expect(warnen(s({ anbieter: 'anthropic', rest: 2, grundlage: 'letzte-ladung' }))).toBe(true);
    const t = warnText(s({ rest: 4.5, verbraucht: 15.5, stundenRest: 3, faktor: 1.15 }), 1.16);
    expect(t).toContain('OpenAI-Guthaben geschätzt noch 4.50 $');
    expect(t).toContain('×1.15');
    expect(t).toContain('€ brutto');
    expect(t).toContain('„OpenAI Guthaben 12,34“');
  });

  it('Kontostand-Eingabe ohne Modell', () => {
    expect(guthabenEingabe('OpenAI Guthaben 2,07')).toEqual({ anbieter: 'openai', betrag: 2.07 });
    expect(guthabenEingabe('Guthaben Anthropic: 13.94 $')).toEqual({ anbieter: 'anthropic', betrag: 13.94 });
    expect(guthabenEingabe('anthropic-guthaben $13,94')).toEqual({ anbieter: 'anthropic', betrag: 13.94 });
    expect(guthabenEingabe('Wie hoch ist das OpenAI Guthaben?')).toBeUndefined();
    expect(guthabenEingabe('OpenAI 2,07')).toBeUndefined();
  });

  it('EZB-Kurs und Euro brutto', () => {
    expect(leseEzbKurs("<Cube currency='USD' rate='1.1612'/>")).toBe(1.1612);
    expect(leseEzbKurs('<Cube/>')).toBeUndefined();
    expect(bruttoEur(50, 1.16)).toBeCloseTo(51.72, 2);
  });

  it('ordnet Modelle Anbietern zu', () => {
    expect(anbieterVonModell('gpt-6.1-sol')).toBe('openai');
    expect(anbieterVonModell('claude-opus-5-5')).toBe('anthropic');
    expect(anbieterVonModell('mistral-large-latest')).toBeUndefined();
  });
});
