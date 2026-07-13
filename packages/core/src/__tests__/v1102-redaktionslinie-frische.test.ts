import { describe, it, expect, vi } from 'vitest';
import { ContentStudio } from '../content-studio.js';
import type { SocialRepository, SocialChannel, ContentItem } from '@alfred/storage';

/**
 * v1102 — Redaktionssystem-Abstimmung (Befund 12.07.2026):
 * (1) Frische-Review HANDELT: überholte scheduled-Items werden zurückgezogen
 *     (vorher nur Empfehlung — approved bleibt Empfehlung).
 * (2) Shelf-Life-Lücke: Items OHNE art-Marker hatten GAR KEINE Haltbarkeit
 *     (Realfall Glasner: 03.07. erstellt, am 12.07. noch eingeplant).
 * (3) Redaktionslinie (config.redaktionslinie) fließt in Konferenz- und
 *     Schreib-Prompts ein.
 * (4) Evergreen-Tagesdeckel: max. N Füller je Tag und Kanal (Default 2).
 */

const OWNER = 'owner-1';
const NOW = new Date().toISOString();

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as never;
}

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: OWNER, platform: 'test', name: 'Kanal', mode: 'approve',
    publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
    maxPostsPerDay: 10, approvedStreak: 0, status: 'active', config: {},
    createdAt: NOW, updatedAt: NOW, ...overrides,
  } as SocialChannel;
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-1', channelId: 'ch-1', userId: OWNER, status: 'scheduled',
    body: 'Post-Text', media: [], hashtags: [], source: 'studio',
    createdAt: NOW, updatedAt: NOW, ...overrides,
  } as ContentItem;
}

describe('v1102 — Shelf-Life-Default für Items ohne art', () => {
  it('ohne art: 7-Tage-Default (übersteuerbar); evergreen/termin bleiben unbegrenzt', () => {
    const ch = makeChannel();
    expect(ContentStudio.shelfLifeHours(undefined, ch)).toBe(168);
    expect(ContentStudio.shelfLifeHours('evergreen', ch)).toBeUndefined();
    expect(ContentStudio.shelfLifeHours('termin', ch)).toBeUndefined();
    expect(ContentStudio.shelfLifeHours('news', ch)).toBe(48);
    expect(ContentStudio.shelfLifeHours('recap', ch)).toBe(72);
    const custom = makeChannel({ config: { shelf_life_hours: { default: 24, news: 12 } } });
    expect(ContentStudio.shelfLifeHours(undefined, custom)).toBe(24);
    expect(ContentStudio.shelfLifeHours('news', custom)).toBe(12);
  });
});

describe('v1102 — Frische-Review handelt statt nur zu empfehlen', () => {
  function reviewStudio(items: ContentItem[], verdicts: Array<{ index: number; verdict: string; grund?: string }>) {
    const transitions: Array<{ id: string; to: string }> = [];
    const socialRepo = {
      listItems: vi.fn(async () => items),
      listChannels: vi.fn(async () => [makeChannel({ config: { topic_ids: ['t1'] } })]),
      transition: vi.fn(async (_u: string, id: string, to: string) => { transitions.push({ id, to }); return {}; }),
      reschedule: vi.fn(async () => true),
      listStories: vi.fn(async () => []),
      mergePerformance: vi.fn(async () => { /* */ }),
    } as unknown as SocialRepository;
    const interestsRepo = {
      listItems: vi.fn(async () => [{ title: 'Frankreich steht im Finale', sourceKind: 'rss' }]),
    } as never;
    const llm = { complete: vi.fn(async () => ({ content: JSON.stringify(verdicts) })) };
    const studio = new ContentStudio(socialRepo, interestsRepo, undefined, llm as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
    return { studio, transitions, llm };
  }

  it('überholtes SCHEDULED-Item → zurückgezogen; überholtes APPROVED-Item → nur Empfehlung', async () => {
    const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const scheduled = makeItem({ id: 'item-sched', status: 'scheduled', scheduledAt: inTwoHours, title: 'Vorschau aufs Viertelfinale' });
    const approved = makeItem({ id: 'item-appr', status: 'approved', scheduledAt: inTwoHours, title: 'Noch ein Beitrag' });
    const { studio, transitions } = reviewStudio(
      [scheduled, approved],
      [{ index: 0, verdict: 'ueberholt', grund: 'Spiel vorbei' }, { index: 1, verdict: 'ueberholt', grund: 'Spiel vorbei' }],
    );
    const r = await studio.planReview();
    expect(transitions).toContainEqual({ id: 'item-sched', to: 'rejected' });   // gehandelt
    expect(transitions.some(t => t.id === 'item-appr')).toBe(false);            // approved unangetastet
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(r.flagged).toBeGreaterThanOrEqual(1); // die Empfehlung für das approved-Item
  });
});

describe('v1111 — Evergreen-Gate: K.-o.-Bezug ist nie zeitlos', () => {
  it('istKoEreignisBezug erkennt Turnier-Runden, lässt echte Evergreens durch', async () => {
    const { istKoEreignisBezug } = await import('../content-studio.js');
    expect(istKoEreignisBezug('Halbfinal-Fieber: Wer holt den Pott?')).toBe(true);
    expect(istKoEreignisBezug('Wenn die Weltelite unter sich bleibt: Halbfinal-Quartett der WM 2026')).toBe(true);
    expect(istKoEreignisBezug('Das Finale rückt näher')).toBe(true);
    expect(istKoEreignisBezug('Viertelfinale im Rückblick')).toBe(true);
    expect(istKoEreignisBezug('Erinnert ihr euch an euer erstes Panini-Album?')).toBe(false);
    expect(istKoEreignisBezug('Sticker-Lücken schließen: Tausch-Strategien im Überblick')).toBe(false);
  });
});

describe('v1102 — Redaktionslinie + Evergreen-Tagesdeckel', () => {
  it('linieOf: erster Familien-Kanal mit config.redaktionslinie gewinnt', () => {
    expect(ContentStudio.linieOf([makeChannel(), makeChannel({ config: { redaktionslinie: '  Countdown aufs Halbfinale  ' } })]))
      .toBe('Countdown aufs Halbfinale');
    expect(ContentStudio.linieOf([makeChannel()])).toBe('');
  });

  it('pickEvergreenSlot: Tagesdeckel (Default 2) — dritter Füller rutscht auf den nächsten Tag, voller Pool → undefined', () => {
    const studio = new ContentStudio({} as never, undefined as never, undefined, { complete: vi.fn() } as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
    const channel = makeChannel();
    const day1 = (h: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    const day2 = (h: number) => { const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(h, 0, 0, 0); return d.toISOString(); };
    // Morgen ist bereits EIN Evergreen geplant → nur noch 1 Platz
    const planned = [makeItem({ id: 'eg-planned', status: 'scheduled', scheduledAt: day1(9), performance: { art: 'evergreen' } })];
    const pool = [day1(11), day1(15), day2(10)];
    const taken = new Map<string, number>();
    const pick = () => (studio as never as {
      pickEvergreenSlot(c: SocialChannel, p: string[], pl: ContentItem[], t: Map<string, number>, nb?: string): string | undefined;
    }).pickEvergreenSlot(channel, pool, planned, taken);
    expect(pick()).toBe(day1(11)); // Platz 2/2 von morgen
    expect(pick()).toBe(day2(10)); // morgen voll → übermorgen (day1(15) übersprungen)
    expect(pick()).toBeUndefined(); // kein Tag mit Kapazität mehr
    expect(pool).toEqual([day1(15)]); // der übersprungene Slot bleibt für Nicht-Evergreens
    // Deckel 0 = Evergreens ganz aus
    const aus = makeChannel({ config: { evergreen_max_per_day: 0 } });
    expect((studio as never as { pickEvergreenSlot(c: SocialChannel, p: string[], pl: ContentItem[], t: Map<string, number>): string | undefined })
      .pickEvergreenSlot(aus, [day2(12)], [], new Map())).toBeUndefined();
  });
});
