import { describe, it, expect } from 'vitest';
import { TelegramAdapter, alsReinText } from './telegram.js';

// v1729 — Realfall 01.11.: „can't parse entities: Unexpected end tag“ → Telegram-Kopie ging verloren
describe('v1729 Telegram-Rückfall auf reinen Text', () => {
  it('alsReinText löst Tags und Entitäten auf, Links bleiben lesbar', () => {
    expect(alsReinText('<b>Aktuell</b> <a href="https://x.at/1">Mac</a> neuwertig, &lt;5 h &amp; ok</a>'))
      .toBe('Aktuell Mac (https://x.at/1) neuwertig, <5 h & ok');
  });

  it('sendet nach abgelehnter Formatierung dieselbe Nachricht als reinen Text', async () => {
    const adapter = new TelegramAdapter('000000:TEST-TOKEN');
    const aufrufe: Array<{ text: string; parse_mode?: string }> = [];
    (adapter as any).bot = { api: { sendMessage: async (_c: number, text: string, o: { parse_mode?: string }) => {
      aufrufe.push({ text, parse_mode: o.parse_mode });
      if (o.parse_mode) throw new Error("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: Unexpected end tag at byte offset 5)");
      return { message_id: 7 };
    } } };
    expect(await adapter.sendMessage('1', '<b>x</b></a>', { parseMode: 'html' })).toBe('7');
    expect(aufrufe).toEqual([{ text: '<b>x</b></a>', parse_mode: 'HTML' }, { text: 'x', parse_mode: undefined }]);
  });

  it('andere Fehler werden nicht verschluckt', async () => {
    const adapter = new TelegramAdapter('000000:TEST-TOKEN');
    (adapter as any).bot = { api: { sendMessage: async () => { throw new Error('403: Forbidden: bot was blocked by the user'); } } };
    await expect(adapter.sendMessage('1', 'x', { parseMode: 'html' })).rejects.toThrow('403');
  });
});
