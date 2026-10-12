import { describe, it, expect, vi } from 'vitest';
import { reaktionAus, signalAus, hinweisCallback, hinweisKnoepfe, grundKnoepfe, gezeigteIds, bekanntTreffer } from '../insights/hinweis-reaktion.js';
import { knappeFassung, knappesInsight } from '../interaktion/knapp.js';
import { QuickActionHandler } from '../quick-actions.js';

// v1364 — Spec „Auf Hinweise reagieren" K1 (Owner 12.10.)
describe('Reaktionen', () => {
  it('nützlich und gelesen schließen den Hinweis, nur nützlich ist ein Signal', () => {
    expect(reaktionAus('nuetzlich')).toEqual({ reaktion: 'nuetzlich', status: 'acted' });
    expect(reaktionAus('gelesen')).toEqual({ reaktion: 'gelesen', status: 'acted' });
    expect(signalAus('nuetzlich')).toBe('positiv');
    expect(signalAus('gelesen')).toBeNull();
    expect(signalAus('besprochen')).toBeNull();
    expect(signalAus(undefined)).toBeNull();
  });

  it('nicht nützlich mit und ohne Grund verwirft; besprochen lässt den Status', () => {
    for (const g of ['nicht_nuetzlich', 'bekannt', 'falsch', 'kein_interesse', 'zu_oft']) {
      expect(reaktionAus(g)?.status).toBe('dismissed');
      expect(signalAus(g)).toBe('negativ');
    }
    expect(reaktionAus('besprochen')).toEqual({ reaktion: 'besprochen', status: null });
    expect(reaktionAus('spaeter')).toBeNull();
  });

  it('Knöpfe der App bis 1.13: erledigt = gelesen (Realfall 11.10.: 68 von 69 in einem Durchgang), verwerfen = nicht nützlich', () => {
    expect(reaktionAus('erledigt')?.reaktion).toBe('gelesen');
    expect(reaktionAus('verwerfen')?.reaktion).toBe('nicht_nuetzlich');
  });
});

describe('Telegram-Knöpfe', () => {
  const a = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', b = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('ein Hinweis: ausgeschrieben; mehrere: nummeriert in zwei Zeilen; ohne gespeicherten Hinweis kein Knopf', () => {
    expect(hinweisKnoepfe([a])).toEqual([[{ text: '👍 Nützlich', callbackData: `hw:${a}:gut` }, { text: '👎 Nicht nützlich', callbackData: `hw:${a}:schlecht` }]]);
    expect(hinweisKnoepfe([a, undefined, b])).toEqual([
      [{ text: '1 👍', callbackData: `hw:${a}:gut` }, { text: '3 👍', callbackData: `hw:${b}:gut` }],
      [{ text: '1 👎', callbackData: `hw:${a}:schlecht` }, { text: '3 👎', callbackData: `hw:${b}:schlecht` }],
    ]);
    expect(hinweisKnoepfe([undefined])).toEqual([]);
    for (const zeile of [...hinweisKnoepfe([a, b]), ...grundKnoepfe(a)]) for (const k of zeile) expect(Buffer.byteLength(k.callbackData)).toBeLessThanOrEqual(64);
  });

  it('Callback-Daten werden zur Reaktion; fremde Daten nicht', () => {
    expect(hinweisCallback(`hw:${a}:gut`)).toEqual({ id: a, reaktion: 'nuetzlich' });
    expect(hinweisCallback(`hw:${a}:kein`)).toEqual({ id: a, reaktion: 'kein_interesse' });
    expect(hinweisCallback(`hw:${a}:oft`)).toEqual({ id: a, reaktion: 'zu_oft' });
    expect(hinweisCallback(`todo:${a}:done`)).toBeNull();
    expect(hinweisCallback(`hw:${a}:loeschen`)).toBeNull();
  });

  it('Knopf „2" gehört zu Zeile „2." der knappen Fassung, auch wenn ein Hinweis leer ist oder Zeilen wegfallen', () => {
    const insights = ['**Wallbox** offline seit 2 h', '   ', 'Paket kommt morgen', 'A', 'B', 'C', 'D'];
    const ids = ['w', 'leer', 'p', 'a', 'b', 'c', 'd'];
    const knapp = knappeFassung(insights);
    const gezeigt = insights.filter(i => knappesInsight(i)).length - knapp.weggelassen;
    expect(knapp.text.split('\n').slice(0, 2)).toEqual(['1. Wallbox offline seit 2 h', '2. Paket kommt morgen']);
    expect(gezeigteIds(insights, ids, gezeigt)).toEqual(['w', 'p', 'a', 'b', 'c']);
  });
});

describe('Beobachtung „schon bekannt"', () => {
  const jetzt = Date.parse('2026-10-20T08:00:00Z');
  const bekannt = [{ text: 'Domains noahhabel.at und noahhabel.com laufen am 15.10. ab — Verlängerung bei nic.at prüfen', am: '2026-10-13T08:00:00Z' }];

  it('gleiches Thema, gleiche Zahlen → gleich, mit Tag seit der Markierung', () => {
    const t = bekanntTreffer('Erinnerung: noahhabel.at und noahhabel.com laufen am 15.10. ab, Verlängerung bei nic.at offen', bekannt, jetzt);
    expect(t).toMatchObject({ tag: 7, inhalt: 'gleich' });
  });

  it('gleiches Thema mit neuen Zahlen → geändert', () => {
    const t = bekanntTreffer('noahhabel.at und noahhabel.com: Verlängerung bei nic.at — Frist jetzt 22.10., Gebühr 30 €', bekannt, jetzt);
    expect(t?.inhalt).toBe('geändert');
  });

  it('anderes Thema oder Markierung älter als 14 Tage → kein Treffer', () => {
    expect(bekanntTreffer('Hausbatterie lädt heute nicht voll, PV-Ertrag gering', bekannt, jetzt)).toBeNull();
    expect(bekanntTreffer('noahhabel.at und noahhabel.com laufen am 15.10. ab — nic.at', bekannt, Date.parse('2026-10-28T09:00:00Z'))).toBeNull();
  });
});

describe('QuickActionHandler — Hinweis-Knöpfe', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  function aufbau() {
    const sendMessage = vi.fn().mockResolvedValue('1');
    const adapters = new Map([['telegram', { sendMessage }]]) as never;
    const logger = { info: vi.fn(), warn: vi.fn() } as never;
    const h = new QuickActionHandler({} as never, {} as never, adapters, logger);
    const handler = vi.fn().mockResolvedValue({ ok: true, titel: 'Wallbox offline' });
    h.setHinweisHandler(handler);
    return { h, sendMessage, handler };
  }

  it('👎 speichert „nicht nützlich" und fragt den Grund freiwillig nach', async () => {
    const { h, sendMessage, handler } = aufbau();
    expect(await h.handle('42', 'telegram' as never, `hw:${id}:schlecht`)).toBe(true);
    expect(handler).toHaveBeenCalledWith('42', 'telegram', id, 'nicht_nuetzlich');
    expect(sendMessage.mock.calls[0][1]).toContain('Warum? (freiwillig)');
    expect(sendMessage.mock.calls[0][2]).toEqual({ replyMarkup: { inlineKeyboard: grundKnoepfe(id) } });
  });

  it('Grund und 👍 werden kurz bestätigt; Fehler gehen nie ins LLM', async () => {
    const { h, sendMessage, handler } = aufbau();
    await h.handle('42', 'telegram' as never, `hw:${id}:bekannt`);
    expect(handler).toHaveBeenLastCalledWith('42', 'telegram', id, 'bekannt');
    expect(sendMessage.mock.calls[0][1]).toBe('Danke — Grund: schon bekannt.');
    await h.handle('42', 'telegram' as never, `hw:${id}:gut`);
    expect(sendMessage.mock.calls[1][1]).toBe('👍 Notiert „Wallbox offline".');
    handler.mockRejectedValueOnce(new Error('db weg'));
    expect(await h.handle('42', 'telegram' as never, `hw:${id}:gut`)).toBe(true);
  });
});
