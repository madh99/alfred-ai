import { describe, it, expect } from 'vitest';
import { ResponseFormatter } from './response-formatter.js';

const tg = (t: string) => new ResponseFormatter().format(t, 'telegram').text;
const zaehle = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('ResponseFormatter Telegram-HTML', () => {
  it('v1729 — rohes „<5 h“ vor einem Link verschluckt keinen Link-Anfang (Realfall 01.11.)', () => {
    const out = tg('| [A](https://x.at/1) | neuwertig, <5 h genutzt | 18.10. |\n| [B](https://x.at/2) | 1900 EUR |');
    expect(out).toContain('neuwertig, &lt;5 h genutzt');
    expect(zaehle(out, /<a href=/g)).toBe(2);
    expect(zaehle(out, /<\/a>/g)).toBe(2);
  });

  it('nicht unterstützte Tags werden weiter entfernt, erlaubte bleiben', () => {
    expect(tg('<div>Hallo</div> <b>fett</b> <span class="x">y</span>')).toBe('Hallo <b>fett</b> y');
    expect(tg('a < b und 3<4')).toBe('a &lt; b und 3&lt;4');
  });
});
