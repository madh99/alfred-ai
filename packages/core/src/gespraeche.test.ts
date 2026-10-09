import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { gespraechsZiel, fadenBefehl, FadenStore, hauptgespraech, verlaufBefehl, spiegelBefehl, herkunftName, type FadenEintrag } from './gespraeche.js';

describe('/verlauf und /spiegel (v1334)', () => {
  it('zeigt die letzten Nachrichten mit Zeit und Herkunft fremder Kanäle, nie die eigene', async () => {
    const liste = [
      { rolle: 'user' as const, text: 'Mach ein Foto', zeit: '2026-10-09T14:43:00Z', herkunft: 'api:sitzung:f883' },
      { rolle: 'assistant' as const, text: 'Erledigt', zeit: '2026-10-09T14:43:10Z', herkunft: 'api:sitzung:f883' },
      { rolle: 'user' as const, text: 'Und jetzt?', zeit: '2026-10-09T14:50:00Z', herkunft: 'telegram:5060785419' },
    ];
    const t = await verlaufBefehl('/verlauf 3', async () => liste, (id) => id === 'f883' ? 'Ubuntu-VM' : undefined, 'telegram:5060785419');
    expect(t).toContain('Du (Ubuntu-VM): Mach ein Foto');
    expect(t).toContain('Alfred: Erledigt');
    expect(t).toContain('Du: Und jetzt?');
    expect(await verlaufBefehl('/verlauf', async () => [], () => undefined, 'telegram:1')).toContain('Noch keine');
    expect(herkunftName('api:web-chat-abc', () => undefined)).toBe('Web');
    expect(herkunftName('api:sitzung:x:faden1', () => 'PC-madh')).toBe('PC-madh');
    expect(herkunftName('telegram:1', () => undefined)).toBe('Telegram');
  });
  it('/spiegel schaltet und bleibt gespeichert, Standard aus', () => {
    const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'alfred-spiegel-'));
    const datei = require('node:path').join(dir, 'gespraeche.json');
    const store = new FadenStore(datei);
    expect(store.spiegelung).toBe(false);
    expect(spiegelBefehl('/spiegel', store)).toContain('aus');
    expect(spiegelBefehl('/spiegel an', store)).toContain('Spiegelung an');
    expect(new FadenStore(datei).spiegelung).toBe(true);
    store.setze('telegram', '1', 'f1');
    expect(new FadenStore(datei).aktiver('telegram', '1')).toBe('f1'); // Fäden-Ablage bleibt neben dem Schalter erhalten
    expect(spiegelBefehl('/spiegel aus', store)).toBe('Spiegelung aus.');
    expect(new FadenStore(datei).spiegelung).toBe(false);
  });
});

const o = { ownerChatId: '5060785419', ownerPlatform: 'telegram' as const };

describe('Gespräche kanalunabhängig (v1330)', () => {
  it('Hauptgespräch: Telegram-Owner-Chat, Gerätesitzung, Terminal und Web landen in derselben Zeile', () => {
    const haupt = { platform: 'telegram', chatId: '5060785419', faden: null };
    expect(gespraechsZiel({ platform: 'telegram', chatId: '5060785419', chatType: 'dm' }, o)).toEqual(haupt);
    expect(gespraechsZiel({ platform: 'api', chatId: 'sitzung:7d9f6a58-52c2', chatType: 'dm' }, o)).toEqual(haupt);
    expect(gespraechsZiel({ platform: 'api', chatId: 'web-chat-abc', chatType: 'dm' }, o)).toEqual(haupt);
    expect(hauptgespraech({})).toEqual({ platform: 'api', chatId: 'owner:haupt' }); // ohne Telegram
  });
  it('Fäden: Sitzung mit Faden, Web-Faden und Telegram mit aktivem Faden', () => {
    const f = { platform: 'api', chatId: 'owner:faden:m1x2', faden: 'm1x2' };
    expect(gespraechsZiel({ platform: 'api', chatId: 'sitzung:abc:m1x2', chatType: 'dm' }, o)).toEqual(f);
    expect(gespraechsZiel({ platform: 'api', chatId: 'web-faden-m1x2', chatType: 'dm' }, o)).toEqual(f);
    expect(gespraechsZiel({ platform: 'telegram', chatId: '5060785419', chatType: 'dm' }, { ...o, aktiverFaden: () => 'm1x2' })).toEqual(f);
    expect(gespraechsZiel({ platform: 'telegram', chatId: '5060785419', chatType: 'dm' }, { ...o, aktiverFaden: () => 'nicht ok!' })?.faden).toBeNull();
  });
  it('bleibt beim Kanal-Gespräch: Gruppen, Projekt-Chats, interne API-Chats, fremde Telegram-Chats', () => {
    expect(gespraechsZiel({ platform: 'telegram', chatId: '-100123', chatType: 'group' }, o)).toBeUndefined();
    expect(gespraechsZiel({ platform: 'api', chatId: 'project:abc', chatType: 'dm' }, o)).toBeUndefined();
    expect(gespraechsZiel({ platform: 'api', chatId: 'sitzung:abc', chatType: 'dm', metadata: { projectId: 'p' } }, o)).toBeUndefined();
    expect(gespraechsZiel({ platform: 'api', chatId: 'api-update-1329', chatType: 'dm' }, o)).toBeUndefined();
    expect(gespraechsZiel({ platform: 'api', chatId: 'api-chat-123', chatType: 'dm' }, o)).toBeUndefined();
    expect(gespraechsZiel({ platform: 'telegram', chatId: '999', chatType: 'dm' }, o)).toBeUndefined();
  });
  it('/faden: Liste, neu, Wechsel per Nummer und Kennung, haupt, löschen — mit Ablage je Kanal-Chat', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'alfred-faden-'));
    const store = new FadenStore(path.join(dir, 'gespraeche.json'));
    const liste: FadenEintrag[] = [
      { faden: null, titel: 'Wie spät ist es?', zeit: '2026-10-09T14:00:00Z', anzahl: 28 },
      { faden: 't1', titel: 'Antworte nur mit Testfaden', zeit: '2026-10-09T14:42:00Z', anzahl: 2 },
      { faden: null, titel: 'Archiv', zeit: '2026-10-09T10:00:00Z', anzahl: 5, archiv: 'sitzung:abc' },
    ];
    const geloescht: string[] = [];
    const deps = { store, liste: async () => liste, loeschen: async (f: string) => { geloescht.push(f); return f === 't1'; } };
    const l = await fadenBefehl('/faden', 'telegram', '5060785419', deps);
    expect(l).toContain('▶ 1. Hauptgespräch'); expect(l).toContain('2. t1'); expect(l).not.toContain('Archiv');
    expect(await fadenBefehl('/faden 2', 'telegram', '5060785419', deps)).toContain('Weiter im Faden t1');
    expect(store.aktiver('telegram', '5060785419')).toBe('t1');
    expect(new FadenStore(path.join(dir, 'gespraeche.json')).aktiver('telegram', '5060785419')).toBe('t1'); // persistiert
    expect(await fadenBefehl('/faden haupt', 'telegram', '5060785419', deps)).toContain('Hauptgespräch');
    expect(store.aktiver('telegram', '5060785419')).toBeNull();
    const neu = await fadenBefehl('/faden neu Urlaub', 'telegram', '5060785419', deps);
    expect(neu).toMatch(/Neuer Faden [a-z0-9]+ angelegt/); expect(store.aktiver('telegram', '5060785419')).toMatch(/^[a-z0-9]+$/);
    expect(await fadenBefehl('/faden t1', 'telegram', '5060785419', deps)).toContain('t1');
    expect(await fadenBefehl('/faden löschen t1', 'telegram', '5060785419', deps)).toBe('Faden t1 gelöscht.');
    expect(geloescht).toEqual(['t1']); expect(store.aktiver('telegram', '5060785419')).toBeNull();
    expect(await fadenBefehl('/faden gibtsnicht', 'telegram', '5060785419', deps)).toContain('Kein Faden');
  });
});
